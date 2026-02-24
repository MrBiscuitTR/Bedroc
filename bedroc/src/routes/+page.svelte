<script lang="ts">
	import {
		notesMap, topicsMap, foldersMap,
		getNotes, getTopics, getFolders,
		createNote, createTopic, saveTopic, deleteTopic,
		createFolder, saveFolder, toggleFolderCollapsed, deleteFolder,
		moveTopic, moveFolder,
		saveNote,
		relativeTime,
		type Topic, type Folder, type Note
	} from '$lib/stores/notes.svelte';
	import { goto } from '$app/navigation';

	// ── Filter / navigation state ──────────────────────────────────
	let search        = $state('');
	let activeTopicId = $state<string | null | 'all'>('all');
	// Track the last visited topic/folder for back-button support
	let lastVisitedId = $state<string | null | 'all'>('all');

	// ── Derived lists ──────────────────────────────────────────────
	let allNotes    = $derived((notesMap.size, getNotes()));
	let allTopics   = $derived((topicsMap.size, getTopics()));
	let allFolders  = $derived((foldersMap.size, getFolders()));

	let filteredNotes = $derived((() => {
		let list = activeTopicId === 'all'
			? allNotes
			: activeTopicId === null
				? allNotes.filter(n => n.topicId === null)
				: allNotes.filter(n => n.topicId === activeTopicId);

		if (search.trim()) {
			const q = search.toLowerCase();
			list = list.filter(n =>
				n.title.toLowerCase().includes(q) ||
				n.body.replace(/<[^>]+>/g, '').toLowerCase().includes(q)
			);
		}
		return list;
	})());

	let panelTitle = $derived(
		activeTopicId === 'all' ? 'All notes'
		: activeTopicId === null ? 'Uncategorised'
		: (allTopics.find(t => t.id === activeTopicId)?.name ?? 'Notes')
	);

	// ── Handlers ──────────────────────────────────────────────────
	function selectTopic(id: string | null | 'all') {
		lastVisitedId = activeTopicId;
		activeTopicId = id;
	}

	function handleNewNote() {
		const topicId = activeTopicId === 'all' ? null : activeTopicId as string | null;
		const id = createNote(topicId);
		goto(`/note/${id}`);
	}

	// ── Topic editor state ─────────────────────────────────────────
	let showTopicEditor = $state(false);
	let editingTopic    = $state<Topic | null>(null);
	let topicName       = $state('');
	let topicColor      = $state('#6b8afd');
	let topicFolderId   = $state<string | null>(null);

	function openNewTopic(folderId: string | null = null) {
		editingTopic  = null;
		topicName     = '';
		topicColor    = '#6b8afd';
		topicFolderId = folderId;
		showTopicEditor = true;
	}

	function openEditTopic(topic: Topic) {
		editingTopic  = topic;
		topicName     = topic.name;
		topicColor    = topic.color;
		topicFolderId = topic.folderId;
		showTopicEditor = true;
	}

	function saveTopicModal() {
		if (!topicName.trim()) return;
		if (editingTopic) {
			saveTopic({ ...editingTopic, name: topicName.trim(), color: topicColor, folderId: topicFolderId });
		} else {
			createTopic(topicName.trim(), topicColor, topicFolderId);
		}
		showTopicEditor = false;
	}

	function handleDeleteTopic(id: string) {
		if (activeTopicId === id) activeTopicId = 'all';
		deleteTopic(id);
	}

	// ── Folder editor state ────────────────────────────────────────
	let showFolderEditor = $state(false);
	let editingFolder    = $state<Folder | null>(null);
	let folderName       = $state('');
	let folderParentId   = $state<string | null>(null);

	function openNewFolder(parentId: string | null = null) {
		editingFolder  = null;
		folderName     = '';
		folderParentId = parentId;
		showFolderEditor = true;
	}

	function openEditFolder(folder: Folder) {
		editingFolder  = folder;
		folderName     = folder.name;
		folderParentId = folder.parentId;
		showFolderEditor = true;
	}

	function saveFolderModal() {
		if (!folderName.trim()) return;
		if (editingFolder) {
			saveFolder({ ...editingFolder, name: folderName.trim(), parentId: folderParentId });
		} else {
			createFolder(folderName.trim(), folderParentId);
		}
		showFolderEditor = false;
	}

	// ── Drag-and-drop ──────────────────────────────────────────────
	// Unified drag state for notes, topics, and folders.

	type DragKind = 'note' | 'topic' | 'folder';

	let dragKind    = $state<DragKind | null>(null);
	let dragId      = $state<string | null>(null);
	let dropTarget  = $state<string | null>(null); // topic/folder id being hovered
	let dropZone    = $state<'topic' | 'folder' | 'root' | null>(null);

	// Long-press timer for mobile drag initiation
	let longPressTimer: ReturnType<typeof setTimeout> | null = null;
	let longPressActive = $state(false);

	function startLongPress(kind: DragKind, id: string) {
		longPressTimer = setTimeout(() => {
			longPressActive = true;
			dragKind = kind;
			dragId   = id;
		}, 500);
	}

	function cancelLongPress() {
		if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
	}

	// Desktop drag handlers (HTML5 DnD API)
	function onDragStart(e: DragEvent, kind: DragKind, id: string) {
		dragKind = kind;
		dragId   = id;
		e.dataTransfer!.effectAllowed = 'move';
		e.dataTransfer!.setData('text/plain', id);
	}

	function onDragEnd() {
		dragKind    = null;
		dragId      = null;
		dropTarget  = null;
		dropZone    = null;
	}

	function onDragOver(e: DragEvent, targetId: string, zone: 'topic' | 'folder' | 'root') {
		e.preventDefault();
		e.dataTransfer!.dropEffect = 'move';
		dropTarget = targetId;
		dropZone   = zone;
	}

	function onDragLeave() {
		dropTarget = null;
		dropZone   = null;
	}

	function onDrop(e: DragEvent, targetId: string | null, zone: 'topic' | 'folder' | 'root') {
		e.preventDefault();
		commitDrop(targetId, zone);
		onDragEnd();
	}

	function commitDrop(targetId: string | null, zone: 'topic' | 'folder' | 'root') {
		if (!dragKind || !dragId) return;

		if (dragKind === 'note') {
			// Drop note onto a topic → recategorize
			if (zone === 'topic' && targetId) {
				const note = notesMap.get(dragId);
				if (note) saveNote({ ...note, topicId: targetId });
			} else if (zone === 'root') {
				const note = notesMap.get(dragId);
				if (note) saveNote({ ...note, topicId: null });
			}
		} else if (dragKind === 'topic') {
			// Drop topic onto a folder → move into folder
			if (zone === 'folder' && targetId) {
				moveTopic(dragId, targetId);
			} else if (zone === 'root') {
				moveTopic(dragId, null);
			} else if (zone === 'topic' && targetId && targetId !== dragId) {
				// Reorder: drop after this topic (same folder)
				const src = topicsMap.get(dragId);
				const tgt = topicsMap.get(targetId);
				if (src && tgt && src.folderId === tgt.folderId) {
					moveTopic(dragId, src.folderId, targetId);
				}
			}
		} else if (dragKind === 'folder') {
			if (zone === 'folder' && targetId && targetId !== dragId) {
				moveFolder(dragId, targetId);
			} else if (zone === 'root') {
				moveFolder(dragId, null);
			} else if (zone === 'folder' && targetId && targetId !== dragId) {
				moveFolder(dragId, null, targetId);
			}
		}
	}

	// ── Helpers ────────────────────────────────────────────────────
	function stripHtml(html: string): string {
		return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
	}

	/** Topics that belong to a given folder (or are unfiled if folderId=null) */
	function topicsInFolder(folderId: string | null): Topic[] {
		return allTopics.filter(t => t.folderId === folderId).sort((a, b) => a.order - b.order);
	}

	/** Direct child folders of a given parent (or root if parentId=null) */
	function childFolders(parentId: string | null): Folder[] {
		return allFolders.filter(f => f.parentId === parentId).sort((a, b) => a.order - b.order);
	}

	function noteCountForTopic(topicId: string): number {
		return allNotes.filter(n => n.topicId === topicId).length;
	}
</script>

<svelte:head>
	<title>Notes — bedroc</title>
</svelte:head>

<div class="page">
	<!-- ── Left panel: folders + topics ────────────────────────── -->
	<aside
		class="topics-panel"
		ondragover={(e) => { e.preventDefault(); dropZone = 'root'; dropTarget = null; }}
		ondrop={(e) => onDrop(e, null, 'root')}
		ondragleave={onDragLeave}
		role="navigation"
		aria-label="Topics and folders"
	>
		<div class="topics-header">
			<span class="label">Topics</span>
			<div class="header-actions">
				<button class="btn-icon" onclick={() => openNewFolder(null)} title="New folder" aria-label="New folder">
					<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
						<path d="M1 3a1 1 0 0 1 1-1h2.5l1 1H10a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3z" stroke="currentColor" stroke-width="1.2"/>
						<path d="M6 5v4M4 7h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
					</svg>
				</button>
				<button class="btn-icon" onclick={() => openNewTopic(null)} title="New topic" aria-label="New topic">
					<svg width="13" height="13" viewBox="0 0 13 13" fill="none">
						<path d="M6.5 1v11M1 6.5h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
					</svg>
				</button>
			</div>
		</div>

		<nav class="topic-list">
			<!-- "All notes" and "Uncategorised" are always at top, not draggable -->
			<button
				class="topic-item"
				class:active={activeTopicId === 'all'}
				onclick={() => selectTopic('all')}
			>
				<span class="topic-dot" style="background: var(--text-faint)"></span>
				<span class="topic-name">All notes</span>
				<span class="topic-count">{allNotes.length}</span>
			</button>

			<button
				class="topic-item"
				class:active={activeTopicId === null}
				class:drop-target={dropZone === 'root' && dragKind === 'note'}
				onclick={() => selectTopic(null)}
				ondragover={(e) => onDragOver(e, 'uncategorised', 'root')}
				ondrop={(e) => onDrop(e, null, 'root')}
			>
				<span class="topic-dot" style="background: var(--border)"></span>
				<span class="topic-name">Uncategorised</span>
				<span class="topic-count">{allNotes.filter(n => !n.topicId).length}</span>
			</button>

			{#if allTopics.length > 0 || allFolders.length > 0}
				<div class="topic-separator"></div>
			{/if}

			<!-- Root-level folders (recursive) -->
			{#each childFolders(null) as folder (folder.id)}
				{@render folderRow(folder, 0)}
			{/each}

			<!-- Root-level (unfiled) topics -->
			{#each topicsInFolder(null) as topic (topic.id)}
				{@render topicRow(topic, 0)}
			{/each}
		</nav>
	</aside>

	<!-- ── Right panel: note list ──────────────────────────────── -->
	<div class="notes-panel">
		<!-- Header -->
		<div class="notes-header">
			<h2 class="notes-title">{panelTitle}</h2>
			<button class="new-btn" onclick={handleNewNote} aria-label="New note">
				<svg width="13" height="13" viewBox="0 0 13 13" fill="none">
					<path d="M6.5 1v11M1 6.5h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
				</svg>
				<span>New</span>
			</button>
		</div>

		<!-- Search -->
		<div class="search-wrap">
			<svg class="search-icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
				<circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.3"/>
				<path d="M10 10l2.5 2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
			</svg>
			<input
				class="search-input"
				type="search"
				placeholder="Search notes…"
				bind:value={search}
				autocorrect="off"
				autocapitalize="off"
				spellcheck="false"
			/>
		</div>

		<!-- Note list -->
		{#if filteredNotes.length === 0}
			<div class="empty">
				<svg width="36" height="36" viewBox="0 0 36 36" fill="none" opacity="0.25">
					<rect x="6" y="4" width="24" height="28" rx="3" stroke="currentColor" stroke-width="1.5"/>
					<path d="M11 12h14M11 17h10M11 22h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
				</svg>
				<p>{search ? 'No notes match your search.' : 'No notes here. Create one!'}</p>
			</div>
		{:else}
			<ul class="note-list">
				{#each filteredNotes as note (note.id)}
					{@const topic = note.topicId ? topicsMap.get(note.topicId) : null}
					<li>
						<a
							href="/note/{note.id}"
							class="note-card"
							class:dragging={dragKind === 'note' && dragId === note.id}
							draggable="true"
							ondragstart={(e) => onDragStart(e, 'note', note.id)}
							ondragend={onDragEnd}
							ontouchstart={() => startLongPress('note', note.id)}
							ontouchend={cancelLongPress}
							ontouchmove={cancelLongPress}
						>
							{#if topic}
								<span class="note-topic-tag" style="color: {topic.color}; border-color: {topic.color}20">
									<span class="note-topic-dot" style="background:{topic.color}"></span>
									{topic.name}
								</span>
							{/if}
							<div class="note-card-top">
								<span class="note-title">{note.title || 'Untitled'}</span>
								<span class="note-time">{relativeTime(note.updatedAt)}</span>
							</div>
							<p class="note-preview">{stripHtml(note.body) || 'Empty note'}</p>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>

<!-- ── Folder row snippet (recursive) ───────────────────────────── -->
{#snippet folderRow(folder: Folder, depth: number)}
	<div
		class="folder-row"
		class:drop-target={dropTarget === folder.id && (dropZone === 'folder')}
		ondragover={(e) => onDragOver(e, folder.id, 'folder')}
		ondrop={(e) => onDrop(e, folder.id, 'folder')}
		ondragleave={onDragLeave}
	>
		<div
			class="folder-item"
			style="padding-left: {10 + depth * 14}px"
			draggable="true"
			ondragstart={(e) => onDragStart(e, 'folder', folder.id)}
			ondragend={onDragEnd}
			ontouchstart={() => startLongPress('folder', folder.id)}
			ontouchend={cancelLongPress}
			ontouchmove={cancelLongPress}
		>
			<!-- Collapse toggle -->
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
				<path d="M1 3a1 1 0 0 1 1-1h2.5l1 1H11a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3z" stroke="currentColor" stroke-width="1.2" fill="none"/>
			</svg>

			<span class="folder-name">{folder.name}</span>

			<div class="folder-actions">
				<button class="btn-icon folder-action-btn" onclick={() => openNewTopic(folder.id)} title="New topic in folder" aria-label="New topic">
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
			<!-- Child folders (recursive) -->
			{#each childFolders(folder.id) as child (child.id)}
				{@render folderRow(child, depth + 1)}
			{/each}
			<!-- Topics inside this folder -->
			{#each topicsInFolder(folder.id) as topic (topic.id)}
				{@render topicRow(topic, depth + 1)}
			{/each}
		{/if}
	</div>
{/snippet}

<!-- ── Topic row snippet ─────────────────────────────────────────── -->
{#snippet topicRow(topic: Topic, depth: number)}
	<div
		class="topic-row"
		class:drop-target={dropTarget === topic.id && dragKind === 'note'}
		ondragover={(e) => onDragOver(e, topic.id, 'topic')}
		ondrop={(e) => onDrop(e, topic.id, 'topic')}
		ondragleave={onDragLeave}
	>
		<button
			class="topic-item"
			class:active={activeTopicId === topic.id}
			style="padding-left: {10 + depth * 14}px"
			draggable="true"
			onclick={() => selectTopic(topic.id)}
			ondragstart={(e) => onDragStart(e, 'topic', topic.id)}
			ondragend={onDragEnd}
			ontouchstart={() => startLongPress('topic', topic.id)}
			ontouchend={cancelLongPress}
			ontouchmove={cancelLongPress}
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

<!-- ── Topic editor modal ─────────────────────────────────────────── -->
{#if showTopicEditor}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="modal-backdrop" onclick={() => (showTopicEditor = false)}></div>
	<div class="modal" role="dialog" aria-modal="true" aria-label="Edit topic">
		<h3 class="modal-title">{editingTopic ? 'Edit topic' : 'New topic'}</h3>

		<div class="modal-field">
			<label class="field-label" for="topic-name">Name</label>
			<input id="topic-name" type="text" bind:value={topicName} placeholder="Topic name" autocorrect="off" autocapitalize="words" />
		</div>

		<div class="modal-field">
			<label class="field-label" for="topic-color">Color</label>
			<div class="color-row">
				{#each ['#6b8afd','#4caf87','#e0a45c','#e05c5c','#c084fc','#38bdf8','#f472b6','#a3e635'] as c}
					<button
						class="color-swatch"
						class:selected={topicColor === c}
						style="background:{c}"
						onclick={() => (topicColor = c)}
						aria-label="Pick color {c}"
					></button>
				{/each}
				<input type="color" class="color-picker-input" bind:value={topicColor} title="Custom color" />
			</div>
		</div>

		<div class="modal-field">
			<label class="field-label" for="topic-folder">Folder</label>
			<select id="topic-folder" bind:value={topicFolderId}>
				<option value={null}>— No folder —</option>
				{#each allFolders as f (f.id)}
					<option value={f.id}>{f.name}</option>
				{/each}
			</select>
		</div>

		<div class="modal-actions">
			{#if editingTopic}
				<button class="btn-danger" onclick={() => { handleDeleteTopic(editingTopic!.id); showTopicEditor = false; }}>
					Delete
				</button>
			{/if}
			<button class="btn-ghost" onclick={() => (showTopicEditor = false)}>Cancel</button>
			<button class="btn-primary modal-save" onclick={saveTopicModal} disabled={!topicName.trim()}>
				{editingTopic ? 'Save' : 'Create'}
			</button>
		</div>
	</div>
{/if}

<!-- ── Folder editor modal ─────────────────────────────────────────── -->
{#if showFolderEditor}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="modal-backdrop" onclick={() => (showFolderEditor = false)}></div>
	<div class="modal" role="dialog" aria-modal="true" aria-label="Edit folder">
		<h3 class="modal-title">{editingFolder ? 'Edit folder' : 'New folder'}</h3>

		<div class="modal-field">
			<label class="field-label" for="folder-name">Name</label>
			<input id="folder-name" type="text" bind:value={folderName} placeholder="Folder name" autocorrect="off" autocapitalize="words" />
		</div>

		<div class="modal-field">
			<label class="field-label" for="folder-parent">Parent folder</label>
			<select id="folder-parent" bind:value={folderParentId}>
				<option value={null}>— Root (no parent) —</option>
				{#each allFolders.filter(f => f.id !== editingFolder?.id) as f (f.id)}
					<option value={f.id}>{f.name}</option>
				{/each}
			</select>
		</div>

		<div class="modal-actions">
			{#if editingFolder}
				<button class="btn-danger" onclick={() => { deleteFolder(editingFolder!.id); showFolderEditor = false; }}>
					Delete
				</button>
			{/if}
			<button class="btn-ghost" onclick={() => (showFolderEditor = false)}>Cancel</button>
			<button class="btn-primary modal-save" onclick={saveFolderModal} disabled={!folderName.trim()}>
				{editingFolder ? 'Save' : 'Create'}
			</button>
		</div>
	</div>
{/if}

<style>
	.page {
		display: flex;
		height: 100%;
		overflow: hidden;
	}

	/* ── Topics panel ──────────────────────────────────────────── */
	.topics-panel {
		width: 200px;
		flex-shrink: 0;
		border-right: 1px solid var(--border);
		display: none;
		flex-direction: column;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
		padding: 14px 8px;
		gap: 4px;
	}

	@media (min-width: 900px) {
		.topics-panel { display: flex; }
	}

	.topics-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 4px 8px;
	}

	.header-actions {
		display: flex;
		align-items: center;
		gap: 2px;
	}

	.topic-list {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.topic-separator {
		height: 1px;
		background: var(--border);
		margin: 6px 4px;
	}

	/* ── Folder rows ───────────────────────────────────────────── */
	.folder-row {
		display: flex;
		flex-direction: column;
		border-radius: var(--radius-sm);
		transition: background 0.1s ease;
	}

	.folder-row.drop-target {
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		outline: 1px dashed color-mix(in srgb, var(--accent) 50%, transparent);
		outline-offset: -1px;
	}

	.folder-item {
		display: flex;
		align-items: center;
		gap: 5px;
		padding-right: 4px;
		padding-top: 5px;
		padding-bottom: 5px;
		border-radius: var(--radius-sm);
		cursor: grab;
		user-select: none;
	}

	.folder-item:active { cursor: grabbing; }

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

	.folder-chevron.collapsed svg {
		transform: rotate(-90deg);
	}

	.folder-icon {
		color: var(--text-faint);
		flex-shrink: 0;
	}

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

	.folder-action-btn {
		padding: 4px;
		color: var(--text-faint);
	}

	/* ── Topic rows ────────────────────────────────────────────── */
	.topic-row {
		display: flex;
		align-items: center;
		gap: 2px;
		border-radius: var(--radius-sm);
		transition: background 0.1s ease;
	}

	.topic-row.drop-target {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		outline: 1px dashed color-mix(in srgb, var(--accent) 50%, transparent);
		outline-offset: -1px;
	}

	.topic-item {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 8px;
		padding-top: 6px;
		padding-bottom: 6px;
		padding-right: 6px;
		border-radius: var(--radius-sm);
		background: none;
		border: none;
		cursor: pointer;
		text-align: left;
		color: var(--text-muted);
		font-size: 13px;
		transition: background 0.12s ease, color 0.12s ease;
		min-width: 0;
		user-select: none;
	}

	.topic-item:hover {
		background: var(--bg-hover);
		color: var(--text);
	}

	.topic-item.active {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		color: var(--text);
	}

	.topic-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.topic-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12.5px;
	}

	.topic-count {
		font-size: 11px;
		color: var(--text-faint);
		flex-shrink: 0;
	}

	.topic-edit-btn {
		opacity: 0;
		flex-shrink: 0;
		padding: 5px;
		color: var(--text-faint);
		transition: opacity 0.1s ease;
	}

	.topic-row:hover .topic-edit-btn { opacity: 1; }

	/* Drag state */
	.dragging { opacity: 0.4; }

	/* ── Notes panel ───────────────────────────────────────────── */
	.notes-panel {
		flex: 1;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		min-width: 0;
	}

	.notes-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 18px 20px 0;
	}

	.notes-title {
		font-size: 16px;
		font-weight: 600;
	}

	.new-btn {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		font-weight: 500;
		color: var(--accent);
		padding: 6px 12px;
		border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--accent) 8%, transparent);
		cursor: pointer;
		transition: background 0.15s ease;
	}

	.new-btn:hover {
		background: color-mix(in srgb, var(--accent) 16%, transparent);
	}

	/* Search */
	.search-wrap {
		position: relative;
		padding: 12px 20px 0;
	}

	.search-icon {
		position: absolute;
		left: 31px;
		top: 50%;
		transform: translateY(-50%);
		color: var(--text-faint);
		pointer-events: none;
		margin-top: 6px;
	}

	.search-input {
		padding-left: 32px !important;
		background: var(--bg-elevated);
	}

	/* Note list */
	.note-list {
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 12px 20px 32px;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
		overscroll-behavior: contain;
		flex: 1;
	}

	.note-card {
		display: flex;
		flex-direction: column;
		gap: 5px;
		padding: 12px 14px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		text-decoration: none;
		transition: background 0.12s ease, border-color 0.12s ease, opacity 0.12s ease;
		cursor: grab;
	}

	.note-card:active { cursor: grabbing; }

	.note-card:hover {
		background: var(--bg-hover);
		border-color: color-mix(in srgb, var(--border) 50%, var(--accent));
		text-decoration: none;
	}

	.note-card.dragging { opacity: 0.35; cursor: grabbing; }

	.note-topic-tag {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 10.5px;
		font-weight: 600;
		letter-spacing: 0.03em;
		border: 1px solid;
		border-radius: 999px;
		padding: 2px 8px 2px 5px;
		width: fit-content;
	}

	.note-topic-dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
	}

	.note-card-top {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}

	.note-title {
		font-size: 13.5px;
		font-weight: 500;
		color: var(--text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.note-time {
		font-size: 11px;
		color: var(--text-faint);
		flex-shrink: 0;
	}

	.note-preview {
		font-size: 12px;
		color: var(--text-muted);
		line-height: 1.5;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	/* Empty state */
	.empty {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 12px;
		color: var(--text-faint);
		text-align: center;
		padding: 40px 20px;
	}

	.empty p { font-size: 13px; }

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

	.modal-title {
		font-size: 15px;
		font-weight: 600;
	}

	.modal-field {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.field-label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-faint);
	}

	.color-row {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.color-swatch {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		border: 2px solid transparent;
		padding: 0;
		cursor: pointer;
		transition: transform 0.1s ease, border-color 0.1s ease;
		flex-shrink: 0;
	}

	.color-swatch:hover { transform: scale(1.15); }
	.color-swatch.selected { border-color: var(--text); }

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

	.modal-save {
		width: auto;
		padding: 9px 18px;
	}
</style>
