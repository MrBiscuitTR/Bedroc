<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		auth, register, setServerUrl,
		normaliseServerUrl, checkServerHealth, serverStatus, isSelfSignedCandidate,
	} from '$lib/stores/auth.svelte.js';
	import { loadFromDb } from '$lib/stores/notes.svelte.js';

	let serverExpanded = $state(false);
	let showPassword = $state(false);
	let showConfirm = $state(false);
	let username = $state('');
	let password = $state('');
	let confirm = $state('');
	let newServerInput = $state(auth.serverUrl);

	let localError = $state<string | null>(null);
	let displayError = $derived(localError ?? auth.error);

	// Password strength 0–4
	let strength = $derived((() => {
		if (password.length === 0) return 0;
		let score = 0;
		if (password.length >= 12) score++;
		if (/[A-Z]/.test(password)) score++;
		if (/[0-9]/.test(password)) score++;
		if (/[^A-Za-z0-9]/.test(password)) score++;
		return score;
	})());

	const strengthLabels = ['', 'Weak', 'Fair', 'Good', 'Strong'];
	const strengthColors = ['', '#e05c5c', '#e0a45c', '#6b8afd', '#4caf87'];

	let passwordTooWeak = $derived(password.length > 0 && strength < 2);
	let passwordsMatch = $derived(confirm.length > 0 && password === confirm);
	let passwordMismatch = $derived(confirm.length > 0 && password !== confirm);
	// passwordTooWeak is shown as a visual warning but does NOT block submission
	let submitDisabled = $derived(
		auth.loading ||
		!username.trim() ||
		!password ||
		!confirm ||
		passwordMismatch
	);

	async function saveServer() {
		const url = normaliseServerUrl(newServerInput.trim());
		newServerInput = url;
		setServerUrl(url);
		serverExpanded = false;
		await checkServerHealth(url);
	}

	$effect(() => { if (serverExpanded) checkServerHealth(); });

	const statusDot: Record<string, string> = {
		unknown: 'dot-unknown', checking: 'dot-checking',
		online:  'dot-online',  offline:  'dot-offline',
	};
	const statusLabel: Record<string, string> = {
		unknown: '', checking: 'Checking…', online: 'Online', offline: 'Unreachable',
	};

	async function handleSubmit(e: Event) {
		e.preventDefault();
		localError = null;

		if (!username.trim()) { localError = 'Please choose a username.'; return; }
		if (username.trim().length < 3) { localError = 'Username must be at least 3 characters.'; return; }
		if (/\s/.test(username.trim())) { localError = 'Username cannot contain spaces.'; return; }
		if (password.length < 8) { localError = 'Password must be at least 8 characters.'; return; }
		if (strength < 2) { localError = 'Password is too weak. Add uppercase letters, numbers, or symbols.'; return; }
		if (password !== confirm) { localError = 'Passwords do not match.'; return; }

		try {
			await register(username.trim(), password);
			await loadFromDb();
			goto('/');
		} catch {
			// error already set in auth.error
		}
	}
</script>

<svelte:head>
	<title>Register — Bedroc</title>
</svelte:head>

<div class="auth-card">
	<div class="brand">
		<img src="/icons/appicon-96.png" alt="Bedroc" class="brand-mark" width="44" height="44" />
		<h1 class="brand-name">Bedroc</h1>
		<p class="brand-tagline">Create your account</p>
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
				placeholder="choose a username"
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
					autocomplete="new-password"
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
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
						{#if showPassword}
							<path d="M2 2l12 12M6.5 6.6A2 2 0 0 0 9.4 9.5M4.2 4.3C2.8 5.2 1.8 6.5 1.5 8c.8 3.3 4 5.5 6.5 5.5 1.2 0 2.3-.4 3.3-1M6 2.6C6.6 2.4 7.3 2.5 8 2.5c2.5 0 5.7 2.2 6.5 5.5-.3 1.2-.9 2.3-1.8 3.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
						{:else}
							<path d="M8 3C4.7 3 1.8 5.2 1 8c.8 2.8 3.7 5 7 5s6.2-2.2 7-5c-.8-2.8-3.7-5-7-5z" stroke="currentColor" stroke-width="1.4"/>
							<circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.4"/>
						{/if}
					</svg>
				</button>
			</div>

			{#if password.length > 0}
				<div class="strength-bar-wrap">
					<div class="strength-bar">
						{#each [1, 2, 3, 4] as seg}
							<div
								class="strength-seg"
								style:background={seg <= strength ? strengthColors[strength] : 'var(--border)'}
							></div>
						{/each}
					</div>
					<span class="strength-label" style:color={strengthColors[strength]}>
						{strengthLabels[strength]}
					</span>
				</div>
				{#if passwordTooWeak}
					<p class="field-warning">Use at least 8 characters with uppercase, numbers, or symbols.</p>
				{/if}
			{/if}
		</div>

		<div class="field">
			<label for="confirm" class="field-label">Confirm password</label>
			<div class="input-wrap">
				<input
					id="confirm"
					type={showConfirm ? 'text' : 'password'}
					autocomplete="new-password"
					placeholder="••••••••••••"
					bind:value={confirm}
					disabled={auth.loading}
					class:input-error={passwordMismatch}
					class:input-ok={passwordsMatch}
					required
				/>
				<button
					type="button"
					class="btn-icon pw-toggle"
					onclick={() => (showConfirm = !showConfirm)}
					aria-label={showConfirm ? 'Hide password' : 'Show password'}
				>
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
						{#if showConfirm}
							<path d="M2 2l12 12M6.5 6.6A2 2 0 0 0 9.4 9.5M4.2 4.3C2.8 5.2 1.8 6.5 1.5 8c.8 3.3 4 5.5 6.5 5.5 1.2 0 2.3-.4 3.3-1M6 2.6C6.6 2.4 7.3 2.5 8 2.5c2.5 0 5.7 2.2 6.5 5.5-.3 1.2-.9 2.3-1.8 3.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
						{:else}
							<path d="M8 3C4.7 3 1.8 5.2 1 8c.8 2.8 3.7 5 7 5s6.2-2.2 7-5c-.8-2.8-3.7-5-7-5z" stroke="currentColor" stroke-width="1.4"/>
							<circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.4"/>
						{/if}
					</svg>
				</button>
			</div>
			{#if passwordMismatch}
				<p class="field-error">Passwords do not match.</p>
			{/if}
		</div>

		<!-- Server URL -->
		<div class="server-row">
			<button type="button" class="server-toggle" onclick={() => (serverExpanded = !serverExpanded)}>
				<span class="server-label">Server</span>
				<span class="server-url">{auth.serverUrl}</span>
				<svg width="12" height="12" viewBox="0 0 12 12" fill="none" class="chevron" class:rotated={serverExpanded}>
					<path d="M2 4l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</button>
			{#if serverExpanded}
				<div class="server-input-wrap">
					<input type="text" class="server-input" placeholder="https://api.bedroc.app or 10.66.66.1" bind:value={newServerInput} spellcheck="false" autocorrect="off" autocapitalize="off"/>
					<button type="button" class="btn-ghost server-save" onclick={saveServer}>Save</button>
				</div>
				{#if serverStatus.value !== 'unknown'}
					<div class="server-status">
						<span class="status-dot {statusDot[serverStatus.value]}"></span>
						<span class="status-text" class:status-offline={serverStatus.value === 'offline'}>
							{statusLabel[serverStatus.value]}
						</span>
						{#if serverStatus.value === 'offline'}
							<span class="status-help">— Check the URL and make sure the server is running</span>
							{#if isSelfSignedCandidate(auth.serverUrl)}
								<span class="status-help">Self-signed cert? <a href={auth.serverUrl} target="_blank" rel="noopener">Open {auth.serverUrl}</a> in a new tab, accept the certificate warning, then retry.</span>
							{/if}
						{/if}
					</div>
				{/if}
				<p class="server-hint">Enter any format: <code>10.66.66.1</code>, <code>192.168.1.5:3000</code>, or <code>https://notes.example.com</code>. Bare IPs and domain names default to https://.</p>
			{/if}
		</div>

		<!-- E2EE notice -->
		<div class="notice">
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="flex-shrink:0">
				<rect x="3" y="6" width="8" height="6" rx="1.5" stroke="currentColor" stroke-width="1.3"/>
				<path d="M5 6V4.5a2 2 0 1 1 4 0V6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
			</svg>
			<span>Your notes are encrypted with your password before leaving your device. <strong>If you lose your password, your data cannot be recovered.</strong> Use a password manager.</span>
		</div>

		<button type="submit" class="btn-primary" disabled={submitDisabled}>
			{auth.loading ? 'Creating account…' : 'Create account'}
		</button>
	</form>

	<p class="auth-switch">
		Already have an account? <a href="/login">Log in</a>
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
	}

	.brand-tagline {
		font-size: 13px;
		color: var(--text-muted);
	}

	.error-banner {
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
		border-radius: var(--radius-md);
		padding: 10px 12px;
		font-size: 13px;
		color: var(--danger);
	}

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

	.field-error {
		font-size: 11px;
		color: var(--danger);
	}

	.field-warning {
		font-size: 11px;
		color: var(--text-muted);
	}

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
	.dot-checking { background: var(--accent); animation: pulse 1s ease-in-out infinite; }
	.dot-online   { background: var(--success); }
	.dot-offline  { background: var(--danger); }

	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50%       { opacity: 0.3; }
	}

	.status-text    { color: var(--text-muted); }
	.status-offline { color: var(--danger); }
	.status-help    { color: var(--text-faint); font-size: 11px; }

	.server-hint code {
		font-family: monospace;
		background: var(--bg-hover);
		padding: 1px 4px;
		border-radius: 3px;
	}

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

	:global(.input-error) {
		border-color: var(--danger) !important;
	}

	:global(.input-ok) {
		border-color: var(--success) !important;
	}

	.strength-bar-wrap {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.strength-bar {
		display: flex;
		gap: 4px;
		flex: 1;
	}

	.strength-seg {
		height: 3px;
		flex: 1;
		border-radius: 999px;
		transition: background 0.2s ease;
	}

	.strength-label {
		font-size: 11px;
		font-weight: 600;
		min-width: 36px;
		transition: color 0.2s ease;
	}

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

	.server-hint {
		font-size: 11px;
		color: var(--text-faint);
		line-height: 1.5;
	}

	.notice {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		background: color-mix(in srgb, var(--accent) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent);
		border-radius: var(--radius-md);
		padding: 10px 12px;
		font-size: 12px;
		color: var(--text-muted);
		line-height: 1.5;
	}

	.notice svg {
		flex-shrink: 0;
		margin-top: 1px;
		color: var(--accent);
	}

	.notice strong {
		color: var(--text);
	}

	.auth-switch {
		text-align: center;
		font-size: 13px;
		color: var(--text-muted);
	}
</style>
