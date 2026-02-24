<script lang="ts">
	// Default public server — users change this to their own backend URL.
	// The value is persisted to localStorage so it survives page reloads.
	let serverUrl = $state(
		typeof localStorage !== 'undefined'
			? (localStorage.getItem('bedroc_server') ?? 'https://api.bedroc.app')
			: 'https://api.bedroc.app'
	);

	let serverExpanded = $state(false);
	let showPassword = $state(false);
	let username = $state('');
	let password = $state('');

	function toggleServer() {
		serverExpanded = !serverExpanded;
	}

	function saveServer() {
		localStorage.setItem('bedroc_server', serverUrl);
		serverExpanded = false;
	}

	function handleSubmit(e: Event) {
		e.preventDefault();
		// Auth logic wired in Phase 1 — placeholder for now.
	}
</script>

<svelte:head>
	<title>Log in — Bedroc</title>
</svelte:head>

<div class="auth-card">
	<div class="brand">
		<div class="brand-mark">B</div>
		<h1 class="brand-name">Bedroc</h1>
		<p class="brand-tagline">Private synchronous notes, your way</p>
	</div>

	<form class="form" onsubmit={handleSubmit}>
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
			<button type="button" class="server-toggle" onclick={toggleServer}>
				<span class="server-label">Server</span>
				<span class="server-url">{serverUrl}</span>
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
					<input
						type="url"
						class="server-input"
						placeholder="https://api.bedroc.app"
						bind:value={serverUrl}
						spellcheck="false"
						autocorrect="off"
						autocapitalize="off"
					/>
					<button type="button" class="btn-ghost server-save" onclick={saveServer}>
						Save
					</button>
				</div>
				<p class="server-hint">
					Enter your self-hosted backend URL, or leave as default to use bedroc.app.
				</p>
			{/if}
		</div>

		<button type="submit" class="btn-primary">Log in</button>
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
		background: var(--accent);
		color: #fff;
		font-size: 22px;
		font-weight: 700;
		border-radius: 12px;
		display: flex;
		align-items: center;
		justify-content: center;
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

	.server-hint {
		font-size: 11px;
		color: var(--text-faint);
		line-height: 1.5;
	}

	/* Bottom link */
	.auth-switch {
		text-align: center;
		font-size: 13px;
		color: var(--text-muted);
	}
</style>
