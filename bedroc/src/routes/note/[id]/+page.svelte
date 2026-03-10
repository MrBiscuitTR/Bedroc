<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import {
		notesMap, topicsMap, foldersMap, conflictsMap, externalUpdates,
		getNotes, getTopics, getFolders,
		createNote, createTopic, saveTopic, deleteTopic,
		createFolder, saveFolder, toggleFolderCollapsed, deleteFolder,
		moveTopic,
		saveNote, resolveConflict,
		relativeTime,
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

	// ── Real-time incoming updates ────────────────────────────────
	// When another device saves this note, externalUpdates receives the new content.
	// If editor is clean → apply silently. If dirty → show a non-blocking banner.
	let incomingUpdate = $state<ExternalUpdate | null>(null);

	$effect(() => {
		if (isNew || !noteId) return;
		const update = externalUpdates.get(noteId);
		if (!update) return;
		externalUpdates.delete(noteId); // consume immediately

		if (saved) {
			// Clean editor — apply silently
			title = update.title;
			if (bodyEl) bodyEl.innerHTML = update.body;
		} else {
			// Dirty editor — show banner; user chooses
			incomingUpdate = update;
		}
	});

	function acceptIncoming() {
		if (!incomingUpdate) return;
		title = incomingUpdate.title;
		if (bodyEl) bodyEl.innerHTML = incomingUpdate.body;
		saved = true;
		incomingUpdate = null;
	}

	function dismissIncoming() {
		// Keep local edits; discard incoming. Next save will overwrite server.
		incomingUpdate = null;
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

	async function doSave() {
		if (saved) return;
		const body = bodyEl?.innerHTML ?? '';
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
	function exec(cmd: string, value?: string) {
		bodyEl?.focus();
		document.execCommand(cmd, false, value);
		// Update state immediately after command (not waiting for keyup/mouseup)
		updateFormatState();
		saved = false;
		scheduleAutosave();
	}

	// Font size: map label → px value stored in a data attribute on the select.
	// We toggle individual size spans around the selection rather than using the
	// unreliable execCommand fontSize workaround.
	function execFontSize(px: string) {
		bodyEl?.focus();
		// Step 1: remove any existing font-size span inside the selection
		// Step 2: wrap selection in <span style="font-size:Xpx">
		document.execCommand('fontSize', false, '7');
		const markers = bodyEl.querySelectorAll('font[size="7"]');
		markers.forEach((el) => {
			const span = document.createElement('span');
			span.style.fontSize = px;
			span.innerHTML = (el as HTMLElement).innerHTML;
			el.replaceWith(span);
		});
		bodyEl.focus();
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
	// Current font size label detected from selection (empty string = mixed/unknown)
	let currentFontSize = $state('');

	function updateFormatState() {
		if (typeof document === 'undefined') return;
		isBold      = document.queryCommandState('bold');
		isItalic    = document.queryCommandState('italic');
		isUnderline = document.queryCommandState('underline');
		isStrike    = document.queryCommandState('strikeThrough');
		isUL        = document.queryCommandState('insertUnorderedList');
		isOL        = document.queryCommandState('insertOrderedList');
		// Detect font size from the focused node's computed style
		currentFontSize = detectFontSize();
	}

	function detectFontSize(): string {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) return '';
		let node: Node | null = sel.getRangeAt(0).commonAncestorContainer;
		// Walk up to find a span with an explicit font-size style
		while (node && node !== bodyEl) {
			if (node.nodeType === Node.ELEMENT_NODE) {
				const fs = (node as HTMLElement).style.fontSize;
				if (fs) {
					const match = fontSizes.find(s => s.value === fs);
					return match ? match.value : '';
				}
			}
			node = node.parentNode;
		}
		return '';
	}

	const fontSizes = [
		{ label: 'Small',   value: '12px' },
		{ label: 'Normal',  value: '15px' },
		{ label: 'Large',   value: '20px' },
		{ label: 'Heading', value: '26px' },
	];

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

	function applyColor(color: string) {
		exec('foreColor', color);
		showColorPicker = false;
	}

	// ── Delete confirm ────────────────────────────────────────────
	let confirmDelete = $state(false);

	// ── Topics side drawer (mirrors +page.svelte) ─────────────────
	let drawerOpen = $state(false);
	let drawerView = $state<'topics' | 'topicNotes'>('topics');
	let selectedDrawerTopic = $state<string | null>(null);

	let allNotes    = $derived((notesMap.size, getNotes()));
	let allTopics   = $derived((topicsMap.size, getTopics()));
	let allFolders  = $derived((foldersMap.size, getFolders()));

	// Active topic derived from the current note
	let currentNote   = $derived(isNew ? null : notesMap.get(noteId!));
	let activeTopicId = $derived(currentNote?.topicId ?? null);

	function topicsInFolder(folderId: string | null): Topic[] {
		return allTopics.filter(t => t.folderId === folderId).sort((a, b) => a.order - b.order);
	}
	function childFolders(parentId: string | null): Folder[] {
		return allFolders.filter(f => f.parentId === parentId).sort((a, b) => a.order - b.order);
	}
	function noteCountForTopic(topicId: string): number {
		return allNotes.filter(n => n.topicId === topicId).length;
	}

	/** Open a note from the drawer: save current note first, then navigate. */
	function openNoteFromDrawer(id: string) {
		if (id === noteId) { drawerOpen = false; return; }
		if (!saved) doSave();
		drawerOpen = false;
		goto(`/note/${id}`, { replaceState: false });
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

	<!-- ── Real-time incoming update banner ─────────────────────── -->
	{#if incomingUpdate}
		<div class="incoming-banner" role="alert">
			<div class="incoming-banner-icon" aria-hidden="true">
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
					<circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.3"/>
					<path d="M7 4v3.5l2 1.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</div>
			<div class="incoming-banner-text">
				<span class="incoming-banner-title">Updated on another device</span>
				<span class="incoming-banner-desc">Your unsaved changes conflict with a newer version.</span>
			</div>
			<div class="incoming-banner-actions">
				<button class="incoming-btn-accept" onclick={acceptIncoming}>Use theirs</button>
				<button class="incoming-btn-dismiss" onclick={dismissIncoming} title="Keep your edits and overwrite on next save">Keep mine</button>
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

		<!-- Font size — value reflects current selection; selecting applies it -->
		<select
			class="fmt-select"
			title="Font size"
			aria-label="Font size"
			value={currentFontSize}
			onchange={(e) => {
				const v = (e.target as HTMLSelectElement).value;
				if (v) execFontSize(v);
			}}
		>
			<option value="" disabled>Size</option>
			{#each fontSizes as fs}
				<option value={fs.value}>{fs.label}</option>
			{/each}
		</select>

		<div class="fmt-divider"></div>

		<!-- Text color -->
		<div class="color-wrap">
			<button
				class="fmt-btn color-btn"
				onclick={() => (showColorPicker = !showColorPicker)}
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
				<div class="color-panel" role="dialog" aria-label="Text color picker">
					<div class="color-swatches">
						{#each textColors as c}
							<button
								class="color-swatch"
								style="background: {c}"
								onclick={() => { customColor = c; applyColor(c); }}
								aria-label="Color {c}"
							></button>
						{/each}
					</div>
					<div class="color-custom-row">
						<input type="color" class="color-input-native" bind:value={customColor}
							oninput={() => applyColor(customColor)} title="Custom color" />
						<span class="color-custom-label">Custom</span>
					</div>
				</div>
			{/if}
		</div>
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
	<div class="drawer-backdrop" onclick={() => { drawerOpen = false; drawerView = 'topics'; selectedDrawerTopic = null; }}></div>
{/if}

<aside
	class="topics-drawer"
	class:open={drawerOpen}
	aria-label="Topics"
>
	<div class="drawer-header">
		{#if drawerView === 'topics'}
			<img src="/icons/appicon-96.png" alt="Bedroc" class="logo-icon" width="28" height="28" />
		{:else}
			<button class="btn-icon" onclick={() => { drawerView = 'topics'; selectedDrawerTopic = null; }} aria-label="Back">
				<svg width="13" height="13" viewBox="0 0 13 13" fill="none">
					<path d="M8.5 2.5L4 6.5l4.5 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</button>
			<span class="label">{allTopics.find(t => t.id === selectedDrawerTopic)?.name ?? 'Notes'}</span>
		{/if}
		<span class="logo-text">Bedroc</span>
		<button class="btn-icon" onclick={() => (drawerOpen = false)} aria-label="Close">
			<svg width="13" height="13" viewBox="0 0 13 13" fill="none">
				<path d="M1.5 1.5l10 10M11.5 1.5l-10 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
			</svg>
		</button>
	</div>

	<nav class="drawer-nav">
		{#if drawerView === 'topics'}

			<!-- Topics & folders (filesystem style) -->
			<div class="drawer-section-title">Topics</div>

			<!-- All notes + Uncategorised top items -->
			<button class="topic-item active" onclick={() => { /* visual only */ }}>
				<span class="topic-dot" style="background: var(--text-faint)"></span>
				<span class="topic-name">All notes</span>
				<span class="topic-count">{allNotes.length}</span>
			</button>
			<button class="topic-item" onclick={() => { /* visual only */ }}>
				<span class="topic-dot topic-dot-uncategorised"></span>
				<span class="topic-name">Uncategorised</span>
				<span class="topic-count">{allNotes.filter(n => !n.topicId).length}</span>
			</button>

			<div class="topic-separator"></div>

			{#each childFolders(null) as folder (folder.id)}
				{@render drawerFolderRow(folder, 0)}
			{/each}
			{#each topicsInFolder(null) as topic (topic.id)}
				{@render drawerTopicRow(topic, 0)}
			{/each}

		{:else}

			<!-- Selected topic notes -->
			{#if selectedDrawerTopic}
				<div class="drawer-section-title">Notes</div>
				{#each allNotes.filter(n => n.topicId === selectedDrawerTopic) as note (note.id)}
					<button class="drawer-note-btn indented" class:active={note.id === noteId} onclick={() => openNoteFromDrawer(note.id)}>
						<span class="drawer-note-title">{note.title || 'Untitled'}</span>
						<span class="drawer-note-time">{relativeTime(note.updatedAt)}</span>
					</button>
				{/each}
			{/if}

		{/if}
	</nav>
</aside>

<!-- ── Drawer folder snippet ───────────────────────────────────── -->
{#snippet drawerFolderRow(folder: Folder, depth = 0)}
	<div class="drawer-folder folder-row">
		<div class="folder-item" style="padding-left: {10 + depth * 14}px" draggable="true">
			<button class="drawer-folder-btn" onclick={() => toggleFolderCollapsed(folder.id)} aria-label="Collapse folder">
				<svg class="drawer-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 3.5L5 6.5 8 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"></path></svg>
				<svg class="folder-icon" width="13" height="12" viewBox="0 0 13 12" fill="none"><path d="M1 3a1 1 0 0 1 1-1h2.5l1 1H11a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3z" stroke="currentColor" stroke-width="1.2"></path></svg>
				<span class="drawer-folder-name folder-name">{formatName(folder.name)}</span>
			</button>
			<div class="folder-actions">
				<button class="btn-icon folder-action-btn" title="New topic" aria-label="New topic" onclick={() => createTopic('New topic', '#6b8afd', folder.id)}>
					<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M5 1v8M1 5h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></path></svg>
				</button>
				<button class="btn-icon folder-action-btn" title="Edit folder" aria-label="Edit folder" onclick={() => openEditFolder ? openEditFolder(folder) : null}>
					<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M6 1.5l2.5 2.5-5 5H1v-2.5l5-5z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"></path></svg>
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

<!-- ── Drawer topic snippet ────────────────────────────────────── -->
{#snippet drawerTopicRow(topic: Topic, depth = 0)}
	<div class="drawer-topic topic-row">
		<div class="topic-item" style="padding-left: {14 + depth * 14}px">
			<button class="topic-item-btn topic-select" draggable="true" onclick={() => { /* select topic visually */ }}>
				<span class="drawer-topic-dot topic-dot" style="background:{topic.color}"></span>
				<span class="drawer-topic-name topic-name">{formatName(topic.name)}</span>
				<span class="drawer-topic-count topic-count">{noteCountForTopic(topic.id)}</span>
			</button>
			<button class="btn-icon topic-edit-btn" aria-label="Edit topic" onclick={() => openEditTopic(topic)}>
				<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M7.5 1.5l2 2-6 6H1.5v-2l6-6z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"></path></svg>
			</button>
		</div>
		{#each allNotes.filter(n => n.topicId === topic.id).sort((a,b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()) as note (note.id)}
			<button class="drawer-note-btn indented" class:active={note.id === noteId} onclick={() => openNoteFromDrawer(note.id)} style="padding-left: {32 + depth * 14}px">
				<span class="drawer-note-title">{note.title || 'Untitled'}</span>
				<span class="drawer-note-time">{relativeTime(note.updatedAt)}</span>
			</button>
		{/each}
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

<style>
	.editor-page {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
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
	/* ── Real-time incoming update banner ── */
	.incoming-banner {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		margin: 0 20px 12px;
		padding: 10px 14px;
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
		border-radius: var(--radius-sm);
		font-size: 13px;
	}

	.incoming-banner-icon {
		color: var(--accent);
		flex-shrink: 0;
		margin-top: 2px;
	}

	.incoming-banner-text {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.incoming-banner-title {
		font-weight: 600;
		color: var(--accent);
		font-size: 12.5px;
	}

	.incoming-banner-desc {
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.4;
	}

	.incoming-banner-actions {
		display: flex;
		flex-direction: column;
		gap: 4px;
		flex-shrink: 0;
	}

	.incoming-btn-accept {
		padding: 4px 10px;
		font-size: 12px;
		font-weight: 600;
		background: var(--accent);
		color: #fff;
		border: none;
		border-radius: var(--radius-sm);
		cursor: pointer;
		white-space: nowrap;
	}

	.incoming-btn-accept:hover { background: var(--accent-dim); }

	.incoming-btn-dismiss {
		padding: 4px 10px;
		font-size: 12px;
		font-weight: 500;
		background: transparent;
		color: var(--text-muted);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		cursor: pointer;
		white-space: nowrap;
	}

	.incoming-btn-dismiss:hover { color: var(--text); border-color: var(--text-muted); }

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

	/* ── Conflict diff view ───────────────────────────────────── */
	.conflict-diff {
		margin: 0 20px 16px;
		border: 1px solid color-mix(in srgb, #e09a3c 40%, transparent);
		border-radius: var(--radius-sm);
		overflow: hidden;
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

	/* Font size select — shows current selection label; placeholder "Size" when mixed */
	.fmt-select {
		font-size: 11px;
		padding: 5px 6px;
		width: auto;
		min-width: 62px;
		background: var(--bg-hover);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		color: var(--text-muted);
		cursor: pointer;
		flex-shrink: 0;
		/* Prevent iOS auto-zoom on the select element */
		font-size: 16px;
	}

	/* Scale down visually while keeping font-size ≥ 16px for iOS */
	.fmt-select {
		transform-origin: left center;
		font-size: 16px;
	}

	@media (min-width: 768px) {
		.fmt-select { font-size: 12px; }
	}

	.fmt-select:focus { box-shadow: none; border-color: var(--accent); }

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

	.color-backdrop { position: fixed; inset: 0; z-index: 50; }

	.color-panel {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		z-index: 51;
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
		overflow-y: auto;
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

	/* ── Topics side drawer ───────────────────────────────────── */
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
		width: 260px;
		max-width: 82vw;
		z-index: 30;
		background: var(--bg-elevated);
		border-right: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		transform: translateX(-100%);
		transition: transform 0.22s ease;
		padding-top: max(16px, env(safe-area-inset-top, 0px));
	}

	.topics-drawer.open {
		transform: translateX(0);
	}

	.drawer-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 12px 10px;
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;

		height: 42px;
	}

	.logo-text {
		font-size: 15px;
		font-weight: 600;
		color: var(--text);
		letter-spacing: -0.01em;
	}

	.header-actions { display: flex; gap: 8px; align-items: center; }

	.drawer-nav {
		flex: 1;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
		overscroll-behavior: contain;
		padding: 8px 8px 32px;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.drawer-section-title {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--text-faint);
		padding: 8px 8px 4px;
	}

	.drawer-divider {
		height: 1px;
		background: var(--border);
		margin: 8px 4px;
	}

	/* Note button inside the drawer */
	.drawer-note-btn {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		width: 100%;
		padding: 7px 8px;
		border-radius: var(--radius-sm);
		background: none;
		border: none;
		text-align: left;
		cursor: pointer;
		color: var(--text-muted);
		font-size: 12.5px;
		transition: background 0.1s ease, color 0.1s ease;
		-webkit-tap-highlight-color: transparent;
	}

	.drawer-note-btn:hover { background: var(--bg-hover); color: var(--text); }

	.drawer-note-btn.active {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		color: var(--text);
	}

	.drawer-note-btn.indented { padding-left: 22px; }

	/* Aliases to match target classes */
	.topic-list { padding: 0 6px; }
	.topic-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 8px; border-radius: var(--radius-sm); background: none; border: none; text-align: left; cursor: pointer; color: var(--text-muted); font-size: 12.5px; }
	.topic-item:hover { background: var(--bg-hover); color: var(--text); }
	.topic-item.active { background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--text); }
	.topic-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
	.topic-name { flex: 1; font-size: 11.5px; font-weight: 600; color: var(--text); letter-spacing: 0.02em; }
	.topic-count { font-size: 10px; color: var(--text-faint); }
	.topic-separator { height: 1px; background: var(--border); margin: 8px 4px; }
	.folder-row { display: flex; flex-direction: column; gap: 2px; }
	.folder-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 2px 8px; background: none; border: none; text-align: left; cursor: pointer; color: var(--text); font-size: 12px; }
	.folder-actions { margin-left: auto; display: flex; gap: 6px; }
	.folder-action-btn { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; }
	.topic-row { display: flex; flex-direction: column; gap: 0; }
	.topic-item { display: flex; align-items: center; width: 100%; }
	.topic-item-btn { display: flex; align-items: center; gap: 7px; padding: 2px 4px; background: none; border: none; width: 100%; flex: 1; }
	.topic-edit-btn { margin-left: 8px; flex-shrink: 0; }
	.topic-name { flex: 1; min-width: 0; text-align: left; }
	.topic-count { margin-left: auto; flex-shrink: 0; color: var(--text-faint); }
	.drawer-topic .drawer-note-btn { padding-top: 4px; padding-bottom: 4px; border-radius: 6px; }
	.drawer-note-btn.indented { padding-left: 24px; }

	.drawer-note-title {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12.5px;
	}

	.drawer-note-time {
		font-size: 10px;
		color: var(--text-faint);
		flex-shrink: 0;
	}

	/* Folder rows in drawer */
	.drawer-folder { display: flex; flex-direction: column; }

	.drawer-folder-btn {
		display: flex;
		align-items: center;
		gap: 5px;
		width: 100%;
		padding: 3px 4px;
		background: none;
		border: none;
		text-align: left;
		cursor: pointer;
		color: var(--text);
		font-size: 12px;
		font-weight: 500;
		-webkit-tap-highlight-color: transparent;
	}

	.drawer-folder-btn:hover { color: var(--text); }

	.drawer-chevron { color: var(--text-faint); flex-shrink: 0; transition: transform 0.15s ease; }
	.drawer-chevron.collapsed { transform: rotate(-90deg); }
	.drawer-folder-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

	/* Topic rows in drawer */
	.drawer-topic { display: flex; flex-direction: column; }

	.drawer-topic-header {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 5px 8px 3px;
	}

	.drawer-topic-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.drawer-topic-name {
		flex: 1;
		font-size: 11.5px;
		font-weight: 600;
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		letter-spacing: 0.02em;
		text-transform: none;
	}

	.drawer-note-preview {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		color: var(--text-faint);
		font-size: 13px;
		padding-top: 2px;
		padding-bottom: 2px;
	}
	.drawer-note-preview-title { color: var(--text-faint); font-size: 13px; }
	.drawer-note-preview-time { font-size: 11px; color: var(--text-faint); }

	.drawer-topic-count {
		font-size: 10px;
		color: var(--text-faint);
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
