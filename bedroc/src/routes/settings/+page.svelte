<script lang="ts">
	import { goto } from '$app/navigation';
	import { autosave, syncIntervalStore, liveSyncStore, notesMap, topicsMap, inactivityLockStore } from '$lib/stores/notes.svelte';
	import { auth, logout, apiFetch, changePassword } from '$lib/stores/auth.svelte.js';
	import { clearStore } from '$lib/stores/notes.svelte.js';

	let confirmLogout = $state(false);
	let confirmDelete = $state(false);

	// ── Sessions ──────────────────────────────────────────────────
	interface Session {
		id: string;
		device_info: string | null;
		login_ip: string | null;
		last_used_at: string | null;
		created_at: string;
		expires_at: string;
	}

	let sessions = $state<Session[]>([]);
	let currentSessionId = $state<string | null>(null);
	let sessionsLoading = $state(true);

	async function loadSessions() {
		try {
			const res = await apiFetch('/api/auth/sessions');
			if (res.ok) {
				const data = await res.json() as { sessions: Session[]; currentSessionId: string | null };
				sessions = data.sessions ?? [];
				currentSessionId = data.currentSessionId ?? null;
			}
		} catch { /* offline */ }
		sessionsLoading = false;
	}

	// Re-run whenever auth becomes ready (handles Electron where restoreSession
	// completes after the settings page has already mounted and run its first effect).
	$effect(() => {
		if (auth.isLoggedIn) loadSessions();
	});

	async function revokeSession(id: string) {
		try {
			await apiFetch(`/api/auth/sessions/${id}`, { method: 'DELETE' });
			sessions = sessions.filter(s => s.id !== id);
		} catch { /* ignore */ }
	}

	async function handleLogout() {
		clearStore();
		await logout();
		goto('/login');
	}

	async function handleDeleteAccount() {
		try {
			await apiFetch('/api/auth/account', { method: 'DELETE' });
		} catch { /* ignore */ }
		clearStore();
		await logout();
		goto('/login');
	}

	// ── Autosave settings ─────────────────────────────────────────
	let autosaveEnabled = $state(autosave.interval > 0);
	let autosaveSeconds = $state(autosave.interval > 0 ? autosave.interval / 1000 : 1);

	function handleAutosaveToggle() {
		autosaveEnabled = !autosaveEnabled;
		autosave.set(autosaveEnabled ? Math.round(autosaveSeconds * 1000) : 0);
	}

	function handleAutosaveSecondsChange() {
		autosaveSeconds = Math.max(0.5, autosaveSeconds);
		if (autosaveEnabled) autosave.set(Math.round(autosaveSeconds * 1000));
	}

	// ── Sync interval ─────────────────────────────────────────────
	let syncSeconds = $state(syncIntervalStore.interval / 1000);

	function handleSyncSecondsChange() {
		syncSeconds = Math.max(1, syncSeconds);
		syncIntervalStore.set(Math.round(syncSeconds * 1000));
	}

	// ── Inactivity lock ───────────────────────────────────────────
	let inactivityMinutes = $state(inactivityLockStore.minutes);

	function handleInactivityChange() {
		const min = Math.round(inactivityMinutes);
		if (min === 0) {
			inactivityLockStore.set(0);
		} else {
			inactivityLockStore.setMinutes(Math.max(1, min));
			inactivityMinutes = inactivityLockStore.minutes;
		}
	}

	// ── Change password ────────────────────────────────────────────
	let showChangePw = $state(false);
	let cpCurrent = $state('');
	let cpNew = $state('');
	let cpConfirm = $state('');
	let cpError = $state<string | null>(null);
	let cpSuccess = $state(false);
	let cpLoading = $state(false);

	async function handleChangePassword() {
		cpError = null;
		cpSuccess = false;
		if (!cpCurrent) { cpError = 'Enter your current password.'; return; }
		if (cpNew.length < 8) { cpError = 'New password must be at least 8 characters.'; return; }
		if (cpNew !== cpConfirm) { cpError = 'New passwords do not match.'; return; }
		if (cpNew === cpCurrent) { cpError = 'New password must be different from current.'; return; }
		cpLoading = true;
		try {
			await changePassword(cpCurrent, cpNew);
			cpSuccess = true;
			cpCurrent = ''; cpNew = ''; cpConfirm = '';
			setTimeout(() => { showChangePw = false; cpSuccess = false; }, 1800);
		} catch (err) {
			cpError = (err as Error).message;
		} finally {
			cpLoading = false;
		}
	}

	// ── Export notes ───────────────────────────────────────────────
	let exportLoading = $state(false);
	let exportError = $state<string | null>(null);

	async function handleExport() {
		if (!auth.dek) { exportError = 'Vault is locked. Please log in again.'; return; }
		exportLoading = true;
		exportError = null;
		try {
			const notes = [...notesMap.values()];
			const items = notes.map((note) => {
				const topic = note.topicId ? topicsMap.get(note.topicId) : null;
				return {
					id: note.id,
					title: note.title || 'Untitled',
					body: note.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
					bodyHtml: note.body,
					topic: topic ? { id: topic.id, name: topic.name, color: topic.color } : null,
					createdAt: new Date(note.createdAt).toISOString(),
					updatedAt: new Date(note.updatedAt).toISOString(),
				};
			});

			// Group by topic name
			const byTopic: Record<string, typeof items> = {};
			for (const n of items) {
				const key = n.topic?.name ?? 'Uncategorised';
				if (!byTopic[key]) byTopic[key] = [];
				byTopic[key].push(n);
			}

			const payload = {
				exportedAt: new Date().toISOString(),
				username: auth.username,
				noteCount: items.length,
				notes: byTopic,
			};

			const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `bedroc-export-${new Date().toISOString().slice(0, 10)}.json`;
			a.click();
			URL.revokeObjectURL(url);
		} catch (err) {
			exportError = (err as Error).message;
		} finally {
			exportLoading = false;
		}
	}
</script>

<svelte:head>
	<title>Settings — Bedroc</title>
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
					<span class="row-value">{auth.username ?? '—'}</span>
				</div>
			</div>
			<div class="divider-inner"></div>
			<div class="row">
				<div class="row-info">
					<span class="row-label">Server</span>
					<span class="row-value muted">{auth.serverUrl}</span>
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
			<div class="divider-inner"></div>
			<div class="row">
				<div class="row-info">
					<span class="row-label">Live editor sync</span>
					<span class="row-sub">Update open notes in real time when another device saves them</span>
				</div>
				<button
					class="toggle"
					class:on={liveSyncStore.enabled}
					onclick={() => liveSyncStore.set(!liveSyncStore.enabled)}
					role="switch"
					aria-checked={liveSyncStore.enabled}
					aria-label="Live editor sync"
				>
					<span class="toggle-thumb"></span>
				</button>
			</div>
			<div class="divider-inner"></div>
			<div class="row">
				<div class="row-info">
					<span class="row-label">Sync interval</span>
					<span class="row-sub">How often to pull changes from the server (min 1s)</span>
				</div>
				<div class="interval-wrap">
					<input
						type="number"
						class="interval-input"
						bind:value={syncSeconds}
						onchange={handleSyncSecondsChange}
						min="1"
						max="300"
						step="1"
						aria-label="Sync interval in seconds"
					/>
					<span class="interval-unit">s</span>
				</div>
			</div>
		</div>
	</section>

	<!-- Security -->
	<section class="section">
		<h3 class="section-title">Security</h3>
		<div class="card">
			<div class="row">
				<div class="row-info">
					<span class="row-label">Inactivity lock</span>
					<span class="row-sub">
						{inactivityMinutes === 0
							? 'Disabled — vault stays unlocked until you log out'
							: `Lock vault after ${inactivityMinutes} minute${inactivityMinutes === 1 ? '' : 's'} of inactivity`}
					</span>
				</div>
				<div class="interval-wrap">
					<input
						type="number"
						class="interval-input"
						bind:value={inactivityMinutes}
						onchange={handleInactivityChange}
						min="0"
						max="480"
						step="1"
						aria-label="Inactivity lock timeout in minutes (0 to disable)"
					/>
					<span class="interval-unit">min</span>
				</div>
			</div>
			<div class="divider-inner"></div>
			<button class="row row-btn" onclick={() => { showChangePw = !showChangePw; cpError = null; cpSuccess = false; }}>
				<div class="row-info">
					<span class="row-label">Change password</span>
					<span class="row-sub">Re-encrypts your data with the new password</span>
				</div>
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none" class="chevron-right" class:rotated={showChangePw}>
					<path d="M5 3l4 4-4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</button>
			{#if showChangePw}
				<div class="divider-inner"></div>
				<div class="change-pw-form">
					{#if cpSuccess}
						<p class="cp-success">Password changed successfully.</p>
					{:else}
						{#if cpError}
							<p class="cp-error">{cpError}</p>
						{/if}
						<input
							type="password"
							placeholder="Current password"
							bind:value={cpCurrent}
							autocomplete="current-password"
							disabled={cpLoading}
						/>
						<input
							type="password"
							placeholder="New password"
							bind:value={cpNew}
							autocomplete="new-password"
							disabled={cpLoading}
						/>
						<input
							type="password"
							placeholder="Confirm new password"
							bind:value={cpConfirm}
							autocomplete="new-password"
							disabled={cpLoading}
						/>
						<div class="cp-actions">
							<button class="btn-ghost" onclick={() => { showChangePw = false; cpError = null; }} disabled={cpLoading}>Cancel</button>
							<button class="btn-primary cp-save" onclick={handleChangePassword} disabled={cpLoading}>
								{cpLoading ? 'Saving…' : 'Save'}
							</button>
						</div>
					{/if}
				</div>
			{/if}
			<div class="divider-inner"></div>
			<button class="row row-btn" onclick={handleExport} disabled={exportLoading}>
				<div class="row-info">
					<span class="row-label">Export notes</span>
					<span class="row-sub">{exportLoading ? 'Preparing export…' : 'Download all notes as decrypted JSON'}</span>
					{#if exportError}<span class="cp-error">{exportError}</span>{/if}
				</div>
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none" class="chevron-right">
					<path d="M7 1v8M4 6l3 3 3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
					<path d="M2 11h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
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
			{#if sessionsLoading}
				<div class="row"><span class="row-sub">Loading…</span></div>
			{:else if sessions.length === 0}
				<div class="row"><span class="row-sub">No sessions found.</span></div>
			{:else}
				{#each sessions as session, i (session.id)}
					{#if i > 0}<div class="divider-inner"></div>{/if}
					<div class="row session-row">
						<div class="row-info">
							<span class="row-label session-label">
								{session.device_info ?? 'Unknown device'}
								{#if session.id === currentSessionId}
									<span class="session-current-badge">This device</span>
								{/if}
							</span>
							<span class="row-sub">
								Logged in {session.last_used_at
									? new Date(session.last_used_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
									: new Date(session.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
								{#if session.login_ip}
									· {session.login_ip}
								{/if}
							</span>
							<span class="row-sub session-expiry">
								Expires {new Date(session.expires_at).toLocaleDateString()}
							</span>
						</div>
						{#if session.id !== currentSessionId}
							<button class="btn-ghost revoke-btn" onclick={() => revokeSession(session.id)}>
								Revoke
							</button>
						{:else}
							<span class="session-current-label">Current</span>
						{/if}
					</div>
				{/each}
			{/if}
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
						<button class="btn-danger confirm-yes" onclick={handleLogout}>Yes, log out</button>
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
						<button class="btn-danger confirm-yes" onclick={handleDeleteAccount}>Delete forever</button>
						<button class="btn-ghost" onclick={() => (confirmDelete = false)}>Cancel</button>
					</div>
				{/if}
			</div>
		</div>
	</section>

	<p class="version">Bedroc v0.1.0 — open source, E2EE</p>
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

	/* Session row */
	.session-label {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}

	.session-current-badge {
		font-size: 10px;
		font-weight: 600;
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
		border-radius: 999px;
		padding: 1px 7px;
		letter-spacing: 0.02em;
		flex-shrink: 0;
	}

	.session-expiry {
		color: var(--text-faint);
		font-size: 11px;
	}

	.session-current-label {
		font-size: 12px;
		color: var(--text-faint);
		flex-shrink: 0;
		padding: 5px 10px;
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

	/* Change password form */
	.change-pw-form {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 14px;
	}

	.change-pw-form input {
		width: 100%;
	}

	.cp-actions {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
	}

	.cp-save {
		width: auto;
		padding: 8px 16px;
	}

	.cp-error {
		font-size: 12px;
		color: var(--danger);
	}

	.cp-success {
		font-size: 13px;
		color: var(--success);
		text-align: center;
		padding: 4px 0;
	}

	.chevron-right {
		transition: transform 0.15s ease;
	}

	.chevron-right.rotated {
		transform: rotate(90deg);
	}
</style>
