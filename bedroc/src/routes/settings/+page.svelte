<script lang="ts">
	import { goto } from '$app/navigation';
	import { autosave, syncIntervalStore, liveSyncStore, notesMap, topicsMap, foldersMap, inactivityLockStore, getTopics, getFolders, toggleFolderCollapsed, type Topic, type Folder } from '$lib/stores/notes.svelte';
	import { auth, logout, apiFetch, changePassword, serverStatus } from '$lib/stores/auth.svelte.js';
	import { clearStore } from '$lib/stores/notes.svelte.js';
	import { theme, toggleTheme } from '$lib/stores/theme.svelte.js';

	// ── Topics panel (sidebar) ────────────────────────────────────
	let allTopics  = $derived((topicsMap.size, getTopics()));
	let allFolders = $derived((foldersMap.size, getFolders()));
	let allNotes   = $derived(notesMap.size);

	function topicsInFolder(folderId: string | null): Topic[] {
		return allTopics.filter(t => t.folderId === folderId).sort((a, b) => a.order - b.order);
	}
	function childFolders(parentId: string | null): Folder[] {
		return allFolders.filter(f => f.parentId === parentId).sort((a, b) => a.order - b.order);
	}
	function noteCountForTopic(topicId: string): number {
		return [...notesMap.values()].filter(n => n.topicId === topicId).length;
	}

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

<div class="settings-layout">

<!-- ── Left panel: folders + topics (desktop only) ──────────── -->
<aside class="topics-panel" role="navigation" aria-label="Topics and folders">
	<!-- Logo row -->
	<div class="panel-logo">
		<img src="/icons/appicon-96.png" alt="Bedroc" class="panel-logo-icon" width="24" height="24" />
		<span class="panel-logo-text">Bedroc</span>
	</div>

	<div class="topics-header">
		<span class="label">Topics</span>
	</div>

	<!-- Pinned -->
	<div class="topic-list-pinned">
		<a href="/" class="topic-item topic-item-all">
			<span class="topic-dot" style="background: var(--text-faint)"></span>
			<span class="topic-name">All notes</span>
			<span class="topic-count">{allNotes}</span>
		</a>
		<a href="/?topic=null" class="topic-item">
			<span class="topic-dot topic-dot-uncategorised"></span>
			<span class="topic-name">Uncategorised</span>
			<span class="topic-count">{[...notesMap.values()].filter(n => !n.topicId).length}</span>
		</a>
		{#if allTopics.length > 0 || allFolders.length > 0}
			<div class="topic-separator"></div>
		{/if}
	</div>

	<!-- Scrollable topics/folders -->
	<nav class="topic-list">
		{#each childFolders(null) as folder (folder.id)}
			{@render settingsFolderRow(folder, 0)}
		{/each}
		{#each topicsInFolder(null) as topic (topic.id)}
			{@render settingsTopicRow(topic, 0)}
		{/each}
	</nav>

	<!-- Footer: user + settings (active) + status dot -->
	<div class="panel-footer">
		<button class="btn-ghost panel-user" onclick={() => {}}>
			<span class="panel-user-avatar" aria-hidden="true">{(auth.username ?? 'A')[0].toUpperCase()}</span>
			<span class="panel-user-name">{auth.username ?? 'Account'}</span>
		</button>
		<a href="/settings" class="panel-settings-btn panel-settings-active" aria-label="Settings" aria-current="page">
			<svg width="15" height="15" viewBox="0 0 16 16" fill="none">
				<circle cx="8" cy="8" r="2.5" stroke="currentColor" stroke-width="1.5"/>
				<path d="M8 1v2M8 13v2M1 8h2M13 8h2M2.93 2.93l1.41 1.41M11.66 11.66l1.41 1.41M2.93 13.07l1.41-1.41M11.66 4.34l1.41-1.41" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
			</svg>
		</a>
		{#if serverStatus.value !== 'unknown'}
			<span class="panel-srv-dot panel-srv-dot-{serverStatus.value}" title={serverStatus.value === 'online' ? 'Server online' : serverStatus.value === 'offline' ? 'Server unreachable' : 'Checking…'}></span>
		{/if}
	</div>
</aside>

<!-- ── Settings content ──────────────────────────────────────── -->
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

	<!-- Appearance -->
	<section class="section">
		<h3 class="section-title">Appearance</h3>
		<div class="card">
			<div class="row">
				<div class="row-info">
					<span class="row-label">Theme</span>
					<span class="row-sub">{theme.isLight ? 'Light' : 'Dark'}</span>
				</div>
				<button
					class="toggle"
					class:on={theme.isLight}
					onclick={toggleTheme}
					role="switch"
					aria-checked={theme.isLight}
					aria-label="Light mode"
				>
					<span class="toggle-thumb"></span>
				</button>
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
								Expires {new Date(session.expires_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
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

	<div class="version-block">
		<p class="version">Bedroc v{__APP_VERSION__} — open source, E2EE</p>
		<p class="version commit">commit <code>{__COMMIT_HASH__}</code></p>
		<p class="version links">
			<a href="/privacy.html" target="_blank" rel="noopener">Privacy Policy</a>
			<span class="dot-sep">·</span>
			<a href="/terms.html" target="_blank" rel="noopener">Terms of Service</a>
			<span class="dot-sep">·</span>
			<a href="mailto:contact@cagancalidag.com">Contact</a>
		</p>
	</div>
</div><!-- end .page -->
</div><!-- end .settings-layout -->

<!-- ── Folder snippet ───────────────────────────────────────── -->
{#snippet settingsFolderRow(folder: Folder, depth: number)}
	<div class="folder-row">
		<div class="folder-item" style="padding-left: {10 + depth * 14}px">
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
		</div>
		{#if !folder.collapsed}
			{#each childFolders(folder.id) as child (child.id)}
				{@render settingsFolderRow(child, depth + 1)}
			{/each}
			{#each topicsInFolder(folder.id) as topic (topic.id)}
				{@render settingsTopicRow(topic, depth + 1)}
			{/each}
		{/if}
	</div>
{/snippet}

{#snippet settingsTopicRow(topic: Topic, depth: number)}
	<div class="topic-row">
		<a
			href="/?topic={topic.id}"
			class="topic-item"
			style="padding-left: {14 + depth * 14}px"
		>
			<span class="topic-dot" style="background: {topic.color}"></span>
			<span class="topic-name">{topic.name}</span>
			<span class="topic-count">{noteCountForTopic(topic.id)}</span>
		</a>
	</div>
{/snippet}

<style>
	/* ── Two-column layout ────────────────────────────── */
	.settings-layout {
		display: flex;
		height: 100%;
		overflow: hidden;
	}

	/* ── Topics panel (matches +page.svelte styles exactly) ── */
	.topics-panel {
		width: var(--sidebar-w);
		flex-shrink: 0;
		border-right: 1px solid var(--border);
		display: none; /* hidden on mobile */
		flex-direction: column;
		overflow: hidden;
		background: var(--bg-elevated);
	}

	@media (min-width: 768px) {
		.topics-panel { display: flex; }
	}

	.panel-logo {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: max(env(safe-area-inset-top, 0px), 8px) 14px;
		min-height: var(--nav-h);
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
	}
	.panel-logo-icon { width: 24px; height: 24px; border-radius: 6px; object-fit: cover; flex-shrink: 0; }
	.panel-logo-text { font-size: 14px; font-weight: 600; color: var(--text); letter-spacing: -0.01em; }

	.topics-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 12px 4px;
		flex-shrink: 0;
	}

	.topic-list-pinned {
		display: flex;
		flex-direction: column;
		gap: 1px;
		padding: 0 8px;
		flex-shrink: 0;
	}

	.topic-list {
		flex: 1;
		overflow-y: auto;
		padding: 0 8px;
	}

	.topic-separator {
		height: 1px;
		background: var(--border);
		margin: 4px 0;
	}

	.topic-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		border-radius: var(--radius-sm);
		font-size: 13px;
		color: var(--text-muted);
		cursor: pointer;
		background: none;
		border: none;
		width: 100%;
		text-align: left;
		text-decoration: none;
		transition: background 0.1s ease, color 0.1s ease;
	}
	@media (hover: hover) { .topic-item:hover { background: var(--bg-hover); color: var(--text); text-decoration: none; } }
	.topic-item.active { background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent); }
	.topic-item-all { font-weight: 500; }

	.topic-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}
	.topic-dot-uncategorised { background: var(--text-faint); }

	.topic-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.topic-count { font-size: 11px; color: var(--text-faint); flex-shrink: 0; }

	/* Folder rows */
	.folder-row { display: flex; flex-direction: column; }
	.folder-item {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 5px 10px;
		border-radius: var(--radius-sm);
		color: var(--text-muted);
		font-size: 12.5px;
		cursor: default;
	}
	.folder-chevron {
		background: none;
		border: none;
		padding: 0;
		color: var(--text-faint);
		cursor: pointer;
		display: flex;
		align-items: center;
		flex-shrink: 0;
		transition: transform 0.15s ease;
	}
	.folder-chevron.collapsed svg { transform: rotate(-90deg); }
	.folder-icon { color: var(--text-faint); flex-shrink: 0; }
	.folder-name { font-size: 12.5px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.topic-row { display: flex; align-items: center; }

	/* Panel footer */
	.panel-footer {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 8px 10px;
		border-top: 1px solid var(--border);
		flex-shrink: 0;
	}
	.panel-user {
		display: flex; align-items: center; gap: 8px;
		flex: 1; min-width: 0;
		padding: 6px 8px;
		border-radius: var(--radius-sm);
		text-align: left;
	}
	.panel-user-avatar {
		width: 24px; height: 24px; border-radius: 50%;
		background: var(--accent-dim); color: var(--accent);
		font-size: 11px; font-weight: 600;
		display: flex; align-items: center; justify-content: center;
		flex-shrink: 0;
	}
	.panel-user-name {
		font-size: 13px; color: var(--text-muted);
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	.panel-settings-btn {
		display: flex; align-items: center; justify-content: center;
		padding: 6px; color: var(--text-faint);
		border-radius: var(--radius-sm);
		transition: background 0.12s, color 0.12s;
		flex-shrink: 0; text-decoration: none;
	}
	.panel-settings-active { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); text-decoration: none; }
	@media (hover: hover) { .panel-settings-btn:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); text-decoration: none; } }
	.panel-srv-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
	.panel-srv-dot-checking { background: var(--text-faint); animation: srv-pulse 1s infinite; }
	.panel-srv-dot-online   { background: var(--success); }
	.panel-srv-dot-offline  { background: var(--danger); }
	@keyframes srv-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

	/* ── Settings content ─────────────────────────────── */
	.page {
		flex: 1;
		overflow-y: auto;
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

	@media (hover: hover) {
		.row-btn:hover {
			background: var(--bg-hover);
		}
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

	@media (hover: hover) {
		.revoke-btn:hover {
			background: color-mix(in srgb, var(--danger) 10%, transparent);
		}
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
	.version-block {
		text-align: center;
		padding-top: 8px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.version {
		font-size: 11px;
		color: var(--text-faint);
	}
	.version.commit code {
		font-family: ui-monospace, monospace;
		font-size: 10px;
		background: var(--bg-hover);
		padding: 1px 4px;
		border-radius: 3px;
	}
	.version.links a {
		color: var(--text-faint);
		text-decoration: none;
		font-size: 11px;
	}
	@media (hover: hover) {
		.version.links a:hover { color: var(--accent); }
	}
	.dot-sep {
		color: var(--text-faint);
		margin: 0 4px;
		font-size: 11px;
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
