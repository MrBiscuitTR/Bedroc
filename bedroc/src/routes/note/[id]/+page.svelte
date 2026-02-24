<script lang="ts">
	import { page } from '$app/state';

	// Placeholder — real note loading wired in Phase 2.
	let noteId = $derived(page.params.id);
	let isNew = $derived(noteId === 'new');

	// Titles/body initialised to placeholders; real loading happens in Phase 2.
	let title = $state('Meeting notes');
	let body  = $state('Q3 goals, action items from last week...\n\n- Follow up with design team\n- Update the roadmap doc\n- Schedule weekly sync');

	let saved = $state(true);
	let titleInput: HTMLInputElement;

	// Mark unsaved whenever content changes.
	$effect(() => {
		// Accessing title and body registers them as dependencies.
		void title; void body;
		saved = false;
	});

	function handleSave() {
		// Save logic wired in Phase 2.
		saved = true;
	}

	function handleBack() {
		history.back();
	}

	function handleDelete() {
		// Delete logic wired in Phase 2.
	}
</script>

<svelte:head>
	<title>{title || 'New note'} — bedroc</title>
</svelte:head>

<div class="editor-page">
	<!-- Toolbar -->
	<div class="toolbar">
		<button class="btn-icon back-btn" onclick={handleBack} aria-label="Back">
			<svg width="18" height="18" viewBox="0 0 18 18" fill="none">
				<path d="M11 4L6 9l5 5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
		</button>

		<div class="toolbar-actions">
			{#if !saved}
				<span class="unsaved-dot" title="Unsaved changes"></span>
			{/if}
			<button class="btn-ghost save-btn" onclick={handleSave} disabled={saved}>
				{saved ? 'Saved' : 'Save'}
			</button>
			{#if !isNew}
				<button class="btn-icon delete-btn" onclick={handleDelete} aria-label="Delete note">
					<svg width="15" height="15" viewBox="0 0 15 15" fill="none">
						<path d="M2 4h11M5 4V2.5A1.5 1.5 0 0 1 6.5 1h2A1.5 1.5 0 0 1 10 2.5V4M6 7v5M9 7v5M3 4l.8 8.5A1.5 1.5 0 0 0 5.3 14h4.4a1.5 1.5 0 0 0 1.5-1.5L12 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
					</svg>
				</button>
			{/if}
		</div>
	</div>

	<!-- Note title -->
	<input
		class="title-input"
		type="text"
		placeholder="Title"
		bind:value={title}
		bind:this={titleInput}
		spellcheck="true"
		autocorrect="on"
		autocapitalize="sentences"
	/>

	<div class="divider"></div>

	<!-- Note body -->
	<textarea
		class="body-input"
		placeholder="Start writing…"
		bind:value={body}
		spellcheck="true"
		autocapitalize="sentences"
	></textarea>
</div>

<style>
	.editor-page {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	/* Toolbar */
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
	}

	.save-btn:disabled {
		color: var(--text-faint);
		border-color: transparent;
		opacity: 1;
	}

	.delete-btn {
		color: var(--text-faint);
	}

	.delete-btn:hover {
		color: var(--danger);
		background: color-mix(in srgb, var(--danger) 10%, transparent);
	}

	/* Title */
	.title-input {
		border: none;
		background: transparent;
		font-size: 20px;
		font-weight: 600;
		color: var(--text);
		padding: 18px 20px 10px;
		letter-spacing: -0.01em;
		border-radius: 0;
		box-shadow: none;
	}

	.title-input:focus {
		border: none;
		box-shadow: none;
	}

	.title-input::placeholder {
		color: var(--text-faint);
		font-weight: 400;
	}

	.divider {
		height: 1px;
		background: var(--border);
		margin: 0 20px;
		flex-shrink: 0;
	}

	/* Body */
	.body-input {
		flex: 1;
		border: none;
		background: transparent;
		font-size: 15px;
		color: var(--text);
		padding: 14px 20px 24px;
		line-height: 1.7;
		border-radius: 0;
		box-shadow: none;
		resize: none;
		/* Fill remaining height */
		min-height: 0;
	}

	.body-input:focus {
		border: none;
		box-shadow: none;
	}

	.body-input::placeholder {
		color: var(--text-faint);
	}
</style>
