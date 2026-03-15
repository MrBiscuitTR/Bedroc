<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { onMount, onDestroy } from 'svelte';
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
	import { Editor, Node, mergeAttributes } from '@tiptap/core';
	import StarterKit from '@tiptap/starter-kit';
	import { Underline } from '@tiptap/extension-underline';
	import { TextStyle, Color, FontSize } from '@tiptap/extension-text-style';
	import { TextAlign } from '@tiptap/extension-text-align';
	import { Subscript } from '@tiptap/extension-subscript';
	import { Superscript } from '@tiptap/extension-superscript';
	import { Link } from '@tiptap/extension-link';
	import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
	import { Image } from '@tiptap/extension-image';
	import { Placeholder } from '@tiptap/extension-placeholder';
	import { Highlight } from '@tiptap/extension-highlight';
	import { Typography } from '@tiptap/extension-typography';
	import { TaskList } from '@tiptap/extension-task-list';
	import { TaskItem } from '@tiptap/extension-task-item';
	import { CharacterCount } from '@tiptap/extension-character-count';
	import { uploadFileAttachment, loadFileAttachment as loadAttachment } from '$lib/attachments.js';

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
	// Plain let — NOT $state. TipTap editor is imperative, not reactive Svelte state.
	// bind:this on a plain let works fine in Svelte 5 for DOM element refs.
	let editorEl: HTMLDivElement;
	let editor: Editor | null = null;
	// Used to trigger $effects that need the editor to be ready
	let editorReady = $state(false);

	// Track the last noteId we loaded content for — prevents overwriting user edits
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

		// Snapshot body + cursor position BEFORE any await
		const body = editor?.getHTML() ?? '';
		const savedPos = editor ? editor.state.selection.anchor : null;

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

			// Restore cursor — TipTap preserves editor state across setContent calls
			// but after a save-induced re-render we re-focus and restore position.
			if (savedPos !== null && editor && editor.isFocused) {
				requestAnimationFrame(() => {
					if (savedPos !== null && editor) {
						const docSize = editor.state.doc.content.size;
						const pos = Math.min(savedPos, docSize - 1);
						editor.commands.setTextSelection(pos);
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
	let colorBtnEl = $state<HTMLButtonElement | undefined>(undefined);
	let colorPanelEl = $state<HTMLDivElement | undefined>(undefined);
	let fontsizeBtnEl = $state<HTMLButtonElement | undefined>(undefined);
	let fontsizePanelEl = $state<HTMLDivElement | undefined>(undefined);

	// ── Custom Image extension with per-image resize handles ────────
	// Replaces the built-in Image extension. Stores 'width' and 'align'
	// as explicit node attributes so they persist to HTML on save/reload.
	// Each image gets its own NodeView with inline resize handles — this
	// avoids the "overlay selects first image only" problem entirely.
	const ResizableImage = Image.extend({
		addAttributes() {
			return {
				...this.parent?.(),
				width:  { default: null, renderHTML: (a) => a.width  ? { width: a.width }  : {} },
				align:  { default: 'none', renderHTML: (a) => a.align && a.align !== 'none' ? { style: `float:${a.align};margin:${a.align === 'left' ? '0 12px 4px 0' : '0 0 4px 12px'}` } : {} },
			};
		},
		addNodeView() {
			return ({ node, getPos }) => {
				const wrapper = document.createElement('span');
				wrapper.className = 'img-node-wrapper';
				wrapper.setAttribute('contenteditable', 'false');
				wrapper.setAttribute('draggable', 'true');

				const img = document.createElement('img');
				img.src = node.attrs.src ?? '';
				img.alt = node.attrs.alt ?? '';
				img.title = node.attrs.title ?? '';
				if (node.attrs.width) img.width = node.attrs.width;
				if (node.attrs.align && node.attrs.align !== 'none') {
					img.style.float = node.attrs.align;
					img.style.margin = node.attrs.align === 'left' ? '0 12px 4px 0' : '0 0 4px 12px';
				}

				// Resize handle (right edge)
				const handle = document.createElement('span');
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
					img.width = newW;
					wrapper.style.width = newW + 'px';
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

				wrapper.append(img, handle);

				return {
					dom: wrapper,
					update(updatedNode) {
						if (updatedNode.type.name !== 'image') return false;
						img.src = updatedNode.attrs.src ?? '';
						if (updatedNode.attrs.width) { img.width = updatedNode.attrs.width; wrapper.style.width = updatedNode.attrs.width + 'px'; }
						else { img.removeAttribute('width'); wrapper.style.width = ''; }
						return true;
					},
				};
			};
		},
	});

	// updateImageResize is now a no-op — handled per-node in ResizableImage nodeView
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
		// Color: stored in textStyle.color
		const color: string = tsAttrs.color ?? '';
		if (color) customColor = color;
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
		// setColor is on the chain via the Color extension
		if (editor) (editor.chain().focus() as any).setColor(color).run();
		updateFormatState();
		saved = false;
		scheduleAutosave();
		showColorPicker = false;
	}

	function unsetColor() {
		if (editor) (editor.chain().focus() as any).unsetColor().run();
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

	// ── TipTap editor init ────────────────────────────────────────
	onMount(() => {
		editor = new Editor({
			element: editorEl,
			extensions: [
				StarterKit.configure({ link: false, underline: false }),
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
				ResizableImage.configure({ inline: true, allowBase64: true }),
				FileAttachmentNode,
				Placeholder.configure({ placeholder: 'Start writing…' }),
			],
			content: '',
			onUpdate: ({ editor: e }) => {
				_bodyText = e.getText() ?? '';
				ttCharCount = (e.storage as any).characterCount?.characters?.() ?? 0;
				ttWordCount = (e.storage as any).characterCount?.words?.() ?? 0;
				saved = false;
				scheduleAutosave();
				updateFormatState();
			},
			onSelectionUpdate: () => {
				updateFormatState();
			},
			onFocus: () => {
				updateFormatState();
			},
			editorProps: {
				attributes: {
					spellcheck: 'true',
				},
			},
		});
		// Signal to $effects that the editor is ready
		editorReady = true;
	});

	onDestroy(() => {
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

		<!-- Highlight -->
		<button class="fmt-btn" class:active={isHighlight}
			onmousedown={(e) => { e.preventDefault(); editor?.chain().focus().toggleHighlight().run(); }} title="Highlight" aria-label="Highlight">
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
				<path d="M2 10l3-3 4-4 2 2-4 4-3 3-2-2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
				<path d="M8 4l2 2" stroke="currentColor" stroke-width="1.3"/>
				<path d="M2 12h3" stroke={isHighlight ? 'var(--accent)' : 'currentColor'} stroke-width="2" stroke-linecap="round"/>
			</svg>
		</button>

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
	<div class="editor-scroll-area">
		<div class="body-editor-wrap" bind:this={editorEl}></div>

		<!-- ── Word count footer ─────────────────────────────── -->
		<div class="word-count" aria-live="polite" aria-atomic="true">
			<span>{wordCount} word{wordCount === 1 ? '' : 's'}</span>
			<span class="count-sep">·</span>
			<span>{charCount} char{charCount === 1 ? '' : 's'}</span>
			<span class="count-sep">·</span>
			<span>{lineCount} line{lineCount === 1 ? '' : 's'}</span>
		</div>
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
							const a = document.createElement('a');
							a.href = dataUri;
							a.download = previewState!.fileName;
							a.click();
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
					<!-- Blob URL avoids CSP data: iframe restriction -->
					<iframe
						src={previewContent}
						title={previewState.fileName}
						class="preview-pdf"
						sandbox="allow-scripts allow-same-origin"
					></iframe>
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
	/* The toolbar is a flex-shrink:0 sibling above .editor-scroll-area.
	   Since .editor-page has overflow:hidden, the only thing that scrolls
	   is .editor-scroll-area — so the format-bar is always visible. */
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
		z-index: 5;
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

	/* ── Editor scroll area + body wrap ─────────────────────── */
	/* .editor-scroll-area is the only element that scrolls.
	   This keeps .format-bar always visible above it. */
	.editor-scroll-area {
		flex: 1;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
		overscroll-behavior: contain;
		position: relative; /* for the image resize overlay */
		display: flex;
		flex-direction: column;
	}

	.body-editor-wrap {
		flex: 1;
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
	.body-editor-wrap :global(.ProseMirror pre) {
		background: var(--bg-hover);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 12px 14px;
		margin: 0.5em 0;
		overflow-x: auto;
	}
	.body-editor-wrap :global(.ProseMirror pre code) {
		background: none;
		padding: 0;
		font-size: 0.875em;
	}
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

	/* Tables */
	.body-editor-wrap :global(.ProseMirror table) {
		border-collapse: collapse;
		margin: 0.75em 0;
		/* Do NOT set table-layout:fixed or overflow:hidden —
		   those break ProseMirror's column-resize-handle drag */
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

	/* Images — inline NodeView wrapper */
	.body-editor-wrap :global(.img-node-wrapper) {
		display: inline-block;
		position: relative;
		max-width: 100%;
		vertical-align: middle;
		line-height: 0;
		/* Allow cursor placement before/after inline image */
		user-select: none;
	}
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
	/* Inline resize handle: right edge of each image */
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
	.body-editor-wrap :global(.ProseMirror-selectednode .img-resize-handle-inline),
	.body-editor-wrap :global(.img-node-wrapper:hover .img-resize-handle-inline) {
		opacity: 0.85;
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
	.body-editor-wrap :global(.ProseMirror mark) {
		background: color-mix(in srgb, #f5e642 60%, transparent);
		color: inherit;
		border-radius: 2px;
		padding: 0 1px;
	}

	/* Link cursor */
	.body-editor-wrap :global(.ProseMirror a) {
		color: var(--accent);
		text-decoration: underline;
		cursor: pointer;
	}

	/* Link / image insert dialog */
	.link-dialog {
		position: fixed;
		z-index: 201;
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
	.link-apply-btn:hover { opacity: 0.85; }

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
	.link-file-btn:hover { background: var(--bg-elevated); color: var(--text); }

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
	.body-editor-wrap :global(.file-attachment-dl:hover) {
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 10%, transparent);
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
	.body-editor-wrap :global(.file-attachment-del:hover) { color: var(--danger); }

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

	/* ── File preview modal ──────────────────────────── */
	.preview-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.72);
		z-index: 200;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 16px;
	}

	.preview-modal {
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: 10px;
		width: 100%;
		max-width: 860px;
		max-height: 90vh;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.preview-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 16px;
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
		gap: 12px;
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
	.preview-close-btn:hover { color: var(--text); background: var(--bg-hover); }

	.preview-body {
		flex: 1;
		overflow: hidden;
		display: flex;
		flex-direction: column;
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
		min-height: 500px;
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
</style>
