<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import {
		notesMap,
		createNote,
		saveNote,
		deleteNote,
		autosave,
		type Note
	} from '$lib/stores/notes.svelte';

	// ── Note identity ─────────────────────────────────────────────
	let noteId  = $derived(page.params.id);
	let isNew   = $derived(noteId === 'new');

	// ── Load or scaffold the note ─────────────────────────────────
	// PLACEHOLDER: no decryption — Phase 2 will AES-GCM decrypt the body.
	let note = $derived(isNew ? null : notesMap.get(noteId));

	let title = $state('');
	let saved = $state(true);
	let bodyEl: HTMLDivElement;
	let titleEl: HTMLInputElement;

	// Initialise title from store when navigating to an existing note.
	$effect(() => {
		const n = isNew ? null : notesMap.get(noteId);
		if (n) {
			title = n.title;
			// Set body HTML once on mount (not on every reactive update to avoid cursor reset).
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
	// PLACEHOLDER: saves to in-memory store only. Phase 2 will encrypt + write to IndexedDB/server.
	let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

	function scheduleAutosave() {
		if (autosave.interval <= 0) return; // autosave disabled
		if (autosaveTimer) clearTimeout(autosaveTimer);
		autosaveTimer = setTimeout(() => {
			doSave();
		}, autosave.interval);
	}

	function doSave() {
		if (saved) return;
		const body = bodyEl?.innerHTML ?? '';
		if (isNew) {
			// Create a new note in the store, then navigate to its UUID.
			const id = createNote(null);
			const created = notesMap.get(id)!;
			saveNote({ ...created, title: title.trim() || 'Untitled', body });
			saved = true;
			// Replace history so back-button doesn't return to /note/new.
			goto(`/note/${id}`, { replaceState: true });
		} else {
			const existing = notesMap.get(noteId);
			if (!existing) return;
			saveNote({ ...existing, title: title.trim() || 'Untitled', body });
			saved = true;
		}
	}

	function handleTitleInput() {
		saved = false;
		scheduleAutosave();
	}

	function handleBodyInput() {
		saved = false;
		scheduleAutosave();
	}

	function handleSave() {
		if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
		doSave();
	}

	function handleBack() {
		history.back();
	}

	function handleDelete() {
		if (isNew) { history.back(); return; }
		deleteNote(noteId);
		goto('/');
	}

	// ── Rich text commands ────────────────────────────────────────
	// PLACEHOLDER: uses document.execCommand (deprecated). Will migrate to
	// ProseMirror or custom contenteditable model in Phase 6.
	function exec(cmd: string, value?: string) {
		document.execCommand(cmd, false, value);
		bodyEl?.focus();
		saved = false;
		scheduleAutosave();
	}

	function execFontSize(size: string) {
		// execCommand fontSize uses 1-7 scale; we need a workaround for CSS px sizes.
		// We apply a temporary marker, then replace it with a styled span.
		document.execCommand('fontSize', false, '7');
		const fontEls = bodyEl.querySelectorAll('font[size="7"]');
		fontEls.forEach((el) => {
			const span = document.createElement('span');
			span.style.fontSize = size;
			span.innerHTML = (el as HTMLElement).innerHTML;
			el.replaceWith(span);
		});
		bodyEl.focus();
		saved = false;
		scheduleAutosave();
	}

	// ── Formatting state (active button highlights) ───────────────
	let isBold       = $state(false);
	let isItalic     = $state(false);
	let isStrike     = $state(false);
	let isUL         = $state(false);
	let isOL         = $state(false);

	function updateFormatState() {
		isBold   = document.queryCommandState('bold');
		isItalic = document.queryCommandState('italic');
		isStrike = document.queryCommandState('strikeThrough');
		isUL     = document.queryCommandState('insertUnorderedList');
		isOL     = document.queryCommandState('insertOrderedList');
	}

	// Font size options
	const fontSizes = [
		{ label: 'Small',   value: '12px' },
		{ label: 'Normal',  value: '15px' },
		{ label: 'Large',   value: '20px' },
		{ label: 'Heading', value: '26px' },
	];

	// Color swatches
	const textColors = [
		'#e2e4ed', // default (near-white)
		'#6b8afd', // accent blue
		'#4caf87', // green
		'#e0a45c', // orange
		'#e05c5c', // red
		'#c084fc', // purple
		'#38bdf8', // sky
		'#f472b6', // pink
	];

	let showColorPicker = $state(false);
	let customColor = $state('#e2e4ed');

	function applyColor(color: string) {
		exec('foreColor', color);
		showColorPicker = false;
	}

	// ── Delete confirm ────────────────────────────────────────────
	let confirmDelete = $state(false);
</script>

<svelte:head>
	<title>{title || 'New note'} — Bedroc</title>
</svelte:head>

<div class="editor-page">
	<!-- ── Top toolbar ─────────────────────────────────────────── -->
	<div class="toolbar">
		<button class="btn-icon back-btn" onclick={handleBack} aria-label="Go back">
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
					<button class="btn-danger-sm" onclick={handleDelete}>Confirm delete</button>
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
		bind:this={titleEl}
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

		<!-- Bold / Italic / Strikethrough -->
		<button
			class="fmt-btn"
			class:active={isBold}
			onclick={() => exec('bold')}
			title="Bold"
			aria-label="Bold"
			aria-pressed={isBold}
		>
			<svg width="13" height="14" viewBox="0 0 13 14" fill="none">
				<path d="M3 2h5a3 3 0 0 1 0 6H3V2zM3 8h5.5a3.5 3.5 0 0 1 0 7H3V8z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
			</svg>
		</button>
		<button
			class="fmt-btn italic-icon"
			class:active={isItalic}
			onclick={() => exec('italic')}
			title="Italic"
			aria-label="Italic"
			aria-pressed={isItalic}
		>
			<svg width="11" height="14" viewBox="0 0 11 14" fill="none">
				<path d="M4 2h6M1 12h6M7 2L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
			</svg>
		</button>
		<button
			class="fmt-btn"
			class:active={isStrike}
			onclick={() => exec('strikeThrough')}
			title="Strikethrough"
			aria-label="Strikethrough"
			aria-pressed={isStrike}
		>
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
				<path d="M1 7h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
				<path d="M4 4c0-1.1.9-2 2-2h2a2 2 0 0 1 0 4H5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
				<path d="M6 7c.5 0 3 .5 3 2.5a2 2 0 0 1-2 2H4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
		</button>

		<div class="fmt-divider"></div>

		<!-- Bullet / Ordered list -->
		<button
			class="fmt-btn"
			class:active={isUL}
			onclick={() => exec('insertUnorderedList')}
			title="Bullet list"
			aria-label="Bullet list"
			aria-pressed={isUL}
		>
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
				<circle cx="2" cy="4" r="1" fill="currentColor"/>
				<circle cx="2" cy="7" r="1" fill="currentColor"/>
				<circle cx="2" cy="10" r="1" fill="currentColor"/>
				<path d="M5 4h8M5 7h8M5 10h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
			</svg>
		</button>
		<button
			class="fmt-btn"
			class:active={isOL}
			onclick={() => exec('insertOrderedList')}
			title="Numbered list"
			aria-label="Numbered list"
			aria-pressed={isOL}
		>
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
				<path d="M1.5 2v3M1 5h1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
				<path d="M1 8.5h1.5L1 10h1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
				<path d="M5 3.5h8M5 7h8M5 10.5h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
			</svg>
		</button>

		<div class="fmt-divider"></div>

		<!-- Font size select -->
		<select
			class="fmt-select"
			title="Font size"
			aria-label="Font size"
			onchange={(e) => {
				const t = e.target as HTMLSelectElement;
				execFontSize(t.value);
				t.value = '';
			}}
		>
			<option value="" disabled selected>Size</option>
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
						<input
							type="color"
							class="color-input-native"
							bind:value={customColor}
							oninput={() => applyColor(customColor)}
							title="Custom color"
						/>
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
		data-placeholder="Start writing…"
		spellcheck="true"
		role="textbox"
		aria-label="Note body"
		aria-multiline="true"
	></div>
</div>

<style>
	.editor-page {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
	}

	/* ── Top toolbar ──────────────────────────────────────────── */
	.toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 14px;
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
	}

	.back-btn {
		color: var(--text-muted);
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

	.save-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--accent) 16%, transparent);
	}

	.save-btn:disabled {
		color: var(--text-faint);
		border-color: transparent;
		background: transparent;
		opacity: 1;
		cursor: default;
	}

	.delete-btn {
		color: var(--text-faint);
	}

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

	.title-input:focus {
		border: none;
		box-shadow: none;
	}

	.title-input::placeholder {
		color: var(--text-faint);
		font-weight: 400;
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
		/* Horizontal scroll on very narrow viewports */
		scrollbar-width: none;
	}

	.format-bar::-webkit-scrollbar { display: none; }

	.fmt-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 3px;
		padding: 5px 6px;
		background: none;
		border: none;
		border-radius: var(--radius-sm);
		color: var(--text-muted);
		cursor: pointer;
		transition: background 0.12s ease, color 0.12s ease;
		flex-shrink: 0;
	}

	.fmt-btn:hover {
		background: var(--bg-hover);
		color: var(--text);
	}

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

	.fmt-select {
		font-size: 11px;
		padding: 4px 6px;
		width: auto;
		min-width: 60px;
		background: var(--bg-hover);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		color: var(--text-muted);
		cursor: pointer;
		flex-shrink: 0;
	}

	.fmt-select:focus {
		box-shadow: none;
		border-color: var(--accent);
	}

	/* Color picker */
	.color-wrap {
		position: relative;
		flex-shrink: 0;
	}

	.color-btn {
		gap: 4px;
	}

	.color-preview {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		border: 1px solid rgba(255,255,255,0.2);
		display: inline-block;
	}

	.color-backdrop {
		position: fixed;
		inset: 0;
		z-index: 50;
	}

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

	.color-swatch:hover {
		transform: scale(1.2);
		border-color: var(--text);
	}

	.color-custom-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

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

	.color-custom-label {
		font-size: 11px;
		color: var(--text-muted);
	}

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

	/* Placeholder via data attribute */
	.body-editor:empty::before {
		content: attr(data-placeholder);
		color: var(--text-faint);
		pointer-events: none;
	}

	/* Style rendered HTML from execCommand */
	.body-editor :global(ul) {
		padding-left: 1.4em;
		list-style-type: disc;
	}

	.body-editor :global(ol) {
		padding-left: 1.4em;
		list-style-type: decimal;
	}

	.body-editor :global(li) {
		margin-bottom: 2px;
	}

	.body-editor :global(b), .body-editor :global(strong) {
		font-weight: 700;
	}

	.body-editor :global(i), .body-editor :global(em) {
		font-style: italic;
	}

	.body-editor :global(strike), .body-editor :global(s) {
		text-decoration: line-through;
	}
</style>
