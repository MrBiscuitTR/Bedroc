<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { auth, restoreSession } from '$lib/stores/auth.svelte.js';
	import { connect as wsConnect, disconnect as wsDisconnect } from '$lib/sync/websocket.js';

	let { children } = $props();

	let path = $derived(page.url.pathname as string);

	const authRoutes = ['/login', '/register'];
	let isAuthRoute = $derived(authRoutes.includes(path));

	// Note editor owns its full-width toolbar on mobile, so we hide the global
	// mobile header on that route to avoid doubling up.
	let isNoteRoute = $derived(path.startsWith('/note'));

	// ── Service worker registration ───────────────────────────────
	// Runs once on mount. Safe on all platforms (iOS 11.3+, Android, desktop).
	onMount(() => {
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.register('/sw.js').catch(() => {
				// Registration failure is non-fatal — app still works without SW
			});
		}
	});

	// ── Auth guard + WebSocket ─────────────────────────────────────
	// On mount, try to restore session from httpOnly refresh cookie.
	// If that fails (or DEK is missing), redirect to /login.
	// On success, open the WebSocket connection for real-time sync.
	onMount(async () => {
		if (isAuthRoute) return;
		await restoreSession();
		if (!auth.isLoggedIn) {
			goto('/login');
		} else {
			wsConnect();
		}

		// Disconnect WebSocket on page unload (tab close, navigate away)
		return () => {
			wsDisconnect();
		};
	});

	// Reconnect when auth state changes (e.g. token refreshed, login from another tab)
	$effect(() => {
		if (auth.isLoggedIn && !isAuthRoute) {
			wsConnect();
		} else {
			wsDisconnect();
		}
	});

	const navItems = [
		{ href: '/',         label: 'Notes',    icon: 'notes' },
		{ href: '/settings', label: 'Settings', icon: 'settings' }
	];

	// ── Split-window state ─────────────────────────────────────────
	let splitActive  = $state(false);
	let splitUrl     = $state('/');
	let splitWidth   = $state(50);
	let isDragging   = $state(false);
	let splitterEl: HTMLDivElement;
	let containerEl: HTMLDivElement;

	function openSplit() {
		splitUrl    = '/';
		splitActive = true;
	}

	function closeSplit() {
		splitActive = false;
	}

	function onSplitterPointerDown(e: PointerEvent) {
		e.preventDefault();
		isDragging = true;
		splitterEl.setPointerCapture(e.pointerId);
	}

	function onSplitterPointerMove(e: PointerEvent) {
		if (!isDragging || !containerEl) return;
		const rect = containerEl.getBoundingClientRect();
		const rightPct = Math.max(20, Math.min(80, ((rect.right - e.clientX) / rect.width) * 100));
		splitWidth = rightPct;
	}

	function onSplitterPointerUp(e: PointerEvent) {
		isDragging = false;
		splitterEl?.releasePointerCapture(e.pointerId);
	}
</script>

{#if isAuthRoute}
	<div class="auth-shell">
		{@render children()}
	</div>
{:else}
	<div class="app-shell">
		<!-- ── Sidebar (desktop) ───────────────────────── -->
		<aside class="sidebar">
			<div class="sidebar-logo">
				<img src="/icons/appicon-96.png" alt="Bedroc" class="logo-icon" width="28" height="28" />
				<span class="logo-text">Bedroc</span>
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

			<!-- Split window toggle -->
			<div class="sidebar-split">
				{#if splitActive}
					<button class="btn-ghost split-btn" onclick={closeSplit} title="Close split view" aria-label="Close split view">
						<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
							<rect x="1" y="1" width="5.5" height="12" rx="1" stroke="currentColor" stroke-width="1.3"/>
							<rect x="7.5" y="1" width="5.5" height="12" rx="1" stroke="currentColor" stroke-width="1.3" opacity="0.4"/>
							<path d="M10 5l2 2-2 2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
						</svg>
						<span>Close split</span>
					</button>
				{:else}
					<button class="btn-ghost split-btn" onclick={openSplit} title="Open split view" aria-label="Open split view">
						<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
							<rect x="1" y="1" width="5.5" height="12" rx="1" stroke="currentColor" stroke-width="1.3"/>
							<rect x="7.5" y="1" width="5.5" height="12" rx="1" stroke="currentColor" stroke-width="1.3"/>
						</svg>
						<span>Split view</span>
					</button>
				{/if}
			</div>

			<div class="sidebar-footer">
				<button class="btn-ghost sidebar-user" onclick={() => {}}>
					<span class="user-avatar" aria-hidden="true">U</span>
					<span class="user-name">username</span>
				</button>
			</div>
		</aside>

		<!-- ── Main content area ────────────────────────── -->
		<div
			class="main-wrap"
			bind:this={containerEl}
			onpointermove={onSplitterPointerMove}
			onpointerup={onSplitterPointerUp}
		>
			<!-- Mobile header — hidden on desktop and on note editor pages
			     (the editor renders its own full-width toolbar that includes
			     a topics drawer toggle as its first item). Height is locked to
			     --nav-h so Notes/Settings pages are perfectly consistent. -->
			{#if !isNoteRoute}
				<header class="mobile-header">
					<span class="mobile-title">
						{#if path === '/'}Notes
						{:else if path === '/settings'}Settings
						{:else}Bedroc{/if}
					</span>
					<div class="mobile-header-actions">
						{#if path === '/'}
							<a href="/note/new" class="btn-icon" aria-label="New note">
								<svg width="18" height="18" viewBox="0 0 18 18" fill="none">
									<path d="M9 3v12M3 9h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
								</svg>
							</a>
						{/if}
					</div>
				</header>
			{/if}

			<!-- Pane container -->
			<div class="pane-container" class:split={splitActive}>
				<!-- Primary pane -->
				<main
					class="main-content"
					style={splitActive ? `width: calc(${100 - splitWidth}% - 2px)` : ''}
				>
					{@render children()}
				</main>

				<!-- Splitter (visible only in split mode) -->
				{#if splitActive}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="splitter"
						class:dragging={isDragging}
						bind:this={splitterEl}
						onpointerdown={onSplitterPointerDown}
						title="Drag to resize"
					>
						<div class="splitter-handle"></div>
					</div>

					<!-- Secondary pane (iframe for independent navigation) -->
					<div class="split-pane" style="width: {splitWidth}%">
						<div class="split-pane-toolbar">
							<span class="split-pane-label">Second pane</span>
							<button class="btn-icon split-close-btn" onclick={closeSplit} aria-label="Close second pane">
								<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
									<path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
								</svg>
							</button>
						</div>
						<iframe
							class="split-iframe"
							src={splitUrl}
							title="Second pane"
							allow="same-origin"
						></iframe>
					</div>
				{/if}
			</div>

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
		overscroll-behavior: none;
	}

	/* ── Sidebar ──────────────────────────────────────── */
	.sidebar {
		width: var(--sidebar-w);
		background: var(--bg-elevated);
		border-right: 1px solid var(--border);
		display: none;
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
		min-height: var(--nav-h);
		padding: max(env(safe-area-inset-top, 0px), 8px) 18px;
		border-bottom: 1px solid var(--border);
	}

	.logo-icon {
		width: 28px;
		height: 28px;
		border-radius: 7px;
		flex-shrink: 0;
		object-fit: cover;
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

	/* Split button in sidebar */
	.sidebar-split {
		padding: 6px 10px;
		border-top: 1px solid var(--border);
	}

	.split-btn {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 7px 10px;
		font-size: 12.5px;
		border-radius: var(--radius-sm);
		color: var(--text-muted);
	}

	.split-btn:hover {
		color: var(--text);
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
		min-width: 0;
	}

	/* ── Mobile header ────────────────────────────────── */
	/* Fixed height (--nav-h) so Notes / Settings headers are identical.
	   Hidden on desktop. Not rendered at all on /note/* routes (editor
	   has its own toolbar that fills this visual role). */
	.mobile-header {
		display: flex;
		align-items: center; /* center vertically to match sidebar logo */
		justify-content: space-between;
		min-height: var(--nav-h);
		padding: max(env(safe-area-inset-top, 0px), 8px) 16px; /* symmetric vertical padding */
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
		line-height: 1;
	}

	.mobile-header-actions {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	/* ── Pane container ───────────────────────────────── */
	.pane-container {
		flex: 1;
		display: flex;
		overflow: hidden;
		min-height: 0;
	}

	/* ── Main content (primary pane) ──────────────────── */
	.main-content {
		flex: 1;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
		overscroll-behavior: contain;
		min-width: 0;
		transition: width 0.05s ease;
	}

	/* In split mode, primary pane has explicit width set inline */
	.pane-container.split .main-content {
		flex: none;
	}

	/* ── Splitter ─────────────────────────────────────── */
	.splitter {
		width: 4px;
		flex-shrink: 0;
		background: var(--border);
		cursor: col-resize;
		position: relative;
		transition: background 0.15s ease;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.splitter:hover,
	.splitter.dragging {
		background: var(--accent);
	}

	.splitter-handle {
		width: 2px;
		height: 32px;
		border-radius: 999px;
		background: currentColor;
		opacity: 0.5;
	}

	/* ── Secondary pane ───────────────────────────────── */
	.split-pane {
		display: flex;
		flex-direction: column;
		flex-shrink: 0;
		min-width: 200px;
		border-left: 1px solid var(--border);
	}

	.split-pane-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 6px 10px;
		background: var(--bg-elevated);
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
	}

	.split-pane-label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-faint);
	}

	.split-close-btn {
		color: var(--text-faint);
		padding: 4px;
	}

	.split-close-btn:hover { color: var(--danger); }

	.split-iframe {
		flex: 1;
		border: none;
		background: var(--bg);
		display: block;
	}

	/* ── Bottom nav ───────────────────────────────────── */
	/* background-color on .main-wrap fills the gap below safe-area on PWA home screen */
	.main-wrap { background: var(--bg-elevated); }

	.bottom-nav {
		display: flex;
		background: var(--bg-elevated);
		border-top: 1px solid var(--border);
		/* Safe area for home indicator — zero on non-notch devices */
		padding-bottom: env(safe-area-inset-bottom, 0px);
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
		-webkit-tap-highlight-color: transparent;
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
