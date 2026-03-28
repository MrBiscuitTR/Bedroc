<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { onMount, onDestroy, tick } from 'svelte';
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

	// ── TipTap editor ─────────────────────────────────────────────
	import { Editor, Node, mergeAttributes, Extension } from '@tiptap/core';
	import { Plugin, TextSelection } from '@tiptap/pm/state';
	import StarterKit from '@tiptap/starter-kit';
	import { Underline } from '@tiptap/extension-underline';
	import { TextStyle, Color, FontSize } from '@tiptap/extension-text-style';
	import { TextAlign } from '@tiptap/extension-text-align';
	import { Subscript } from '@tiptap/extension-subscript';
	import { Superscript } from '@tiptap/extension-superscript';
	import { Link } from '@tiptap/extension-link';
	import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
	import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
	import { createLowlight, all } from 'lowlight';
	import { Image } from '@tiptap/extension-image';
	import { Placeholder } from '@tiptap/extension-placeholder';
	import { Highlight as HighlightBase } from '@tiptap/extension-highlight';
	import { Typography } from '@tiptap/extension-typography';
	import { TaskList } from '@tiptap/extension-task-list';
	import { TaskItem } from '@tiptap/extension-task-item';
	import { CharacterCount } from '@tiptap/extension-character-count';
	import { uploadFileAttachment, loadFileAttachment as loadAttachment, retryAttachmentUpload } from '$lib/attachments.js';

	// Highlight extension patched to emit --hl-color CSS custom property
	// instead of inline background-color so our CSS can apply color-mix transparency.
	const Highlight = HighlightBase.extend({
		addAttributes() {
			return {
				color: {
					default: null,
					parseHTML: (el) => el.style.getPropertyValue('--hl-color') || el.getAttribute('data-color') || null,
					renderHTML: (attrs) => {
						if (!attrs.color) return {};
						return { style: '--hl-color: ' + attrs.color, 'data-color': attrs.color };
					},
				},
			};
	},
});

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

	// ── Print layout (A4 page mode) ──────────────────────────────
	const LS_PRINT_LAYOUT = 'bedroc_print_layout_notes';
	function loadPrintLayoutSet(): Set<string> {
		if (typeof localStorage === 'undefined') return new Set();
		try {
			const raw = localStorage.getItem(LS_PRINT_LAYOUT);
			return raw ? new Set(JSON.parse(raw)) : new Set();
		} catch { return new Set(); }
	}
	function savePrintLayoutSet(s: Set<string>) {
		localStorage.setItem(LS_PRINT_LAYOUT, JSON.stringify([...s]));
	}
	let printLayout = $state(false);
	// Sync printLayout with noteId on navigation
	$effect(() => {
		if (noteId && noteId !== 'new') {
			printLayout = loadPrintLayoutSet().has(noteId);
		} else {
			printLayout = false;
		}
	});
	function togglePrintLayout() {
		printLayout = !printLayout;
		if (noteId && noteId !== 'new') {
			const s = loadPrintLayoutSet();
			if (printLayout) s.add(noteId); else s.delete(noteId);
			savePrintLayoutSet(s);
		}
	}
	function handlePrint() {
		if ((window as any).bedrocElectron && (window as any).bedrocElectron.print) {
			(window as any).bedrocElectron.print();
		} else {
			window.print();
		}
	}

	// ── Find / replace ───────────────────────────────────────────
	type FindMatch = { from: number; to: number };
	let showFindDialog = $state(false);
	let findQuery = $state('');
	let replaceQuery = $state('');
	let findCaseSensitive = $state(false);
	let findMatches = $state<FindMatch[]>([]);
	let activeFindIndex = $state(-1);
	let findInputEl = $state<HTMLInputElement | undefined>(undefined);

	function collectFindMatches(): FindMatch[] {
		if (!editor || !findQuery) return [];
		const q = findCaseSensitive ? findQuery : findQuery.toLowerCase();
		const qLen = findQuery.length;
		if (!qLen) return [];
		const matches: FindMatch[] = [];

		editor.state.doc.descendants((node, pos) => {
			if (!node.isText || !node.text) return;
			const hay = findCaseSensitive ? node.text : node.text.toLowerCase();
			let idx = 0;
			while (idx <= hay.length - qLen) {
				const foundAt = hay.indexOf(q, idx);
				if (foundAt === -1) break;
				// `pos` for text nodes already points to the first character.
				// Using `+1` shifts matches one character to the right.
				matches.push({ from: pos + foundAt, to: pos + foundAt + qLen });
				idx = foundAt + Math.max(1, qLen);
			}
		});

		return matches;
	}

	function selectFindMatch(index: number) {
		if (!editor || index < 0 || index >= findMatches.length) return;
		const match = findMatches[index];
		const tr = editor.state.tr
			.setSelection(TextSelection.create(editor.state.doc, match.from, match.to))
			.scrollIntoView();
		editor.view.dispatch(tr);
		editor.view.focus();
		activeFindIndex = index;
	}

	function refreshFindMatches() {
		const matches = collectFindMatches();
		findMatches = matches;
		if (!editor || !matches.length) {
			activeFindIndex = -1;
			return;
		}
		const selFrom = editor.state.selection.from;
		const selTo = editor.state.selection.to;
		activeFindIndex = matches.findIndex((m) => m.from === selFrom && m.to === selTo);
	}

	let _findScrollTop = 0;

	async function openFindDialog() {
		if (!editor) return;
		_findScrollTop = scrollAreaEl?.scrollTop ?? 0;
		showFindDialog = true;
		const { from, to } = editor.state.selection;
		if (from !== to) {
			const selected = editor.state.doc.textBetween(from, to, ' ', ' ');
			if (selected && selected.length <= 120) findQuery = selected;
		}
		await tick();
		findInputEl?.focus();
		findInputEl?.select();
		refreshFindMatches();
	}

	function closeFindDialog() {
		const savedTop = _findScrollTop;
		showFindDialog = false;
		findMatches = [];
		activeFindIndex = -1;
		editor?.commands.focus();
		// Restore scroll position after focus (which may trigger a scroll-to-cursor)
		requestAnimationFrame(() => {
			if (scrollAreaEl) scrollAreaEl.scrollTop = savedTop;
		});
	}

	function findNext() {
		refreshFindMatches();
		if (!editor || !findMatches.length) return;
		const next = activeFindIndex >= 0
			? (activeFindIndex + 1) % findMatches.length
			: 0;
		selectFindMatch(next);
	}

	function findPrev() {
		refreshFindMatches();
		if (!editor || !findMatches.length) return;
		const prev = activeFindIndex >= 0
			? (activeFindIndex - 1 + findMatches.length) % findMatches.length
			: findMatches.length - 1;
		selectFindMatch(prev);
	}

	function replaceCurrentMatch() {
		if (!editor || activeFindIndex < 0 || activeFindIndex >= findMatches.length) return;
		const match = findMatches[activeFindIndex];
		const tr = editor.state.tr.insertText(replaceQuery, match.from, match.to);
		editor.view.dispatch(tr);
		saved = false;
		scheduleAutosave();
		refreshFindMatches();
		if (findMatches.length) {
			selectFindMatch(Math.min(activeFindIndex, findMatches.length - 1));
		}
	}

	function replaceAllMatches() {
		if (!editor || !findMatches.length) return;
		let tr = editor.state.tr;
		for (let i = findMatches.length - 1; i >= 0; i--) {
			const m = findMatches[i];
			tr = tr.insertText(replaceQuery, m.from, m.to);
		}
		editor.view.dispatch(tr);
		saved = false;
		scheduleAutosave();
		refreshFindMatches();
	}

	// ── Print layout ─────────────────────────────────────────────
	// A4 at 96 CSS DPI: 794 × 1123px.
	// PAGE_MARGIN = top/bottom margin per page (whitespace, no text).
	// PAGE_GAP    = visible gap between pages (the --bg-hover strip).
	// SPACER_H    = total dead zone per boundary = bottom margin + gap + top margin.
	//
	// Spacers are injected directly into the ProseMirror DOM as non-editable
	// <div class="pm-page-spacer"> elements. They push content down so no text
	// ever falls in the margin/gap zone. They are removed before saving and
	// hidden in @media print.
	const A4_PAGE_W  = 794;
	const A4_PAGE_H  = 1123;
	const PAGE_MARGIN = 40;  // top and bottom page margin (px)
	const PAGE_GAP    = 32;  // visible gap strip between pages (px)
	const SPACER_H    = PAGE_MARGIN + PAGE_GAP + PAGE_MARGIN; // 112px total dead zone

	let mobilePrintScale = $state(1);
	let _printMinScale = 1;  // set by updateMobilePrintScale; pinch cannot zoom below this
	let _contentNaturalH = $state(0);      // tracked by ResizeObserver on contentWrapEl
	let _contentResizeObs: ResizeObserver | null = null;
	let _pageBreakRaf: number | null = null;

	function updateMobilePrintScale() {
		if (typeof window === 'undefined' || !printLayout || window.innerWidth >= 768) {
			mobilePrintScale = 1;
			return;
		}
		const viewportW = scrollAreaEl?.clientWidth ?? window.innerWidth;
		// Zoom targets editor-content-wrap (794px paper + 24px padding each side = 842px).
		const scale = Math.min(1, viewportW / (A4_PAGE_W + 48));
		mobilePrintScale = Math.max(0.3, Number(scale.toFixed(4)));
		_printMinScale = mobilePrintScale; // remember the fit-to-page scale as the zoom floor
	}

	// ── Custom pinch-zoom for print layout scroll area ───────────
	// Viewport zoom is blocked globally (meta tag + gesturestart in layout.svelte).
	// When the user pinches inside the print layout scroll area we intercept the
	// 2-finger touchmove here and update mobilePrintScale instead.
	let _pinchStartScale = 1;
	// Focal point: content coord under pinch center at start
	let _pinchFocalX = 0;
	let _pinchFocalY = 0;
	// Viewport offset of pinch center from scroll area edges
	let _pinchVP_X = 0;
	let _pinchVP_Y = 0;

	// ── iOS Safari: gesture events forwarded from +layout.svelte via custom events
	// iOS gesturestart/gesturechange are proprietary and fire on the document.
	// layout.svelte intercepts them, calls preventDefault to block viewport zoom,
	// and forwards the scale data here via window custom events.
	function handlePrintGestureStart(e: CustomEvent) {
		if (!printLayout) return;
		_pinchStartScale = mobilePrintScale;
		const sa = scrollAreaEl;
		if (!sa) return;
		_pinchVP_X = sa.clientWidth / 2;
		_pinchVP_Y = sa.clientHeight / 2;
		_pinchFocalX = (sa.scrollLeft + _pinchVP_X) / mobilePrintScale;
		_pinchFocalY = (sa.scrollTop  + _pinchVP_Y) / mobilePrintScale;
	}

	function handlePrintGestureChange(e: CustomEvent) {
		if (!printLayout) return;
		const gestureScale = e.detail?.scale ?? 1;
		const newScale = Number(Math.max(_printMinScale, Math.min(3, _pinchStartScale * gestureScale)).toFixed(4));
		mobilePrintScale = newScale;
		const targetLeft = _pinchFocalX * newScale - _pinchVP_X;
		const targetTop  = _pinchFocalY * newScale - _pinchVP_Y;
		requestAnimationFrame(() => {
			if (scrollAreaEl) {
				scrollAreaEl.scrollLeft = Math.max(0, targetLeft);
				scrollAreaEl.scrollTop  = Math.max(0, targetTop);
			}
		});
	}

	// ── Android / non-iOS: touchstart/touchmove (standard touch events)
	function _getPinchDist(touches: TouchList): number {
		const dx = touches[0].clientX - touches[1].clientX;
		const dy = touches[0].clientY - touches[1].clientY;
		return Math.sqrt(dx * dx + dy * dy);
	}
	let _pinchStartDist = 0;

	function handlePrintPinchStart(e: TouchEvent) {
		if (!printLayout || e.touches.length !== 2) return;
		_pinchStartDist = _getPinchDist(e.touches);
		_pinchStartScale = mobilePrintScale;
		const saRect = scrollAreaEl.getBoundingClientRect();
		const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
		const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
		_pinchVP_X = midX - saRect.left;
		_pinchVP_Y = midY - saRect.top;
		_pinchFocalX = (scrollAreaEl.scrollLeft + _pinchVP_X) / mobilePrintScale;
		_pinchFocalY = (scrollAreaEl.scrollTop  + _pinchVP_Y) / mobilePrintScale;
	}

	function handlePrintPinchMove(e: TouchEvent) {
		if (!printLayout || e.touches.length !== 2) return;
		e.preventDefault();
		if (_pinchStartDist === 0) return;
		const ratio = _getPinchDist(e.touches) / _pinchStartDist;
		const newScale = Number(Math.max(_printMinScale, Math.min(3, _pinchStartScale * ratio)).toFixed(4));
		mobilePrintScale = newScale;
		const targetLeft = _pinchFocalX * newScale - _pinchVP_X;
		const targetTop  = _pinchFocalY * newScale - _pinchVP_Y;
		requestAnimationFrame(() => {
			if (scrollAreaEl) {
				scrollAreaEl.scrollLeft = Math.max(0, targetLeft);
				scrollAreaEl.scrollTop  = Math.max(0, targetTop);
			}
		});
	}

	// Remove all injected spacers from ProseMirror DOM
	function removePageSpacers() {
		const pm = editorEl?.querySelector('.ProseMirror') as HTMLElement | null;
		if (!pm) return;
		pm.querySelectorAll('.pm-page-spacer').forEach(el => el.remove());
	}

	// Return the offsetTop of el relative to ancestor (not necessarily offsetParent).
	function offsetTopRelTo(el: HTMLElement, ancestor: HTMLElement): number {
		let top = 0;
		let cur: HTMLElement | null = el;
		while (cur && cur !== ancestor) {
			top += cur.offsetTop;
			cur = cur.offsetParent as HTMLElement | null;
		}
		return top;
	}

	// Inject spacers into ProseMirror DOM at page boundaries.
	// Each spacer pushes content down by SPACER_H px, so no text falls in
	// the margin/gap zone.
	function injectPageSpacers() {
		const pm = editorEl?.querySelector('.ProseMirror') as HTMLElement | null;
		if (!pm) return;

		removePageSpacers();

		// Content area per page: A4 height minus top and bottom page margins
		const contentH = A4_PAGE_H - PAGE_MARGIN - PAGE_MARGIN; // 1043px

		// boundary = top offset (relative to pm) where the current page's content ends.
		// pm has padding-top = PAGE_MARGIN, so children start at PAGE_MARGIN.
		// First boundary: PAGE_MARGIN + contentH = 1083px.
		let boundary = PAGE_MARGIN + contentH;

		let i = 0;
		while (i < pm.children.length) {
			const child = pm.children[i] as HTMLElement;
			if (child.classList.contains('pm-page-spacer')) { i++; continue; }

			// offsetTop relative to pm (not offsetParent, which may differ)
			const childTop = offsetTopRelTo(child, pm);

			if (childTop >= boundary - 2) {
				const spacer = document.createElement('div');
				spacer.className = 'pm-page-spacer';
				spacer.contentEditable = 'false';
				spacer.setAttribute('aria-hidden', 'true');
				pm.insertBefore(spacer, child);
				boundary += SPACER_H + contentH;
				// Don't increment — re-check same child against updated boundary
			} else {
				i++;
			}
		}
	}

	// Before printing: wrap each floated image + its visually-adjacent siblings in a
	// display:flow-root container with break-inside:avoid. This forces the browser to
	// treat the float and its wrapping text as one indivisible unit for page breaks.
	// Positions are all measured before any DOM mutations to avoid stale layout reads.
	function prepareFloatGroupsForPrint() {
		const pm = editorEl?.querySelector('.ProseMirror') as HTMLElement | null;
		if (!pm) return;

		// Measure all direct children's tops relative to pm BEFORE touching the DOM
		const childTops = new Map<Element, number>();
		Array.from(pm.children).forEach(c => {
			childTops.set(c, offsetTopRelTo(c as HTMLElement, pm));
		});

		// Collect float images + their bottom boundary
		const floats: { el: HTMLElement; bottom: number }[] = [];
		pm.querySelectorAll(':scope > .img-node-wrapper').forEach(node => {
			const el = node as HTMLElement;
			if (!el.style.cssFloat || el.style.cssFloat === 'none') return;
			floats.push({ el, bottom: (childTops.get(el) ?? 0) + el.offsetHeight });
		});

		// Wrap each float + overlapping siblings
		floats.forEach(({ el, bottom }) => {
			const wrapper = document.createElement('div');
			wrapper.className = 'pm-float-group';
			pm.insertBefore(wrapper, el);
			wrapper.appendChild(el);

			let next = wrapper.nextElementSibling as HTMLElement | null;
			while (next && !next.classList.contains('img-node-wrapper')) {
				const top = childTops.get(next) ?? Infinity;
				if (top < bottom) {
					wrapper.appendChild(next);
					next = wrapper.nextElementSibling as HTMLElement | null;
				} else {
					break;
				}
			}
		});
	}

	// After printing: restore the DOM exactly as it was
	function restoreFloatGroupsAfterPrint() {
		const pm = editorEl?.querySelector('.ProseMirror') as HTMLElement | null;
		if (!pm) return;
		pm.querySelectorAll('.pm-float-group').forEach(wrapper => {
			// Move children back before the wrapper (preserves order)
			while (wrapper.firstChild) pm.insertBefore(wrapper.firstChild, wrapper);
			wrapper.remove();
		});
	}

	function schedulePageBreakCompute() {
		if (_pageBreakRaf) cancelAnimationFrame(_pageBreakRaf);
		// Double rAF: first frame lets Svelte finish rendering,
		// second frame lets the browser complete layout before we measure.
		_pageBreakRaf = requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				if (printLayout) injectPageSpacers();
				_pageBreakRaf = null;
			});
		});
	}

	$effect(() => {
		if (printLayout && editorReady) {
			updateMobilePrintScale();
			schedulePageBreakCompute();
		} else {
			mobilePrintScale = 1;
			removePageSpacers();
		}
	});

	function handleViewportResize() {
		updateMobilePrintScale();
		if (printLayout) schedulePageBreakCompute();
	}

	// ── Load note ─────────────────────────────────────────────────
	// Notes are stored decrypted in IndexedDB; encryption happens at sync time.
	let title = $state('');
	let saved = $state(true);
	// Plain let - NOT $state. TipTap editor is imperative, not reactive Svelte state.
	// bind:this on a plain let works fine in Svelte 5 for DOM element refs.
	let editorEl: HTMLDivElement;
	let scrollAreaEl: HTMLDivElement;
	let contentWrapEl: HTMLDivElement;
	let editor: Editor | null = null;
	// Used to trigger $effects that need the editor to be ready
	let editorReady = $state(false);

	// Track the last noteId we loaded content for - prevents overwriting user edits
	// after saveNote triggers a notesMap update while the user is still on the same note.
	let loadedNoteId: string | null = null;

	// This $effect runs when the note changes OR after the editor becomes ready.
	// We use editorReady as a dependency trigger so it fires after onMount sets up TipTap.
	$effect(() => {
		if (!editorReady || !editor) return; // wait for editor init
		const n = isNew ? null : notesMap.get(noteId!);
		const isNewNoteId = noteId !== loadedNoteId;

		if (n) {
			if (isNewNoteId) {
				title = n.title;
				editor.commands.setContent(n.body || '', { emitUpdate: false });
				_bodyText = editor.getText() ?? '';
				loadedNoteId = noteId ?? null;
				saved = true;
				// On note load, retry any file attachment uploads that may have failed.
				// Runs after setContent so the doc has the fileAttachment nodes.
				if (auth.dek && auth.userId) {
					requestAnimationFrame(() => {
						editor?.state.doc.descendants((node) => {
							if (node.type.name === 'fileAttachment' && node.attrs.hash) {
								retryAttachmentUpload(node.attrs.hash, auth.userId!, auth.dek!);
							}
						});
					});
				}
			}
		} else if (isNew && isNewNoteId) {
			title = '';
			editor.commands.setContent('', { emitUpdate: false });
			_bodyText = '';
			loadedNoteId = 'new';
			saved = true;
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
		if (_saving) return;
		_saving = true;

		// Re-attempt server upload for any fileAttachment nodes whose previous
		// fire-and-forget upload may have silently failed (server is idempotent).
		if (editor && auth.dek && auth.userId) {
			editor.state.doc.descendants((node) => {
				if (node.type.name === 'fileAttachment' && node.attrs.hash) {
					retryAttachmentUpload(node.attrs.hash, auth.userId!, auth.dek!);
				}
			});
		}

		// Snapshot body BEFORE any await
		const body = editor?.getHTML() ?? '';

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
			// saveNote does not call setContent, so TipTap's selection is undisturbed.
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

	/** Apply an external update to the editor, preserving cursor position (TipTap). */
	function applyExternalUpdate(update: ExternalUpdate): void {
		if (!editor) return;
		const wasFocused = editor.isFocused;
		const savedPos = wasFocused ? editor.state.selection.anchor : null;

		title = update.title;
		editor.commands.setContent(update.body || '', { emitUpdate: false });
		_bodyText = editor.getText() ?? '';

		if (savedPos !== null) {
			requestAnimationFrame(() => {
				if (savedPos !== null && editor) {
					const docSize = editor.state.doc.content.size;
					editor.commands.setTextSelection(Math.min(savedPos, docSize - 1));
				}
			});
		}
	}

	let incomingUpdate = $state<ExternalUpdate | null>(null);
	// Timestamp of the last time we saved - suppress external updates that arrive
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

	// ── Word / char / line count ──────────────────────────────────
	let _bodyText = $state('');

	function getWordCount(text: string): number {
		const trimmed = text.trim();
		if (!trimmed) return 0;
		return trimmed.split(/\s+/).length;
	}
	function getLineCount(text: string): number {
		if (!text.trim()) return 0;
		return text.split('\n').filter(l => l.trim()).length;
	}

	let wordCount = $derived(getWordCount(_bodyText));
	let charCount = $derived(_bodyText.replace(/\s/g, '').length);
	let lineCount = $derived(getLineCount(_bodyText));
	// CharacterCount from TipTap (updated after editor is ready)
	let ttCharCount = $state(0);
	let ttWordCount = $state(0);

	function handleTitleInput() { saved = false; scheduleAutosave(); }

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

	// ── Rich text commands (TipTap) ──────────────────────────────

	// ── Formatting state (reactive, updated by TipTap transaction) ─
	let isBold       = $state(false);
	let isItalic     = $state(false);
	let isUnderline  = $state(false);
	let isStrike     = $state(false);
	let isUL         = $state(false);
	let isOL         = $state(false);
	let isTaskList   = $state(false);
	let isHighlight  = $state(false);
	let isCode       = $state(false);
	let isBlockquote = $state(false);
	let isCodeBlock  = $state(false);
	let activeHeading = $state(0); // 0 = paragraph, 1-4 = h1-h4
	let currentFontSize = $state('16'); // numeric string without unit
	let showFontSizePicker = $state(false);
	let showHeadingPicker = $state(false);
	let headingBtnEl = $state<HTMLButtonElement | undefined>(undefined);
	let headingPanelEl = $state<HTMLDivElement | undefined>(undefined);
	// Link insert UI
	let showLinkDialog = $state(false);
	// Link tooltip (hover/cursor)
	let linkTooltip = $state<{ href: string; x: number; y: number } | null>(null);
	let _linkTooltipFadeTimer: ReturnType<typeof setTimeout> | null = null;
	let _linkHoverTimer: ReturnType<typeof setTimeout> | null = null;
	let _linkTooltipVisible = $state(false);
	let _mouseOnTooltip = false;
	let _mouseOnLink = false;
	let _cursorInLink = false;
	let linkUrl = $state('');
	let linkBtnEl = $state<HTMLButtonElement | undefined>(undefined);
	// Image insert UI
	let showImageDialog = $state(false);
	let imageUrl = $state('');
	let imageBtnEl = $state<HTMLButtonElement | undefined>(undefined);
	let imageFileInput = $state<HTMLInputElement | undefined>(undefined);

	let isInTable    = $state(false); // tracked in updateFormatState for table controls

	let showColorPicker = $state(false);
	let customColor = $state('#e2e4ed');
	let colorIsDefault = $state(true); // true = cursor is on plain (non-colored) text
	let colorBtnEl = $state<HTMLButtonElement | undefined>(undefined);
	let colorPanelEl = $state<HTMLDivElement | undefined>(undefined);
	let fontsizeBtnEl = $state<HTMLButtonElement | undefined>(undefined);
	let fontsizePanelEl = $state<HTMLDivElement | undefined>(undefined);

	// ── Highlight color ────────────────────────────────────────────
	const LS_HIGHLIGHT_COLOR = 'bedroc_highlight_color';
	const highlightPresets = [
		{ label: 'Yellow', color: '#faf594' },
		{ label: 'Green',  color: '#74f481' },
		{ label: 'Blue',   color: '#a5f3fc' },
		{ label: 'Red',    color: '#f98181' },
		{ label: 'Purple', color: '#b197fc' },
		{ label: 'Orange', color: '#fbbc88' },
	];
	function loadHighlightColor(): string {
		if (typeof localStorage === 'undefined') return '#faf594';
		return localStorage.getItem(LS_HIGHLIGHT_COLOR) ?? '#faf594';
	}
	let currentHighlightColor = $state(loadHighlightColor());
	// Separate opacity (0-100) for the custom color picker. Stored alongside color in localStorage.
	const LS_HIGHLIGHT_OPACITY = 'bedroc_highlight_opacity';
	let customHlOpacity = $state(parseInt(typeof localStorage !== 'undefined' ? (localStorage.getItem(LS_HIGHLIGHT_OPACITY) ?? '100') : '100', 10));
	let showHighlightPicker = $state(false);
	let highlightBtnEl = $state<HTMLButtonElement | undefined>(undefined);
	let highlightPanelEl = $state<HTMLDivElement | undefined>(undefined);

	function customHlColor(): string {
		// Extract the base hex from currentHighlightColor (strip any existing alpha)
		const hex = currentHighlightColor.replace(/#([0-9a-f]{6})[0-9a-f]{0,2}/i, '#$1');
		if (customHlOpacity >= 100) return hex;
		const alpha = Math.round(customHlOpacity / 100 * 255).toString(16).padStart(2, '0');
		return hex + alpha;
	}

	function applyHighlight() {
		if (!editor) return;
		if (editor.isActive('highlight')) {
			editor.chain().focus().unsetHighlight().run();
		} else {
			(editor.chain().focus() as any).setHighlight({ color: currentHighlightColor }).run();
		}
		saved = false;
		scheduleAutosave();
	}
	function setHighlightColor(color: string) {
		currentHighlightColor = color;
		localStorage.setItem(LS_HIGHLIGHT_COLOR, color);
		showHighlightPicker = false;
		// Apply the new color immediately if highlight is active
		if (editor?.isActive('highlight')) {
			(editor.chain().focus() as any).setHighlight({ color }).run();
			saved = false;
			scheduleAutosave();
		}
	}

	$effect(() => {
		if (showHighlightPicker) positionPanel(highlightBtnEl, highlightPanelEl);
	});

	// ── Custom Image extension ──────────────────────────────────────
	// Block node with per-image resize + alignment (float-left, float-right, block).
	//
	// Alignment modes:
	//   'none'  - block, full width of editor column, cursor before/after on own line
	//   'left'  - float: left, text flows to the right of the image
	//   'right' - float: right, text flows to the left of the image
	//
	// Each image's NodeView renders its own controls (no shared Svelte state),
	// so multiple images all work independently.
	const ResizableImage = Image.extend({
		inline: false,
		group: 'block',

		addAttributes() {
			return {
				...this.parent?.(),
				width: {
					default: null,
					renderHTML: (a) => a.width ? { 'data-width': String(a.width) } : {},
					parseHTML: (el) => {
						const v = el.getAttribute('data-width');
						return v ? Number(v) : null;
					},
				},
				align: {
					default: 'none',
					renderHTML: (a) => {
						if (!a.align || a.align === 'none') return {};
						return { 'data-align': a.align };
					},
					parseHTML: (el) => el.getAttribute('data-align') || 'none',
				},
			};
		},

		addNodeView() {
			return ({ node, getPos }) => {
				// Outer wrapper - always block-level.
				// float is applied to the wrapper so text can flow around it.
				const wrapper = document.createElement('div');
				wrapper.className = 'img-node-wrapper';
				wrapper.setAttribute('contenteditable', 'false');

				const img = document.createElement('img');
				img.src = node.attrs.src ?? '';
				img.alt = node.attrs.alt ?? '';
				img.title = node.attrs.title ?? '';

				// Alignment toolbar (block / float-left / float-right)
				const toolbar = document.createElement('div');
				toolbar.className = 'img-align-toolbar';

				function makeAlignBtn(alignVal: string, title: string, svgPath: string) {
					const btn = document.createElement('button');
					btn.className = 'img-align-btn';
					btn.title = title;
					btn.setAttribute('data-align', alignVal);
					btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none">${svgPath}</svg>`;
					btn.addEventListener('mousedown', (e) => {
						e.preventDefault();
						e.stopPropagation();
						if (typeof getPos === 'function') {
							const pos = getPos();
							if (typeof pos === 'number') {
								editor?.chain().focus().setNodeSelection(pos).updateAttributes('image', { align: alignVal }).run();
								saved = false;
								scheduleAutosave();
							}
						}
					});
					return btn;
				}

				// Block (no float) - image on its own line
				const btnBlock = makeAlignBtn('none', 'Block (own line)',
					'<rect x="1" y="1" width="12" height="3" rx="1" fill="currentColor"/><rect x="1" y="6" width="8" height="2" rx="1" fill="currentColor" opacity=".5"/><rect x="1" y="10" width="6" height="2" rx="1" fill="currentColor" opacity=".5"/>');
				// Float left - text flows to the right
				const btnLeft = makeAlignBtn('left', 'Float left (text wraps right)',
					'<rect x="1" y="1" width="6" height="6" rx="1" fill="currentColor"/><path d="M9 2h4M9 5h4M1 9h12M1 12h10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".6"/>');
				// Float right - text flows to the left
				const btnRight = makeAlignBtn('right', 'Float right (text wraps left)',
					'<rect x="7" y="1" width="6" height="6" rx="1" fill="currentColor"/><path d="M1 2h4M1 5h4M1 9h12M1 12h10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".6"/>');

				toolbar.append(btnBlock, btnLeft, btnRight);

				// Resize handle (right edge drag)
				const handle = document.createElement('div');
				handle.className = 'img-resize-handle-inline';
				handle.title = 'Drag to resize';

				let dragging = false;
				let startX = 0;
				let startW = 0;

				handle.addEventListener('pointerdown', (e) => {
					e.preventDefault();
					e.stopPropagation();
					dragging = true;
					startX = e.clientX;
					startW = img.getBoundingClientRect().width;
					handle.setPointerCapture(e.pointerId);
				});
				handle.addEventListener('pointermove', (e) => {
					if (!dragging) return;
					const newW = Math.max(40, Math.round(startW + e.clientX - startX));
					img.style.width = newW + 'px';
					img.style.height = 'auto';
				});
				handle.addEventListener('pointerup', (e) => {
					if (!dragging) return;
					dragging = false;
					const newW = Math.max(40, Math.round(startW + e.clientX - startX));
					if (typeof getPos === 'function') {
						const pos = getPos();
						if (typeof pos === 'number') {
							editor?.chain().focus().setNodeSelection(pos).updateAttributes('image', { width: newW }).run();
							saved = false;
							scheduleAutosave();
						}
					}
				});
				handle.addEventListener('pointercancel', () => { dragging = false; });

				wrapper.append(toolbar, img, handle);

				function applyAttrs(attrs: Record<string, unknown>) {
					img.src = (attrs.src as string) ?? '';
					img.alt = (attrs.alt as string) ?? '';
					// Width - apply to img only; wrapper always fits to image
					if (attrs.width) {
						img.style.width = attrs.width + 'px';
						img.style.height = 'auto';
					} else {
						img.style.width = '';
						img.style.height = '';
					}
					// Float alignment on wrapper
					// wrapper is always inline-block so it shrinks to image size.
					// For block mode we set display:block + width:fit-content so it
					// sits on its own line but doesn't stretch the full editor width.
					const align = (attrs.align as string) || 'none';
					if (align === 'left') {
						wrapper.style.cssFloat = 'left';
						wrapper.style.margin = '4px 16px 8px 0';
						wrapper.style.display = 'inline-block';
					} else if (align === 'right') {
						wrapper.style.cssFloat = 'right';
						wrapper.style.margin = '4px 0 8px 16px';
						wrapper.style.display = 'inline-block';
					} else {
						wrapper.style.cssFloat = '';
						wrapper.style.margin = '4px 0';
						wrapper.style.display = 'block';
					}
					// Highlight active align button
					toolbar.querySelectorAll<HTMLButtonElement>('.img-align-btn').forEach((b) => {
						b.classList.toggle('active', b.getAttribute('data-align') === align);
					});
				}

				let _lastAttrs = { ...node.attrs };
				applyAttrs(node.attrs);

				return {
					dom: wrapper,
					update(updatedNode) {
						if (updatedNode.type.name !== 'image') return false;
						const a = updatedNode.attrs;
						// Only mutate the DOM when attrs actually changed - avoids browser
						// selection resets caused by DOM mutations during typing transactions.
						if (a.src !== _lastAttrs.src || a.width !== _lastAttrs.width || a.align !== _lastAttrs.align || a.alt !== _lastAttrs.alt) {
							_lastAttrs = { ...a };
							applyAttrs(a);
						}
						return true;
					},
				};
			};
		},
	});

	// no-op - per-node NodeView handles everything
	function updateImageResize() {}

		// ── File attachment ──────────────────────────────────────────
	// Custom TipTap node for embedded files (PDF, zip, etc.)
	// Rendered as a download card. Stored as encrypted base64 in IndexedDB.

	// Custom TipTap node: file attachment card
	const FileAttachmentNode = Node.create({
		name: 'fileAttachment',
		group: 'block',
		atom: true,
		addAttributes() {
			return {
				hash:     { default: '' },
				fileName: { default: 'file' },
				mimeType: { default: 'application/octet-stream' },
				size:     { default: 0 },
			};
		},
		parseHTML() {
			return [{ tag: 'div[data-file-attachment]' }];
		},
		renderHTML({ HTMLAttributes }) {
			return ['div', mergeAttributes(HTMLAttributes, { 'data-file-attachment': '' })];
		},
		addNodeView() {
			return ({ node, getPos }) => {
				const dom = document.createElement('div');
				dom.className = 'file-attachment-card';
				dom.setAttribute('data-file-attachment', '');
				dom.setAttribute('contenteditable', 'false');

				const icon = document.createElement('span');
				icon.className = 'file-attachment-icon';
				icon.innerHTML = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="3" y="1" width="9" height="13" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M8 1v4h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M5 10h6M5 13h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;

				const info = document.createElement('div');
				info.className = 'file-attachment-info';

				const name = document.createElement('span');
				name.className = 'file-attachment-name';
				name.textContent = node.attrs.fileName;

				const meta = document.createElement('span');
				meta.className = 'file-attachment-meta';
				const kb = node.attrs.size ? `${Math.round(node.attrs.size / 1024)} KB · ` : '';
				meta.textContent = kb + node.attrs.mimeType;

				info.append(name, meta);

				// Make icon + name clickable for previewable files
				const canPreview = node.attrs.mimeType === 'application/pdf'
					|| node.attrs.mimeType.startsWith('text/')
					|| /(javascript|json|xml|x-python|x-sh|x-c|x-java|x-ruby|x-php|x-rust|x-go|x-typescript|x-yaml|x-toml|csv)/.test(node.attrs.mimeType);
				if (canPreview) {
					icon.style.cursor = 'pointer';
					icon.title = 'Preview';
					info.style.cursor = 'pointer';
					const triggerPreview = (ev: MouseEvent) => {
						ev.stopPropagation();
						openPreview(node.attrs.hash, node.attrs.fileName, node.attrs.mimeType);
					};
					icon.onclick = triggerPreview;
					info.onclick = triggerPreview;
				}

				const dlBtn = document.createElement('button');
				dlBtn.className = 'file-attachment-dl';
				dlBtn.title = 'Download';
				dlBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="flex-shrink:0"><path d="M6 1v7M3.5 6l2.5 2 2.5-2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M1 10h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg><span>Download</span>`;
				dlBtn.onclick = async (e) => {
					e.stopPropagation();
					const dataUri = await loadAttachment(node.attrs.hash, auth.userId!, auth.dek);
					if (!dataUri) { alert('Attachment unavailable (vault may be locked)'); return; }
					const a = document.createElement('a');
					a.href = dataUri;
					a.download = node.attrs.fileName;
					a.click();
				};

				const delBtn = document.createElement('button');
				delBtn.className = 'file-attachment-del';
				delBtn.title = 'Remove from note';
				delBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M1 1l9 9M10 1l-9 9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;
				delBtn.onclick = (e) => {
					e.stopPropagation();
					if (typeof getPos === 'function') {
						const pos = getPos();
						if (typeof pos === 'number') {
							editor?.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run();
						}
					}
				};

				dom.append(icon, info, dlBtn, delBtn);
				return { dom };
			};
		},
	});

	// Show file insert dialog
	let showFileDialog = $state(false);
	let fileBtnEl = $state<HTMLLabelElement | undefined>(undefined);

	// ── File preview modal ───────────────────────────────────────
	type PreviewState = { hash: string; fileName: string; mimeType: string } | null;
	let previewState = $state<PreviewState>(null);
	// For PDFs: a Blob URL (avoids CSP data: iframe restriction)
	// For text/code: the decoded string
	let previewContent = $state<string | null>(null);
	let previewLoading = $state(false);
	let _previewBlobUrl: string | null = null; // revoke on close

	async function openPreview(hash: string, fileName: string, mimeType: string) {
		previewState = { hash, fileName, mimeType };
		previewContent = null;
		previewLoading = true;

		const dataUri = await loadAttachment(hash, auth.userId!, auth.dek);
		previewLoading = false;
		if (!dataUri) return;

		if (mimeType === 'application/pdf') {
			// Convert data URI → Blob URL so the browser doesn't block it in an iframe
			const comma = dataUri.indexOf(',');
			const b64 = dataUri.slice(comma + 1);
			const binary = atob(b64);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
			const blob = new Blob([bytes], { type: 'application/pdf' });
			if (_previewBlobUrl) URL.revokeObjectURL(_previewBlobUrl);
			_previewBlobUrl = URL.createObjectURL(blob);
			previewContent = _previewBlobUrl;
		} else {
			// Text/code: decode base64 → string
			try {
				const comma = dataUri.indexOf(',');
				const b64 = dataUri.slice(comma + 1);
				previewContent = atob(b64);
			} catch {
				previewContent = dataUri; // already text (edge case)
			}
		}
	}

	function closePreview() {
		if (_previewBlobUrl) { URL.revokeObjectURL(_previewBlobUrl); _previewBlobUrl = null; }
		previewState = null;
		previewContent = null;
	}

	function showLinkTooltip(href: string, viewportX: number, viewportY: number) {
		if (_linkTooltipFadeTimer) { clearTimeout(_linkTooltipFadeTimer); _linkTooltipFadeTimer = null; }
		// Convert viewport coords to scroll-area-relative coords
		const sa = scrollAreaEl;
		if (!sa) return;
		const rect = sa.getBoundingClientRect();
		const x = viewportX - rect.left + sa.scrollLeft;
		const y = viewportY - rect.top + sa.scrollTop;
		// Clamp x so tooltip doesn't overflow
		const saWidth = sa.clientWidth;
		const cx = Math.max(160, Math.min(x, saWidth - 160));
		linkTooltip = { href, x: cx, y };
		_linkTooltipVisible = true;
	}

	function scheduleLinkTooltipHide() {
		if (_linkTooltipFadeTimer) return; // already scheduled
		_linkTooltipFadeTimer = setTimeout(() => {
			// Don't hide if mouse is on tooltip or link, or cursor is inside a link
			if (_mouseOnTooltip || _mouseOnLink || _cursorInLink) {
				_linkTooltipFadeTimer = null;
				return;
			}
			_linkTooltipVisible = false;
			_linkTooltipFadeTimer = setTimeout(() => {
				linkTooltip = null;
				_linkTooltipFadeTimer = null;
			}, 150);
		}, 300);
	}

	function hideLinkTooltipImmediate() {
		if (_linkTooltipFadeTimer) { clearTimeout(_linkTooltipFadeTimer); _linkTooltipFadeTimer = null; }
		_linkTooltipVisible = false;
		linkTooltip = null;
		_cursorInLink = false;
		_mouseOnLink = false;
		_mouseOnTooltip = false;
	}

	// Browser detection for PDF rendering
	const _ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
	const _isIOS = /iPhone|iPad|iPod/.test(_ua);
	// Safari desktop: has "Safari" but NOT "Chrome" in UA
	const _isSafariDesktop = !_isIOS && /Safari/.test(_ua) && !/Chrome|Chromium|Edg/.test(_ua);

	function isPreviewable(mimeType: string): boolean {
		return (
			mimeType === 'application/pdf' ||
			mimeType.startsWith('text/') ||
			/\/(javascript|json|xml|x-python|x-sh|x-c|x-c\+\+|x-java|x-ruby|x-php|x-rust|x-go|x-typescript|x-yaml|x-toml|csv)/.test(mimeType)
		);
	}

	async function handleAttachFile(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file || !editor) return;
		const reader = new FileReader();
		reader.onload = async (ev) => {
			const dataUri = ev.target?.result as string;
			if (!dataUri) return;
			const hash = await uploadFileAttachment(dataUri, file.type || 'application/octet-stream', auth.userId!, auth.dek);
			editor!.chain().focus().insertContent({
				type: 'fileAttachment',
				attrs: { hash, fileName: file.name, mimeType: file.type || 'application/octet-stream', size: file.size },
			}).run();
			saved = false;
			scheduleAutosave();
		};
		reader.readAsDataURL(file);
		showFileDialog = false;
		input.value = '';
	}

	const fontSizeOptions = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];

	const textColors = [
		'#e2e4ed', '#6b8afd', '#4caf87', '#e0a45c',
		'#e05c5c', '#c084fc', '#38bdf8', '#f472b6',
	];

	function updateFormatState() {
		if (!editor) return;
		isBold      = editor.isActive('bold');
		isItalic    = editor.isActive('italic');
		isUnderline = editor.isActive('underline');
		isStrike    = editor.isActive('strike');
		isUL        = editor.isActive('bulletList');
		isOL        = editor.isActive('orderedList');
		isTaskList  = editor.isActive('taskList');
		isHighlight = editor.isActive('highlight');
		isCode      = editor.isActive('code');
		isBlockquote = editor.isActive('blockquote');
		isCodeBlock = editor.isActive('codeBlock');
		activeHeading = editor.isActive('heading', { level: 1 }) ? 1
			: editor.isActive('heading', { level: 2 }) ? 2
			: editor.isActive('heading', { level: 3 }) ? 3
			: editor.isActive('heading', { level: 4 }) ? 4
			: 0;
		// Font size: textStyle carries fontSize; value is stored WITH px unit (e.g. "16px")
		// We strip the unit for display and comparison
		const tsAttrs = editor.getAttributes('textStyle');
		const rawFs: string = tsAttrs.fontSize ?? '';
		currentFontSize = rawFs ? rawFs.replace('px', '') : '16';
		// Color: stored in textStyle.color; reset to default hex when cursor is on plain text
		const color: string = tsAttrs.color ?? '';
		customColor = color || '#e2e4ed';
		colorIsDefault = !color;
		// Table context
		isInTable = editor.isActive('table');
		// Image selection
		updateImageResize();
	}

	// Position a floating panel below its trigger button.
	function positionPanel(btn: HTMLElement | undefined, panel: HTMLElement | undefined) {
		if (!btn || !panel) return;
		const rect = btn.getBoundingClientRect();
		panel.style.top  = (rect.bottom + 6) + 'px';
		panel.style.left = rect.left + 'px';
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
		colorIsDefault = false;
		// setColor is on the chain via the Color extension
		if (editor) (editor.chain().focus() as any).setColor(color).run();
		updateFormatState();
		saved = false;
		scheduleAutosave();
		showColorPicker = false;
	}

	function unsetColor() {
		if (editor) (editor.chain().focus() as any).unsetColor().run();
		colorIsDefault = true;
		customColor = '#e2e4ed';
		updateFormatState();
		saved = false;
		scheduleAutosave();
	}

	function execFontSize(sizeNum: number) {
		if (!editor) return;
		// FontSize extension stores the value as-is in style="font-size:Xpx"
		// Pass the full CSS value including px unit
		(editor.chain().focus() as any).setFontSize(`${sizeNum}px`).run();
		updateFormatState();
		saved = false;
		scheduleAutosave();
	}

	function clearFormatting() {
		editor?.chain().focus().clearNodes().unsetAllMarks().run();
		updateFormatState();
		saved = false;
		scheduleAutosave();
	}

	function insertLink() {
		if (!editor || !linkUrl.trim()) return;
		const url = linkUrl.trim().startsWith('http') ? linkUrl.trim() : `https://${linkUrl.trim()}`;
		editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
		linkUrl = '';
		showLinkDialog = false;
		saved = false;
		scheduleAutosave();
	}

	function removeLink() {
		editor?.chain().focus().unsetLink().run();
		showLinkDialog = false;
		saved = false;
		scheduleAutosave();
	}

	function insertImageFromUrl() {
		if (!editor || !imageUrl.trim()) return;
		editor.chain().focus().setImage({ src: imageUrl.trim() }).run();
		imageUrl = '';
		showImageDialog = false;
		saved = false;
		scheduleAutosave();
	}

	function handleImageFile(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file || !editor) return;
		const reader = new FileReader();
		reader.onload = async (ev) => {
			const src = ev.target?.result as string;
			if (src) {
				// Pre-store encrypted in IndexedDB + upload to server.
				// extractAttachments() will replace the data: URI with a placeholder on save.
				await uploadFileAttachment(src, file.type || 'image/*', auth.userId!, auth.dek);
				editor!.chain().focus().setImage({ src }).run();
				saved = false;
				scheduleAutosave();
			}
		};
		reader.readAsDataURL(file);
		showImageDialog = false;
		input.value = '';
	}

	$effect(() => {
		if (showHeadingPicker) positionPanel(headingBtnEl, headingPanelEl);
	});
	$effect(() => {
		if (showLinkDialog) positionPanel(linkBtnEl as any, document.getElementById('link-dialog') as any);
	});
	$effect(() => {
		if (showImageDialog) positionPanel(imageBtnEl as any, document.getElementById('image-dialog') as any);
	});

	$effect(() => {
		if (!showFindDialog || !editorReady) return;
		// Recompute only on query/options changes to avoid deep effect loops.
		findQuery;
		findCaseSensitive;
		refreshFindMatches();
	});

	// ── Ensure paragraph padding around block nodes ───────────────
	// Tables and images are block-level; ProseMirror can't place a cursor
	// "beside" them since they span the full editor width. This extension
	// ensures the document always has a trailing paragraph so the user can
	// click below a table/image and place the cursor there.
	const TrailingParagraph = Extension.create({
		name: 'trailingParagraph',
		addProseMirrorPlugins() {
			return [
				new Plugin({
					appendTransaction(_, __, newState) {
						const { doc, tr, schema } = newState;
						const lastNode = doc.lastChild;
						if (lastNode && lastNode.type.name !== 'paragraph') {
							return tr.insert(doc.content.size, schema.nodes.paragraph.create());
						}
						return null;
					},
				}),
			];
		},
	});

	// ── TipTap editor init ────────────────────────────────────────
	onMount(() => {
		editor = new Editor({
			element: editorEl,
			extensions: [
				StarterKit.configure({ link: false, underline: false, codeBlock: false }),
				CodeBlockLowlight.extend({
					addNodeView() {
						return ({ node, getPos, editor: e }) => {
							const wrap = document.createElement('div');
							wrap.className = 'code-block-wrap';

							const header = document.createElement('div');
							header.className = 'code-block-header';

							const langSelect = document.createElement('select');
							langSelect.className = 'code-block-lang';
							const langs = ['plaintext','javascript','typescript','python','rust','go','java','c','cpp','csharp','php','ruby','swift','kotlin','bash','shell','sql','html','css','json','yaml','toml','markdown','diff','xml'];
							for (const l of langs) {
								const opt = document.createElement('option');
								opt.value = l;
								opt.textContent = l;
								if (l === (node.attrs.language || 'plaintext')) opt.selected = true;
								langSelect.appendChild(opt);
							}
							// Use getPos + setNodeMarkup to reliably persist the language attribute.
							// updateAttributes() from the factory param can go stale after node moves;
							// getPos() always returns the current position.
							langSelect.addEventListener('change', () => {
								if (typeof getPos !== 'function') return;
								const pos = getPos();
								if (typeof pos !== 'number') return;
								const lang = langSelect.value;
								e.chain().focus()
									.setNodeSelection(pos)
									.updateAttributes('codeBlock', { language: lang })
									.run();
								saved = false;
								scheduleAutosave();
							});

							header.appendChild(langSelect);

							const pre = document.createElement('pre');
							const code = document.createElement('code');
							pre.appendChild(code);

							wrap.append(header, pre);

							return {
								dom: wrap,
								contentDOM: code,
								update(updatedNode) {
									if (updatedNode.type.name !== 'codeBlock') return false;
									// Only sync the select when the attribute actually changed
									// (not on every keystroke). Prevents the select from jumping
									// back to 'plaintext' while the user is typing inside the block.
									const lang = updatedNode.attrs.language || 'plaintext';
									if (langSelect.value !== lang) langSelect.value = lang;
									return true;
								},
							};
						};
					},
				}).configure({ lowlight: createLowlight(all), defaultLanguage: 'plaintext' }),
				Underline,
				TextStyle,
				Color,
				FontSize,
				TextAlign.configure({ types: ['heading', 'paragraph'] }),
				Subscript,
				Superscript,
				Highlight.configure({ multicolor: true }),
				Typography,
				TaskList,
				TaskItem.configure({ nested: true }),
				CharacterCount,
				Link.configure({
					openOnClick: false,
					HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
				}),
				Table.configure({ resizable: true }),
				TableRow,
				TableHeader,
				TableCell,
				ResizableImage.configure({ allowBase64: true }),
				FileAttachmentNode,
				Placeholder.configure({ placeholder: 'Start writing…' }),
				TrailingParagraph,
			],
			content: '',
			onUpdate: ({ editor: e }) => {
				_bodyText = e.getText() ?? '';
				ttCharCount = (e.storage as any).characterCount?.characters?.() ?? 0;
				ttWordCount = (e.storage as any).characterCount?.words?.() ?? 0;
				saved = false;
				scheduleAutosave();
				updateFormatState();
				if (printLayout) schedulePageBreakCompute();
				},
			onTransaction: () => {
				// updateFormatState on every transaction so toolbar reflects mark
				// toggles (bold/italic/underline etc.) immediately - onUpdate alone
				// can lag by one frame when Svelte batches state writes.
				updateFormatState();
			},
			onSelectionUpdate: ({ editor: ed }) => {
				updateFormatState();
				// Cursor-on-link: show tooltip if cursor is inside a link mark
				const { state } = ed;
				if (state.selection.empty && state.selection.$from.parent.type.name !== "codeBlock") {
					const mark = state.doc.resolve(state.selection.from).marks().find((m: any) => m.type.name === "link");
					if (mark) {
						_cursorInLink = true;
						const href: string = mark.attrs.href ?? "";
						try {
							const coords = ed.view.coordsAtPos(state.selection.from);
							showLinkTooltip(href, coords.left, coords.bottom + 6);
						} catch {}
					} else {
						_cursorInLink = false;
						if (linkTooltip && !_mouseOnTooltip && !_mouseOnLink) scheduleLinkTooltipHide();
					}
				} else {
					_cursorInLink = false;
					if (linkTooltip && !_mouseOnTooltip && !_mouseOnLink) scheduleLinkTooltipHide();
				}
			},
			onFocus: () => {
				updateFormatState();
			},
			editorProps: {
				attributes: {
					spellcheck: 'true',
				},
				handleKeyDown(view, event) {
					const isTab = event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey;
					if (!isTab) return false;

					const { state } = view;
					const selFrom = state.selection.$from;
					const inList = selFrom.node(selFrom.depth - 1)?.type.name === 'listItem'
						|| selFrom.node(selFrom.depth - 1)?.type.name === 'taskItem';
					const inTable = state.selection.$from.node(1)?.type.name === 'table';
					if (inList || inTable) return false; // let TipTap handle it

					event.preventDefault();
					const { from, to } = state.selection;

					if (from === to) {
						// Cursor only: Tab inserts 4 spaces; Shift+Tab removes up to 4 leading spaces
						if (event.shiftKey) {
							// nodeStart = start of this textblock's content
							const nodeStart = state.doc.resolve(from).start();
							// For code blocks, lines are separated by newlines - find the last newline before cursor
							const textToFrom = state.doc.textBetween(nodeStart, from);
							const lastNl = textToFrom.lastIndexOf('\n');
							const lineStart = lastNl >= 0 ? nodeStart + lastNl + 1 : nodeStart;
							const lineText = state.doc.textBetween(lineStart, from);
							const spaces = lineText.match(/^([  ]{1,4})/)?.[1] ?? '';
							if (spaces.length > 0) {
								view.dispatch(state.tr.delete(lineStart, lineStart + spaces.length));
							}
						} else {
							// Use regular spaces in code blocks (pre/code preserves them);
							// use NBSP elsewhere so indentation survives HTML round-trip.
							const inCode = state.selection.$from.node(-1)?.type.name === 'codeBlock'
								|| state.selection.$from.parent.type.name === 'codeBlock';
							view.dispatch(state.tr.insertText(inCode ? '    ' : '    '));
						}
						return true;
					}

					// Range selection: indent/deindent every line overlapping [from, to].
					// Code blocks use newlines within a single textblock node;
					// regular paragraphs are separate textblock nodes.
					// Both cases are handled by scanning each textblock for newline-separated lines.
					type LineInfo = { start: number; leadingSpaces: number };
					const lines: LineInfo[] = [];
					state.doc.nodesBetween(from, to, (node, pos) => {
						if (!node.isTextblock) return;
						const nodeContentStart = pos + 1;
						const nodeContentEnd   = pos + node.nodeSize - 1;
						// Get full text of this node to find newline positions
						const nodeText = state.doc.textBetween(nodeContentStart, nodeContentEnd, '\n');
						// Walk each newline-separated line within the node
						let lineOffset = 0;
						for (const lineText of nodeText.split('\n')) {
							const lineDocStart = nodeContentStart + lineOffset;
							// Only process lines that overlap the selection [from, to]
							const lineDocEnd = lineDocStart + lineText.length;
							if (lineDocEnd >= from && lineDocStart <= to) {
								const sample = lineText.slice(0, 4);
								const spaces = sample.match(/^([  ]{1,4})/)?.[1]?.length ?? 0;
								lines.push({ start: lineDocStart, leadingSpaces: spaces });
							}
							lineOffset += lineText.length + 1; // +1 for the newline char
						}
					});

					let tr = state.tr;
					let offset = 0;
					// Indentation: regular spaces in code blocks (pre preserves them),
					// non-breaking spaces elsewhere so they survive HTML round-trip.
					const isCodeBlock = state.selection.$from.node(-1)?.type.name === 'codeBlock'
						|| state.selection.$from.parent.type.name === 'codeBlock';
					const INDENT = isCodeBlock ? '    ' : '    ';
					for (const line of lines) {
						const pos = line.start + offset;
						if (event.shiftKey) {
							if (line.leadingSpaces > 0) {
								tr.delete(pos, pos + line.leadingSpaces);
								offset -= line.leadingSpaces;
							}
						} else {
							tr.insertText(INDENT, pos);
							offset += 4;
						}
					}

					view.dispatch(tr);
					return true;
				},
			},
		});

		// ── Link hover tooltip ───────────────────────────────────────
		function getAnchorTarget(el: EventTarget | null): HTMLAnchorElement | null {
			let node = el as HTMLElement | null;
			while (node && node !== editorEl) {
				if (node.tagName === "A") return node as HTMLAnchorElement;
				node = node.parentElement;
			}
			return null;
		}
		editorEl.addEventListener("mouseover", (e: MouseEvent) => {
			const a = getAnchorTarget(e.target);
			if (!a) {
				if (_linkHoverTimer) { clearTimeout(_linkHoverTimer); _linkHoverTimer = null; }
				_mouseOnLink = false;
				// Don't hide immediately — cursor might be moving to tooltip or still in link via selection
				if (linkTooltip && !_cursorInLink && !_mouseOnTooltip) scheduleLinkTooltipHide();
				return;
			}
			_mouseOnLink = true;
			if (_linkTooltipFadeTimer) { clearTimeout(_linkTooltipFadeTimer); _linkTooltipFadeTimer = null; }
			const href = a.href;
			if (_linkHoverTimer) clearTimeout(_linkHoverTimer);
			_linkHoverTimer = setTimeout(() => {
				const rect = a.getBoundingClientRect();
				showLinkTooltip(href, rect.left + rect.width / 2, rect.bottom + 6);
				_linkHoverTimer = null;
			}, 600);
		});
		editorEl.addEventListener("mouseout", (e: MouseEvent) => {
			const a = getAnchorTarget(e.relatedTarget);
			if (!a) {
				_mouseOnLink = false;
				if (_linkHoverTimer) { clearTimeout(_linkHoverTimer); _linkHoverTimer = null; }
				if (linkTooltip && !_cursorInLink && !_mouseOnTooltip) scheduleLinkTooltipHide();
			}
		});
		// Signal to $effects that the editor is ready
		editorReady = true;
		updateMobilePrintScale();
		window.addEventListener('resize', handleViewportResize, { passive: true });
		window.addEventListener('beforeprint', prepareFloatGroupsForPrint);
		window.addEventListener('afterprint', restoreFloatGroupsAfterPrint);
		// Pinch-zoom for print layout: non-passive so we can call preventDefault()
		// Android: standard touch events (iOS compositor steals these for panning)
		scrollAreaEl.addEventListener('touchstart', handlePrintPinchStart, { passive: true });
		scrollAreaEl.addEventListener('touchmove', handlePrintPinchMove, { passive: false });
		// iOS Safari: gesture events forwarded from +layout.svelte as custom window events
		window.addEventListener('printGestureStart', handlePrintGestureStart as EventListener);
		window.addEventListener('printGestureChange', handlePrintGestureChange as EventListener);
		// Track natural (un-transformed) height of contentWrapEl for the scale wrapper sizing
		_contentResizeObs = new ResizeObserver(([entry]) => {
			_contentNaturalH = entry.contentRect.height;
		});
		_contentResizeObs.observe(contentWrapEl);
	});

	onDestroy(() => {
		window.removeEventListener('resize', handleViewportResize);
		window.removeEventListener('beforeprint', prepareFloatGroupsForPrint);
		window.removeEventListener('afterprint', restoreFloatGroupsAfterPrint);
		scrollAreaEl?.removeEventListener('touchstart', handlePrintPinchStart);
		scrollAreaEl?.removeEventListener('touchmove', handlePrintPinchMove);
		window.removeEventListener('printGestureStart', handlePrintGestureStart as EventListener);
		window.removeEventListener('printGestureChange', handlePrintGestureChange as EventListener);
		_contentResizeObs?.disconnect();
		editor?.destroy();
	});

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
		if (editingTopic) {
			saveTopic({ ...editingTopic, name: topicName.trim(), color: topicColor, folderId: topicFolderId });
		} else {
			createTopic(topicName.trim(), topicColor, topicFolderId);
		}
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
		if (editingFolder) {
			saveFolder({ ...editingFolder, name: folderName.trim(), parentId: folderParentId });
		} else {
			createFolder(folderName.trim(), folderParentId);
		}
		showFolderEditor = false;
	}
</script>

<svelte:window onkeydown={(e) => {
	if ((e.ctrlKey || e.metaKey) && e.key === 's') {
		e.preventDefault();
		handleSave();
	}
	if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
		e.preventDefault();
		openFindDialog();
		return;
	}
	if (showFindDialog && e.key === 'Escape') {
		e.preventDefault();
		closeFindDialog();
	}
}} />

<svelte:head>
	<title>{title || 'New note'} - Bedroc</title>
</svelte:head>

<div class="editor-page" class:print-layout={printLayout}>
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
			<button
				class="btn-icon find-toolbar-btn"
				onclick={openFindDialog}
				title="Find and replace (Ctrl+F)"
				aria-label="Find and replace"
			>
				<span class="find-toolbar-icon" aria-hidden="true"></span>
			</button>

			<!-- Print layout toggle -->
			<button
				class="btn-icon print-layout-btn"
				class:active={printLayout}
				onclick={togglePrintLayout}
				title={printLayout ? 'Exit print layout' : 'Print layout (A4)'}
				aria-label={printLayout ? 'Exit print layout' : 'Print layout (A4)'}
				aria-pressed={printLayout}
			>
				<svg width="15" height="15" viewBox="0 0 15 15" fill="none">
					<rect x="2.5" y="1" width="10" height="13" rx="1" stroke="currentColor" stroke-width="1.3"/>
					<path d="M5 4h5M5 6.5h5M5 9h3" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
				</svg>
			</button>

			{#if printLayout}
				<button
					class="btn-icon print-btn"
					onclick={handlePrint}
					title="Print"
					aria-label="Print"
				>
					<svg width="15" height="15" viewBox="0 0 15 15" fill="none">
						<path d="M4 5V1.5h7V5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
						<rect x="1.5" y="5" width="12" height="6" rx="1" stroke="currentColor" stroke-width="1.2"/>
						<path d="M4 8.5h7v5H4z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
						<circle cx="10.5" cy="7.5" r="0.6" fill="currentColor"/>
					</svg>
				</button>
			{/if}

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

	{#if showFindDialog}
		<div class="find-dialog" role="dialog" aria-label="Find and replace">
			<div class="find-row">
				<input
					class="find-input"
					bind:this={findInputEl}
					type="text"
					placeholder="Find"
					bind:value={findQuery}
					onkeydown={(e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							if (e.shiftKey) findPrev(); else findNext();
						}
						if (e.key === 'Escape') {
							e.preventDefault();
							closeFindDialog();
						}
					}}
				/>
				<span class="find-count" aria-live="polite">
					{#if findQuery && findMatches.length > 0}
						{activeFindIndex >= 0 ? activeFindIndex + 1 : 0}/{findMatches.length}
					{:else}
						0/0
					{/if}
				</span>
				<button class="find-btn" onclick={findPrev} disabled={!findMatches.length} aria-label="Previous match">Prev</button>
				<button class="find-btn" onclick={findNext} disabled={!findMatches.length} aria-label="Next match">Next</button>
				<button class="find-close" onclick={closeFindDialog} aria-label="Close find">
					<span class="find-close-icon" aria-hidden="true"></span>
				</button>
			</div>
			<div class="find-row">
				<input
					class="find-input"
					type="text"
					placeholder="Replace"
					bind:value={replaceQuery}
					onkeydown={(e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							replaceCurrentMatch();
						}
						if (e.key === 'Escape') {
							e.preventDefault();
							closeFindDialog();
						}
					}}
				/>
				<div class="find-replace-actions">
					<label class="find-case">
						<input type="checkbox" bind:checked={findCaseSensitive} />
						<span>Case</span>
					</label>
					<button class="find-btn" onclick={replaceCurrentMatch} disabled={!findMatches.length}>Replace</button>
					<button class="find-btn" onclick={replaceAllMatches} disabled={!findMatches.length}>All</button>
				</div>
			</div>
		</div>
	{/if}

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
			<span>Vault locked - viewing only. Unlock in the main window to edit and sync.</span>
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

	<!-- ── Formatting toolbar (sticky) ────────────────────────── -->
	<div class="format-bar" role="toolbar" aria-label="Text formatting">
		<!-- Undo / Redo -->
		<button class="fmt-btn" onmousedown={(e) => { e.preventDefault(); editor?.chain().focus().undo().run(); }} title="Undo" aria-label="Undo">
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
				<path d="M2 5H8a4 4 0 1 1 0 8H4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
				<path d="M4 2L1.5 5 4 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
		</button>
		<button class="fmt-btn" onmousedown={(e) => { e.preventDefault(); editor?.chain().focus().redo().run(); }} title="Redo" aria-label="Redo">
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
				<path d="M12 5H6a4 4 0 1 0 0 8h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
				<path d="M10 2l2.5 3L10 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
		</button>

		<div class="fmt-divider"></div>

		<!-- Bold -->
		<button class="fmt-btn" class:active={isBold}
			onmousedown={(e) => { e.preventDefault(); editor?.chain().focus().toggleBold().run(); }} title="Bold" aria-label="Bold" aria-pressed={isBold}>
			<svg width="13" height="14" viewBox="0 0 13 14" fill="none">
				<path d="M3 2h5a3 3 0 0 1 0 6H3V2zM3 8h5.5a3.5 3.5 0 0 1 0 7H3V8z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
			</svg>
		</button>
		<!-- Italic -->
		<button class="fmt-btn" class:active={isItalic}
			onmousedown={(e) => { e.preventDefault(); editor?.chain().focus().toggleItalic().run(); }} title="Italic" aria-label="Italic" aria-pressed={isItalic}>
			<svg width="11" height="14" viewBox="0 0 11 14" fill="none">
				<path d="M4 2h6M1 12h6M7 2L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
			</svg>
		</button>
		<!-- Underline -->
		<button class="fmt-btn" class:active={isUnderline}
			onmousedown={(e) => { e.preventDefault(); editor?.chain().focus().toggleUnderline().run(); }} title="Underline" aria-label="Underline" aria-pressed={isUnderline}>
			<svg width="13" height="15" viewBox="0 0 13 15" fill="none">
				<path d="M2 2v5a4.5 4.5 0 0 0 9 0V2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
				<line x1="1" y1="14" x2="12" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
			</svg>
		</button>
		<!-- Strikethrough -->
		<button class="fmt-btn" class:active={isStrike}
			onmousedown={(e) => { e.preventDefault(); editor?.chain().focus().toggleStrike().run(); }} title="Strikethrough" aria-label="Strikethrough" aria-pressed={isStrike}>
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
				<path d="M1 7h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
				<path d="M4 4c0-1.1.9-2 2-2h2a2 2 0 0 1 0 4H5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
				<path d="M6 7c.5 0 3 .5 3 2.5a2 2 0 0 1-2 2H4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
		</button>

		<div class="fmt-divider"></div>

		<!-- Bullet list -->
		<button class="fmt-btn" class:active={isUL}
			onmousedown={(e) => { e.preventDefault(); editor?.chain().focus().toggleBulletList().run(); }} title="Bullet list" aria-label="Bullet list" aria-pressed={isUL}>
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
				<circle cx="2" cy="4" r="1" fill="currentColor"/>
				<circle cx="2" cy="7" r="1" fill="currentColor"/>
				<circle cx="2" cy="10" r="1" fill="currentColor"/>
				<path d="M5 4h8M5 7h8M5 10h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
			</svg>
		</button>
		<!-- Ordered list -->
		<button class="fmt-btn" class:active={isOL}
			onmousedown={(e) => { e.preventDefault(); editor?.chain().focus().toggleOrderedList().run(); }} title="Numbered list" aria-label="Numbered list" aria-pressed={isOL}>
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
				<path d="M1.5 2v3M1 5h1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
				<path d="M1 8.5h1.5L1 10h1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
				<path d="M5 3.5h8M5 7h8M5 10.5h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
			</svg>
		</button>

		<div class="fmt-divider"></div>

		<!-- Font size - custom pixel picker -->
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
				<span class="fontsize-label">{currentFontSize}px</span>
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
								execFontSize(sz);
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
				<span class="color-preview" class:color-preview-default={colorIsDefault} style={colorIsDefault ? '' : `background: ${customColor}`}></span>
			</button>

			{#if showColorPicker}
				<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
				<div class="color-backdrop" onpointerdown={() => (showColorPicker = false)}></div>
				<div class="color-panel" bind:this={colorPanelEl} role="dialog" aria-label="Text color picker"
					onpointerdown={(e) => e.stopPropagation()}
					onclick={(e) => e.stopPropagation()}>
					<div class="color-swatches">
						<!-- Default: removes color mark, text uses theme default -->
						<button
							class="color-swatch color-swatch-default"
							class:active={colorIsDefault}
							onmousedown={(e) => { e.preventDefault(); unsetColor(); showColorPicker = false; }}
							aria-label="Default (remove color)"
							title="Default (remove color)"
						></button>
						{#each textColors as c}
							<button
								class="color-swatch"
								class:active={!colorIsDefault && customColor === c}
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

		<!-- Highlight (split button: icon toggles, arrow opens color picker) -->
		<div class="highlight-wrap">
			<button class="fmt-btn highlight-apply-btn" class:active={isHighlight}
				onmousedown={(e) => { e.preventDefault(); applyHighlight(); }}
				title="Highlight (current color)" aria-label="Highlight">
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
					<path d="M2 10l3-3 4-4 2 2-4 4-3 3-2-2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
					<path d="M8 4l2 2" stroke="currentColor" stroke-width="1.3"/>
					<path d="M2 12h3" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="color:{currentHighlightColor}"/>
				</svg>
			</button>
			<button class="fmt-btn highlight-arrow-btn"
				bind:this={highlightBtnEl}
				onmousedown={(e) => { e.preventDefault(); showHighlightPicker = !showHighlightPicker; showColorPicker = false; showFontSizePicker = false; }}
				title="Highlight color" aria-label="Highlight color" aria-expanded={showHighlightPicker}>
				<svg width="7" height="5" viewBox="0 0 7 5" fill="none" aria-hidden="true">
					<path d="M1 1l2.5 3L6 1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</button>
			{#if showHighlightPicker}
				<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
				<div class="color-backdrop" onpointerdown={() => (showHighlightPicker = false)}></div>
				<div class="color-panel highlight-color-panel" bind:this={highlightPanelEl} role="dialog" aria-label="Highlight color"
					onpointerdown={(e) => e.stopPropagation()}
					onclick={(e) => e.stopPropagation()}>
					<div class="color-swatches">
						{#each highlightPresets as p}
							<button
								class="color-swatch"
								class:active={currentHighlightColor === p.color}
								style="background: {p.color}"
								onmousedown={(e) => { e.preventDefault(); setHighlightColor(p.color); }}
								aria-label={p.label}
								title={p.label}
							></button>
						{/each}
					</div>
					<div class="color-custom-row">
						<input type="color" class="color-input-native" value={currentHighlightColor.slice(0, 7)}
							onchange={(e) => {
								const base = (e.currentTarget as HTMLInputElement).value;
								const alpha = customHlOpacity >= 100 ? '' : Math.round(customHlOpacity / 100 * 255).toString(16).padStart(2, '0');
								setHighlightColor(base + alpha);
							}} title="Custom highlight color" />
						<span class="color-custom-label">Custom</span>
					</div>
					<div class="color-custom-row">
						<input type="range" class="color-opacity-slider" min="10" max="100" step="5"
							value={customHlOpacity}
							oninput={(e) => {
								customHlOpacity = parseInt((e.currentTarget as HTMLInputElement).value, 10);
								localStorage.setItem(LS_HIGHLIGHT_OPACITY, String(customHlOpacity));
								const base = currentHighlightColor.slice(0, 7);
								const alpha = customHlOpacity >= 100 ? '' : Math.round(customHlOpacity / 100 * 255).toString(16).padStart(2, '0');
								const color = base + alpha;
								// Inline update - do NOT call setHighlightColor() here, it closes the picker
								currentHighlightColor = color;
								localStorage.setItem(LS_HIGHLIGHT_COLOR, color);
								if (editor?.isActive('highlight')) {
									(editor.chain().focus() as any).setHighlight({ color }).run();
									saved = false;
									scheduleAutosave();
								}
							}} title="Opacity" />
						<span class="color-custom-label">{customHlOpacity}%</span>
					</div>
				</div>
			{/if}
		</div>

		<!-- Inline code -->
		<button class="fmt-btn" class:active={isCode}
			onmousedown={(e) => { e.preventDefault(); editor?.chain().focus().toggleCode().run(); }} title="Inline code (`)" aria-label="Inline code">
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
				<path d="M4 4L1 7l3 3M10 4l3 3-3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
		</button>

		<div class="fmt-divider"></div>

		<!-- Heading dropdown -->
		<div class="fontsize-wrap">
			<button
				class="fmt-btn fontsize-btn heading-btn"
				class:active={activeHeading > 0}
				bind:this={headingBtnEl}
				onmousedown={(e) => {
					e.preventDefault();
					showHeadingPicker = !showHeadingPicker;
					showFontSizePicker = false;
					showColorPicker = false;
				}}
				title="Heading style"
				aria-label="Heading style"
				aria-expanded={showHeadingPicker}
			>
				<span class="fontsize-label">{activeHeading === 0 ? 'P' : `H${activeHeading}`}</span>
				<svg width="8" height="5" viewBox="0 0 8 5" fill="none" aria-hidden="true">
					<path d="M1 1l3 3 3-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</button>
			{#if showHeadingPicker}
				<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
				<div class="fontsize-backdrop" onclick={() => (showHeadingPicker = false)}></div>
				<div class="fontsize-panel" bind:this={headingPanelEl} role="listbox" aria-label="Heading style">
					{#each [['P','Paragraph',0],['H1','Heading 1',1],['H2','Heading 2',2],['H3','Heading 3',3],['H4','Heading 4',4]] as [label,name,level]}
						<button class="fontsize-option" class:active={activeHeading === level}
							role="option" aria-selected={activeHeading === level}
							onmousedown={(e) => {
								e.preventDefault();
								if (level === 0) editor?.chain().focus().setParagraph().run();
								else editor?.chain().focus().toggleHeading({ level: level as any }).run();
								showHeadingPicker = false;
							}}>
							<span style="font-size:{level === 0 ? 13 : level === 1 ? 18 : level === 2 ? 15 : 13}px;font-weight:{level === 0 ? 400 : 600}">{name}</span>
						</button>
					{/each}
				</div>
			{/if}
		</div>

		<div class="fmt-divider"></div>

		<!-- Task list -->
		<button class="fmt-btn" class:active={isTaskList}
			onmousedown={(e) => { e.preventDefault(); editor?.chain().focus().toggleTaskList().run(); }} title="Task list" aria-label="Task list">
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
				<rect x="1.5" y="1.5" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/>
				<path d="M3 4l1.2 1.2L6.5 2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
				<path d="M8 4h5M8 7h5M8 10h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
				<rect x="1.5" y="8.5" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/>
			</svg>
		</button>

		<!-- Blockquote -->
		<button class="fmt-btn" class:active={isBlockquote}
			onmousedown={(e) => { e.preventDefault(); editor?.chain().focus().toggleBlockquote().run(); }} title="Blockquote (Ctrl+Shift+B)" aria-label="Blockquote">
			<svg width="14" height="12" viewBox="0 0 14 12" fill="none">
				<path d="M1 1h4v5H1zM8 1h4v5H8z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
				<path d="M3 6v5M11 6v5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
			</svg>
		</button>

		<!-- Code block -->
		<button class="fmt-btn" class:active={isCodeBlock}
			onmousedown={(e) => { e.preventDefault(); editor?.chain().focus().toggleCodeBlock().run(); }} title="Code block" aria-label="Code block">
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
				<rect x="1" y="2" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.3"/>
				<path d="M4 6L2 8l2 2M10 6l2 2-2 2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
				<path d="M8 5l-2 6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
			</svg>
		</button>

		<div class="fmt-divider"></div>

		<!-- Link insert -->
		<div class="color-wrap">
			<button
				class="fmt-btn"
				class:active={editor?.isActive('link')}
				bind:this={linkBtnEl}
				onmousedown={(e) => {
					e.preventDefault();
					if (editor?.isActive('link')) { removeLink(); return; }
					linkUrl = editor?.getAttributes('link').href ?? '';
					showLinkDialog = !showLinkDialog;
					showImageDialog = false;
					showColorPicker = false;
					showFontSizePicker = false;
				}}
				title={editor?.isActive('link') ? 'Remove link' : 'Insert link (Ctrl+K)'}
				aria-label="Link"
			>
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
					<path d="M5.5 8.5a3.5 3.5 0 0 0 5 0l1.5-1.5a3.5 3.5 0 0 0-5-5L5.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
					<path d="M8.5 5.5a3.5 3.5 0 0 0-5 0L2 7a3.5 3.5 0 0 0 5 5L8.5 10.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
				</svg>
			</button>
			{#if showLinkDialog}
				<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
				<div class="color-backdrop" onclick={() => (showLinkDialog = false)}></div>
				<div id="link-dialog" class="link-dialog" role="dialog" aria-label="Insert link">
					<!-- svelte-ignore a11y_autofocus -->
					<input
						class="link-input"
						type="url"
						placeholder="https://…"
						bind:value={linkUrl}
						autofocus
						onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); insertLink(); } if (e.key === 'Escape') showLinkDialog = false; }}
					/>
					<button class="link-apply-btn" onmousedown={(e) => { e.preventDefault(); insertLink(); }}>Apply</button>
				</div>
			{/if}
		</div>

		<!-- Image insert -->
		<div class="color-wrap">
			<button
				class="fmt-btn"
				bind:this={imageBtnEl}
				onmousedown={(e) => {
					e.preventDefault();
					showImageDialog = !showImageDialog;
					showLinkDialog = false;
					showColorPicker = false;
					showFontSizePicker = false;
				}}
				title="Insert image"
				aria-label="Insert image"
			>
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
					<rect x="1" y="2" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.3"/>
					<circle cx="4.5" cy="5.5" r="1" fill="currentColor"/>
					<path d="M1 9.5l3.5-3 3 3 2-2 3.5 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</button>
			{#if showImageDialog}
				<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
				<div class="color-backdrop" onclick={() => (showImageDialog = false)}></div>
				<div id="image-dialog" class="link-dialog image-dialog" role="dialog" aria-label="Insert image">
					<!-- svelte-ignore a11y_autofocus -->
					<input
						class="link-input"
						type="url"
						placeholder="Image URL…"
						bind:value={imageUrl}
						autofocus
						onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); insertImageFromUrl(); } if (e.key === 'Escape') showImageDialog = false; }}
					/>
					<button class="link-apply-btn" onmousedown={(e) => { e.preventDefault(); insertImageFromUrl(); }}>URL</button>
					<label class="link-file-btn" title="Upload from device">
						<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
							<path d="M6 1v7M3.5 3.5L6 1l2.5 2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
							<path d="M1 9v1a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
						</svg>
						<input
							type="file"
							accept="image/*"
							bind:this={imageFileInput}
							onchange={handleImageFile}
							style="display:none"
						/>
					</label>
				</div>
			{/if}
		</div>

		<!-- File attachment -->
		<label class="fmt-btn" title="Attach file" aria-label="Attach file" bind:this={fileBtnEl}>
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
				<path d="M12 7.5l-5 5a3.5 3.5 0 0 1-5-5l5.5-5.5a2 2 0 0 1 2.8 2.8L5 10.1a.5.5 0 0 1-.7-.7l5-5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
			<input type="file" style="display:none" onchange={handleAttachFile} />
		</label>

		<div class="fmt-divider"></div>

		<!-- Insert table -->
		<button class="fmt-btn" title="Insert table" aria-label="Insert table"
			onmousedown={(e) => { e.preventDefault(); editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); }}>
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
				<rect x="1" y="1" width="12" height="12" rx="1" stroke="currentColor" stroke-width="1.3"/>
				<path d="M1 5h12M1 9h12M5 1v12M9 1v12" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
			</svg>
		</button>

		<!-- Table controls (shown when cursor is inside a table) -->
		{#if isInTable}
			<button class="fmt-btn" title="Add row below" aria-label="Add row"
				onmousedown={(e) => { e.preventDefault(); editor?.chain().focus().addRowAfter().run(); }}>
				<svg width="14" height="12" viewBox="0 0 14 12" fill="none">
					<rect x="1" y="1" width="12" height="7" rx="1" stroke="currentColor" stroke-width="1.2"/>
					<path d="M7 9v3M5.5 10.5h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
				</svg>
			</button>
			<button class="fmt-btn" title="Add column after" aria-label="Add column"
				onmousedown={(e) => { e.preventDefault(); editor?.chain().focus().addColumnAfter().run(); }}>
				<svg width="12" height="14" viewBox="0 0 12 14" fill="none">
					<rect x="1" y="1" width="7" height="12" rx="1" stroke="currentColor" stroke-width="1.2"/>
					<path d="M9 7h3M10.5 5.5v3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
				</svg>
			</button>
			<button class="fmt-btn" title="Delete row" aria-label="Delete row"
				onmousedown={(e) => { e.preventDefault(); editor?.chain().focus().deleteRow().run(); }}>
				<svg width="14" height="12" viewBox="0 0 14 12" fill="none">
					<rect x="1" y="1" width="12" height="7" rx="1" stroke="currentColor" stroke-width="1.2"/>
					<path d="M5 10.5l2 1.5 2-1.5" stroke="var(--danger)" stroke-width="1.3" stroke-linecap="round"/>
				</svg>
			</button>
			<button class="fmt-btn" title="Delete column" aria-label="Delete column"
				onmousedown={(e) => { e.preventDefault(); editor?.chain().focus().deleteColumn().run(); }}>
				<svg width="12" height="14" viewBox="0 0 12 14" fill="none">
					<rect x="1" y="1" width="7" height="12" rx="1" stroke="currentColor" stroke-width="1.2"/>
					<path d="M9.5 9.5l1.5 2-1.5-0.5" stroke="var(--danger)" stroke-width="1.3" stroke-linecap="round"/>
				</svg>
			</button>
			<button class="fmt-btn" title="Delete table" aria-label="Delete table"
				onmousedown={(e) => { e.preventDefault(); editor?.chain().focus().deleteTable().run(); }}>
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
					<rect x="1" y="1" width="12" height="12" rx="1" stroke="var(--danger)" stroke-width="1.3"/>
					<path d="M4 4l6 6M10 4l-6 6" stroke="var(--danger)" stroke-width="1.3" stroke-linecap="round"/>
				</svg>
			</button>
		{/if}

		<div class="fmt-divider"></div>

		<!-- Clear formatting -->
		<button class="fmt-btn" onmousedown={(e) => { e.preventDefault(); clearFormatting(); }} title="Clear formatting" aria-label="Clear formatting">
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
				<path d="M2 3h10M4.5 3l1 8M9.5 3l-1 8M6 7h2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
				<path d="M10 11l3 3M13 11l-3 3" stroke="var(--danger)" stroke-width="1.3" stroke-linecap="round"/>
			</svg>
		</button>
	</div>

	<!-- ── TipTap editor + image resize overlay wrapper ───────── -->
	<div class="editor-scroll-area" bind:this={scrollAreaEl}>
		<!-- Print layout wrapper — outer sizes the scroll area to the scaled dimensions;
		     inner renders at full A4 width and is visually scaled via transform.
		     This pattern works on real iOS Safari where CSS zoom on flex children
		     with min-width does not correctly reduce the layout footprint. -->
		<div class="print-scale-outer"
			style={printLayout && mobilePrintScale !== 1
				? `width:${(A4_PAGE_W+48)*mobilePrintScale}px;overflow:hidden;${_contentNaturalH > 0 ? `height:${(_contentNaturalH*mobilePrintScale).toFixed(1)}px;` : ''}flex:none;align-self:flex-start;`
				: ''}
		>
			<div class="editor-content-wrap" class:print-layout-wrap={printLayout} bind:this={contentWrapEl}
				 style={printLayout && mobilePrintScale !== 1 ? `transform:scale(${mobilePrintScale});transform-origin:top left;` : ''}>
				<div class="body-editor-wrap" bind:this={editorEl}></div>
			</div>
		</div>

		<!-- Link hover tooltip -->
		{#if linkTooltip}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="link-tooltip"
				class:link-tooltip-fade={!_linkTooltipVisible}
				style="left: {linkTooltip.x}px; top: {linkTooltip.y}px"
				onmouseenter={() => { _mouseOnTooltip = true; if (_linkTooltipFadeTimer) { clearTimeout(_linkTooltipFadeTimer); _linkTooltipFadeTimer = null; } _linkTooltipVisible = true; }}
				onmouseleave={() => { _mouseOnTooltip = false; if (!_cursorInLink && !_mouseOnLink) scheduleLinkTooltipHide(); }}
			>
				<a
					href={linkTooltip.href}
					target="_blank"
					rel="noopener noreferrer"
					class="link-tooltip-anchor"
					onclick={() => { hideLinkTooltipImmediate(); }}
				>
					<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M1 9L9 1M9 1H4M9 1v5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
					<span class="link-tooltip-text">{linkTooltip.href}</span>
				</a>
			</div>
		{/if}

	</div>
	<!-- ── Word count footer ─────────────────────────────── -->
	<div class="word-count" aria-live="polite" aria-atomic="true">
		<span>{wordCount} word{wordCount === 1 ? '' : 's'}</span>
		<span class="count-sep">·</span>
		<span>{charCount} char{charCount === 1 ? '' : 's'}</span>
		<span class="count-sep">·</span>
		<span>{lineCount} line{lineCount === 1 ? '' : 's'}</span>
	</div>
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
			<input id="topic-name-e" type="text" bind:value={topicName} placeholder="Topic name" autocorrect="off" autocapitalize="words"
				onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveTopicModal(); } }} />
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
			<input id="folder-name-e" type="text" bind:value={folderName} placeholder="Folder name" autocorrect="off" autocapitalize="words"
				onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveFolderModal(); } }} />
		</div>
		<div class="modal-field">
			<label class="field-label" for="folder-parent-e">Parent folder</label>
			<select id="folder-parent-e" bind:value={folderParentId}
				onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveFolderModal(); } }}>
				<option value={null}>- Root (no parent) -</option>
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

<!-- ── File preview modal ──────────────────────────────────────────── -->
{#if previewState}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="preview-backdrop" onclick={closePreview} onkeydown={(e) => e.key === 'Escape' && closePreview()}>
		<div class="preview-modal" onclick={(e) => e.stopPropagation()}>
			<div class="preview-header">
				<span class="preview-filename">{previewState.fileName}</span>
				<div class="preview-header-actions">
					<button class="btn-ghost preview-dl-btn" onclick={async () => {
							const dataUri = await loadAttachment(previewState!.hash, auth.userId!, auth.dek);
							if (!dataUri) return;
							const comma = dataUri.indexOf(",");
							const b64 = dataUri.slice(comma + 1);
							const binary = atob(b64);
							const bytes = new Uint8Array(binary.length);
							for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
							const mime = dataUri.slice(5, comma).split(";")[0];
							const blob = new Blob([bytes], { type: mime });
							const blobUrl = URL.createObjectURL(blob);
							const a = document.createElement("a");
							a.href = blobUrl;
							a.download = previewState!.fileName;
							a.target = "_blank";
							document.body.appendChild(a);
							a.click();
							document.body.removeChild(a);
							setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
						}}>
						<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v7M3.5 6l2.5 2 2.5-2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M1 10h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
						Download
					</button>
					<button class="preview-close-btn" onclick={closePreview} aria-label="Close preview">
						<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
					</button>
				</div>
			</div>
			<div class="preview-body">
				{#if previewLoading}
					<div class="preview-loading">Loading…</div>
				{:else if !previewContent}
					<div class="preview-error">Attachment unavailable (vault may be locked or file missing).</div>
				{:else if previewState.mimeType === 'application/pdf'}
					{#if _isIOS}
						<div class="preview-pdf-ios">
							<p>PDF inline preview is not supported on iOS Safari.</p>
							<p>Tap the <strong>Download</strong> button above to open it in a PDF viewer.</p>
						</div>
					{:else if _isSafariDesktop}
						<!-- Safari desktop blocks object/plugin PDFs; iframe works -->
						<iframe
							src={previewContent}
							class="preview-pdf"
							title={previewState.fileName}
						></iframe>
					{:else}
						<!-- Chrome/Edge/Firefox: object tag renders blob PDFs reliably -->
						<object
							data={previewContent}
							type="application/pdf"
							class="preview-pdf"
							aria-label={previewState.fileName}
						>
							<p class="preview-error">PDF cannot display inline - use the Download button.</p>
						</object>
					{/if}
				{:else}
					<!-- previewContent is already decoded text (set in openPreview) -->
					<pre class="preview-text">{previewContent}</pre>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.editor-page {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
		position: relative;
		isolation: isolate;
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

	@media (hover: hover) { .save-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 16%, transparent); } }

	.save-btn:disabled {
		color: var(--text-faint);
		border-color: transparent;
		background: transparent;
		opacity: 1;
		cursor: default;
	}

	.delete-btn { color: var(--text-faint); }
	@media (hover: hover) {
		.delete-btn:hover {
			color: var(--danger);
			background: color-mix(in srgb, var(--danger) 10%, transparent);
		}
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

	@media (hover: hover) { .conflict-btn-resolve:hover { opacity: 0.85; } }

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

	@media (hover: hover) {
		.conflict-btn-dismiss:hover {
			color: var(--text);
			border-color: var(--text-muted);
		}
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
	@media (hover: hover) { .incoming-btn-accept:hover { opacity: 0.85; } }
	.incoming-btn-dismiss {
		padding: 4px 10px; font-size: 12px; font-weight: 500;
		background: transparent; color: var(--text-muted);
		border: 1px solid var(--border); border-radius: var(--radius-sm);
		cursor: pointer; transition: color 0.12s, border-color 0.12s;
	}
	@media (hover: hover) { .incoming-btn-dismiss:hover { color: var(--text); border-color: var(--text-muted); } }

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

	@media (hover: hover) { .conflict-diff-close:hover { color: var(--text); } }

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

	@media (hover: hover) {
		.conflict-pick-btn:hover:not(:disabled) {
			background: var(--accent);
			color: #fff;
			border-color: var(--accent);
		}
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

	@media (hover: hover) {
		.conflict-pick-btn-merge:hover:not(:disabled) {
			background: var(--accent);
			color: #fff;
			border-color: var(--accent);
		}
	}

	/* ── Formatting toolbar ───────────────────────────────────── */
	/* The toolbar is a flex-shrink:0 sibling above .editor-scroll-area.
	   Since .editor-page has overflow:hidden, the only thing that scrolls
	   is .editor-scroll-area - so the format-bar is always visible. */
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
		position: relative;
		z-index: 105; /* higher than editor elements to prevent popups from appearing behind */
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

	@media (hover: hover) { .fmt-btn:hover { background: var(--bg-hover); color: var(--text); } }

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

	.fontsize-backdrop { position: fixed; inset: 0; z-index: 1500; }

	.fontsize-panel {
		position: fixed;
		z-index: 1501;
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

	.fontsize-option.active {
		background: var(--bg-hover);
		color: var(--text);
	}
	@media (hover: hover) {
		.fontsize-option:hover {
			background: var(--bg-hover);
			color: var(--text);
		}
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
	/* When cursor is on plain (uncolored) text - show a slash to indicate "no color" */
	.color-preview.color-preview-default {
		background: transparent;
		border: 1px solid var(--text-muted);
		position: relative;
		overflow: hidden;
	}
	.color-preview.color-preview-default::after {
		content: '';
		position: absolute;
		top: 50%;
		left: -1px;
		width: 14px;
		height: 1px;
		background: var(--text-muted);
		transform: rotate(-45deg);
		transform-origin: center;
	}

	.color-backdrop { position: fixed; inset: 0; z-index: 1500; }

	.color-panel {
		position: fixed;
		z-index: 1501;
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

	@media (hover: hover) { .color-swatch:hover { transform: scale(1.2); border-color: var(--text); } }
	.color-swatch.active { border-color: var(--text); }

	/* Default color swatch - slash-circle to indicate "no color" */
	.color-swatch-default {
		background: transparent;
		border-color: var(--border);
		position: relative;
		overflow: hidden;
	}
	.color-swatch-default::after {
		content: '';
		display: block;
		position: absolute;
		inset: 0;
		background: linear-gradient(
			to top right,
			transparent calc(50% - 1px),
			var(--danger) calc(50% - 1px),
			var(--danger) calc(50% + 1px),
			transparent calc(50% + 1px)
		);
	}
	.color-swatch-default.active { border-color: var(--text); }

	/* ── Highlight split button ───────────────────────────────────── */
	.highlight-wrap {
		position: relative;
		display: flex;
		align-items: center;
	}
	.highlight-apply-btn { border-radius: var(--radius-sm) 0 0 var(--radius-sm) !important; }
	.highlight-arrow-btn {
		padding: 0 4px !important;
		min-width: 16px !important;
		border-radius: 0 var(--radius-sm) var(--radius-sm) 0 !important;
		border-left: 1px solid var(--border) !important;
	}
	.highlight-color-panel { min-width: 180px; }

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

	.color-custom-label { font-size: 11px; color: var(--text-muted); min-width: 28px; text-align: right; }

	.color-opacity-slider {
		flex: 1;
		min-width: 0;
		height: 4px;
		cursor: pointer;
		accent-color: var(--accent);
	}

	/* ── Editor scroll area + body wrap ─────────────────────── */
	/* .editor-scroll-area is the only element that scrolls.
	   This keeps .format-bar always visible above it. */
	.editor-scroll-area {
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
		-webkit-overflow-scrolling: touch;
		overscroll-behavior: contain;
		touch-action: pan-y pinch-zoom;
		position: relative; /* for the image resize overlay */
		display: flex;
		flex-direction: column;
	}

	.editor-page.print-layout .editor-scroll-area {
		overflow: auto;
		overflow-x: auto;
		touch-action: manipulation;
		overscroll-behavior: contain;
		scrollbar-gutter: stable;
	}

	/* Default (non-print-scale) state: transparent pass-through flex child */
	.print-scale-outer {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	.editor-content-wrap {
		flex: 1;
		display: flex;
		flex-direction: column;
	}
	.editor-content-wrap.print-layout-wrap {
		position: relative;
		display: block;
		flex: 0 0 auto;
		width: 100%;          /* fill scroll area so body-editor-wrap can center */
		min-width: calc(794px + 48px); /* never narrower than A4 + side padding */
		padding: 24px 24px 40px;
		box-sizing: border-box;
	}

	.body-editor-wrap {
		flex: 1;
		overflow-x: hidden;
	}

	/* ProseMirror is the actual contenteditable TipTap renders */
	.body-editor-wrap :global(.ProseMirror) {
		min-height: 100%;
		padding: 14px 20px 40px;
		font-size: 16px;
		line-height: 1.7;
		color: var(--text);
		outline: none;
		word-break: break-word;
		font-family: inherit;
	}

	/* Placeholder via TipTap Placeholder extension */
	.body-editor-wrap :global(.ProseMirror p.is-editor-empty:first-child::before) {
		content: attr(data-placeholder);
		color: var(--text-faint);
		pointer-events: none;
		float: left;
		height: 0;
	}

	/* Content styles */
	.body-editor-wrap :global(.ProseMirror ul)  { padding-left: 1.4em; list-style-type: disc; }
	.body-editor-wrap :global(.ProseMirror ol)  { padding-left: 1.4em; list-style-type: decimal; }
	.body-editor-wrap :global(.ProseMirror li)  { margin-bottom: 2px; }
	.body-editor-wrap :global(.ProseMirror p)   { margin: 0 0 0.25em; }
	.body-editor-wrap :global(.ProseMirror h1)  { font-size: 1.7em; font-weight: 700; margin: 0.8em 0 0.3em; line-height: 1.3; }
	.body-editor-wrap :global(.ProseMirror h2)  { font-size: 1.35em; font-weight: 600; margin: 0.7em 0 0.3em; line-height: 1.35; }
	.body-editor-wrap :global(.ProseMirror h3)  { font-size: 1.1em; font-weight: 600; margin: 0.6em 0 0.25em; }
	.body-editor-wrap :global(.ProseMirror strong) { font-weight: 700; }
	.body-editor-wrap :global(.ProseMirror em)     { font-style: italic; }
	.body-editor-wrap :global(.ProseMirror u)      { text-decoration: underline; }
	.body-editor-wrap :global(.ProseMirror s)      { text-decoration: line-through; }
	.body-editor-wrap :global(.ProseMirror code) {
		font-family: ui-monospace, 'Cascadia Code', monospace;
		background: var(--bg-hover);
		padding: 1px 5px;
		border-radius: 3px;
		font-size: 0.88em;
		color: var(--text);
	}
	.body-editor-wrap :global(.code-block-wrap) {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		margin: 0.5em 0;
		overflow: hidden;
	}
	.body-editor-wrap :global(.code-block-header) {
		display: flex;
		align-items: center;
		padding: 4px 8px;
		background: color-mix(in srgb, var(--border) 60%, var(--bg-elevated));
		border-bottom: 1px solid var(--border);
	}
	.body-editor-wrap :global(.code-block-lang) {
		font-size: 11px;
		color: var(--text-muted);
		background: transparent;
		border: none;
		outline: none;
		cursor: pointer;
		padding: 0 2px;
	}
	.body-editor-wrap :global(.code-block-lang option) {
		background: var(--bg-elevated);
		color: var(--text);
	}
	.body-editor-wrap :global(.ProseMirror pre) {
		background: var(--bg-hover);
		padding: 12px 14px;
		margin: 0;
		overflow-x: auto;
	}
	.body-editor-wrap :global(.ProseMirror pre code) {
		background: none;
		padding: 0;
		font-size: 0.875em;
	}

	/* ── Syntax highlighting (lowlight / highlight.js token classes) ── */
	.body-editor-wrap :global(.hljs-comment),
	.body-editor-wrap :global(.hljs-quote)           { color: #6b7280; font-style: italic; }
	.body-editor-wrap :global(.hljs-keyword),
	.body-editor-wrap :global(.hljs-selector-tag),
	.body-editor-wrap :global(.hljs-built_in)        { color: #c084fc; }
	.body-editor-wrap :global(.hljs-string),
	.body-editor-wrap :global(.hljs-attr),
	.body-editor-wrap :global(.hljs-addition)        { color: #4ade80; }
	.body-editor-wrap :global(.hljs-number),
	.body-editor-wrap :global(.hljs-literal)         { color: #fb923c; }
	.body-editor-wrap :global(.hljs-function),
	.body-editor-wrap :global(.hljs-title)           { color: #60a5fa; }
	.body-editor-wrap :global(.hljs-variable),
	.body-editor-wrap :global(.hljs-name)            { color: #f87171; }
	.body-editor-wrap :global(.hljs-type),
	.body-editor-wrap :global(.hljs-class .hljs-title) { color: #facc15; }
	.body-editor-wrap :global(.hljs-meta),
	.body-editor-wrap :global(.hljs-doctag)          { color: #38bdf8; }
	.body-editor-wrap :global(.hljs-deletion)        { color: #f87171; }
	.body-editor-wrap :global(.hljs-section)         { color: #6b8afd; font-weight: 600; }
	.body-editor-wrap :global(.hljs-subst)           { color: var(--text); }
	/* light mode adjustments */
	:global([data-theme='light']) .body-editor-wrap :global(.hljs-comment) { color: #9ca3af; }
	:global([data-theme='light']) .body-editor-wrap :global(.hljs-keyword) { color: #7c3aed; }
	:global([data-theme='light']) .body-editor-wrap :global(.hljs-string)  { color: #16a34a; }
	:global([data-theme='light']) .body-editor-wrap :global(.hljs-number)  { color: #ea580c; }
	:global([data-theme='light']) .body-editor-wrap :global(.hljs-function){ color: #2563eb; }
	:global([data-theme='light']) .body-editor-wrap :global(.hljs-variable){ color: #dc2626; }
	:global([data-theme='light']) .body-editor-wrap :global(.hljs-type)    { color: #b45309; }
	.body-editor-wrap :global(.ProseMirror blockquote) {
		border-left: 3px solid var(--border);
		padding-left: 1em;
		color: var(--text-muted);
		margin: 0.5em 0;
	}
	.body-editor-wrap :global(.ProseMirror hr) {
		border: none;
		border-top: 1px solid var(--border);
		margin: 1em 0;
	}

	/* Tables — max-width prevents horizontal page overflow.
	   Do NOT set table-layout:fixed or overflow:hidden -
	   those break ProseMirror's column-resize-handle drag. */
	.body-editor-wrap :global(.ProseMirror table) {
		border-collapse: collapse;
		margin: 0.75em 0;
		max-width: 100%;
	}
	.body-editor-wrap :global(.ProseMirror td),
	.body-editor-wrap :global(.ProseMirror th) {
		border: 1px solid var(--border);
		padding: 6px 10px;
		vertical-align: top;
		min-width: 60px;
		position: relative;
	}
	.body-editor-wrap :global(.ProseMirror th) {
		background: var(--bg-hover);
		font-weight: 600;
		font-size: 12.5px;
		color: var(--text-muted);
	}
	.body-editor-wrap :global(.ProseMirror .selectedCell::after) {
		content: '';
		position: absolute;
		inset: 0;
		background: color-mix(in srgb, var(--accent) 15%, transparent);
		pointer-events: none;
	}
	.body-editor-wrap :global(.ProseMirror .column-resize-handle) {
		position: absolute;
		right: -2px;
		top: 0;
		bottom: 0;
		width: 4px;
		background: var(--accent);
		cursor: col-resize;
		z-index: 20;
	}

	/* Gapcursor - blinking cursor that appears before/after block nodes
	   (tables, images) that cannot hold a real text cursor inside.
	   This is the canonical ProseMirror gapcursor CSS. Without it the
	   cursor exists but is invisible, so clicks appear to do nothing. */
	.body-editor-wrap :global(.ProseMirror-gapcursor) {
		display: none;
		pointer-events: none;
		position: relative;
	}
	.body-editor-wrap :global(.ProseMirror-focused .ProseMirror-gapcursor) {
		display: block;
	}
	.body-editor-wrap :global(.ProseMirror-gapcursor:after) {
		content: '';
		display: block;
		position: absolute;
		top: -2px;
		width: 20px;
		border-top: 2px solid var(--text);
		animation: ProseMirror-cursor-blink 1.1s steps(2, start) infinite;
	}
	@keyframes ProseMirror-cursor-blink {
		to { visibility: hidden; }
	}
	/* The gapcursor div is inserted as a sibling of the block node.
	   :after positions left=0 by default (cursor before the block).
	   When cursor is after the block, ProseMirror puts the gapcursor after it. */

	/* Images - NodeView wrapper always shrink-wraps the image.
	   JS sets display/float per alignment mode; CSS just ensures
	   the wrapper never grows beyond the image itself. */
	.body-editor-wrap :global(.img-node-wrapper) {
		position: relative;
		width: fit-content;   /* shrink-wrap - never stretches full editor width */
		max-width: 100%;
		line-height: 0;       /* prevents phantom gap below image */
		user-select: none;
	}
	/* Selected state */
	.body-editor-wrap :global(.img-node-wrapper.ProseMirror-selectednode) {
		outline: 2px solid var(--accent);
		border-radius: 3px;
	}
	.body-editor-wrap :global(.img-node-wrapper img) {
		max-width: 100%;
		height: auto;
		border-radius: var(--radius-sm);
		display: block;
		cursor: default;
	}

	/* Alignment toolbar - visible on hover or selection */
	.body-editor-wrap :global(.img-align-toolbar) {
		display: none;
		position: absolute;
		top: 6px;
		left: 6px;
		z-index: 10;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 3px 4px;
		gap: 2px;
		flex-direction: row;
		box-shadow: 0 2px 8px rgba(0,0,0,0.4);
	}
	.body-editor-wrap :global(.img-node-wrapper.ProseMirror-selectednode .img-align-toolbar) {
		display: flex;
	}
	@media (hover: hover) {
		.body-editor-wrap :global(.img-node-wrapper:hover .img-align-toolbar) {
			display: flex;
		}
	}
	.body-editor-wrap :global(.img-align-btn) {
		background: none;
		border: none;
		border-radius: 4px;
		color: var(--text-muted);
		cursor: pointer;
		padding: 3px 4px;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: background 0.1s, color 0.1s;
	}
	@media (hover: hover) {
		.body-editor-wrap :global(.img-align-btn:hover) {
			background: var(--bg-hover);
			color: var(--text);
		}
	}
	.body-editor-wrap :global(.img-align-btn.active) {
		background: color-mix(in srgb, var(--accent) 18%, transparent);
		color: var(--accent);
	}

	/* Resize handle: right edge */
	.body-editor-wrap :global(.img-resize-handle-inline) {
		position: absolute;
		right: -4px;
		top: 50%;
		transform: translateY(-50%);
		width: 8px;
		height: 40px;
		background: var(--accent);
		border-radius: 4px;
		cursor: ew-resize;
		opacity: 0;
		transition: opacity 0.15s;
		z-index: 5;
	}
	.body-editor-wrap :global(.img-node-wrapper.ProseMirror-selectednode .img-resize-handle-inline) {
		opacity: 0.85;
	}
	@media (hover: hover) {
		.body-editor-wrap :global(.img-node-wrapper:hover .img-resize-handle-inline) {
			opacity: 0.85;
		}
	}

	/* Clear floats after each block so subsequent content is not pulled up */
	.body-editor-wrap :global(.ProseMirror > * + *) {
		clear: none; /* individual clearfix where needed */
	}
	/* Paragraph after a floated image should clear it when there's no more text to wrap */
	.body-editor-wrap :global(.img-node-wrapper[style*="float"] + p:empty),
	.body-editor-wrap :global(.img-node-wrapper[style*="float"] + br) {
		clear: both;
	}

	/* Task list */
	.body-editor-wrap :global(.ProseMirror ul[data-type="taskList"]) {
		list-style: none;
		padding-left: 0.5em;
	}
	.body-editor-wrap :global(.ProseMirror ul[data-type="taskList"] li) {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		margin-bottom: 3px;
	}
	.body-editor-wrap :global(.ProseMirror ul[data-type="taskList"] li > label) {
		flex-shrink: 0;
		margin-top: 3px;
		cursor: pointer;
	}
	.body-editor-wrap :global(.ProseMirror ul[data-type="taskList"] li > div) {
		flex: 1;
		min-width: 0;
	}
	.body-editor-wrap :global(.ProseMirror ul[data-type="taskList"] input[type="checkbox"]) {
		accent-color: var(--accent);
		width: 14px;
		height: 14px;
		cursor: pointer;
	}
	.body-editor-wrap :global(.ProseMirror ul[data-type="taskList"] li[data-checked="true"] > div) {
		text-decoration: line-through;
		color: var(--text-faint);
	}

	/* Highlight */
	/* The Highlight extension now stores color as --hl-color CSS custom property.
	   color-mix makes any highlight semi-transparent so text remains readable
	   on both dark and light themes. The 45% blend gives a visible tint without
	   washing out text. */
	.body-editor-wrap :global(.ProseMirror mark) {
		background: color-mix(in srgb, var(--hl-color, #faf594) 45%, transparent);
		color: var(--text);
		border-radius: 2px;
		padding: 0 1px;
	}

	/* Link cursor */
	.body-editor-wrap :global(.ProseMirror a) {
		color: var(--accent);
		text-decoration: underline;
		cursor: text;
	}

	/* Link hover tooltip */
	.link-tooltip {
		position: absolute;
		z-index: 500;
		transform: translateX(-50%);
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 5px 10px;
		box-shadow: 0 4px 16px rgba(0,0,0,0.18);
		pointer-events: auto;
		opacity: 1;
		transition: opacity 0.5s ease;
		max-width: min(320px, 90vw);
	}
	.link-tooltip.link-tooltip-fade {
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.15s ease;
	}
	.link-tooltip-anchor {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--accent);
		text-decoration: none;
		font-size: 12px;
		line-height: 1.4;
		cursor: pointer;
	}
	@media (hover: hover) { .link-tooltip-anchor:hover { text-decoration: underline; } }
	.link-tooltip-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 280px;
		display: block;
	}
	.preview-pdf-ios {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100%;
		gap: 8px;
		color: var(--text-muted);
		font-size: 14px;
		text-align: center;
		padding: 32px;
	}

	/* Link / image insert dialog */
	.link-dialog {
		position: fixed;
		z-index: 1501;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		padding: 8px;
		display: flex;
		align-items: center;
		gap: 6px;
		box-shadow: 0 8px 24px rgba(0,0,0,0.5);
		min-width: 280px;
	}

	.find-dialog {
		position: fixed;
		top: max(env(safe-area-inset-top, 0px), 12px);
		right: 12px;
		z-index: 1600;
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px;
		width: min(520px, calc(100vw - 24px));
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		box-shadow: 0 10px 28px rgba(0,0,0,0.45);
	}
	.find-row {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.find-input {
		flex: 1;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		color: var(--text);
		font-size: 13px;
		padding: 6px 10px;
		outline: none;
		font-family: inherit;
	}
	.find-input:focus { border-color: var(--accent); }
	/* Prevent iOS auto-zoom on focus — triggered when font-size < 16px */
	@media (hover: none) {
		.find-input { font-size: 16px; }
	}
	.find-count {
		font-size: 12px;
		color: var(--text-faint);
		min-width: 42px;
		text-align: center;
	}
	.find-btn {
		padding: 6px 10px;
		font-size: 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--bg-hover);
		color: var(--text-muted);
		cursor: pointer;
		white-space: nowrap;
	}
	.find-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	@media (hover: hover) {
		.find-btn:hover:not(:disabled) {
			background: color-mix(in srgb, var(--accent) 10%, transparent);
			color: var(--accent);
		}
	}
	.find-close {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		background: none;
		border: none;
		border-radius: var(--radius-sm);
		color: var(--text-muted);
		cursor: pointer;
	}
	@media (hover: hover) {
		.find-close:hover {
			background: var(--bg-hover);
			color: var(--text);
		}
	}
	.find-replace-actions {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
	}
	.find-case {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 12px;
		color: var(--text-muted);
		user-select: none;
		flex-shrink: 0;
		white-space: nowrap;
	}
	.find-case input[type="checkbox"] {
		appearance: none;
		-webkit-appearance: none;
		width: 14px;
		height: 14px;
		min-width: 14px;
		max-width: 14px;
		border: 1px solid var(--border);
		border-radius: 3px;
		background: var(--bg);
		cursor: pointer;
		position: relative;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
	}
	.find-case input[type="checkbox"]:checked {
		background: var(--accent);
		border-color: var(--accent);
	}
	.find-case input[type="checkbox"]:checked::after {
		content: '';
		position: absolute;
		left: 50%;
		top: 50%;
		width: 4px;
		height: 7px;
		border: 1.5px solid #fff;
		border-top: none;
		border-left: none;
		transform: translate(-50%, -60%) rotate(45deg);
	}

	.find-toolbar-btn {
		position: relative;
	}
	.find-toolbar-icon {
		display: inline-block;
		width: 12px;
		height: 12px;
		position: relative;
		box-sizing: border-box;
		border: 1.6px solid currentColor;
		border-radius: 50%;
	}
	.find-toolbar-icon::before {
		content: '';
		position: absolute;
		width: 6px;
		height: 1.8px;
		background: currentColor;
		right: -4px;
		top: 8px;
		transform: rotate(42deg);
		border-radius: 2px;
	}

	.find-close-icon {
		display: inline-block;
		width: 10px;
		height: 10px;
		position: relative;
	}
	.find-close-icon::before,
	.find-close-icon::after {
		content: '';
		position: absolute;
		left: 4px;
		top: 0;
		width: 1.5px;
		height: 10px;
		background: currentColor;
		border-radius: 2px;
	}
	.find-close-icon::before { transform: rotate(45deg); }
	.find-close-icon::after { transform: rotate(-45deg); }

	.link-input {
		flex: 1;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		color: var(--text);
		font-size: 13px;
		padding: 6px 10px;
		outline: none;
		font-family: inherit;
	}
	.link-input:focus { border-color: var(--accent); }

	.link-apply-btn {
		padding: 6px 12px;
		font-size: 12px;
		font-weight: 600;
		background: var(--accent);
		color: #0f1117;
		border: none;
		border-radius: var(--radius-sm);
		cursor: pointer;
		white-space: nowrap;
		flex-shrink: 0;
	}
	@media (hover: hover) { .link-apply-btn:hover { opacity: 0.85; } }

	.link-file-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
		background: var(--bg-hover);
		cursor: pointer;
		color: var(--text-muted);
		flex-shrink: 0;
	}
	@media (hover: hover) { .link-file-btn:hover { background: var(--bg-elevated); color: var(--text); } }

	.heading-btn { min-width: 44px; }

	/* ── Word count footer ─────────────────────────────────────── */
	.word-count {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 20px 10px;
		font-size: 11px;
		color: var(--text-faint);
		flex-shrink: 0;
		user-select: none;
		border-top: 1px solid var(--border);
	}

	.count-sep {
		opacity: 0.5;
	}

	/* ── Image resize handles ──────────────────────────────────── */

	/* ── File attachment card ──────────────────────────────────── */
	.body-editor-wrap :global(.file-attachment-card) {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 14px;
		margin: 0.5em 0;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		cursor: default;
		user-select: none;
	}
	.body-editor-wrap :global(.file-attachment-card.ProseMirror-selectednode) {
		outline: 2px solid var(--accent);
	}
	.body-editor-wrap :global(.file-attachment-icon) {
		color: var(--text-muted);
		flex-shrink: 0;
		display: flex;
		align-items: center;
	}
	.body-editor-wrap :global(.file-attachment-info) {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.body-editor-wrap :global(.file-attachment-name) {
		font-size: 13px;
		font-weight: 500;
		color: var(--text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.body-editor-wrap :global(.file-attachment-meta) {
		font-size: 11px;
		color: var(--text-faint);
	}
	.body-editor-wrap :global(.file-attachment-dl) {
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 4px 10px;
		height: 28px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
		background: var(--bg-hover);
		color: var(--text-muted);
		font-size: 12px;
		cursor: pointer;
		flex-shrink: 0;
		white-space: nowrap;
		transition: color 0.1s, background 0.1s;
	}
	@media (hover: hover) {
		.body-editor-wrap :global(.file-attachment-dl:hover) {
			color: var(--accent);
			background: color-mix(in srgb, var(--accent) 10%, transparent);
		}
	}
	.body-editor-wrap :global(.file-attachment-del) {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border-radius: var(--radius-sm);
		border: none;
		background: transparent;
		color: var(--text-faint);
		cursor: pointer;
		flex-shrink: 0;
		transition: color 0.1s;
	}
	@media (hover: hover) { .body-editor-wrap :global(.file-attachment-del:hover) { color: var(--danger); } }

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

	/* Topic row - highlight border when note belongs to this topic */
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

	@media (hover: hover) { .topic-item:hover { background: var(--bg-hover); color: var(--text); } }

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

	@media (hover: hover) { .topic-row:hover .topic-edit-btn { opacity: 1; } }

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

	@media (hover: hover) { .folder-item:hover { background: var(--bg-hover); } }

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

	@media (hover: hover) { .folder-item:hover .folder-actions { opacity: 1; } }

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

	@media (hover: hover) { .color-swatch-sm:hover { transform: scale(1.15); } }
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

	/* ── File preview modal ──────────────────────────── */
	.preview-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.72);
		z-index: 200;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		overflow: auto;
		padding: max(env(safe-area-inset-top, 0px), 10px) 12px max(env(safe-area-inset-bottom, 0px), 10px);
	}
	@media (min-width: 768px) {
		.preview-backdrop {
			align-items: center;
			padding: 16px;
		}
	}

	.preview-modal {
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: 10px;
		width: 100%;
		max-width: 860px;
		max-height: min(90vh, calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 20px));
		display: flex;
		flex-direction: column;
		overflow: hidden;
		margin: 0 auto;
	}
	@media (max-width: 767px) {
		.preview-modal {
			max-height: calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 8px);
		}
	}

	.preview-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 16px;
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
		gap: 12px;
		position: sticky;
		top: 0;
		background: var(--bg-elevated);
		z-index: 1;
	}

	.preview-filename {
		font-size: 13px;
		font-weight: 500;
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.preview-header-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
	}

	.preview-dl-btn {
		display: flex;
		align-items: center;
		gap: 5px;
		font-size: 12px;
		padding: 5px 10px;
		height: auto;
	}

	.preview-close-btn {
		background: none;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		padding: 4px;
		display: flex;
		align-items: center;
		border-radius: 4px;
		transition: color 0.15s, background 0.15s;
	}
	@media (hover: hover) { .preview-close-btn:hover { color: var(--text); background: var(--bg-hover); } }

	.preview-body {
		flex: 1;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	.preview-loading,
	.preview-error {
		padding: 32px;
		text-align: center;
		color: var(--text-muted);
		font-size: 13px;
	}

	.preview-pdf {
		flex: 1;
		width: 100%;
		height: 100%;
		min-height: min(500px, calc(100dvh - 220px));
		border: none;
		background: #fff;
	}

	.preview-text {
		flex: 1;
		overflow: auto;
		margin: 0;
		padding: 16px 20px;
		font-family: 'SFMono-Regular', 'Consolas', 'Liberation Mono', monospace;
		font-size: 12.5px;
		line-height: 1.6;
		color: var(--text);
		white-space: pre;
		tab-size: 2;
		background: var(--bg);
		max-height: calc(90vh - 60px);
	}

	/* ── Print layout toggle button ────────────────────────────── */
	.print-layout-btn {
		/* color: var(--text-faint); */
		transition: color 0.15s;
	}
	.print-layout-btn.active {
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 12%, transparent);
	}
	@media (hover: hover) {
		.print-layout-btn:hover { color: var(--accent); }
	}

	.print-btn {
		color: var(--text-muted);
		transition: color 0.15s;
	}
	@media (hover: hover) {
		.print-btn:hover { color: var(--accent); }
	}

	/* ── Print layout mode (A4 page simulation) ──────────────── */
	/* A4 = 210mm × 297mm ≈ 794px × 1123px at 96 DPI.
	   We fix the editor content to 794px wide so it renders
	   identically on every device regardless of screen size. */
	.print-layout .editor-scroll-area {
		background: var(--bg-hover);
	}

	.print-layout .body-editor-wrap {
		width: 794px;
		min-width: 794px;
		max-width: 794px;
		margin: 0 auto;
		background: var(--bg);
		box-shadow: 0 1px 8px rgba(0,0,0,0.18), 0 0 0 1px var(--border);
		border-radius: 2px;
	}

	.print-layout .body-editor-wrap :global(.ProseMirror) {
		padding: 40px 40px 40px;
		min-height: 1123px;
		font-family: 'Inter', sans-serif;
		font-size: 12pt;  /* 12pt = 16px at 96dpi; matches @media print exactly */
		line-height: 1.7;
		-webkit-text-size-adjust: 100%;
		text-size-adjust: 100%;
	}

	/* In print layout, images must not exceed A4 content width */
	.print-layout .body-editor-wrap :global(.img-node-wrapper img) {
		max-width: 100%;
	}

	/* Title in print layout - constrain to page width */
	.print-layout .title-input {
		max-width: 794px;
		margin-left: auto;
		margin-right: auto;
		width: 100%;
		box-sizing: border-box;
	}

	/* ── Page spacers (injected into ProseMirror DOM) ──────────── */
	/* Non-editable divs injected at each page boundary to push content
	   past the margin+gap zone. SPACER_H = 40px bottom margin + 32px gap
	   + 40px top margin = 112px. The middle 32px shows --bg-hover (gap);
	   the 40px zones above/below are plain --bg (page color, same as content). */
	.print-layout .body-editor-wrap :global(.pm-page-spacer) {
		display: block;
		width: 100%;
		height: 112px; /* must match SPACER_H in JS: PAGE_MARGIN*2 + PAGE_GAP */
		background: linear-gradient(
			to bottom,
			var(--bg)       0px,
			var(--bg)       40px,
			var(--bg-hover) 40px,
			var(--bg-hover) 72px,
			var(--bg)       72px,
			var(--bg)       112px
		);
		pointer-events: none;
		user-select: none;
		-webkit-user-select: none;
		cursor: default;
		border: none;
		outline: none;
		margin: 0;
		padding: 0;
		flex-shrink: 0;
		/* Thin border lines at the gap edges make pages look distinct */
		border-top: 1px solid var(--border);
		border-bottom: 1px solid var(--border);
		box-sizing: border-box;
	}

	/* ── @media print — for actual printing ──────────────────── */
	/* Use device-independent units throughout:
	   - @page size: A4 (named size, always 210×297mm regardless of device DPI)
	   - margin: mm (physical millimetres, not px which varies by DPI)
	   - font-size: pt (1pt = 1/72in, physically consistent everywhere)
	   - container widths: 100% of the A4 printable area
	   This ensures identical output on desktop, iOS, and Android. */
	@media print {
		@page {
			size: A4;
			margin: 10.5mm 0; /* 10.5mm ≈ 40px at 96dpi; repeats on every page */
		}

		:global(html),
		:global(body) {
			width: 100% !important;
			margin: 0 !important;
			padding: 0 !important;
			font-size: 12pt !important; /* 12pt = 16px at 96dpi, device-independent */
			-webkit-text-size-adjust: 100% !important;
			text-size-adjust: 100% !important;
		}

		.toolbar,
		.format-bar,
		.word-count,
		.topics-drawer,
		.drawer-backdrop,
		.no-dek-banner,
		.conflict-banner,
		.conflict-diff,
		.incoming-banner,
		.link-tooltip,
		.preview-backdrop,
		.print-layout-btn,
		.print-btn,
		.title-input {
			display: none !important;
		}

		.pm-page-spacer {
			display: none !important;
		}

		.editor-page {
			height: auto !important;
			overflow: visible !important;
			width: 100% !important;
			border: none !important;
			outline: none !important;
			box-shadow: none !important;
		}

		.editor-scroll-area {
			overflow: visible !important;
			background: white !important;
			width: 100% !important;
			zoom: 1 !important;
			border: none !important;
			outline: none !important;
			box-shadow: none !important;
			scrollbar-gutter: auto !important;
		}

		.print-scale-outer {
			width: 100% !important;
			height: auto !important;
			overflow: visible !important;
			flex: 1 !important;
			align-self: auto !important;
		}

		.editor-content-wrap {
			display: block !important;
			overflow: visible !important;
			width: 100% !important;
			padding: 0 !important;
			zoom: 1 !important;
			transform: none !important;
			min-width: 0 !important;
		}

		.body-editor-wrap {
			width: 100% !important;
			min-width: 0 !important;
			max-width: 100% !important;
			margin: 0 !important;
			background: white !important;
			background-image: none !important;
			box-shadow: none !important;
			overflow: visible !important;
			border-radius: 0 !important;
			zoom: 1 !important;
		}

		/* Horizontal gutter in mm. Top/bottom = 0 — @page margin handles per-page spacing. */
		.body-editor-wrap :global(.ProseMirror) {
			padding: 0 10.5mm !important;
			min-height: 0 !important;
			font-family: 'Inter', sans-serif !important;
			font-size: 12pt !important;
			line-height: 1.7 !important;
			color: black !important;
			background: none !important;
		}

		.body-editor-wrap :global(.img-node-wrapper) {
			break-inside: avoid;
			page-break-inside: avoid;
		}
		/* Float group: BFC container injected before print to keep float + wrapping text together */
		:global(.pm-float-group) {
			display: flow-root;
			break-inside: avoid;
			page-break-inside: avoid;
		}

		/* All block content: avoid splitting across a page break */
		.body-editor-wrap :global(.ProseMirror table),
		.body-editor-wrap :global(.code-block-wrap),
		.body-editor-wrap :global(.file-attachment-card),
		.body-editor-wrap :global(.ProseMirror blockquote),
		.body-editor-wrap :global(.ProseMirror ul[data-type="taskList"] li) {
			break-inside: avoid;
			page-break-inside: avoid;
		}

		/* Keep headings with the content that follows them */
		.body-editor-wrap :global(.ProseMirror h1),
		.body-editor-wrap :global(.ProseMirror h2),
		.body-editor-wrap :global(.ProseMirror h3) {
			break-after: avoid;
			page-break-after: avoid;
		}

		.body-editor-wrap :global(.img-node-wrapper img) {
			max-width: 100% !important;
		}
		.body-editor-wrap :global(.ProseMirror table) {
			max-width: 100%;
			border-collapse: collapse;
		}
		.body-editor-wrap :global(.ProseMirror td),
		.body-editor-wrap :global(.ProseMirror th) {
			border: 1px solid #ccc !important;
			color: black !important;
			background: white !important;
		}
		.body-editor-wrap :global(.ProseMirror th) {
			background: #f0f0f0 !important;
			font-weight: 600;
		}

		/* Hide interactive chrome */
		.body-editor-wrap :global(.img-align-toolbar),
		.body-editor-wrap :global(.img-resize-handle-inline) {
			display: none !important;
		}

		/* Hide selection outlines — selected nodes show accent outlines in print preview */
		:global(.ProseMirror-selectednode) {
			outline: none !important;
			box-shadow: none !important;
		}
		:global(.selectedCell::after) {
			display: none !important;
		}

		/* Print-friendly colors */
		.body-editor-wrap :global(.ProseMirror h1),
		.body-editor-wrap :global(.ProseMirror h2),
		.body-editor-wrap :global(.ProseMirror h3),
		.body-editor-wrap :global(.ProseMirror h4) {
			color: black !important;
		}
		.body-editor-wrap :global(.ProseMirror blockquote) {
			border-left-color: #ccc !important;
			color: #333 !important;
		}
		.body-editor-wrap :global(.ProseMirror code) {
			background: #f5f5f5 !important;
			color: #333 !important;
		}
		.body-editor-wrap :global(.code-block-wrap) {
			background: #f5f5f5 !important;
			border: 1px solid #ddd !important;
		}
		.body-editor-wrap :global(.code-block-wrap code) {
			color: #333 !important;
		}
		.body-editor-wrap :global(.code-block-header) {
			background: #eee !important;
			color: #333 !important;
			border-bottom: 1px solid #ddd !important;
		}
		.body-editor-wrap :global(.ProseMirror a) {
			color: black !important;
			text-decoration: underline !important;
		}
	}
</style>
