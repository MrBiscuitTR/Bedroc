<script lang="ts">
	import {
		notesMap, topicsMap, foldersMap,
		getNotes, getTopics, getFolders,
		createNote, createTopic, saveTopic, deleteTopic,
		createFolder, saveFolder, toggleFolderCollapsed, deleteFolder,
		moveTopic, moveFolder,
		saveNote, reorderNote,
		sortModeStore,
		relativeTime,
		type Topic, type Folder, type Note, type SortMode
	} from '$lib/stores/notes.svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { auth, serverStatus } from '$lib/stores/auth.svelte.js';

	// ── Filter / navigation state ──────────────────────────────────
	let search        = $state('');
	// Honour ?topic=<id> query param set by the note editor drawer
	let activeTopicId = $state<string | null | 'all'>(page.url.searchParams.get('topic') ?? 'all');
	let lastVisitedId = $state<string | null | 'all'>('all');

	// Mobile side nav drawer
	let drawerOpen = $state(false);

	// ── Derived lists ──────────────────────────────────────────────
	let sortMode    = $derived(sortModeStore.value);
	let allNotes    = $derived((notesMap.size, getNotes(sortMode)));
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
		drawerOpen = false;
	}

	async function handleNewNote() {
		const topicId = activeTopicId === 'all' ? null : activeTopicId as string | null;
		const id = await createNote(topicId);
		goto(`/note/${id}`);
	}

	// ── Topic editor state ─────────────────────────────────────────
	let showTopicEditor = $state(false);
	let editingTopic    = $state<Topic | null>(null);
	let topicName       = $state('');
	let topicColor      = $state('#6b8afd');
	let topicFolderId   = $state<string | null>(null);

	function openNewTopic(folderId: string | null = null) {
		editingTopic = null; topicName = ''; topicColor = '#6b8afd'; topicFolderId = folderId;
		showTopicEditor = true;
	}

	function openEditTopic(topic: Topic) {
		editingTopic = topic; topicName = topic.name; topicColor = topic.color; topicFolderId = topic.folderId;
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
		editingFolder = null; folderName = ''; folderParentId = parentId;
		showFolderEditor = true;
	}

	function openEditFolder(folder: Folder) {
		editingFolder = folder; folderName = folder.name; folderParentId = folder.parentId;
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
	type DragKind = 'note' | 'topic' | 'folder';

	let dragKind    = $state<DragKind | null>(null);
	let dragId      = $state<string | null>(null);
	let dropTarget  = $state<string | null>(null);
	// 'before' = insertion line above target, 'into' = drop into target, 'after' = insertion line below
	let dropSide    = $state<'before' | 'into' | 'after' | null>(null);

	// Which zone the current drag is over: 'root' | 'topic' | 'folder' | 'note'
	let dropZone    = $state<'root' | 'topic' | 'folder' | 'note' | null>(null);

	let longPressTimer: ReturnType<typeof setTimeout> | null = null;
	let longPressActive = $state(false);
	// Track touch start position to allow small finger movement without cancelling
	let touchStartX = 0;
	let touchStartY = 0;
	const LONG_PRESS_MOVE_THRESHOLD = 8; // px — allow slight movement during press

	function startLongPress(kind: DragKind, id: string, e?: TouchEvent) {
		cancelLongPress();
		if (e?.touches?.[0]) {
			touchStartX = e.touches[0].clientX;
			touchStartY = e.touches[0].clientY;
		}
		longPressTimer = setTimeout(() => {
			longPressActive = true;
			dragKind = kind;
			dragId   = id;
			// Vibrate on activation so user knows drag mode started
			if (navigator.vibrate) navigator.vibrate(30);
			// Add touch listeners to emulate dragover on touch devices
			document.addEventListener('touchmove', onTouchMove, { passive: false });
			document.addEventListener('touchend', onTouchEnd);
		}, 400);
	}

	function resetDragState() {
		if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
		longPressActive = false;
		dragKind = null;
		dragId   = null;
		dropTarget = null; dropSide = null; dropZone = null;
		document.removeEventListener('touchmove', onTouchMove);
		document.removeEventListener('touchend', onTouchEnd);
	}

	function cancelLongPress(e?: TouchEvent) {
		// If drag is already active, document-level onTouchMove handles tracking — don't cancel here
		if (longPressActive) return;
		// Allow small movement (scroll wiggle) without cancelling the long press timer
		if (longPressTimer && e?.touches?.[0]) {
			const dx = Math.abs(e.touches[0].clientX - touchStartX);
			const dy = Math.abs(e.touches[0].clientY - touchStartY);
			if (dx < LONG_PRESS_MOVE_THRESHOLD && dy < LONG_PRESS_MOVE_THRESHOLD) return;
		}
		resetDragState();
	}

	function elementClosestClass(el: Element | null, cls: string) {
		while (el && el !== document.documentElement) {
			if (el.classList && el.classList.contains(cls)) return el as HTMLElement;
			el = el.parentElement;
		}
		return null;
	}

	function onTouchMove(e: TouchEvent) {
		if (!longPressActive || !e.touches || e.touches.length === 0) return;
		e.preventDefault();
		const t = e.touches[0];
		const el = document.elementFromPoint(t.clientX, t.clientY) as Element | null;

		// Detect "uncategorize" drop zone (All notes / Uncategorised buttons)
		const uncategorizeEl = el?.closest('[data-drop-uncategorize]') as Element | null;
		if (uncategorizeEl && dragKind === 'note') {
			dropZone = 'uncategorize';
			dropTarget = '__uncategorize__';
			dropSide = 'into';
			return;
		}

		// detect topic, folder, or note elements
		const topicEl = elementClosestClass(el, 'topic-item');
		const folderEl = elementClosestClass(el, 'folder-item');
		const noteCard = elementClosestClass(el, 'note-card');
		if (topicEl) {
			const id = topicEl.getAttribute('data-topic-id') || topicEl.getAttribute('data-id');
			if (id) {
				dropZone = 'topic';
				dropTarget = id;
				// compute side using element rect
				const rect = topicEl.getBoundingClientRect();
				const rel = (t.clientY - rect.top) / rect.height;
				if (dragKind === 'note') {
					if (rel < 0.3) dropSide = 'before';
					else if (rel > 0.7) dropSide = 'after';
					else dropSide = 'into';
				} else {
					dropSide = rel < 0.5 ? 'before' : 'after';
				}
				return;
			}
		}
		if (folderEl) {
			const id = folderEl.getAttribute('data-folder-id') || folderEl.getAttribute('data-id');
			if (id) {
				dropZone = 'folder';
				dropTarget = id;
				const rect = folderEl.getBoundingClientRect();
				const rel = (t.clientY - rect.top) / rect.height;
				if (dragKind === 'topic' || dragKind === 'folder') {
					if (rel < 0.3) dropSide = 'before';
					else if (rel > 0.7) dropSide = 'after';
					else dropSide = 'into';
				} else {
					dropSide = rel < 0.5 ? 'before' : 'after';
				}
				return;
			}
		}
		if (noteCard) {
			const li = elementClosestClass(noteCard, 'note-list') ? (noteCard.parentElement as HTMLElement) : noteCard.parentElement as HTMLElement;
			const noteId = noteCard.getAttribute('data-note-id') || noteCard.getAttribute('href')?.split('/').pop();
			if (noteId) {
				dropZone = 'note';
				dropTarget = noteId;
				const rect = (noteCard as HTMLElement).getBoundingClientRect();
				const rel = (t.clientY - rect.top) / rect.height;
				dropSide = rel < 0.5 ? 'before' : 'after';
				return;
			}
		}
		// if none matched, clear
		dropTarget = null; dropSide = null; dropZone = null;
	}

	function onTouchEnd(e?: TouchEvent) {
		// commit based on dragKind/dragId/dropZone/dropTarget/dropSide
		if (!longPressActive) return;
		if (dragKind && dragId && dropTarget) {
			if (dropZone === 'uncategorize') {
				// Drop on "All notes" or "Uncategorised" → remove topic from note
				if (dragKind === 'note') {
					const note = notesMap.get(dragId);
					if (note) saveNote({ ...note, topicId: null });
				}
			} else if (dropZone === 'topic') {
				if (dragKind === 'note') {
					const note = notesMap.get(dragId);
					if (note) saveNote({ ...note, topicId: dropTarget });
				} else if (dragKind === 'topic') {
					// reorder/move topic
					const tgt = topicsMap.get(dropTarget);
					if (tgt) {
						const newFolder = tgt.folderId ?? null;
						// compute afterId from dropSide
						const siblings = [...topicsMap.values()].filter(t => t.folderId === newFolder && t.id !== dragId).sort((a,b)=>a.order-b.order);
						const tgtIdx = siblings.findIndex(t=>t.id===dropTarget);
						let afterId: string | undefined;
						if (dropSide === 'after') afterId = dropTarget;
						else afterId = tgtIdx>0?siblings[tgtIdx-1].id:undefined;
						moveTopic(dragId, newFolder, afterId);
					}
				}
			} else if (dropZone === 'folder') {
				if (dragKind === 'topic') {
					if (dropSide === 'into') moveTopic(dragId, dropTarget);
					else {
						const tgt = foldersMap.get(dropTarget);
						if (tgt) moveTopic(dragId, tgt.parentId ?? null);
					}
				} else if (dragKind === 'folder') {
					if (dropSide === 'into') moveFolder(dragId, dropTarget);
					else {
						const tgt = foldersMap.get(dropTarget);
						if (tgt) moveFolder(dragId, tgt.parentId ?? null, dropSide === 'after' ? dropTarget : undefined);
					}
				}
			} else if (dropZone === 'note') {
				if (dragKind === 'note' && sortMode === 'custom') {
					if (dropSide === 'after') reorderNote(dragId, dropTarget);
					else {
						const sorted = [...notesMap.values()].filter(n => n.topicId === notesMap.get(dropTarget!)?.topicId).sort((a,b)=>a.customOrder-b.customOrder);
						const idx = sorted.findIndex(n=>n.id===dropTarget);
						reorderNote(dragId, idx>0?sorted[idx-1].id:null);
					}
				}
			}
		}
		resetDragState();
		onDragEnd();
	}

	function onDragStart(e: DragEvent, kind: DragKind, id: string) {
		dragKind = kind;
		dragId   = id;
		e.dataTransfer!.effectAllowed = 'move';
		e.dataTransfer!.setData('text/plain', id);
	}

	function onDragEnd() {
		dragKind = null; dragId = null; dropTarget = null; dropSide = null; dropZone = null;
	}

	/**
	 * Generic dragover handler. `side` determines the visual:
	 *  - 'into'   → full outline (note→topic, topic→folder)
	 *  - 'before' → top insertion line
	 *  - 'after'  → bottom insertion line
	 *
	 * For topic and folder rows, we split the element in half:
	 * top half = 'before', bottom half = 'after'. If the dragged
	 * kind can go "into" this target (note→topic, topic/note→folder),
	 * we use the middle third for 'into'.
	 */
	function calcSide(e: DragEvent, canDropInto: boolean): 'before' | 'into' | 'after' {
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const rel  = (e.clientY - rect.top) / rect.height;
		if (canDropInto) {
			if (rel < 0.3) return 'before';
			if (rel > 0.7) return 'after';
			return 'into';
		}
		return rel < 0.5 ? 'before' : 'after';
	}

	function onTopicDragOver(e: DragEvent, topicId: string) {
		e.preventDefault();
		e.dataTransfer!.dropEffect = 'move';
		if (dragKind === null || dragId === topicId) return;
		dropTarget = topicId;
		// note → into topic; topic → reorder (before/after)
		dropSide = calcSide(e, dragKind === 'note');
	}

	function onFolderDragOver(e: DragEvent, folderId: string) {
		e.preventDefault();
		e.dataTransfer!.dropEffect = 'move';
		if (dragKind === null || dragId === folderId) return;
		dropTarget = folderId;
		// topic or folder → can go into folder (middle) or reorder (top/bottom)
		dropSide = calcSide(e, dragKind === 'topic' || dragKind === 'folder');
	}

	function onNoteDragOver(e: DragEvent, noteId: string) {
		if (dragKind !== 'note' || sortMode !== 'custom') return;
		e.preventDefault();
		dropTarget = noteId;
		dropSide   = calcSide(e, false);
	}

	function onDragLeave(e: DragEvent) {
		const related = e.relatedTarget as Node | null;
		const current = e.currentTarget as HTMLElement;
		if (related && current.contains(related)) return;
		dropTarget = null; dropSide = null; dropZone = null;
	}

	// Generic wrapper used in the template; routes to the more specific handlers
	function onDragOver(e: DragEvent, id: string | null, zone: 'root' | 'topic' | 'folder' | 'note') {
		e.preventDefault();
		e.dataTransfer!.dropEffect = 'move';
		if (dragKind === null) return;
		dropZone = zone;
		if (zone === 'root') {
			dropTarget = 'root';
			dropSide = 'into';
			return;
		}
		if (zone === 'topic') return onTopicDragOver(e, id as string);
		if (zone === 'folder') return onFolderDragOver(e, id as string);
		if (zone === 'note') return onNoteDragOver(e, id as string);
	}

	function onDrop(e: DragEvent, id: string | null, zone: 'root' | 'topic' | 'folder' | 'note') {
		e.preventDefault();
		if (zone === 'root') return onRootDrop(e);
		if (zone === 'topic' && id) return onTopicDrop(e, id);
		if (zone === 'folder' && id) return onFolderDrop(e, id);
		if (zone === 'note' && id) return onNoteDrop(e, id);
		// fallback
		onDragEnd();
	}

	function onTopicDrop(e: DragEvent, topicId: string) {
		e.preventDefault();
		if (!dragKind || !dragId || dragId === topicId) { onDragEnd(); return; }
		if (dragKind === 'note') {
			const note = notesMap.get(dragId);
			if (note) saveNote({ ...note, topicId });
		} else if (dragKind === 'topic') {
			const src = topicsMap.get(dragId);
			const tgt = topicsMap.get(topicId);
			if (src && tgt) {
				const side = calcSide(e, false);
				// Determine target folder (we allow moving into target's folder)
				const newFolder = tgt.folderId ?? null;
				// Build ordered siblings in that folder
				const siblings = [...topicsMap.values()]
					.filter(t => t.folderId === newFolder && t.id !== dragId)
					.sort((a,b) => a.order - b.order);
				const tgtIdx = siblings.findIndex(t => t.id === topicId);
				let afterId: string | undefined;
				if (side === 'after') {
					afterId = topicId;
				} else {
					// before: insert before target → afterId is previous sibling (or undefined for start)
					afterId = tgtIdx > 0 ? siblings[tgtIdx - 1].id : undefined;
				}
				moveTopic(dragId, newFolder, afterId);
			}
		}
		onDragEnd();
	}

	function onFolderDrop(e: DragEvent, folderId: string) {
		e.preventDefault();
		if (!dragKind || !dragId || dragId === folderId) { onDragEnd(); return; }
		const side = calcSide(e, dragKind === 'topic' || dragKind === 'folder');
		if (dragKind === 'topic') {
			if (side === 'into') {
				moveTopic(dragId, folderId);
			} else {
				// Reorder topic relative to this folder's position in parent — treat as same-level
				const tgt = foldersMap.get(folderId);
				const src = topicsMap.get(dragId);
				if (src && tgt) moveTopic(dragId, tgt.parentId ?? null);
			}
		} else if (dragKind === 'folder') {
			if (side === 'into') {
				moveFolder(dragId, folderId);
			} else {
				const tgt = foldersMap.get(folderId);
				if (tgt) moveFolder(dragId, tgt.parentId ?? null, side === 'after' ? folderId : undefined);
			}
		} else if (dragKind === 'note') {
			// Drop note into folder = move to uncategorised (no-op, ignore)
		}
		onDragEnd();
	}

	function onNoteDrop(e: DragEvent, noteId: string) {
		e.preventDefault();
		if (dragKind !== 'note' || !dragId || dragId === noteId || sortMode !== 'custom') { onDragEnd(); return; }
		const side = calcSide(e, false);
		// 'before' = insert before noteId means afterId is the one before it — simpler: reorderNote puts AFTER afterId
		// So 'after' → afterId = noteId, 'before' → afterId = null (find previous)
		if (side === 'after') {
			reorderNote(dragId, noteId);
		} else {
			// Find the note just before noteId in sorted list
			const sorted = [...notesMap.values()]
				.filter(n => n.topicId === notesMap.get(noteId)?.topicId)
				.sort((a, b) => a.customOrder - b.customOrder);
			const idx = sorted.findIndex(n => n.id === noteId);
			reorderNote(dragId, idx > 0 ? sorted[idx - 1].id : null);
		}
		onDragEnd();
	}

	function onRootDrop(e: DragEvent) {
		e.preventDefault();
		if (!dragKind || !dragId) { onDragEnd(); return; }
		if (dragKind === 'note') {
			const note = notesMap.get(dragId);
			if (note) saveNote({ ...note, topicId: null });
		} else if (dragKind === 'topic') {
			moveTopic(dragId, null);
		} else if (dragKind === 'folder') {
			moveFolder(dragId, null);
		}
		onDragEnd();
	}

	// ── Helpers ────────────────────────────────────────────────────
	function stripHtml(html: string): string {
		return html
			.replace(/<[^>]+>/g, ' ')         // strip tags
			.replace(/&nbsp;/gi, ' ')          // decode non-breaking space
			.replace(/&amp;/gi, '&')
			.replace(/&lt;/gi, '<')
			.replace(/&gt;/gi, '>')
			.replace(/&quot;/gi, '"')
			.replace(/&#39;/gi, "'")
			.replace(/\s+/g, ' ')
			.trim();
	}

	function topicsInFolder(folderId: string | null): Topic[] {
		return allTopics.filter(t => t.folderId === folderId).sort((a, b) => a.order - b.order);
	}

	function childFolders(parentId: string | null): Folder[] {
		return allFolders.filter(f => f.parentId === parentId).sort((a, b) => a.order - b.order);
	}

	function noteCountForTopic(topicId: string): number {
		return allNotes.filter(n => n.topicId === topicId).length;
	}
</script>

<svelte:head>
	<title>Notes — Bedroc</title>
</svelte:head>

<div class="page" class:long-press-active={longPressActive}>
	<!-- ── Left panel: folders + topics ────────────────────────── -->
	<aside
		class="topics-panel"
		class:drawer-open={drawerOpen}
		ondragover={(e) => e.preventDefault()}
		ondrop={onRootDrop}
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
				<button class="btn-icon drawer-close-btn" onclick={() => (drawerOpen = false)} aria-label="Close">
					<svg width="13" height="13" viewBox="0 0 13 13" fill="none">
						<path d="M1.5 1.5l10 10M11.5 1.5l-10 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
					</svg>
				</button>
			</div>
		</div>

		<nav class="topic-list">
			<button
				class="topic-item topic-item-all"
				class:active={activeTopicId === 'all'}
				class:drop-highlight={dropZone === 'uncategorize' && dragKind === 'note'}
				data-drop-uncategorize="true"
				onclick={() => selectTopic('all')}
			>
				<span class="topic-dot" style="background: var(--text-faint)"></span>
				<span class="topic-name">All notes</span>
				<span class="topic-count">{allNotes.length}</span>
			</button>

			<button
				class="topic-item"
				class:drop-highlight={dropZone === 'uncategorize' && dragKind === 'note'}
				data-drop-uncategorize="true"
				class:active={activeTopicId === null}
				class:drop-target-topic={dropZone === 'root' && dragKind === 'note'}
				onclick={() => selectTopic(null)}
				ondragover={(e) => onDragOver(e, 'uncategorised', 'root')}
				ondrop={(e) => onDrop(e, null, 'root')}
			>
				<span class="topic-dot topic-dot-uncategorised"></span>
				<span class="topic-name">Uncategorised</span>
				<span class="topic-count">{allNotes.filter(n => !n.topicId).length}</span>
			</button>

			{#if allTopics.length > 0 || allFolders.length > 0}
				<div class="topic-separator"></div>
			{/if}

			{#each childFolders(null) as folder (folder.id)}
				{@render folderRow(folder, 0)}
			{/each}

			{#each topicsInFolder(null) as topic (topic.id)}
				{@render topicRow(topic, 0)}
			{/each}
		</nav>

		<!-- Panel footer: user info + server status dot — shown in drawer (mobile only).
		     Desktop shows this in the layout sidebar footer instead. -->
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

	<!-- ── Right panel: note list ──────────────────────────────── -->
	<div class="notes-panel">
		<!-- Header -->
		<div class="notes-header">
			<!-- <h2 class="notes-title">{panelTitle}</h2> -->
			<div class="notes-header-actions">
                <!-- ── Mobile: topics drawer toggle ─────────────────────────── -->
                <button
                    class="drawer-toggle"
                    onclick={() => (drawerOpen = true)}
                    aria-label="Open topics"
                    aria-expanded={drawerOpen}
                >
                    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
                        <rect x="2" y="3" width="6" height="12" rx="1" stroke="currentColor" stroke-width="1.4"/>
                        <path d="M11 6h5M11 9h5M11 12h5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
                    </svg>
                    <span class="drawer-toggle-label">{panelTitle}</span>
                    <svg class="drawer-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M4 3l4 3-4 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </button>

                {#if drawerOpen}
                    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                    <div class="drawer-backdrop" onclick={() => (drawerOpen = false)}></div>
                {/if}
                <div class="notes-header-right">
                    <!-- Sort mode picker -->
                    <div class="sort-wrap">
                        <!-- Recent -->
                        <button
                            class="sort-btn"
                            class:active={sortMode === 'recent'}
                            onclick={() => sortModeStore.set('recent')}
                            title="Sort by last modified"
                            aria-label="Sort by last modified"
                            aria-pressed={sortMode === 'recent'}
                        >
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                                <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.3"/>
                                <path d="M7 4v3.5l2 1.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        <!-- Alphabetical -->
                        <button
                            class="sort-btn"
                            class:active={sortMode === 'alpha'}
                            onclick={() => sortModeStore.set('alpha')}
                            title="Sort alphabetically"
                            aria-label="Sort alphabetically"
                            aria-pressed={sortMode === 'alpha'}
                        >
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                                <path d="M2 11L5.5 3 9 11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                                <path d="M3 9h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
                                <path d="M11 3v8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
                                <path d="M9.5 8.5l1.5 1.5 1.5-1.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        <!-- Custom / manual -->
                        <button
                            class="sort-btn"
                            class:active={sortMode === 'custom'}
                            onclick={() => sortModeStore.set('custom')}
                            title="Custom order (drag to reorder)"
                            aria-label="Custom order"
                            aria-pressed={sortMode === 'custom'}
                        >
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                                <path d="M2 4h10M2 7h7M2 10h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
                                <path d="M11 8.5v-3m0 0l-1.5 1.5m1.5-1.5l1.5 1.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                    </div>
                    <button class="new-btn" onclick={handleNewNote} aria-label="New note">
                        <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                            <path d="M6.5 1v11M1 6.5h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                        </svg>
                        <span>New</span>
                    </button>
                </div>
			</div>
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

		{#if sortMode === 'custom'}
			<p class="sort-hint">Drag notes to reorder</p>
		{/if}

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
					<li
						ondragover={(e) => sortMode === 'custom' ? onDragOver(e, note.id, 'note') : undefined}
						ondrop={(e) => sortMode === 'custom' ? onDrop(e, note.id, 'note') : undefined}
						ondragleave={sortMode === 'custom' ? onDragLeave : undefined}
						class:drop-target-note={dropTarget === note.id && dropZone === 'note'}
					>
						<a
							href="/note/{note.id}"
							class="note-card"
							class:dragging={dragKind === 'note' && dragId === note.id}
							draggable="true"
							ondragstart={(e) => onDragStart(e, 'note', note.id)}
							ondragend={onDragEnd}
							ontouchstart={(e) => startLongPress('note', note.id, e)}
							ontouchend={(e) => cancelLongPress(e)}
							ontouchmove={(e) => cancelLongPress(e)}
						>
							<!-- Topic tag: always shown; grey+dotted for uncategorised -->
							{#if topic}
								<span class="note-topic-tag" style="color: {topic.color}; border-color: {topic.color}40">
									<span class="note-topic-dot" style="background:{topic.color}"></span>
									{topic.name}
								</span>
							{:else}
								<span class="note-topic-tag note-topic-uncategorised">
									<span class="note-topic-dot note-topic-dot-grey"></span>
									Uncategorised
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
		class:drop-target-folder={dropTarget === folder.id && dropZone === 'folder' && (dragKind === 'topic' || dragKind === 'folder')}
	>
		<div
			class="folder-item"
			data-folder-id={folder.id}
			style="padding-left: {10 + depth * 14}px"
			draggable="true"
			ondragover={(e) => onDragOver(e, folder.id, 'folder')}
			ondrop={(e) => onDrop(e, folder.id, 'folder')}
			ondragleave={onDragLeave}
			ondragstart={(e) => onDragStart(e, 'folder', folder.id)}
			ondragend={onDragEnd}
			ontouchstart={(e) => startLongPress('folder', folder.id, e)}
			ontouchend={(e) => cancelLongPress(e)}
			ontouchmove={(e) => cancelLongPress(e)}
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
				<path d="M1 3a1 1 0 0 1 1-1h2.5l1 1H11a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3z" stroke="currentColor" stroke-width="1.2" fill="none"/>
			</svg>

			<span class="folder-name">{folder.name}</span>

			<div class="folder-actions">
				<button class="btn-icon folder-action-btn" onclick={() => openNewTopic(folder.id)} title="New topic" aria-label="New topic">
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
				{@render folderRow(child, depth + 1)}
			{/each}
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
		class:drop-target-topic={dropTarget === topic.id && dragKind === 'note'}
		class:drop-target-topic-reorder={dropTarget === topic.id && dragKind === 'topic'}
		class:drop-target-topic-reorder-before={dropTarget === topic.id && dragKind === 'topic' && dropSide === 'before'}
		class:drop-target-topic-reorder-after={dropTarget === topic.id && dragKind === 'topic' && dropSide === 'after'}
	>
		<button
			class="topic-item"
			class:active={activeTopicId === topic.id}
			data-topic-id={topic.id}
			style="padding-left: {14 + depth * 14}px"
			draggable="true"
			onclick={() => selectTopic(topic.id)}
			ondragover={(e) => onDragOver(e, topic.id, 'topic')}
			ondrop={(e) => onDrop(e, topic.id, 'topic')}
			ondragleave={onDragLeave}
			ondragstart={(e) => onDragStart(e, 'topic', topic.id)}
			ondragend={onDragEnd}
			ontouchstart={(e) => startLongPress('topic', topic.id, e)}
			ontouchend={(e) => {
				if (!longPressActive) {
					cancelLongPress();
				} else {
					cancelLongPress();
					e.preventDefault();
				}
			}}
			ontouchmove={(e) => cancelLongPress(e)}
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
					<button class="color-swatch" class:selected={topicColor === c} style="background:{c}"
						onclick={() => (topicColor = c)} aria-label="Pick color {c}"></button>
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
				<button class="btn-danger" onclick={() => { handleDeleteTopic(editingTopic!.id); showTopicEditor = false; }}>Delete</button>
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
	.page {
		display: flex;
		height: 100%;
		overflow: hidden;
		position: relative;
	}

	/* ── Mobile drawer toggle button ────────────────────────────── */
	.drawer-toggle {
		display: none;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 6px 10px;
		font-size: 12.5px;
		font-weight: 500;
		color: var(--text-muted);
		cursor: pointer;
		min-width: 0;
		max-width: 45%;
		-webkit-tap-highlight-color: transparent;
	}

	.drawer-toggle-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.drawer-chevron { flex-shrink: 0; color: var(--text-faint); }

	@media (max-width: 899px) {
		.drawer-toggle { display: flex; }
	}

	.drawer-backdrop {
		position: fixed;
		inset: 0;
		z-index: 19;
		background: rgba(0,0,0,0.5);
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
		.topics-panel {
			display: flex;
		}
		.drawer-close-btn { display: none; }
	}

	@media (max-width: 899px) {
		.topics-panel {
		display: flex;
		position: fixed;
		top: 0;
		left: 0;
		bottom: 0;
		width: 240px;
		max-width: 80vw;
		z-index: 20;
		background: var(--bg-elevated);
		border-right: 1px solid var(--border);
		transform: translateX(-100%);
		transition: transform 0.22s ease;
		padding-top: max(20px, env(safe-area-inset-top, 14px));
		}
		.topics-panel.drawer-open { transform: translateX(0); }
	}

	/* ── Split-pane container queries ──────────────────────────────
	   When the primary pane is narrower than 700px (i.e. split mode is
	   active), collapse the static topics panel to a drawer just like
	   on mobile, and show the drawer toggle button.                    */
	@container main-pane (max-width: 699px) {
		/* container-type: inline-size on .main-content traps position:fixed children,
		   so we use position:absolute here (relative to .page which is position:relative). */
		.drawer-backdrop {
			position: absolute;
		}
		.topics-panel {
			display: flex;
			position: absolute;
			top: 0;
			left: 0;
			bottom: 0;
			width: 240px;
			max-width: 80%;
			z-index: 20;
			background: var(--bg-elevated);
			border-right: 1px solid var(--border);
			transform: translateX(-100%);
			transition: transform 0.22s ease;
			padding-top: 14px;
		}
		.topics-panel.drawer-open { transform: translateX(0); }
		.drawer-toggle { display: flex; }
		.drawer-close-btn { display: flex; }
		/* Show panel footer in the drawer when in narrow split mode */
		.panel-footer { display: flex; }
	}

	/* Panel footer: user + status dot — at bottom of drawer (mobile) and desktop topics panel */
	.panel-footer {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 8px 10px 10px;
		margin-top: auto;
		border-top: 1px solid var(--border);
		flex-shrink: 0;
	}

	/* Hide on desktop when full-width — the layout sidebar footer handles it there.
	   The container query above re-shows it when in narrow split mode. */
	@media (min-width: 900px) {
		.panel-footer { display: none; }
	}
	@container main-pane (min-width: 700px) {
		.panel-footer { display: none; }
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

	.topics-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 4px 8px;
	}

	.header-actions { display: flex; align-items: center; gap: 2px; }

	.topic-list { display: flex; flex-direction: column; gap: 1px; }

	.topic-separator { height: 1px; background: var(--border); margin: 6px 4px; }

	/* ── Folder rows ───────────────────────────────────────────── */
	.folder-row {
		display: flex;
		flex-direction: column;
		border-radius: var(--radius-sm);
		transition: background 0.1s ease;
	}

	/* Folder: dragging a topic/note INTO this folder — full accent outline on header row */
	.folder-row.drop-target-folder > .folder-item {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		border-radius: var(--radius-sm);
		outline: 1.5px solid var(--accent);
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
	.folder-item:hover { background: var(--bg-hover); border-radius: var(--radius-sm); }

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

	/* ── Topic rows ────────────────────────────────────────────── */
	.topic-row {
		display: flex;
		align-items: center;
		gap: 2px;
		border-radius: var(--radius-sm);
		transition: background 0.1s ease;
	}

	/* Note-over-topic: full accent outline to signal "drop note into this topic" */
	.topic-row.drop-target-topic .topic-item {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		color: var(--text);
		outline: 1.5px solid var(--accent);
		outline-offset: -1px;
		border-radius: var(--radius-sm);
	}

	/* Topic-over-topic reorder: bottom insertion line shows where it will land */
	.topic-row.drop-target-topic-reorder {
		border-radius: 0;
	}

	/* Topic reorder insertion lines: show top or bottom depending on side */
	.topic-row.drop-target-topic-reorder-before { border-top: 2px solid var(--accent); }
	.topic-row.drop-target-topic-reorder-after { border-bottom: 2px solid var(--accent); }

	.topic-item {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 6px 6px 0;
		border-radius: var(--radius-sm);
		background: none;
		border: none;
		cursor: grab;
		text-align: left;
		color: var(--text-muted);
		font-size: 13px;
		transition: background 0.12s ease, color 0.12s ease;
		min-width: 0;
		user-select: none;
		-webkit-tap-highlight-color: transparent;
	}

	/* Always prevent text selection when interacting with draggable items */
	.topic-item, .folder-item, .note-card {
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
	}

	.topic-item:active { cursor: grabbing; }

	.topic-item:hover { background: var(--bg-hover); color: var(--text); }

	/* When long-press dragging on touch, disable selection/drag highlights to avoid accidental text selection */
	.page.long-press-active .topic-item,
	.page.long-press-active .folder-item,
	.page.long-press-active .note-card {
		user-select: none;
		-webkit-user-select: none;
		-webkit-user-drag: none;
	}

	.topic-item.active {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		color: var(--text);
	}

	/* Highlighted when a note is dragged over the uncategorize zone */
	.topic-item.drop-highlight {
		background: color-mix(in srgb, var(--success) 14%, transparent);
		outline: 1.5px solid color-mix(in srgb, var(--success) 50%, transparent);
		color: var(--text);
	}

	.topic-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
        margin-left: 4px;
	}

	/* Uncategorised dot: grey with dashed border */
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
		padding: 18px 20px 0;
	}

	@media (max-width: 899px) {
		.notes-header { padding-top: 14px; }
	}
	@container main-pane (max-width: 699px) {
		.notes-header { padding-top: 14px; }
	}

	/* Full-width flex row: drawer toggle (shrinks) + right actions (pushes right) */
	.notes-header-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-width: 0;
	}

	.notes-header-right {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: 8px;
		margin-left: auto;
		flex-shrink: 0;
	}

	.notes-title { font-size: 16px; font-weight: 600; }

	/* ── Sort controls ─────────────────────────────────────────── */
	.sort-wrap {
		display: flex;
		align-items: center;
		gap: 1px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 4px;
	}

	.sort-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 5px 7px;
		background: none;
		border: none;
		border-radius: calc(var(--radius-sm) - 2px);
		color: var(--text-faint);
		cursor: pointer;
		transition: background 0.1s ease, color 0.1s ease;
		-webkit-tap-highlight-color: transparent;
	}

	.sort-btn:hover { color: var(--text-muted); }

	.sort-btn.active {
		background: color-mix(in srgb, var(--accent) 15%, transparent);
		color: var(--accent);
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
		flex-shrink: 0;
		-webkit-tap-highlight-color: transparent;
	}

	.new-btn:hover { background: color-mix(in srgb, var(--accent) 16%, transparent); }

	.sort-hint {
		font-size: 11px;
		color: var(--text-faint);
		padding: 4px 20px 0;
		text-align: right;
	}

	/* Search */
	.search-wrap { position: relative; padding: 12px 20px 0; }

	.search-icon {
		position: absolute;
		left: 31px;
		top: 50%;
		transform: translateY(-50%);
		color: var(--text-faint);
		pointer-events: none;
		margin-top: 6px;
	}

	.search-input { padding-left: 32px !important; background: var(--bg-elevated); }

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
		scrollbar-width: none;
		-ms-overflow-style: none;
	}
	.note-list::-webkit-scrollbar { display: none; }

	/* Custom sort: insertion line above the target note */
	.drop-target-note {
		border-top: 2px solid var(--accent);
		border-radius: 2px;
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
		-webkit-tap-highlight-color: transparent;
	}

	.note-card:active { cursor: grabbing; }

	.note-card:hover {
		background: var(--bg-hover);
		border-color: color-mix(in srgb, var(--border) 50%, var(--accent));
		text-decoration: none;
	}

	.note-card.dragging { opacity: 0.35; cursor: grabbing; }

	/* Topic tag on note card */
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

	/* Uncategorised tag: grey text, dotted border */
	.note-topic-uncategorised {
		color: var(--text-faint);
		border-color: var(--text-faint);
		border-style: dashed;
	}

	.note-topic-dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
	}

	.note-topic-dot-grey {
		background: var(--text-faint) !important;
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

	.note-time { font-size: 11px; color: var(--text-faint); flex-shrink: 0; }

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
	.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 100; }

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

	.modal-actions { display: flex; align-items: center; gap: 8px; justify-content: flex-end; }
	.modal-save { width: auto; padding: 9px 18px; }
</style>
