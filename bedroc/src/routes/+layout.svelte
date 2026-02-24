<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';

	let { children } = $props();

	// Extracted as plain string — prevents TypeScript from narrowing the
	// SvelteKit route pattern type and producing false "no overlap" errors.
	let path = $derived(page.url.pathname as string);

	const authRoutes = ['/login', '/register'];
	let isAuthRoute = $derived(authRoutes.includes(path));

	const navItems = [
		{ href: '/',         label: 'Notes',    icon: 'notes' },
		{ href: '/settings', label: 'Settings', icon: 'settings' }
	];
</script>

{#if isAuthRoute}
	<!-- Bare layout for login / register -->
	<div class="auth-shell">
		{@render children()}
	</div>
{:else}
	<!-- Full app shell -->
	<div class="app-shell">
		<!-- ── Sidebar (desktop) ───────────────────────── -->
		<aside class="sidebar">
			<div class="sidebar-logo">
				<span class="logo-mark">b</span>
				<span class="logo-text">bedroc</span>
			</div>

			<nav class="sidebar-nav">
				{#each navItems as item}
					<a
						href={item.href}
						class="nav-item"
						class:active={path === item.href ||
							(path.startsWith('/note') && item.href === '/')}
					>
						<span class="nav-icon" aria-hidden="true">
							{#if item.icon === 'notes'}
								<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
									<rect x="2" y="2" width="12" height="2" rx="1" fill="currentColor"/>
									<rect x="2" y="6" width="9" height="2" rx="1" fill="currentColor"/>
									<rect x="2" y="10" width="11" height="2" rx="1" fill="currentColor"/>
									<rect x="2" y="14" width="7" height="1.5" rx="0.75" fill="currentColor"/>
								</svg>
							{:else if item.icon === 'settings'}
								<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
									<circle cx="8" cy="8" r="2.5" stroke="currentColor" stroke-width="1.5"/>
									<path d="M8 1v2M8 13v2M1 8h2M13 8h2M2.93 2.93l1.41 1.41M11.66 11.66l1.41 1.41M2.93 13.07l1.41-1.41M11.66 4.34l1.41-1.41" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
								</svg>
							{/if}
						</span>
						<span>{item.label}</span>
					</a>
				{/each}
			</nav>

			<div class="sidebar-footer">
				<button class="btn-ghost sidebar-user" onclick={() => {}}>
					<span class="user-avatar" aria-hidden="true">U</span>
					<span class="user-name">username</span>
				</button>
			</div>
		</aside>

		<!-- ── Main content ────────────────────────────── -->
		<div class="main-wrap">
			<!-- Mobile header -->
			<header class="mobile-header">
				<span class="mobile-title">
					{#if path === '/'}
						Notes
					{:else if path.startsWith('/note')}
						Edit note
					{:else if path === '/settings'}
						Settings
					{:else}
						bedroc
					{/if}
				</span>
				{#if path === '/'}
					<a href="/note/new" class="btn-icon" aria-label="New note">
						<svg width="18" height="18" viewBox="0 0 18 18" fill="none">
							<path d="M9 3v12M3 9h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
						</svg>
					</a>
				{/if}
			</header>

			<!-- Page content -->
			<main class="main-content">
				{@render children()}
			</main>

			<!-- Mobile bottom nav -->
			<nav class="bottom-nav" aria-label="Main navigation">
				{#each navItems as item}
					<a
						href={item.href}
						class="bottom-nav-item"
						class:active={path === item.href ||
							(path.startsWith('/note') && item.href === '/')}
					>
						<span class="nav-icon" aria-hidden="true">
							{#if item.icon === 'notes'}
								<svg width="20" height="20" viewBox="0 0 16 16" fill="none">
									<rect x="2" y="2" width="12" height="2" rx="1" fill="currentColor"/>
									<rect x="2" y="6" width="9" height="2" rx="1" fill="currentColor"/>
									<rect x="2" y="10" width="11" height="2" rx="1" fill="currentColor"/>
									<rect x="2" y="14" width="7" height="1.5" rx="0.75" fill="currentColor"/>
								</svg>
							{:else if item.icon === 'settings'}
								<svg width="20" height="20" viewBox="0 0 16 16" fill="none">
									<circle cx="8" cy="8" r="2.5" stroke="currentColor" stroke-width="1.5"/>
									<path d="M8 1v2M8 13v2M1 8h2M13 8h2M2.93 2.93l1.41 1.41M11.66 11.66l1.41 1.41M2.93 13.07l1.41-1.41M11.66 4.34l1.41-1.41" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
								</svg>
							{/if}
						</span>
						<span class="bottom-nav-label">{item.label}</span>
					</a>
				{/each}
			</nav>
		</div>
	</div>
{/if}

<style>
	/* ── Auth shell ───────────────────────────────────── */
	.auth-shell {
		min-height: 100dvh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px 16px;
		background: var(--bg);
	}

	/* ── App shell ────────────────────────────────────── */
	.app-shell {
		display: flex;
		height: 100dvh;
		overflow: hidden;
	}

	/* ── Sidebar ──────────────────────────────────────── */
	.sidebar {
		width: var(--sidebar-w);
		background: var(--bg-elevated);
		border-right: 1px solid var(--border);
		display: none; /* hidden on mobile */
		flex-direction: column;
		flex-shrink: 0;
	}

	@media (min-width: 768px) {
		.sidebar { display: flex; }
	}

	.sidebar-logo {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 20px 18px 16px;
		border-bottom: 1px solid var(--border);
	}

	.logo-mark {
		width: 28px;
		height: 28px;
		background: var(--accent);
		color: #fff;
		font-weight: 700;
		font-size: 15px;
		border-radius: 7px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.logo-text {
		font-size: 15px;
		font-weight: 600;
		color: var(--text);
		letter-spacing: -0.01em;
	}

	.sidebar-nav {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 12px 10px;
		flex: 1;
	}

	.nav-item {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 10px;
		border-radius: var(--radius-sm);
		color: var(--text-muted);
		font-size: 13.5px;
		font-weight: 500;
		text-decoration: none;
		transition: background 0.12s ease, color 0.12s ease;
	}

	.nav-item:hover {
		background: var(--bg-hover);
		color: var(--text);
		text-decoration: none;
	}

	.nav-item.active {
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		color: var(--accent);
	}

	.nav-icon {
		display: flex;
		align-items: center;
		flex-shrink: 0;
	}

	.sidebar-footer {
		padding: 12px 10px;
		border-top: 1px solid var(--border);
	}

	.sidebar-user {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 8px 10px;
		border-radius: var(--radius-sm);
		text-align: left;
	}

	.user-avatar {
		width: 26px;
		height: 26px;
		border-radius: 50%;
		background: var(--accent-dim);
		color: var(--accent);
		font-size: 12px;
		font-weight: 600;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.user-name {
		font-size: 13px;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* ── Main wrap ────────────────────────────────────── */
	.main-wrap {
		flex: 1;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	/* ── Mobile header ────────────────────────────────── */
	.mobile-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: var(--nav-h);
		padding: 0 16px;
		background: var(--bg-elevated);
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
	}

	@media (min-width: 768px) {
		.mobile-header { display: none; }
	}

	.mobile-title {
		font-size: 16px;
		font-weight: 600;
		color: var(--text);
	}

	/* ── Main content ─────────────────────────────────── */
	.main-content {
		flex: 1;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
	}

	/* ── Bottom nav ───────────────────────────────────── */
	.bottom-nav {
		display: flex;
		background: var(--bg-elevated);
		border-top: 1px solid var(--border);
		/* Safe area for iOS home indicator */
		padding-bottom: env(safe-area-inset-bottom);
		flex-shrink: 0;
	}

	@media (min-width: 768px) {
		.bottom-nav { display: none; }
	}

	.bottom-nav-item {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 3px;
		padding: 10px 8px;
		color: var(--text-faint);
		text-decoration: none;
		transition: color 0.12s ease;
	}

	.bottom-nav-item:hover,
	.bottom-nav-item.active {
		color: var(--accent);
		text-decoration: none;
	}

	.bottom-nav-label {
		font-size: 10px;
		font-weight: 500;
		letter-spacing: 0.02em;
	}
</style>
