<script lang="ts">
	import { autosave } from '$lib/stores/notes.svelte';

	// Settings page — shell only. Actual logic wired in Phase 5/6.
	let confirmLogout = $state(false);
	let confirmDelete = $state(false);

	const serverUrl =
		typeof localStorage !== 'undefined'
			? (localStorage.getItem('bedroc_server') ?? 'https://api.bedroc.app')
			: 'https://api.bedroc.app';

	// Placeholder session list — real data from server in Phase 5.
	const sessions = [
		{ id: '1', device: 'Chrome on macOS',  location: 'Current session', current: true },
		{ id: '2', device: 'Safari on iPhone', location: 'Last seen 2h ago', current: false },
	];

	// ── Autosave settings ─────────────────────────────────────────
	// autosave.interval === 0 means disabled.
	let autosaveEnabled = $state(autosave.interval > 0);
	// Display value in seconds for the UI input.
	let autosaveSeconds = $state(autosave.interval > 0 ? autosave.interval / 1000 : 1);

	function handleAutosaveToggle() {
		autosaveEnabled = !autosaveEnabled;
		autosave.set(autosaveEnabled ? Math.round(autosaveSeconds * 1000) : 0);
	}

	function handleAutosaveSecondsChange() {
		autosaveSeconds = Math.max(0.5, autosaveSeconds);
		if (autosaveEnabled) autosave.set(Math.round(autosaveSeconds * 1000));
	}
</script>

<svelte:head>
	<title>Settings — bedroc</title>
</svelte:head>

<div class="page">
	<h2 class="page-title">Settings</h2>

	<!-- Account -->
	<section class="section">
		<h3 class="section-title">Account</h3>
		<div class="card">
			<div class="row">
				<div class="row-info">
					<span class="row-label">Username</span>
					<span class="row-value">username</span>
				</div>
			</div>
			<div class="divider-inner"></div>
			<div class="row">
				<div class="row-info">
					<span class="row-label">Server</span>
					<span class="row-value muted">{serverUrl}</span>
				</div>
			</div>
		</div>
	</section>

	<!-- Editor -->
	<section class="section">
		<h3 class="section-title">Editor</h3>
		<div class="card">
			<div class="row">
				<div class="row-info">
					<span class="row-label">Autosave</span>
					<span class="row-sub">Automatically save notes while you type</span>
				</div>
				<button
					class="toggle"
					class:on={autosaveEnabled}
					onclick={handleAutosaveToggle}
					role="switch"
					aria-checked={autosaveEnabled}
					aria-label="Autosave"
				>
					<span class="toggle-thumb"></span>
				</button>
			</div>
			{#if autosaveEnabled}
				<div class="divider-inner"></div>
				<div class="row">
					<div class="row-info">
						<span class="row-label">Autosave interval</span>
						<span class="row-sub">How long after you stop typing before saving</span>
					</div>
					<div class="interval-wrap">
						<input
							type="number"
							class="interval-input"
							bind:value={autosaveSeconds}
							onchange={handleAutosaveSecondsChange}
							min="0.5"
							max="60"
							step="0.5"
							aria-label="Autosave interval in seconds"
						/>
						<span class="interval-unit">s</span>
					</div>
				</div>
			{/if}
		</div>
	</section>

	<!-- Security -->
	<section class="section">
		<h3 class="section-title">Security</h3>
		<div class="card">
			<button class="row row-btn">
				<div class="row-info">
					<span class="row-label">Change password</span>
					<span class="row-sub">Re-encrypts your data with the new password</span>
				</div>
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none" class="chevron-right">
					<path d="M5 3l4 4-4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</button>
			<div class="divider-inner"></div>
			<button class="row row-btn">
				<div class="row-info">
					<span class="row-label">Export notes</span>
					<span class="row-sub">Download all notes as decrypted JSON</span>
				</div>
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none" class="chevron-right">
					<path d="M5 3l4 4-4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</button>
		</div>
		<p class="section-note">
			Exporting creates a decrypted file. Keep it safe and delete it when done.
		</p>
	</section>

	<!-- Sessions -->
	<section class="section">
		<h3 class="section-title">Active sessions</h3>
		<div class="card">
			{#each sessions as session, i (session.id)}
				{#if i > 0}<div class="divider-inner"></div>{/if}
				<div class="row">
					<div class="row-info">
						<span class="row-label">
							{session.device}
							{#if session.current}
								<span class="badge">This device</span>
							{/if}
						</span>
						<span class="row-sub">{session.location}</span>
					</div>
					{#if !session.current}
						<button class="btn-ghost revoke-btn">Revoke</button>
					{/if}
				</div>
			{/each}
		</div>
	</section>

	<!-- Danger zone -->
	<section class="section">
		<h3 class="section-title danger-title">Danger zone</h3>
		<div class="card danger-card">
			<!-- Logout -->
			<div class="row">
				<div class="row-info">
					<span class="row-label">Log out</span>
					<span class="row-sub">Clears all keys and cached data from this device</span>
				</div>
				{#if !confirmLogout}
					<button class="btn-ghost danger-btn" onclick={() => (confirmLogout = true)}>
						Log out
					</button>
				{:else}
					<div class="confirm-row">
						<span class="confirm-text">Sure?</span>
						<button class="btn-danger confirm-yes">Yes, log out</button>
						<button class="btn-ghost" onclick={() => (confirmLogout = false)}>Cancel</button>
					</div>
				{/if}
			</div>
			<div class="divider-inner"></div>
			<!-- Delete account -->
			<div class="row">
				<div class="row-info">
					<span class="row-label">Delete account</span>
					<span class="row-sub">Permanently deletes your account and all notes. Cannot be undone.</span>
				</div>
				{#if !confirmDelete}
					<button class="btn-ghost danger-btn" onclick={() => (confirmDelete = true)}>
						Delete
					</button>
				{:else}
					<div class="confirm-row">
						<span class="confirm-text">Sure?</span>
						<button class="btn-danger confirm-yes">Delete forever</button>
						<button class="btn-ghost" onclick={() => (confirmDelete = false)}>Cancel</button>
					</div>
				{/if}
			</div>
		</div>
	</section>

	<p class="version">bedroc v0.1.0 — open source, E2EE</p>
</div>

<style>
	.page {
		padding: 20px 20px 40px;
		max-width: 560px;
		display: flex;
		flex-direction: column;
		gap: 24px;
	}

	.page-title {
		font-size: 17px;
		font-weight: 600;
		display: none;
	}

	@media (min-width: 768px) {
		.page-title { display: block; }
	}

	/* Section */
	.section {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.section-title {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-faint);
		padding: 0 2px;
	}

	.section-note {
		font-size: 11px;
		color: var(--text-faint);
		padding: 0 2px;
		line-height: 1.5;
	}

	.danger-title {
		color: color-mix(in srgb, var(--danger) 70%, var(--text-faint));
	}

	/* Card */
	.card {
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		overflow: hidden;
	}

	.danger-card {
		border-color: color-mix(in srgb, var(--danger) 20%, var(--border));
	}

	.divider-inner {
		height: 1px;
		background: var(--border);
	}

	/* Row */
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 13px 14px;
	}

	.row-btn {
		background: none;
		border: none;
		width: 100%;
		text-align: left;
		cursor: pointer;
		transition: background 0.12s ease;
	}

	.row-btn:hover {
		background: var(--bg-hover);
	}

	.row-info {
		display: flex;
		flex-direction: column;
		gap: 3px;
		flex: 1;
		min-width: 0;
	}

	.row-label {
		font-size: 13.5px;
		color: var(--text);
		font-weight: 500;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.row-value {
		font-size: 13px;
		color: var(--text-muted);
	}

	.row-value.muted {
		font-size: 12px;
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.row-sub {
		font-size: 12px;
		color: var(--text-faint);
		line-height: 1.4;
	}

	.chevron-right {
		color: var(--text-faint);
		flex-shrink: 0;
	}

	/* Badge */
	.badge {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.04em;
		background: color-mix(in srgb, var(--accent) 15%, transparent);
		color: var(--accent);
		padding: 2px 6px;
		border-radius: 999px;
	}

	/* Revoke / danger buttons */
	.revoke-btn {
		font-size: 12px;
		color: var(--danger);
		padding: 5px 10px;
		border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
		border-radius: var(--radius-sm);
		flex-shrink: 0;
	}

	.revoke-btn:hover {
		background: color-mix(in srgb, var(--danger) 10%, transparent);
	}

	.danger-btn {
		font-size: 12px;
		color: var(--danger);
		flex-shrink: 0;
	}

	/* Confirm inline */
	.confirm-row {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
	}

	.confirm-text {
		font-size: 12px;
		color: var(--text-faint);
	}

	.confirm-yes {
		font-size: 12px;
		padding: 5px 10px;
		border-radius: var(--radius-sm);
	}

	/* Toggle switch */
	.toggle {
		width: 40px;
		height: 22px;
		border-radius: 999px;
		background: var(--border);
		border: none;
		padding: 0;
		cursor: pointer;
		position: relative;
		transition: background 0.2s ease;
		flex-shrink: 0;
	}

	.toggle.on {
		background: var(--accent);
	}

	.toggle-thumb {
		position: absolute;
		top: 3px;
		left: 3px;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: #fff;
		transition: transform 0.2s ease;
		display: block;
	}

	.toggle.on .toggle-thumb {
		transform: translateX(18px);
	}

	/* Interval input */
	.interval-wrap {
		display: flex;
		align-items: center;
		gap: 4px;
		flex-shrink: 0;
	}

	.interval-input {
		width: 60px;
		font-size: 13px;
		padding: 6px 8px;
		text-align: right;
	}

	.interval-unit {
		font-size: 12px;
		color: var(--text-faint);
	}

	/* Version */
	.version {
		font-size: 11px;
		color: var(--text-faint);
		text-align: center;
		padding-top: 8px;
	}
</style>
