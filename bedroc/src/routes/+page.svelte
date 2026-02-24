<script lang="ts">
	// Placeholder notes — replaced with real data in Phase 2.
	const notes = [
		{ id: '1', title: 'Shopping list', preview: 'Milk, eggs, bread, coffee...', updatedAt: '2m ago' },
		{ id: '2', title: 'Meeting notes', preview: 'Q3 goals, action items from last week...', updatedAt: '1h ago' },
		{ id: '3', title: 'Ideas',         preview: 'New feature concepts for the project...', updatedAt: 'Yesterday' },
		{ id: '4', title: 'Passwords hint', preview: 'Remember: use the pattern we agreed on...', updatedAt: '3d ago' },
	];

	let search = $state('');

	let filtered = $derived(
		search.trim().length === 0
			? notes
			: notes.filter(
				(n) =>
					n.title.toLowerCase().includes(search.toLowerCase()) ||
					n.preview.toLowerCase().includes(search.toLowerCase())
			)
	);
</script>

<svelte:head>
	<title>Notes — bedroc</title>
</svelte:head>

<div class="page">
	<!-- Desktop header row -->
	<div class="page-header">
		<h2 class="page-title">Notes</h2>
		<a href="/note/new" class="btn-icon new-btn" aria-label="New note">
			<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
				<path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
			</svg>
			<span>New</span>
		</a>
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
	{#if filtered.length === 0}
		<div class="empty">
			<svg width="36" height="36" viewBox="0 0 36 36" fill="none" opacity="0.3">
				<rect x="6" y="4" width="24" height="28" rx="3" stroke="currentColor" stroke-width="1.5"/>
				<path d="M11 12h14M11 17h10M11 22h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
			</svg>
			<p>{search ? 'No notes match your search.' : 'No notes yet. Create one!'}</p>
		</div>
	{:else}
		<ul class="note-list">
			{#each filtered as note (note.id)}
				<li>
					<a href="/note/{note.id}" class="note-card">
						<div class="note-card-top">
							<span class="note-title">{note.title}</span>
							<span class="note-time">{note.updatedAt}</span>
						</div>
						<p class="note-preview">{note.preview}</p>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.page {
		padding: 20px 20px 32px;
		max-width: 680px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	/* Desktop header */
	.page-header {
		display: none;
		align-items: center;
		justify-content: space-between;
	}

	@media (min-width: 768px) {
		.page-header { display: flex; }
	}

	.page-title {
		font-size: 17px;
		font-weight: 600;
	}

	.new-btn {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
		font-weight: 500;
		color: var(--accent);
		padding: 7px 12px;
		border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--accent) 8%, transparent);
		text-decoration: none;
		transition: background 0.15s ease;
	}

	.new-btn:hover {
		background: color-mix(in srgb, var(--accent) 16%, transparent);
		text-decoration: none;
	}

	/* Search */
	.search-wrap {
		position: relative;
	}

	.search-icon {
		position: absolute;
		left: 11px;
		top: 50%;
		transform: translateY(-50%);
		color: var(--text-faint);
		pointer-events: none;
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
	}

	.note-card {
		display: flex;
		flex-direction: column;
		gap: 5px;
		padding: 13px 14px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		text-decoration: none;
		transition: background 0.12s ease, border-color 0.12s ease;
	}

	.note-card:hover {
		background: var(--bg-hover);
		border-color: color-mix(in srgb, var(--border) 60%, var(--accent));
		text-decoration: none;
	}

	.note-card-top {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}

	.note-title {
		font-size: 14px;
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
		font-size: 12.5px;
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
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		padding: 60px 20px;
		color: var(--text-faint);
		text-align: center;
	}

	.empty p {
		font-size: 13px;
	}
</style>
