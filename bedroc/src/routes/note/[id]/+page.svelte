<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import {
		notesMap, topicsMap, foldersMap,
		getNotes, getTopics, getFolders,
		createNote, createTopic, saveTopic, deleteTopic,
		createFolder, saveFolder, toggleFolderCollapsed, deleteFolder,
		moveTopic,
		saveNote,
		relativeTime,
		type Topic, type Folder
	} from '$lib/stores/notes.svelte';

	// ── Note identity ─────────────────────────────────────────────
	let noteId  = $derived(page.params.id);
	let isNew   = $derived(noteId === 'new');

	// ── Load note ─────────────────────────────────────────────────
	// PLACEHOLDER: no decryption — Phase 2 will AES-GCM decrypt the body.
	let title = $state('');
	let saved = $state(true);
	let bodyEl: HTMLDivElement;

	$effect(() => {
		const n = isNew ? null : notesMap.get(noteId);
		if (n) {
			title = n.title;
			if (bodyEl && bodyEl.innerHTML !== n.body) {
				bodyEl.innerHTML = n.body;
			}
		} else if (isNew) {
			title = '';
			if (bodyEl) bodyEl.innerHTML = '';
		}
		saved = true;
	});

	// ── Autosave ──────────────────────────────────────────────────
	// PLACEHOLDER: saves to in-memory store only.
	import { autosave } from '$lib/stores/notes.svelte';

	let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

	function scheduleAutosave() {
		if (autosave.interval <= 0) return;
		if (autosaveTimer) clearTimeout(autosaveTimer);
		autosaveTimer = setTimeout(doSave, autosave.interval);
	}

	function doSave() {
		if (saved) return;
		const body = bodyEl?.innerHTML ?? '';
		if (isNew) {
			const id = createNote(null);
			const created = notesMap.get(id)!;
			saveNote({ ...created, title: dedupTitle(title.trim() || 'Untitled', null, id), body });
			saved = true;
			goto(`/note/${id}`, { replaceState: true });
		} else {
			const existing = notesMap.get(noteId);
			if (!existing) return;
			saveNote({ ...existing, title: dedupTitle(title.trim() || 'Untitled', existing.topicId, existing.id), body });
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

	function handleTitleInput() { saved = false; scheduleAutosave(); }
	function handleBodyInput()  { saved = false; scheduleAutosave(); updateFormatState(); }

	function handleSave() {
		if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
		doSave();
	}

	function handleBack() {
		if (!saved) doSave();
		goto('/');
	}

	function handleDelete() {
		if (isNew) { goto('/'); return; }
		import('$lib/stores/notes.svelte').then(({ deleteNote }) => {
			deleteNote(noteId);
			goto('/');
		});
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

	let allNotes    = $derived((notesMap.size, getNotes()));
	let allTopics   = $derived((topicsMap.size, getTopics()));
	let allFolders  = $derived((foldersMap.size, getFolders()));

	// Active topic derived from the current note
	let currentNote   = $derived(isNew ? null : notesMap.get(noteId));
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
	<div class="drawer-backdrop" onclick={() => (drawerOpen = false)}></div>
{/if}

<aside
	class="topics-drawer"
	class:open={drawerOpen}
	aria-label="Topics"
>
	<div class="drawer-header">
		<span class="label">Topics</span>
		<button class="btn-icon" onclick={() => (drawerOpen = false)} aria-label="Close">
			<svg width="13" height="13" viewBox="0 0 13 13" fill="none">
				<path d="M1.5 1.5l10 10M11.5 1.5l-10 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
			</svg>
		</button>
	</div>

	<nav class="drawer-nav">
		<!-- All notes -->
		<div class="drawer-section-title">All notes</div>
		{#each allNotes as note (note.id)}
			<button
				class="drawer-note-btn"
				class:active={note.id === noteId}
				onclick={() => openNoteFromDrawer(note.id)}
			>
				<span class="drawer-note-title">{note.title || 'Untitled'}</span>
				<span class="drawer-note-time">{relativeTime(note.updatedAt)}</span>
			</button>
		{/each}

		<!-- Topics & folders -->
		<div class="drawer-divider"></div>
		<div class="drawer-section-title">Topics</div>

		{#each childFolders(null) as folder (folder.id)}
			{@render drawerFolderRow(folder)}
		{/each}
		{#each topicsInFolder(null) as topic (topic.id)}
			{@render drawerTopicRow(topic)}
		{/each}
	</nav>
</aside>

<!-- ── Drawer folder snippet ───────────────────────────────────── -->
{#snippet drawerFolderRow(folder: Folder)}
	<div class="drawer-folder">
		<button class="drawer-folder-btn" onclick={() => toggleFolderCollapsed(folder.id)}>
			<svg class="drawer-chevron" class:collapsed={folder.collapsed} width="10" height="10" viewBox="0 0 10 10" fill="none">
				<path d="M2 3.5L5 6.5 8 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
			<svg width="12" height="11" viewBox="0 0 13 12" fill="none">
				<path d="M1 3a1 1 0 0 1 1-1h2.5l1 1H11a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3z" stroke="currentColor" stroke-width="1.2"/>
			</svg>
			<span class="drawer-folder-name">{folder.name}</span>
		</button>
		{#if !folder.collapsed}
			{#each childFolders(folder.id) as child (child.id)}
				{@render drawerFolderRow(child)}
			{/each}
			{#each topicsInFolder(folder.id) as topic (topic.id)}
				{@render drawerTopicRow(topic)}
			{/each}
		{/if}
	</div>
{/snippet}

<!-- ── Drawer topic snippet ────────────────────────────────────── -->
{#snippet drawerTopicRow(topic: Topic)}
	<div class="drawer-topic">
		<div class="drawer-topic-header">
			<span class="drawer-topic-dot" style="background:{topic.color}"></span>
			<span class="drawer-topic-name">{topic.name}</span>
			<span class="drawer-topic-count">{noteCountForTopic(topic.id)}</span>
		</div>
		{#each allNotes.filter(n => n.topicId === topic.id) as note (note.id)}
			<button
				class="drawer-note-btn indented"
				class:active={note.id === noteId}
				onclick={() => openNoteFromDrawer(note.id)}
			>
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
			min-height: unset;
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
	}

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
		padding: 6px 8px;
		background: none;
		border: none;
		text-align: left;
		cursor: pointer;
		color: var(--text-faint);
		font-size: 12px;
		font-weight: 500;
		-webkit-tap-highlight-color: transparent;
	}

	.drawer-folder-btn:hover { color: var(--text-muted); }

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
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

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
