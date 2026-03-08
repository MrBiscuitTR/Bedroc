<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		auth, login, setServerUrl, removeSavedServer,
		normaliseServerUrl, checkServerHealth, serverStatus, isSelfSignedCandidate,
	} from '$lib/stores/auth.svelte.js';
	import { loadFromDb, syncFromServer } from '$lib/stores/notes.svelte.js';

	let serverExpanded = $state(false);
	let showPassword = $state(false);
	let username = $state('');
	let password = $state('');
	let newServerInput = $state(auth.serverUrl);

	// Local client-side validation errors; combined with store errors
	let localError = $state<string | null>(null);
	let displayError = $derived(localError ?? auth.error);

	async function handleSubmit(e: Event) {
		e.preventDefault();
		localError = null;
		if (!username.trim()) { localError = 'Please enter your username.'; return; }
		if (!password) { localError = 'Please enter your password.'; return; }
		try {
			await login(username.trim(), password);
			await loadFromDb();
			syncFromServer(); // fire-and-forget background sync
			goto('/');
		} catch {
			// error already set in auth.error by the store
		}
	}

	async function saveServer() {
		const url = normaliseServerUrl(newServerInput.trim());
		newServerInput = url; // show normalised form
		setServerUrl(url);
		serverExpanded = false;
		await checkServerHealth(url);
	}

	function selectServer(url: string) {
		setServerUrl(url);
		newServerInput = url;
		serverExpanded = false;
		checkServerHealth(url);
	}

	// Run health check whenever server panel opens
	$effect(() => { if (serverExpanded) checkServerHealth(); });

	const statusDot: Record<string, string> = {
		unknown: 'dot-unknown', checking: 'dot-checking',
		online:  'dot-online',  offline:  'dot-offline',
	};
	const statusLabel: Record<string, string> = {
		unknown: '', checking: 'Checking…', online: 'Online', offline: 'Unreachable',
	};
</script>

<svelte:head>
	<title>Log in — Bedroc</title>
</svelte:head>

<div class="auth-card">
	<div class="brand">
		<img src="/icons/appicon-96.png" alt="Bedroc" class="brand-mark" width="44" height="44" />
		<h1 class="brand-name">Bedroc</h1>
		<p class="brand-tagline">Private synchronous notes, your way</p>
	</div>

	<form class="form" onsubmit={handleSubmit}>
		{#if displayError}
			<div class="error-banner" role="alert">{displayError}</div>
		{/if}

		<div class="field">
			<label for="username" class="field-label">Username</label>
			<input
				id="username"
				type="text"
				autocomplete="username"
				autocorrect="off"
				autocapitalize="off"
				spellcheck="false"
				placeholder="your username"
				bind:value={username}
				disabled={auth.loading}
				required
			/>
		</div>

		<div class="field">
			<label for="password" class="field-label">Password</label>
			<div class="input-wrap">
				<input
					id="password"
					type={showPassword ? 'text' : 'password'}
					autocomplete="current-password"
					placeholder="••••••••••••"
					bind:value={password}
					disabled={auth.loading}
					required
				/>
				<button
					type="button"
					class="btn-icon pw-toggle"
					onclick={() => (showPassword = !showPassword)}
					aria-label={showPassword ? 'Hide password' : 'Show password'}
				>
					{#if showPassword}
						<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
							<path d="M2 2l12 12M6.5 6.6A2 2 0 0 0 9.4 9.5M4.2 4.3C2.8 5.2 1.8 6.5 1.5 8c.8 3.3 4 5.5 6.5 5.5 1.2 0 2.3-.4 3.3-1M6 2.6C6.6 2.4 7.3 2.5 8 2.5c2.5 0 5.7 2.2 6.5 5.5-.3 1.2-.9 2.3-1.8 3.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
						</svg>
					{:else}
						<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
							<path d="M8 3C4.7 3 1.8 5.2 1 8c.8 2.8 3.7 5 7 5s6.2-2.2 7-5c-.8-2.8-3.7-5-7-5z" stroke="currentColor" stroke-width="1.4"/>
							<circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.4"/>
						</svg>
					{/if}
				</button>
			</div>
		</div>

		<!-- Server URL — subtle, expandable -->
		<div class="server-row">
			<button type="button" class="server-toggle" onclick={() => (serverExpanded = !serverExpanded)}>
				<span class="server-label">Server</span>
				<span class="server-url">{auth.serverUrl}</span>
				<svg
					width="12"
					height="12"
					viewBox="0 0 12 12"
					fill="none"
					class="chevron"
					class:rotated={serverExpanded}
				>
					<path d="M2 4l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</button>

			{#if serverExpanded}
				<div class="server-input-wrap">
					<!-- type="text" so bare IPs (10.66.66.1) are accepted without browser validation errors -->
					<input
						type="text"
						class="server-input"
						placeholder="https://api.bedroc.app or 10.66.66.1"
						bind:value={newServerInput}
						spellcheck="false"
						autocorrect="off"
						autocapitalize="off"
					/>
					<button type="button" class="btn-ghost server-save" onclick={saveServer}>
						Save
					</button>
				</div>

				<!-- Live health check indicator -->
				{#if serverStatus.value !== 'unknown'}
					<div class="server-status">
						<span class="status-dot {statusDot[serverStatus.value]}"></span>
						<span class="status-text" class:status-offline={serverStatus.value === 'offline'}>
							{statusLabel[serverStatus.value]}
						</span>
						{#if serverStatus.value === 'offline'}
							<span class="status-help">— Check the URL and make sure the server is running</span>
							{#if isSelfSignedCandidate(auth.serverUrl)}
								<span class="status-help">Self-signed cert: browsers block cross-origin requests to self-signed HTTPS. <a href="{auth.serverUrl}/login" target="_blank" rel="noopener">Open the app directly at {auth.serverUrl}/login</a> — same-origin requests always work.</span>
							{/if}
						{/if}
					</div>
				{/if}

				{#if auth.savedServers.length > 1}
					<div class="saved-servers">
						{#each auth.savedServers as url}
							<div class="saved-server-row">
								<button type="button" class="saved-server-btn" onclick={() => selectServer(url)}>
									{url}
								</button>
								{#if url !== 'https://api.bedroc.app'}
									<button
										type="button"
										class="btn-icon remove-server"
										onclick={() => removeSavedServer(url)}
										aria-label="Remove server"
									>
										<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
											<path d="M2 2l8 8M10 2L2 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
										</svg>
									</button>
								{/if}
							</div>
						{/each}
					</div>
				{/if}

				<p class="server-hint">
					Enter any format: <code>10.66.66.1</code>, <code>192.168.1.5:3000</code>, or <code>https://notes.example.com</code>. Bare IPs and domain names default to https://.
				</p>
			{/if}
		</div>

		<button type="submit" class="btn-primary" disabled={auth.loading}>
			{auth.loading ? 'Logging in…' : 'Log in'}
		</button>
	</form>

	<p class="auth-switch">
		No account? <a href="/register">Register</a>
	</p>
</div>

<style>
	.auth-card {
		width: 100%;
		max-width: 360px;
		display: flex;
		flex-direction: column;
		gap: 28px;
	}

	/* Brand */
	.brand {
		text-align: center;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
	}

	.brand-mark {
		width: 44px;
		height: 44px;
		border-radius: 12px;
		object-fit: cover;
		margin-bottom: 4px;
	}

	.brand-name {
		font-size: 22px;
		font-weight: 700;
		letter-spacing: -0.02em;
		color: var(--text);
	}

	.brand-tagline {
		font-size: 13px;
		color: var(--text-muted);
	}

	/* Error banner */
	.error-banner {
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
		border-radius: var(--radius-md);
		padding: 10px 12px;
		font-size: 13px;
		color: var(--danger);
	}

	/* Form */
	.form {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.field-label {
		font-size: 12px;
		font-weight: 500;
		color: var(--text-muted);
	}

	/* Password field with toggle */
	.input-wrap {
		position: relative;
	}

	.input-wrap input {
		padding-right: 40px;
	}

	.pw-toggle {
		position: absolute;
		right: 8px;
		top: 50%;
		transform: translateY(-50%);
	}

	/* Server row */
	.server-row {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.server-toggle {
		display: flex;
		align-items: center;
		gap: 6px;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		width: fit-content;
	}

	.server-label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-faint);
	}

	.server-url {
		font-size: 12px;
		color: var(--text-muted);
		max-width: 200px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.chevron {
		color: var(--text-faint);
		transition: transform 0.15s ease;
		flex-shrink: 0;
	}

	.chevron.rotated {
		transform: rotate(180deg);
	}

	.server-input-wrap {
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.server-input {
		font-size: 13px !important;
		padding: 8px 10px !important;
	}

	.server-save {
		flex-shrink: 0;
		font-size: 12px;
		padding: 7px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		white-space: nowrap;
	}

	.saved-servers {
		display: flex;
		flex-direction: column;
		gap: 2px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		overflow: hidden;
	}

	.saved-server-row {
		display: flex;
		align-items: center;
	}

	.saved-server-btn {
		flex: 1;
		text-align: left;
		background: none;
		border: none;
		padding: 8px 10px;
		font-size: 12px;
		color: var(--text-muted);
		cursor: pointer;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.saved-server-btn:hover {
		background: var(--bg-hover);
		color: var(--text);
	}

	.remove-server {
		padding: 8px;
		color: var(--text-faint);
	}

	.remove-server:hover {
		color: var(--danger);
	}

	.server-hint {
		font-size: 11px;
		color: var(--text-faint);
		line-height: 1.6;
	}

	.server-hint code {
		font-family: monospace;
		font-size: 11px;
		background: var(--bg-hover);
		padding: 1px 4px;
		border-radius: 3px;
	}

	/* Health check status */
	.server-status {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
	}

	.status-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.dot-unknown  { background: var(--text-faint); }
	.dot-checking { background: var(--text-faint); animation: pulse 1s infinite; }
	.dot-online   { background: var(--success); }
	.dot-offline  { background: var(--danger); }

	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50%       { opacity: 0.3; }
	}

	.status-text { color: var(--text-muted); }
	.status-text.status-offline { color: var(--danger); }
	.status-help { color: var(--text-faint); font-size: 11px; }

	/* Bottom link */
	.auth-switch {
		text-align: center;
		font-size: 13px;
		color: var(--text-muted);
	}
</style>
