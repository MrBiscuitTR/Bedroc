<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { auth, serverStatus } from '$lib/stores/auth.svelte.js';
	import {
		notesMap, topicsMap, foldersMap, conflictsMap,
		getNotes, getTopics, getFolders,
		createNote, createTopic, saveTopic, deleteTopic,
		createFolder, saveFolder, toggleFolderCollapsed, deleteFolder,
		moveTopic,
		saveNote, resolveConflict,
		relativeTime,
		externalUpdates, liveSyncStore,
		type Topic, type Folder, type ConflictRecord, type ExternalUpdate
	} from '$lib/stores/notes.svelte';

	// ── Note identity ─────────────────────────────────────────────
	let noteId  = $derived(page.params.id);
	let isNew   = $derived(noteId === 'new');

	// ── Conflict resolution ───────────────────────────────────────
	let conflict = $derived(noteId && !isNew ? conflictsMap.get(noteId) : undefined);
	let showConflict = $derived(!!conflict);
	// 'banner' = collapsed notice, 'diff' = full diff view
	let conflictView = $state<'banner' | 'diff'>('banner');
	// Custom merge text (used in diff view when user edits the merge area)
	let mergeTitle = $state('');
	let mergeBody = $state('');
	let mergeDirty = $state(false);
	let conflictResolving = $state(false);

	$effect(() => {
		if (conflict) {
			mergeTitle = conflict.localTitle;
			mergeBody = conflict.localBody;
			mergeDirty = false;
		}
	});

	async function handleResolveConflict(choice: 'local' | 'server' | 'merge') {
		if (!noteId || !conflict) return;
		conflictResolving = true;
		try {
			if (choice === 'merge') {
				await resolveConflict(noteId, { title: mergeTitle, body: mergeBody });
			} else {
				await resolveConflict(noteId, choice);
			}
			conflictView = 'banner';
		} finally {
			conflictResolving = false;
		}
	}

	// ── Load note ─────────────────────────────────────────────────
	// Notes are stored decrypted in IndexedDB; encryption happens at sync time.
	let title = $state('');
	let saved = $state(true);
	let bodyEl = $state<HTMLDivElement | undefined>(undefined);

	// Track the last noteId we loaded content for — prevents overwriting user edits
	// after saveNote triggers a notesMap update while the user is still on the same note.
	let loadedNoteId: string | null = null;

	$effect(() => {
		const n = isNew ? null : notesMap.get(noteId!);
		const isNewNoteId = noteId !== loadedNoteId;

		if (n) {
			// Only load content when switching to a different note —
			// never overwrite user edits triggered by save/sync updates
			if (bodyEl && isNewNoteId) {
				title = n.title;
				bodyEl.innerHTML = n.body;
				loadedNoteId = noteId;
				saved = true;
			}
		} else if (isNew && isNewNoteId) {
			title = '';
			if (bodyEl) {
				bodyEl.innerHTML = '';
				loadedNoteId = 'new';
				saved = true;
			}
		}
	});

	// ── Autosave ──────────────────────────────────────────────────
	import { autosave } from '$lib/stores/notes.svelte';

	let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

	function scheduleAutosave() {
		if (autosave.interval <= 0) return;
		if (autosaveTimer) clearTimeout(autosaveTimer);
		autosaveTimer = setTimeout(doSave, autosave.interval);
	}

	// Prevents concurrent saves from racing each other.
	let _saving = false;

	async function doSave() {
		if (saved) return;
		if (_saving) return; // already in flight — the next autosave will catch unsaved changes
		_saving = true;

		// Snapshot body + cursor BEFORE any await — nothing can change the DOM
		// between these two lines and the async work below.
		const body = bodyEl?.innerHTML ?? '';
		const savedPosition = bodyEl ? saveCursorPosition(bodyEl) : null;

		try {
			if (isNew) {
				const id = await createNote(null);
				const created = notesMap.get(id)!;
				await saveNote({ ...created, title: dedupTitle(title.trim() || 'Untitled', null, id), body });
				saved = true;
				goto(`/note/${id}`, { replaceState: true });
			} else {
				const existing = notesMap.get(noteId!);
				if (!existing) return;
				await saveNote({ ...existing, title: dedupTitle(title.trim() || 'Untitled', existing.topicId, existing.id), body });
				saved = true;
				_lastSaveAt = Date.now();
			}

			// Restore cursor after save.  The save touches IDB + reactivity but
			// should NOT touch bodyEl.innerHTML (the $effect guard prevents that),
			// so we only need to restore if the browser moved the caret (it can
			// after certain layout-triggering async operations).
			if (savedPosition && bodyEl && document.activeElement === bodyEl) {
				requestAnimationFrame(() => {
					if (savedPosition && bodyEl && document.activeElement === bodyEl) {
						restoreCursorPosition(bodyEl, savedPosition);
					}
				});
			}
		} finally {
			_saving = false;
		}
	}

	/** Ensure no two notes in the same topic share a title; appends (2), (3)… if needed. */
	function dedupTitle(base: string, topicId: string | null, ownId: string): string {
		const siblings = getNotes().filter(n => n.topicId === topicId && n.id !== ownId);
		const titles = new Set(siblings.map(n => n.title));
		if (!titles.has(base)) return base;
		let i = 2;
		while (titles.has(`${base} (${i})`)) i++;
		return `${base} (${i})`;
	}

	/** Format stored names as Title Case for display */
	function formatName(name: string): string {
		if (!name) return '';
		return name.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
	}

	function getTopNoteForTopic(topicId: string) {
		const notes = allNotes.filter(n => n.topicId === topicId).slice();
		if (!notes.length) return null;
		notes.sort((a,b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
		return notes[0];
	}

	// ── Real-time external update (from another device/tab) ───────
	// Uses character-offset cursor saving so the cursor stays in place after innerHTML update.

	// ── Cursor preservation ───────────────────────────────────────
	// We use a path-based approach rather than char-offset.  A path is an array
	// of child indices from root to the caret node.  This handles:
	//   - Cursor inside empty elements (empty <li>, after <br>)
	//   - Cursor in text nodes
	//   - Mixed content (text + inline elements)
	// After an innerHTML replacement, the structure should be identical (same
	// HTML string), so the path restores correctly.

	interface CursorPos {
		path: number[];        // child indices from root to the container node
		offset: number;        // offset inside that container (char offset for text, child index for element)
		isCollapsed: boolean;
	}

	function getNodePath(root: Node, node: Node): number[] | null {
		const path: number[] = [];
		let cur: Node = node;
		while (cur !== root) {
			const parent = cur.parentNode;
			if (!parent) return null;
			const idx = Array.from(parent.childNodes).indexOf(cur as ChildNode);
			if (idx === -1) return null;
			path.unshift(idx);
			cur = parent;
		}
		return path;
	}

	function resolveNodePath(root: Node, path: number[]): Node | null {
		let cur: Node = root;
		for (const idx of path) {
			const child = cur.childNodes[idx];
			if (!child) return null;
			cur = child;
		}
		return cur;
	}

	function saveCursorPosition(root: HTMLElement): CursorPos | null {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) return null;
		const range = sel.getRangeAt(0);
		if (!root.contains(range.startContainer)) return null;

		const path = getNodePath(root, range.startContainer);
		if (!path) return null;
		return { path, offset: range.startOffset, isCollapsed: range.collapsed };
	}

	function restoreCursorPosition(root: HTMLElement, pos: CursorPos): void {
		const sel = window.getSelection();
		if (!sel) return;
		const node = resolveNodePath(root, pos.path);
		if (!node) {
			// Path no longer valid (content changed) — put cursor at end
			const range = document.createRange();
			range.selectNodeContents(root);
			range.collapse(false);
			sel.removeAllRanges();
			sel.addRange(range);
			return;
		}
		const maxOffset = node.nodeType === Node.TEXT_NODE
			? (node as Text).length
			: node.childNodes.length;
		const clampedOffset = Math.min(pos.offset, maxOffset);
		const range = document.createRange();
		range.setStart(node, clampedOffset);
		range.collapse(true);
		sel.removeAllRanges();
		sel.addRange(range);
	}

	/** Apply an external update to the editor, preserving cursor position. */
	function applyExternalUpdate(update: ExternalUpdate): void {
		if (!bodyEl) return;
		const sel = window.getSelection();
		const editorFocused = sel && sel.rangeCount > 0 && bodyEl.contains(sel.getRangeAt(0).startContainer);
		const cursorPos = editorFocused ? saveCursorPosition(bodyEl) : null;

		title = update.title;
		bodyEl.innerHTML = update.body;

		if (cursorPos) {
			restoreCursorPosition(bodyEl, cursorPos);
		}
	}

	let incomingUpdate = $state<ExternalUpdate | null>(null);
	// Timestamp of the last time we saved — suppress external updates that arrive
	// within a short window after our own save to avoid false conflict banners.
	let _lastSaveAt = 0;

	$effect(() => {
		if (isNew || !noteId) return;
		const update = externalUpdates.get(noteId);
		if (!update) return;
		externalUpdates.delete(noteId); // consume

		// Suppress updates that arrive <3 s after we saved the same note ourselves.
		// These are echoes of our own write propagated back via the sync channel.
		if (Date.now() - _lastSaveAt < 3000) return;

		if (saved) {
			applyExternalUpdate(update);
		} else {
			incomingUpdate = update;
		}
	});

	function acceptIncoming() {
		if (!incomingUpdate) return;
		applyExternalUpdate(incomingUpdate);
		saved = true;
		incomingUpdate = null;
	}

	function dismissIncoming() {
		incomingUpdate = null;
	}

	function handleTitleInput() { saved = false; scheduleAutosave(); }
	function handleBodyInput()  { saved = false; scheduleAutosave(); updateFormatState(); }

	async function handleSave() {
		if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
		await doSave();
	}

	async function handleBack() {
		if (!saved) await doSave();
		goto('/');
	}

	async function handleDelete() {
		if (isNew) { goto('/'); return; }
		const { deleteNote } = await import('$lib/stores/notes.svelte');
		await deleteNote(noteId!);
		goto('/');
	}

	// ── Rich text commands ────────────────────────────────────────
	// PLACEHOLDER: uses document.execCommand (deprecated). Phase 6: ProseMirror.

	// ── Toolbar selection preservation ───────────────────────────
	// When a toolbar button is clicked, the editor loses focus (blur) before the
	// click handler runs.  We save the Range on blur and restore it inside exec()
	// BEFORE focus() is called — this prevents the browser from resetting the
	// selection to the start of the editable div.
	//
	// IMPORTANT: Do NOT clear _savedRange on focus.  The sequence for a toolbar
	// click is: editor blur → save range → button mousedown → button click fires
	// exec() → exec calls focus() → editor focus → exec calls restoreSavedRange()
	// If we cleared on focus, the range would be gone before restoreSavedRange().

	let _savedRange: Range | null = null;

	function onEditorFocus() {
		// Do NOT clear _savedRange here — see comment above.
		// The range is cleared in restoreSavedRange() after it is used.
	}

	function onEditorBlur() {
		const sel = window.getSelection();
		if (sel && sel.rangeCount > 0 && bodyEl?.contains(sel.getRangeAt(0).commonAncestorContainer)) {
			_savedRange = sel.getRangeAt(0).cloneRange();
		}
	}

	function restoreSavedRange() {
		if (!_savedRange) return;
		const range = _savedRange;
		_savedRange = null; // consume — clear after use, not on focus
		const sel = window.getSelection();
		if (sel) {
			sel.removeAllRanges();
			sel.addRange(range);
		}
	}

	function exec(cmd: string, value?: string) {
		// Restore saved range BEFORE focus so the browser sees the right selection
		// when focus() triggers internal selection restoration.
		if (_savedRange) restoreSavedRange();
		bodyEl?.focus();
		document.execCommand(cmd, false, value);
		updateFormatState();
		saved = false;
		scheduleAutosave();
	}

	function execFontSize(px: string) {
		if (_savedRange) restoreSavedRange();
		bodyEl?.focus();
		// Use the font-size=7 marker trick to find the selected range, then
		// replace with a proper <span style="font-size:Xpx">.
		document.execCommand('fontSize', false, '7');
		bodyEl?.querySelectorAll('font[size="7"]').forEach((el) => {
			const span = document.createElement('span');
			span.style.fontSize = px;
			span.innerHTML = (el as HTMLElement).innerHTML;
			el.replaceWith(span);
		});
		updateFormatState();
		saved = false;
		scheduleAutosave();
	}

	// ── Formatting state ──────────────────────────────────────────
	let isBold      = $state(false);
	let isItalic    = $state(false);
	let isUnderline = $state(false);
	let isStrike    = $state(false);
	let isUL        = $state(false);
	let isOL        = $state(false);
	// Current font size in px detected from selection ('15' = 15px default)
	let currentFontSize = $state('');
	let showFontSizePicker = $state(false);

	function updateFormatState() {
		if (typeof document === 'undefined') return;
		isBold      = document.queryCommandState('bold');
		isItalic    = document.queryCommandState('italic');
		isUnderline = document.queryCommandState('underline');
		isStrike    = document.queryCommandState('strikeThrough');
		isUL        = document.queryCommandState('insertUnorderedList');
		isOL        = document.queryCommandState('insertOrderedList');
		currentFontSize = detectFontSizePx();
	}

	// Walk up from the selection to find the nearest explicit font-size style.
	// Returns the numeric px value as a string (e.g. '12'), or '' if none found.
	function detectFontSizePx(): string {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) return '';
		let node: Node | null = sel.getRangeAt(0).startContainer;
		if (node?.nodeType === Node.TEXT_NODE) node = node.parentNode;
		while (node && node !== bodyEl) {
			if (node.nodeType === Node.ELEMENT_NODE) {
				const fs = (node as HTMLElement).style.fontSize;
				if (fs && fs.endsWith('px')) return fs.slice(0, -2);
			}
			node = (node as Element).parentElement;
		}
		return '';
	}

	const fontSizeOptions = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];

	// Color swatches
	const textColors = [
		'#e2e4ed',
		'#6b8afd',
		'#4caf87',
		'#e0a45c',
		'#e05c5c',
		'#c084fc',
		'#38bdf8',
		'#f472b6',
	];

	let showColorPicker = $state(false);
	let customColor = $state('#e2e4ed');
	let colorBtnEl = $state<HTMLButtonElement | undefined>(undefined);
	let colorPanelEl = $state<HTMLDivElement | undefined>(undefined);
	let fontsizeBtnEl = $state<HTMLButtonElement | undefined>(undefined);
	let fontsizePanelEl = $state<HTMLDivElement | undefined>(undefined);

	// Position a floating panel below its trigger button.
	function positionPanel(btn: HTMLElement | undefined, panel: HTMLElement | undefined) {
		if (!btn || !panel) return;
		const rect = btn.getBoundingClientRect();
		panel.style.top  = (rect.bottom + 6) + 'px';
		panel.style.left = rect.left + 'px';
		// Clamp so it doesn't go off-screen to the right
		requestAnimationFrame(() => {
			const pr = panel.getBoundingClientRect();
			if (pr.right > window.innerWidth - 8) {
				panel.style.left = Math.max(8, window.innerWidth - pr.width - 8) + 'px';
			}
		});
	}

	$effect(() => {
		if (showColorPicker) positionPanel(colorBtnEl, colorPanelEl);
	});
	$effect(() => {
		if (showFontSizePicker) positionPanel(fontsizeBtnEl, fontsizePanelEl);
	});

	function applyColor(color: string) {
		customColor = color;
		exec('foreColor', color);
		showColorPicker = false;
	}

	// ── Clear formatting ─────────────────────────────────────────
	function clearFormatting() {
		exec('removeFormat');
		// removeFormat doesn't remove lists — toggle them off if active
		if (document.queryCommandState('insertUnorderedList')) exec('insertUnorderedList');
		if (document.queryCommandState('insertOrderedList')) exec('insertOrderedList');
	}

	// ── Paste without formatting (Ctrl+Shift+V) ──────────────────
	function handlePaste(e: ClipboardEvent) {
		// Ctrl+Shift+V → paste as plain text in the current cursor style
		const isPlainPaste = e.shiftKey && (e.ctrlKey || e.metaKey);
		// Also strip formatting from any paste that contains styled HTML (standard Ctrl+V)
		// so pasted content doesn't override the user's formatting for subsequent typing.
		const html = e.clipboardData?.getData('text/html') ?? '';
		const text = e.clipboardData?.getData('text/plain') ?? '';

		if (isPlainPaste || html) {
			e.preventDefault();
			// Insert plain text at cursor — preserves current typing style
			const plain = text || (e.clipboardData?.getData('text/plain') ?? '');
			document.execCommand('insertText', false, plain);
			saved = false;
			scheduleAutosave();
		}
		// Else: let the browser handle it (e.g. images)
	}

	// ── Delete confirm ────────────────────────────────────────────
	let confirmDelete = $state(false);

	// ── Topics side drawer (mirrors +page.svelte aside) ───────────
	let drawerOpen = $state(false);

	let allNotes    = $derived((notesMap.size, getNotes()));
	let allTopics   = $derived((topicsMap.size, getTopics()));
	let allFolders  = $derived((foldersMap.size, getFolders()));

	// The topic the current note belongs to (for border highlight)
	let currentNote    = $derived(isNew ? null : notesMap.get(noteId!));
	let activeTopicId  = $derived(currentNote?.topicId ?? null);

	function topicsInFolder(folderId: string | null): Topic[] {
		return allTopics.filter(t => t.folderId === folderId).sort((a, b) => a.order - b.order);
	}
	function childFolders(parentId: string | null): Folder[] {
		return allFolders.filter(f => f.parentId === parentId).sort((a, b) => a.order - b.order);
	}
	function noteCountForTopic(topicId: string): number {
		return allNotes.filter(n => n.topicId === topicId).length;
	}

	/** Navigate to the notes list filtered by topic. Saves first if dirty. */
	function goToTopic(id: string | null | 'all') {
		if (!saved) doSave();
		drawerOpen = false;
		if (id === 'all') goto('/');
		else if (id === null) goto('/');
		else goto(`/?topic=${id}`);
	}

	// Topic editor modal state (inline, same as +page.svelte)
	let showTopicEditor = $state(false);
	let editingTopic    = $state<Topic | null>(null);
	let topicName       = $state('');
	let topicColor      = $state('#6b8afd');
	let topicFolderId   = $state<string | null>(null);

	function openEditTopic(topic: Topic) {
		editingTopic = topic; topicName = topic.name; topicColor = topic.color; topicFolderId = topic.folderId;
		showTopicEditor = true;
	}
	function saveTopicModal() {
		if (!topicName.trim()) return;
		if (editingTopic) saveTopic({ ...editingTopic, name: topicName.trim(), color: topicColor, folderId: topicFolderId });
		showTopicEditor = false;
	}
	function handleDeleteTopic(id: string) {
		deleteTopic(id);
		showTopicEditor = false;
	}

	// Folder editor modal state
	let showFolderEditor = $state(false);
	let editingFolder    = $state<Folder | null>(null);
	let folderName       = $state('');
	let folderParentId   = $state<string | null>(null);

	function openEditFolder(folder: Folder) {
		editingFolder = folder; folderName = folder.name; folderParentId = folder.parentId;
		showFolderEditor = true;
	}
	function saveFolderModal() {
		if (!folderName.trim()) return;
		if (editingFolder) saveFolder({ ...editingFolder, name: folderName.trim(), parentId: folderParentId });
		showFolderEditor = false;
	}
</script>

<svelte:head>
	<title>{title || 'New note'} — Bedroc</title>
</svelte:head>

<div class="editor-page">
	<!-- ── Top toolbar ─────────────────────────────────────────── -->
	<div class="toolbar">
		<!-- Left side: drawer toggle on mobile, back button on desktop -->
		<button
			class="btn-icon drawer-toggle-btn mobile-only"
			onclick={() => (drawerOpen = true)}
			aria-label="Open topics"
			aria-expanded={drawerOpen}
		>
			<svg width="18" height="18" viewBox="0 0 18 18" fill="none">
				<rect x="2" y="3" width="6" height="12" rx="1" stroke="currentColor" stroke-width="1.4"/>
				<path d="M11 6h5M11 9h5M11 12h5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
			</svg>
		</button>
		<button
			class="btn-icon back-btn desktop-only"
			onclick={handleBack}
			aria-label="Go back"
		>
			<svg width="18" height="18" viewBox="0 0 18 18" fill="none">
				<path d="M11 4L6 9l5 5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
		</button>

		<div class="toolbar-actions">
			{#if !saved}
				<span class="unsaved-dot" title="Unsaved changes"></span>
			{/if}

			<button class="save-btn" onclick={handleSave} disabled={saved}>
				{saved ? 'Saved' : 'Save'}
			</button>

			{#if !isNew}
				{#if confirmDelete}
					<button class="btn-danger-sm" onclick={handleDelete}>Delete</button>
					<button class="btn-icon" onclick={() => (confirmDelete = false)} aria-label="Cancel">
						<svg width="13" height="13" viewBox="0 0 13 13" fill="none">
							<path d="M1.5 1.5l10 10M11.5 1.5l-10 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
						</svg>
					</button>
				{:else}
					<button class="btn-icon delete-btn" onclick={() => (confirmDelete = true)} aria-label="Delete note">
						<svg width="15" height="15" viewBox="0 0 15 15" fill="none">
							<path d="M2 4h11M5 4V2.5A1.5 1.5 0 0 1 6.5 1h2A1.5 1.5 0 0 1 10 2.5V4M6 7v5M9 7v5M3 4l.8 8.5A1.5 1.5 0 0 0 5.3 14h4.4a1.5 1.5 0 0 0 1.5-1.5L12 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
						</svg>
					</button>
				{/if}
			{/if}
		</div>
	</div>

	<!-- ── Note title ──────────────────────────────────────────── -->
	<input
		class="title-input"
		type="text"
		placeholder="Title"
		bind:value={title}
		oninput={handleTitleInput}
		spellcheck="true"
		autocapitalize="sentences"
	/>

	<!-- ── No-DEK banner (split-pane / iframe without vault key) ── -->
	{#if !auth.dek}
		<div class="no-dek-banner" role="status">
			<svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
				<rect x="3" y="6" width="8" height="7" rx="1.2" stroke="currentColor" stroke-width="1.3"/>
				<path d="M5 6V4.5a2 2 0 114 0V6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
			</svg>
			<span>Vault locked — viewing only. Unlock in the main window to edit and sync.</span>
		</div>
	{/if}

	<!-- ── Incoming update banner (real-time, unsaved conflict) ─── -->
	{#if incomingUpdate}
		<div class="incoming-banner" role="alert">
			<div class="incoming-banner-icon" aria-hidden="true">
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
					<circle cx="7" cy="7" r="6" stroke="currentColor" stroke-width="1.3"/>
					<path d="M7 4v3.5l2 1.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</div>
			<div class="incoming-banner-text">
				<span class="incoming-banner-title">Updated on another device</span>
				<span class="incoming-banner-desc">Your unsaved changes conflict with a newer version.</span>
			</div>
			<div class="incoming-banner-actions">
				<button class="incoming-btn-accept" onclick={acceptIncoming}>Use theirs</button>
				<button class="incoming-btn-dismiss" onclick={dismissIncoming}>Keep mine</button>
			</div>
		</div>
	{/if}

	<!-- ── Conflict notice ──────────────────────────────────────── -->
	{#if showConflict && conflict}
		{#if conflictView === 'banner'}
			<div class="conflict-banner" role="alert">
				<div class="conflict-banner-icon" aria-hidden="true">
					<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
						<path d="M7 1L13 12H1L7 1Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
						<path d="M7 5v3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
						<circle cx="7" cy="10.5" r="0.6" fill="currentColor"/>
					</svg>
				</div>
				<div class="conflict-banner-text">
					<span class="conflict-banner-title">Sync conflict</span>
					<span class="conflict-banner-desc">
						This note was edited on another device while you were offline.
					</span>
				</div>
				<div class="conflict-banner-actions">
					<button class="conflict-btn-resolve" onclick={() => (conflictView = 'diff')}>
						Resolve
					</button>
					<button class="conflict-btn-dismiss" onclick={() => handleResolveConflict('local')} title="Keep your version and discard server version">
						Keep mine
					</button>
				</div>
			</div>
		{:else}
			<!-- Full diff view -->
			<div class="conflict-diff">
				<div class="conflict-diff-header">
					<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
						<path d="M7 1L13 12H1L7 1Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
						<path d="M7 5v3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
						<circle cx="7" cy="10.5" r="0.6" fill="currentColor"/>
					</svg>
					<span>Resolve sync conflict</span>
					<button class="conflict-diff-close" onclick={() => (conflictView = 'banner')} aria-label="Collapse conflict view">
						<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
							<path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
						</svg>
					</button>
				</div>

				<div class="conflict-versions">
					<!-- Your version -->
					<div class="conflict-version conflict-version-local">
						<div class="conflict-version-label">
							Your version
							<span class="conflict-version-time">
								{relativeTime(conflict.localUpdatedAt)}
							</span>
						</div>
						<div class="conflict-version-title">{conflict.localTitle || '(no title)'}</div>
						<!-- eslint-disable-next-line svelte/no-at-html-tags -->
						<div class="conflict-version-body">{@html conflict.localBody || '<em>(empty)</em>'}</div>
						<button
							class="conflict-pick-btn"
							onclick={() => handleResolveConflict('local')}
							disabled={conflictResolving}
						>
							Use this version
						</button>
					</div>

					<!-- Server version -->
					<div class="conflict-version conflict-version-server">
						<div class="conflict-version-label">
							Server version
							<span class="conflict-version-time">
								{relativeTime(conflict.serverUpdatedAt)}
							</span>
						</div>
						<div class="conflict-version-title">{conflict.serverTitle || '(no title)'}</div>
						<!-- eslint-disable-next-line svelte/no-at-html-tags -->
						<div class="conflict-version-body">{@html conflict.serverBody || '<em>(empty)</em>'}</div>
						<button
							class="conflict-pick-btn"
							onclick={() => handleResolveConflict('server')}
							disabled={conflictResolving}
						>
							Use this version
						</button>
					</div>
				</div>

				<!-- Manual merge -->
				<div class="conflict-merge">
					<div class="conflict-merge-label">Or write a custom merge:</div>
					<input
						class="conflict-merge-title"
						type="text"
						placeholder="Title"
						bind:value={mergeTitle}
						oninput={() => (mergeDirty = true)}
					/>
					<div
						class="conflict-merge-body"
						contenteditable="true"
						role="textbox"
						aria-label="Merge body"
						aria-multiline="true"
						data-placeholder="Merge content…"
						oninput={(e) => { mergeBody = (e.currentTarget as HTMLElement).innerHTML; mergeDirty = true; }}
					></div>
					<button
						class="conflict-pick-btn conflict-pick-btn-merge"
						onclick={() => handleResolveConflict('merge')}
						disabled={conflictResolving || !mergeDirty}
					>
						{conflictResolving ? 'Saving…' : 'Save merged version'}
					</button>
				</div>
			</div>
		{/if}
	{/if}

	<!-- ── Formatting toolbar ──────────────────────────────────── -->
	<div class="format-bar" role="toolbar" aria-label="Text formatting">
		<!-- Undo / Redo -->
		<button class="fmt-btn" onclick={() => exec('undo')} title="Undo" aria-label="Undo">
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
				<path d="M2 5H8a4 4 0 1 1 0 8H4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
				<path d="M4 2L1.5 5 4 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
		</button>
		<button class="fmt-btn" onclick={() => exec('redo')} title="Redo" aria-label="Redo">
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
				<path d="M12 5H6a4 4 0 1 0 0 8h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
				<path d="M10 2l2.5 3L10 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
		</button>

		<div class="fmt-divider"></div>

		<!-- Bold -->
		<button class="fmt-btn" class:active={isBold}
			onclick={() => exec('bold')} title="Bold" aria-label="Bold" aria-pressed={isBold}>
			<svg width="13" height="14" viewBox="0 0 13 14" fill="none">
				<path d="M3 2h5a3 3 0 0 1 0 6H3V2zM3 8h5.5a3.5 3.5 0 0 1 0 7H3V8z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
			</svg>
		</button>
		<!-- Italic -->
		<button class="fmt-btn" class:active={isItalic}
			onclick={() => exec('italic')} title="Italic" aria-label="Italic" aria-pressed={isItalic}>
			<svg width="11" height="14" viewBox="0 0 11 14" fill="none">
				<path d="M4 2h6M1 12h6M7 2L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
			</svg>
		</button>
		<!-- Underline -->
		<button class="fmt-btn" class:active={isUnderline}
			onclick={() => exec('underline')} title="Underline" aria-label="Underline" aria-pressed={isUnderline}>
			<svg width="13" height="15" viewBox="0 0 13 15" fill="none">
				<path d="M2 2v5a4.5 4.5 0 0 0 9 0V2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
				<line x1="1" y1="14" x2="12" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
			</svg>
		</button>
		<!-- Strikethrough -->
		<button class="fmt-btn" class:active={isStrike}
			onclick={() => exec('strikeThrough')} title="Strikethrough" aria-label="Strikethrough" aria-pressed={isStrike}>
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
				<path d="M1 7h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
				<path d="M4 4c0-1.1.9-2 2-2h2a2 2 0 0 1 0 4H5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
				<path d="M6 7c.5 0 3 .5 3 2.5a2 2 0 0 1-2 2H4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
		</button>

		<div class="fmt-divider"></div>

		<!-- Bullet list -->
		<button class="fmt-btn" class:active={isUL}
			onclick={() => exec('insertUnorderedList')} title="Bullet list" aria-label="Bullet list" aria-pressed={isUL}>
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
				<circle cx="2" cy="4" r="1" fill="currentColor"/>
				<circle cx="2" cy="7" r="1" fill="currentColor"/>
				<circle cx="2" cy="10" r="1" fill="currentColor"/>
				<path d="M5 4h8M5 7h8M5 10h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
			</svg>
		</button>
		<!-- Ordered list -->
		<button class="fmt-btn" class:active={isOL}
			onclick={() => exec('insertOrderedList')} title="Numbered list" aria-label="Numbered list" aria-pressed={isOL}>
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
				<path d="M1.5 2v3M1 5h1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
				<path d="M1 8.5h1.5L1 10h1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
				<path d="M5 3.5h8M5 7h8M5 10.5h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
			</svg>
		</button>

		<div class="fmt-divider"></div>

		<!-- Font size — custom pixel picker -->
		<div class="fontsize-wrap">
			<button
				class="fmt-btn fontsize-btn"
				bind:this={fontsizeBtnEl}
				onmousedown={(e) => {
					e.preventDefault(); // keep editor focus
					showFontSizePicker = !showFontSizePicker;
					showColorPicker = false;
				}}
				title="Font size"
				aria-label="Font size"
				aria-expanded={showFontSizePicker}
			>
				<span class="fontsize-label">{currentFontSize ? currentFontSize + 'px' : 'Size'}</span>
				<svg width="8" height="5" viewBox="0 0 8 5" fill="none" aria-hidden="true">
					<path d="M1 1l3 3 3-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</button>

			{#if showFontSizePicker}
				<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
				<div class="fontsize-backdrop" onclick={() => (showFontSizePicker = false)}></div>
				<div class="fontsize-panel" bind:this={fontsizePanelEl} role="listbox" aria-label="Font size options">
					{#each fontSizeOptions as sz}
						<button
							class="fontsize-option"
							class:active={currentFontSize === String(sz)}
							role="option"
							aria-selected={currentFontSize === String(sz)}
							onmousedown={(e) => {
								e.preventDefault();
								execFontSize(sz + 'px');
								showFontSizePicker = false;
							}}
						>{sz}</button>
					{/each}
				</div>
			{/if}
		</div>

		<div class="fmt-divider"></div>

		<!-- Text color -->
		<div class="color-wrap">
			<button
				class="fmt-btn color-btn"
				bind:this={colorBtnEl}
				onmousedown={(e) => {
					e.preventDefault();
					showColorPicker = !showColorPicker;
					showFontSizePicker = false;
				}}
				title="Text color"
				aria-label="Text color"
				aria-expanded={showColorPicker}
			>
				<svg width="13" height="14" viewBox="0 0 13 14" fill="none">
					<path d="M2 11.5L6.5 2 11 11.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
					<path d="M3.5 8.5h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
				</svg>
				<span class="color-preview" style="background: {customColor}"></span>
			</button>

			{#if showColorPicker}
				<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
				<div class="color-backdrop" onclick={() => (showColorPicker = false)}></div>
				<div class="color-panel" bind:this={colorPanelEl} role="dialog" aria-label="Text color picker">
					<div class="color-swatches">
						{#each textColors as c}
							<button
								class="color-swatch"
								style="background: {c}"
								onmousedown={(e) => { e.preventDefault(); applyColor(c); }}
								aria-label="Color {c}"
							></button>
						{/each}
					</div>
					<div class="color-custom-row">
						<input type="color" class="color-input-native" bind:value={customColor}
							onchange={() => applyColor(customColor)} title="Custom color" />
						<span class="color-custom-label">Custom</span>
					</div>
				</div>
			{/if}
		</div>

		<div class="fmt-divider"></div>

		<!-- Clear formatting -->
		<button class="fmt-btn" onmousedown={(e) => { e.preventDefault(); clearFormatting(); }} title="Clear formatting" aria-label="Clear formatting">
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
				<path d="M2 3h10M4.5 3l1 8M9.5 3l-1 8M6 7h2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
				<path d="M10 11l3 3M13 11l-3 3" stroke="var(--danger)" stroke-width="1.3" stroke-linecap="round"/>
			</svg>
		</button>
	</div>

	<!-- ── Editable body ────────────────────────────────────────── -->
	<div
		class="body-editor"
		contenteditable="true"
		bind:this={bodyEl}
		oninput={handleBodyInput}
		onkeyup={updateFormatState}
		onmouseup={updateFormatState}
		ontouchend={updateFormatState}
		onselectionchange={updateFormatState}
		onfocus={onEditorFocus}
		onblur={onEditorBlur}
		onpaste={handlePaste}
		data-placeholder="Start writing…"
		spellcheck="true"
		role="textbox"
		aria-label="Note body"
		aria-multiline="true"
	></div>
</div>

<!-- ── Topics side drawer ─────────────────────────────────────── -->
{#if drawerOpen}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="drawer-backdrop" onclick={() => (drawerOpen = false)}></div>
{/if}

<!-- Mirrors +page.svelte <aside class="topics-panel"> exactly.
     Topic clicks navigate to /?topic=<id> (note editor → list).
     The topic of the current note gets an accent border highlight. -->
<aside
	class="topics-drawer"
	class:open={drawerOpen}
	aria-label="Topics and folders"
	role="navigation"
>
	<div class="topics-header">
		<span class="label">Topics</span>
		<div class="header-actions">
			<button class="btn-icon" onclick={() => { editingFolder = null; folderName = ''; folderParentId = null; showFolderEditor = true; }} title="New folder" aria-label="New folder">
				<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
					<path d="M1 3a1 1 0 0 1 1-1h2.5l1 1H10a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3z" stroke="currentColor" stroke-width="1.2"/>
					<path d="M6 5v4M4 7h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
				</svg>
			</button>
			<button class="btn-icon" onclick={() => { showTopicEditor = true; editingTopic = null; topicName = ''; topicColor = '#6b8afd'; topicFolderId = null; }} title="New topic" aria-label="New topic">
				<svg width="13" height="13" viewBox="0 0 13 13" fill="none">
					<path d="M6.5 1v11M1 6.5h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
				</svg>
			</button>
			<button class="btn-icon" onclick={() => (drawerOpen = false)} aria-label="Close">
				<svg width="13" height="13" viewBox="0 0 13 13" fill="none">
					<path d="M1.5 1.5l10 10M11.5 1.5l-10 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
				</svg>
			</button>
		</div>
	</div>

	<nav class="topic-list">
		<button
			class="topic-item topic-item-all"
			onclick={() => goToTopic('all')}
		>
			<span class="topic-dot" style="background: var(--text-faint)"></span>
			<span class="topic-name">All notes</span>
			<span class="topic-count">{allNotes.length}</span>
		</button>

		<button
			class="topic-item"
			onclick={() => goToTopic(null)}
		>
			<span class="topic-dot topic-dot-uncategorised"></span>
			<span class="topic-name">Uncategorised</span>
			<span class="topic-count">{allNotes.filter(n => !n.topicId).length}</span>
		</button>

		{#if allTopics.length > 0 || allFolders.length > 0}
			<div class="topic-separator"></div>
		{/if}

		{#each childFolders(null) as folder (folder.id)}
			{@render drawerFolderRow(folder, 0)}
		{/each}
		{#each topicsInFolder(null) as topic (topic.id)}
			{@render drawerTopicRow(topic, 0)}
		{/each}
	</nav>

	<!-- Panel footer: user + status dot (same as +page.svelte mobile drawer) -->
	<div class="panel-footer">
		<button class="btn-ghost panel-user" onclick={() => {}}>
			<span class="panel-user-avatar" aria-hidden="true">{(auth.username ?? 'A')[0].toUpperCase()}</span>
			<span class="panel-user-name">{auth.username ?? 'Account'}</span>
		</button>
		{#if serverStatus.value !== 'unknown'}
			<span class="panel-srv-dot panel-srv-dot-{serverStatus.value}" title={serverStatus.value === 'online' ? 'Server online' : serverStatus.value === 'offline' ? 'Server unreachable' : 'Checking…'}></span>
		{/if}
	</div>
</aside>

<!-- ── Drawer folder snippet (mirrors +page.svelte folderRow) ─── -->
{#snippet drawerFolderRow(folder: Folder, depth = 0)}
	<div class="folder-row">
		<div
			class="folder-item"
			data-folder-id={folder.id}
			style="padding-left: {10 + depth * 14}px"
		>
			<button
				class="folder-chevron"
				class:collapsed={folder.collapsed}
				onclick={() => toggleFolderCollapsed(folder.id)}
				aria-label={folder.collapsed ? 'Expand folder' : 'Collapse folder'}
			>
				<svg width="10" height="10" viewBox="0 0 10 10" fill="none">
					<path d="M2 3.5L5 6.5 8 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</button>
			<svg class="folder-icon" width="13" height="12" viewBox="0 0 13 12" fill="none">
				<path d="M1 3a1 1 0 0 1 1-1h2.5l1 1H11a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3z" stroke="currentColor" stroke-width="1.2"/>
			</svg>
			<span class="folder-name">{folder.name}</span>
			<div class="folder-actions">
				<button class="btn-icon folder-action-btn" onclick={() => { showTopicEditor = true; editingTopic = null; topicName = ''; topicColor = '#6b8afd'; topicFolderId = folder.id; }} title="New topic" aria-label="New topic">
					<svg width="10" height="10" viewBox="0 0 10 10" fill="none">
						<path d="M5 1v8M1 5h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
					</svg>
				</button>
				<button class="btn-icon folder-action-btn" onclick={() => openEditFolder(folder)} title="Edit folder" aria-label="Edit folder">
					<svg width="10" height="10" viewBox="0 0 10 10" fill="none">
						<path d="M6 1.5l2.5 2.5-5 5H1v-2.5l5-5z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>
					</svg>
				</button>
			</div>
		</div>
		{#if !folder.collapsed}
			{#each childFolders(folder.id) as child (child.id)}
				{@render drawerFolderRow(child, depth + 1)}
			{/each}
			{#each topicsInFolder(folder.id) as topic (topic.id)}
				{@render drawerTopicRow(topic, depth + 1)}
			{/each}
		{/if}
	</div>
{/snippet}

<!-- ── Drawer topic snippet (mirrors +page.svelte topicRow) ───── -->
{#snippet drawerTopicRow(topic: Topic, depth = 0)}
	<div
		class="topic-row"
		class:current-topic={topic.id === activeTopicId}
	>
		<button
			class="topic-item"
			data-topic-id={topic.id}
			style="padding-left: {14 + depth * 14}px"
			onclick={() => goToTopic(topic.id)}
		>
			<span class="topic-dot" style="background: {topic.color}"></span>
			<span class="topic-name">{topic.name}</span>
			<span class="topic-count">{noteCountForTopic(topic.id)}</span>
		</button>
		<button class="btn-icon topic-edit-btn" onclick={() => openEditTopic(topic)} aria-label="Edit topic">
			<svg width="11" height="11" viewBox="0 0 11 11" fill="none">
				<path d="M7.5 1.5l2 2-6 6H1.5v-2l6-6z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
			</svg>
		</button>
	</div>
{/snippet}

<!-- ── Topic editor modal ─────────────────────────────────────── -->
{#if showTopicEditor}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="modal-backdrop" onclick={() => (showTopicEditor = false)}></div>
	<div class="modal" role="dialog" aria-modal="true" aria-label="Edit topic">
		<h3 class="modal-title">{editingTopic ? 'Edit topic' : 'New topic'}</h3>
		<div class="modal-field">
			<label class="field-label" for="topic-name-e">Name</label>
			<input id="topic-name-e" type="text" bind:value={topicName} placeholder="Topic name" autocorrect="off" autocapitalize="words" />
		</div>
		<div class="modal-field">
			<label class="field-label" for="topic-color-e">Color</label>
			<div class="color-row">
				{#each ['#6b8afd','#4caf87','#e0a45c','#e05c5c','#c084fc','#38bdf8','#f472b6','#a3e635'] as c}
					<button class="color-swatch-sm" class:selected={topicColor === c} style="background:{c}"
						onclick={() => (topicColor = c)} aria-label="Color {c}"></button>
				{/each}
				<input type="color" class="color-picker-input" bind:value={topicColor} title="Custom color" />
			</div>
		</div>
		<div class="modal-actions">
			{#if editingTopic}
				<button class="btn-danger" onclick={() => handleDeleteTopic(editingTopic!.id)}>Delete</button>
			{/if}
			<button class="btn-ghost" onclick={() => (showTopicEditor = false)}>Cancel</button>
			<button class="btn-primary modal-save" onclick={saveTopicModal} disabled={!topicName.trim()}>
				{editingTopic ? 'Save' : 'Create'}
			</button>
		</div>
	</div>
{/if}

<!-- ── Folder editor modal ─────────────────────────────────────── -->
{#if showFolderEditor}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="modal-backdrop" onclick={() => (showFolderEditor = false)}></div>
	<div class="modal" role="dialog" aria-modal="true" aria-label="Edit folder">
		<h3 class="modal-title">{editingFolder ? 'Edit folder' : 'New folder'}</h3>
		<div class="modal-field">
			<label class="field-label" for="folder-name-e">Name</label>
			<input id="folder-name-e" type="text" bind:value={folderName} placeholder="Folder name" autocorrect="off" autocapitalize="words" />
		</div>
		<div class="modal-field">
			<label class="field-label" for="folder-parent-e">Parent folder</label>
			<select id="folder-parent-e" bind:value={folderParentId}>
				<option value={null}>— Root (no parent) —</option>
				{#each allFolders.filter(f => f.id !== editingFolder?.id) as f (f.id)}
					<option value={f.id}>{f.name}</option>
				{/each}
			</select>
		</div>
		<div class="modal-actions">
			{#if editingFolder}
				<button class="btn-danger" onclick={() => { deleteFolder(editingFolder!.id); showFolderEditor = false; }}>Delete</button>
			{/if}
			<button class="btn-ghost" onclick={() => (showFolderEditor = false)}>Cancel</button>
			<button class="btn-primary modal-save" onclick={saveFolderModal} disabled={!folderName.trim()}>
				{editingFolder ? 'Save' : 'Create'}
			</button>
		</div>
	</div>
{/if}

<style>
	.editor-page {
		display: flex;
		flex-direction: column;
		height: 100%;
		/* overflow: hidden; */ /*cagan - 3-14-26 3:33*/
	}

	/* ── Visibility helpers ────────────────────────────────────── */
	.mobile-only { display: flex; }
	.desktop-only { display: none; }

	@media (min-width: 768px) {
		.mobile-only  { display: none; }
		.desktop-only { display: flex; }
	}

	/* ── Top toolbar ──────────────────────────────────────────── */
	.toolbar {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		min-height: var(--nav-h);
		padding: max(env(safe-area-inset-top, 0px), 12px) 14px 12px;
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
		background: var(--bg-elevated);
	}

	@media (min-width: 768px) {
		.toolbar {
			min-height: var(--nav-h);
			align-items: center;
			padding: 10px 14px;
		}
	}

	.back-btn, .drawer-toggle-btn {
		color: var(--text-muted);
		-webkit-tap-highlight-color: transparent;
	}

	.toolbar-actions {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.unsaved-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
	}

	.save-btn {
		font-size: 13px;
		font-weight: 500;
		color: var(--accent);
		padding: 6px 12px;
		border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--accent) 8%, transparent);
		cursor: pointer;
		transition: background 0.15s ease;
	}

	.save-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 16%, transparent); }

	.save-btn:disabled {
		color: var(--text-faint);
		border-color: transparent;
		background: transparent;
		opacity: 1;
		cursor: default;
	}

	.delete-btn { color: var(--text-faint); }
	.delete-btn:hover {
		color: var(--danger);
		background: color-mix(in srgb, var(--danger) 10%, transparent);
	}

	.btn-danger-sm {
		font-size: 12px;
		font-weight: 500;
		color: var(--danger);
		padding: 5px 10px;
		border: 1px solid var(--danger);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--danger) 8%, transparent);
		cursor: pointer;
	}

	/* ── Title ────────────────────────────────────────────────── */
	.title-input {
		border: none;
		background: transparent;
		font-size: 20px;
		font-weight: 600;
		color: var(--text);
		padding: 16px 20px 10px;
		letter-spacing: -0.01em;
		border-radius: 0;
		box-shadow: none;
		flex-shrink: 0;
	}

	.title-input:focus { border: none; box-shadow: none; }
	.title-input::placeholder { color: var(--text-faint); font-weight: 400; }

	/* ── Conflict banner ──────────────────────────────────────── */
	.conflict-banner {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		margin: 0 20px 12px;
		padding: 10px 14px;
		background: color-mix(in srgb, #e09a3c 12%, transparent);
		border: 1px solid color-mix(in srgb, #e09a3c 40%, transparent);
		border-radius: var(--radius-sm);
		font-size: 13px;
	}

	.conflict-banner-icon {
		color: #e09a3c;
		flex-shrink: 0;
		margin-top: 2px;
	}

	.conflict-banner-text {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.conflict-banner-title {
		font-weight: 600;
		color: #e09a3c;
		font-size: 12.5px;
	}

	.conflict-banner-desc {
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.4;
	}

	.conflict-banner-actions {
		display: flex;
		flex-direction: column;
		gap: 4px;
		flex-shrink: 0;
	}

	.conflict-btn-resolve {
		padding: 4px 10px;
		font-size: 12px;
		font-weight: 600;
		background: #e09a3c;
		color: #0f1117;
		border: none;
		border-radius: var(--radius-sm);
		cursor: pointer;
		transition: opacity 0.12s ease;
	}

	.conflict-btn-resolve:hover { opacity: 0.85; }

	.conflict-btn-dismiss {
		padding: 4px 10px;
		font-size: 12px;
		font-weight: 500;
		background: transparent;
		color: var(--text-muted);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		cursor: pointer;
		transition: color 0.12s ease, border-color 0.12s ease;
	}

	.conflict-btn-dismiss:hover {
		color: var(--text);
		border-color: var(--text-muted);
	}

	/* ── No-DEK (vault locked) banner ────────────────────────── */
	.no-dek-banner {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 16px;
		background: color-mix(in srgb, var(--text-faint) 8%, transparent);
		border-bottom: 1px solid var(--border);
		font-size: 12px;
		color: var(--text-faint);
		flex-shrink: 0;
	}

	/* ── Incoming real-time update banner ────────────────────── */
	.incoming-banner {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		margin: 0 20px 12px;
		padding: 10px 14px;
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
		border-radius: var(--radius-md);
		font-size: 13px;
	}
	.incoming-banner-icon { color: var(--accent); flex-shrink: 0; margin-top: 2px; }
	.incoming-banner-text { flex: 1; display: flex; flex-direction: column; gap: 2px; }
	.incoming-banner-title { font-weight: 600; color: var(--accent); font-size: 12.5px; }
	.incoming-banner-desc { color: var(--text-muted); font-size: 12px; line-height: 1.4; }
	.incoming-banner-actions { display: flex; flex-direction: column; gap: 4px; flex-shrink: 0; }
	.incoming-btn-accept {
		padding: 4px 10px; font-size: 12px; font-weight: 600;
		background: var(--accent); color: #0f1117; border: none;
		border-radius: var(--radius-sm); cursor: pointer; transition: opacity 0.12s;
	}
	.incoming-btn-accept:hover { opacity: 0.85; }
	.incoming-btn-dismiss {
		padding: 4px 10px; font-size: 12px; font-weight: 500;
		background: transparent; color: var(--text-muted);
		border: 1px solid var(--border); border-radius: var(--radius-sm);
		cursor: pointer; transition: color 0.12s, border-color 0.12s;
	}
	.incoming-btn-dismiss:hover { color: var(--text); border-color: var(--text-muted); }

	/* ── Conflict diff view ───────────────────────────────────── */
	.conflict-diff {
		margin: 0 20px 16px;
		border: 1px solid color-mix(in srgb, #e09a3c 40%, transparent);
		border-radius: var(--radius-sm);
		/* overflow: hidden; */
		font-size: 13px;
	}

	.conflict-diff-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 14px;
		background: color-mix(in srgb, #e09a3c 12%, transparent);
		border-bottom: 1px solid color-mix(in srgb, #e09a3c 30%, transparent);
		color: #e09a3c;
		font-weight: 600;
		font-size: 12.5px;
	}

	.conflict-diff-close {
		margin-left: auto;
		background: transparent;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		padding: 2px;
		display: flex;
		align-items: center;
	}

	.conflict-diff-close:hover { color: var(--text); }

	.conflict-versions {
		display: grid;
		grid-template-columns: 1fr 1fr;
		border-bottom: 1px solid var(--border);
	}

	@media (max-width: 600px) {
		.conflict-versions { grid-template-columns: 1fr; }
	}

	.conflict-version {
		padding: 12px 14px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.conflict-version-local {
		border-right: 1px solid var(--border);
	}

	@media (max-width: 600px) {
		.conflict-version-local {
			border-right: none;
			border-bottom: 1px solid var(--border);
		}
	}

	.conflict-version-label {
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.conflict-version-time {
		font-weight: 400;
		text-transform: none;
		letter-spacing: 0;
		color: var(--text-faint);
	}

	.conflict-version-title {
		font-weight: 600;
		font-size: 14px;
		color: var(--text);
	}

	.conflict-version-body {
		font-size: 12.5px;
		color: var(--text-muted);
		line-height: 1.5;
		max-height: 120px;
		overflow-y: auto;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.conflict-pick-btn {
		margin-top: auto;
		padding: 5px 12px;
		font-size: 12px;
		font-weight: 600;
		background: var(--bg-hover);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		cursor: pointer;
		transition: background 0.12s ease, border-color 0.12s ease;
		align-self: flex-start;
	}

	.conflict-pick-btn:hover:not(:disabled) {
		background: var(--accent);
		color: #fff;
		border-color: var(--accent);
	}

	.conflict-pick-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.conflict-merge {
		padding: 12px 14px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		background: var(--bg);
	}

	.conflict-merge-label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.conflict-merge-title {
		border: 1px solid var(--border);
		background: var(--bg-elevated);
		color: var(--text);
		padding: 6px 10px;
		border-radius: var(--radius-sm);
		font-size: 13px;
		font-family: inherit;
		outline: none;
	}

	.conflict-merge-title:focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 20%, transparent);
	}

	.conflict-merge-body {
		min-height: 80px;
		max-height: 200px;
		overflow-y: auto;
		border: 1px solid var(--border);
		background: var(--bg-elevated);
		color: var(--text);
		padding: 8px 10px;
		border-radius: var(--radius-sm);
		font-size: 13px;
		line-height: 1.5;
		outline: none;
	}

	.conflict-merge-body:focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 20%, transparent);
	}

	.conflict-merge-body:empty::before {
		content: attr(data-placeholder);
		color: var(--text-faint);
		pointer-events: none;
	}

	.conflict-pick-btn-merge {
		background: color-mix(in srgb, var(--accent) 20%, transparent);
		border-color: color-mix(in srgb, var(--accent) 40%, transparent);
		color: var(--accent);
	}

	.conflict-pick-btn-merge:hover:not(:disabled) {
		background: var(--accent);
		color: #fff;
		border-color: var(--accent);
	}

	/* ── Formatting toolbar ───────────────────────────────────── */
	.format-bar {
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 6px 14px;
		border-top: 1px solid var(--border);
		border-bottom: 1px solid var(--border);
		background: var(--bg-elevated);
		flex-shrink: 0;
		overflow-x: auto;
		scrollbar-width: none;
	}

	.format-bar::-webkit-scrollbar { display: none; }

	.fmt-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 3px;
		padding: 6px 7px;
		background: none;
		border: none;
		border-radius: var(--radius-sm);
		color: var(--text-muted);
		cursor: pointer;
		transition: background 0.1s ease, color 0.1s ease;
		flex-shrink: 0;
		-webkit-tap-highlight-color: transparent;
	}

	.fmt-btn:hover { background: var(--bg-hover); color: var(--text); }

	.fmt-btn.active {
		background: color-mix(in srgb, var(--accent) 15%, transparent);
		color: var(--accent);
	}

	.fmt-divider {
		width: 1px;
		height: 16px;
		background: var(--border);
		margin: 0 4px;
		flex-shrink: 0;
	}

	/* Font size custom picker */
	.fontsize-wrap { position: relative; flex-shrink: 0; }

	.fontsize-btn {
		gap: 4px;
		min-width: 52px;
		justify-content: space-between;
		padding: 5px 8px;
		border: 1px solid var(--border);
		background: var(--bg-hover);
		border-radius: var(--radius-sm);
		color: var(--text-muted);
	}

	.fontsize-label {
		font-size: 12px;
		font-weight: 500;
		line-height: 1;
		white-space: nowrap;
	}

	.fontsize-backdrop { position: fixed; inset: 0; z-index: 200; }

	.fontsize-panel {
		position: fixed;
		z-index: 201;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		padding: 4px 0;
		display: flex;
		flex-direction: column;
		box-shadow: 0 8px 24px rgba(0,0,0,0.5);
		max-height: 260px;
		overflow-y: auto;
		min-width: 70px;
	}

	.fontsize-option {
		padding: 6px 14px;
		text-align: left;
		font-size: 13px;
		color: var(--text-muted);
		background: none;
		border: none;
		cursor: pointer;
		transition: background 0.1s, color 0.1s;
		white-space: nowrap;
	}

	.fontsize-option:hover,
	.fontsize-option.active {
		background: var(--bg-hover);
		color: var(--text);
	}

	.fontsize-option.active { color: var(--accent); }

	/* Color picker */
	.color-wrap { position: relative; flex-shrink: 0; }
	.color-btn { gap: 4px; }

	.color-preview {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		border: 1px solid rgba(255,255,255,0.2);
		display: inline-block;
	}

	.color-backdrop { position: fixed; inset: 0; z-index: 200; }

	.color-panel {
		position: fixed;
		z-index: 201;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		padding: 10px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		box-shadow: 0 8px 24px rgba(0,0,0,0.5);
	}

	.color-swatches {
		display: grid;
		grid-template-columns: repeat(4, 22px);
		gap: 6px;
	}

	.color-swatch {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		border: 2px solid transparent;
		padding: 0;
		cursor: pointer;
		transition: transform 0.1s ease, border-color 0.1s ease;
	}

	.color-swatch:hover { transform: scale(1.2); border-color: var(--text); }

	.color-custom-row { display: flex; align-items: center; gap: 8px; }

	.color-input-native {
		width: 28px !important;
		height: 28px !important;
		padding: 0 !important;
		border-radius: 50% !important;
		border: 2px solid var(--border) !important;
		cursor: pointer;
		background: none;
		box-shadow: none !important;
		flex-shrink: 0;
	}

	.color-custom-label { font-size: 11px; color: var(--text-muted); }

	/* ── Body editor ──────────────────────────────────────────── */
	.body-editor {
		flex: 1;
		padding: 14px 20px 32px;
		font-size: 15px;
		line-height: 1.7;
		color: var(--text);
		outline: none;
		/* overflow-y: auto; */ /*cagan - 3-14-26 3:33 -- needs scroll not hidden*/
		-webkit-overflow-scrolling: touch;
		overscroll-behavior: contain;
		word-break: break-word;
	}

	.body-editor:empty::before {
		content: attr(data-placeholder);
		color: var(--text-faint);
		pointer-events: none;
	}

	.body-editor :global(ul)     { padding-left: 1.4em; list-style-type: disc; }
	.body-editor :global(ol)     { padding-left: 1.4em; list-style-type: decimal; }
	.body-editor :global(li)     { margin-bottom: 2px; }
	.body-editor :global(b), .body-editor :global(strong) { font-weight: 700; }
	.body-editor :global(i), .body-editor :global(em)     { font-style: italic; }
	.body-editor :global(u)      { text-decoration: underline; }
	.body-editor :global(strike), .body-editor :global(s) { text-decoration: line-through; }

	/* ── Topics side drawer (mirrors +page.svelte aside exactly) ── */
	.drawer-backdrop {
		position: fixed;
		inset: 0;
		z-index: 29;
		background: rgba(0,0,0,0.5);
	}

	.topics-drawer {
		position: fixed;
		top: 0;
		left: 0;
		bottom: 0;
		width: 240px;
		max-width: 80vw;
		z-index: 30;
		background: var(--bg-elevated);
		border-right: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		transform: translateX(-100%);
		transition: transform 0.22s ease;
		padding: max(20px, env(safe-area-inset-top, 14px)) 8px 0;
		gap: 4px;
	}

	.topics-drawer.open { transform: translateX(0); }

	.label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-faint);
		padding: 0 4px;
	}

	/* Topics header row */
	.topics-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 4px 8px;
		flex-shrink: 0;
	}

	.header-actions { display: flex; align-items: center; gap: 2px; }

	/* Topic list scroll area */
	.topic-list {
		display: flex;
		flex-direction: column;
		gap: 1px;
		flex: 1;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
		overscroll-behavior: contain;
	}

	.topic-separator { height: 1px; background: var(--border); margin: 6px 4px; }

	/* Topic row — highlight border when note belongs to this topic */
	.topic-row {
		display: flex;
		align-items: center;
		gap: 2px;
		border-radius: var(--radius-sm);
	}

	.topic-row.current-topic .topic-item {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		color: var(--text);
		outline: 1.5px solid var(--accent);
		outline-offset: -1px;
		border-radius: var(--radius-sm);
	}

	.topic-item {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 6px 6px 0;
		border-radius: var(--radius-sm);
		background: none;
		border: none;
		cursor: pointer;
		text-align: left;
		color: var(--text-muted);
		font-size: 13px;
		transition: background 0.12s ease, color 0.12s ease;
		min-width: 0;
		-webkit-tap-highlight-color: transparent;
	}

	.topic-item:hover { background: var(--bg-hover); color: var(--text); }

	.topic-item-all { /* same as topic-item */ }

	.topic-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
		margin-left: 4px;
	}

	.topic-dot-uncategorised {
		background: transparent !important;
		border: 1.5px dashed var(--text-faint);
	}

	.topic-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12.5px;
	}

	.topic-count { font-size: 11px; color: var(--text-faint); flex-shrink: 0; }

	.topic-edit-btn {
		opacity: 0;
		flex-shrink: 0;
		padding: 5px;
		color: var(--text-faint);
		transition: opacity 0.1s ease;
	}

	.topic-row:hover .topic-edit-btn { opacity: 1; }

	/* Folder rows */
	.folder-row {
		display: flex;
		flex-direction: column;
		border-radius: var(--radius-sm);
	}

	.folder-item {
		display: flex;
		align-items: center;
		gap: 5px;
		padding-right: 4px;
		padding-top: 5px;
		padding-bottom: 5px;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.folder-item:hover { background: var(--bg-hover); }

	.folder-chevron {
		background: none;
		border: none;
		padding: 2px;
		cursor: pointer;
		color: var(--text-faint);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		transition: transform 0.15s ease;
	}

	.folder-chevron.collapsed svg { transform: rotate(-90deg); }

	.folder-icon { color: var(--text-faint); flex-shrink: 0; }

	.folder-name {
		flex: 1;
		font-size: 12px;
		font-weight: 500;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.folder-actions {
		display: flex;
		align-items: center;
		gap: 1px;
		opacity: 0;
		transition: opacity 0.1s ease;
	}

	.folder-item:hover .folder-actions { opacity: 1; }

	.folder-action-btn { padding: 4px; color: var(--text-faint); }

	/* Panel footer: user + status dot */
	.panel-footer {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 8px 10px 10px;
		margin-top: auto;
		border-top: 1px solid var(--border);
		flex-shrink: 0;
	}

	.panel-user {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: 1;
		min-width: 0;
		padding: 6px 8px;
		border-radius: var(--radius-sm);
		text-align: left;
	}

	.panel-user-avatar {
		width: 24px;
		height: 24px;
		border-radius: 50%;
		background: var(--accent-dim);
		color: var(--accent);
		font-size: 11px;
		font-weight: 600;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.panel-user-name {
		font-size: 13px;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.panel-srv-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex-shrink: 0;
		margin-left: auto;
	}
	.panel-srv-dot-checking { background: var(--text-faint); animation: panel-srv-pulse 1s infinite; }
	.panel-srv-dot-online   { background: var(--success); }
	.panel-srv-dot-offline  { background: var(--danger); }
	@keyframes panel-srv-pulse {
		0%, 100% { opacity: 1; }
		50%       { opacity: 0.3; }
	}

	/* ── Modals ──────────────────────────────────────────────────── */
	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0,0,0,0.5);
		z-index: 100;
	}

	.modal {
		position: fixed;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		z-index: 101;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		padding: 20px;
		width: min(360px, calc(100vw - 32px));
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.modal-title { font-size: 15px; font-weight: 600; }

	.modal-field { display: flex; flex-direction: column; gap: 6px; }

	.field-label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-faint);
	}

	.color-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

	.color-swatch-sm {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		border: 2px solid transparent;
		padding: 0;
		cursor: pointer;
		transition: transform 0.1s ease, border-color 0.1s ease;
		flex-shrink: 0;
	}

	.color-swatch-sm:hover { transform: scale(1.15); }
	.color-swatch-sm.selected { border-color: var(--text); }

	.color-picker-input {
		width: 28px !important;
		height: 28px !important;
		padding: 0 !important;
		border-radius: 50% !important;
		border: 2px solid var(--border) !important;
		cursor: pointer;
		background: none;
		box-shadow: none !important;
	}

	.modal-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		justify-content: flex-end;
	}

	.modal-save { width: auto; padding: 9px 18px; }
</style>
