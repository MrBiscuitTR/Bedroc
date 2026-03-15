<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { auth, restoreSession, serverStatus, lockVault } from '$lib/stores/auth.svelte.js';
	import { initTheme } from '$lib/stores/theme.svelte.js';
	import { connect as wsConnect, disconnect as wsDisconnect } from '$lib/sync/websocket.js';
	import { syncFromServer, syncIntervalStore, loadFromDb, inactivityLockStore } from '$lib/stores/notes.svelte.js';

	let { children } = $props();

	let path = $derived(page.url.pathname as string);

	const authRoutes = ['/login', '/register'];
	let isAuthRoute = $derived(authRoutes.includes(path));

	// Note editor owns its full-width toolbar on mobile, so we hide the global
	// mobile header on that route to avoid doubling up.
	let isNoteRoute = $derived(path.startsWith('/note'));

	// ── Service worker registration + theme ──────────────────────
	onMount(() => {
		// Apply saved theme (data-theme attribute on <html>)
		initTheme();
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.register('/sw.js').catch(() => {
				// Registration failure is non-fatal — app still works without SW
			});
		}
	});

	// Detect if running inside a split-view iframe. Iframes share the same
	// origin so the refresh cookie works, but the DEK can't be unlocked without
	// a password — we don't redirect iframes to /login to avoid an auth loop.
	let isInIframe = $state(false);

	// ── Auth guard + WebSocket ─────────────────────────────────────
	// On mount, try to restore session from httpOnly refresh cookie.
	// If that fails (or DEK is missing), redirect to /login.
	// On success, open the WebSocket connection for real-time sync.
	onMount(async () => {
		isInIframe = window.self !== window.top;
		if (isAuthRoute) return;
		// Skip restoreSession if already logged in (e.g. just came from login page).
		// restoreSession calls tryRefreshToken which can clobber an in-memory token
		// if the refresh network request fails or races with an existing valid token.
		if (!auth.isLoggedIn) {
			await restoreSession();
		}
		if (!auth.isLoggedIn) {
			// Don't redirect iframes to /login — they share the parent's vault
			// state and will work once the parent window unlocks the DEK.
			if (!isInIframe) goto('/login');
			else {
				// Iframe: userId is set from the refresh token even without a DEK.
				// Load notes from the shared IndexedDB so the pane shows content.
				if (auth.userId) loadFromDb().catch(() => {});
				// Show the server status dot by running a health check.
				import('$lib/stores/auth.svelte.js').then(({ checkServerHealth }) => {
					checkServerHealth().catch(() => {});
				});
			}
		} else if (auth.dek) {
			// Logged in with DEK available — do one immediate sync so UI is
			// up-to-date without waiting for the first periodic interval tick.
			syncFromServer().catch(() => {});
		}

		// Disconnect WebSocket on page unload (tab close, navigate away)
		return () => {
			wsDisconnect();
		};
	});

	// Manage WebSocket connection based on login state.
	// Does NOT call syncFromServer — that would create a reactive loop because
	// syncFromServer updates notes/topics state, causing this effect to re-run.
	$effect(() => {
		const isLoggedIn = auth.isLoggedIn;
		const hasDek = !!auth.dek;
		if (isLoggedIn && hasDek && !isAuthRoute) {
			wsConnect();
		} else if (!isLoggedIn) {
			wsDisconnect();
		}
	});

	// Periodic background sync + health check.
	// Fires every syncIntervalStore.interval ms (default 5s, min 1s).
	// The WebSocket handles push-triggered syncs; this catches anything missed.
	$effect(() => {
		const isLoggedIn = auth.isLoggedIn;
		const hasDek = !!auth.dek;
		if (!isLoggedIn || !hasDek || isAuthRoute) return;
		const ms = syncIntervalStore.interval;
		const id = setInterval(() => {
			syncFromServer().catch((err) => { console.error('[layout] periodic sync error', err); });
		}, ms);
		return () => {
			clearInterval(id);
		};
	});

	// ── Inactivity vault lock ──────────────────────────────────────
	// Tracks the last time the user did something on THIS device (keyboard,
	// mouse, touch). Sync events do NOT count. When idle for the configured
	// duration the vault is locked — DEK wiped, user sees unlock prompt.
	$effect(() => {
		const inactivityMs = inactivityLockStore.ms;
		const hasDek = !!auth.dek;
		// Disabled (0) or vault already locked or on auth pages — nothing to do
		if (!inactivityMs || !hasDek || isAuthRoute) return;

		let timer: ReturnType<typeof setTimeout>;

		function resetTimer() {
			clearTimeout(timer);
			timer = setTimeout(() => {
				if (auth.dek) {
					lockVault();
					goto('/login');
				}
			}, inactivityMs);
		}

		const events = ['keydown', 'pointerdown', 'pointermove', 'touchstart', 'scroll'] as const;
		// Throttle: only reset the timer at most once per 10 seconds to avoid
		// hammering state updates on every mousemove.
		let lastReset = 0;
		function onActivity() {
			const now = Date.now();
			if (now - lastReset < 10_000) return;
			lastReset = now;
			resetTimer();
		}

		resetTimer(); // start timer immediately
		for (const ev of events) {
			window.addEventListener(ev, onActivity, { passive: true, capture: true });
		}

		return () => {
			clearTimeout(timer);
			for (const ev of events) {
				window.removeEventListener(ev, onActivity, { capture: true });
			}
		};
	});

	// ── Split-window state ─────────────────────────────────────────
	let splitActive  = $state(false);
	let splitUrl     = $state('/');
	let splitWidth   = $state(50);
	let isDragging   = $state(false);
	// Ghost position (% from right) shown during drag; committed on pointer-up
	let ghostPct     = $state(50);
	let splitterEl: HTMLDivElement;
	let containerEl: HTMLDivElement;

	// Min secondary pane: 20%. Min primary pane: 20% (so max secondary is 80%).
	const SPLIT_MIN = 20;
	const SPLIT_MAX = 80;

	function openSplit() {
		splitUrl    = '/';
		splitActive = true;
		window.dispatchEvent(new CustomEvent('bedroc:split-changed', { detail: { active: true } }));
	}

	function closeSplit() {
		splitActive = false;
		window.dispatchEvent(new CustomEvent('bedroc:split-changed', { detail: { active: false } }));
	}

	// Listen for split open/close requests from child pages (e.g. topics panel)
	onMount(() => {
		function onOpen() { openSplit(); }
		function onClose() { closeSplit(); }
		window.addEventListener('bedroc:open-split', onOpen);
		window.addEventListener('bedroc:close-split', onClose);
		return () => {
			window.removeEventListener('bedroc:open-split', onOpen);
			window.removeEventListener('bedroc:close-split', onClose);
		};
	});

	function onSplitterPointerDown(e: PointerEvent) {
		e.preventDefault();
		isDragging = true;
		ghostPct   = splitWidth;
		// Capture pointer so all subsequent move/up events fire on the splitter
		// regardless of where the pointer travels (fixes touch on iPad/iPhone).
		splitterEl.setPointerCapture(e.pointerId);
	}

	function onSplitterPointerMove(e: PointerEvent) {
		if (!isDragging || !containerEl) return;
		const rect = containerEl.getBoundingClientRect();
		ghostPct = Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, ((rect.right - e.clientX) / rect.width) * 100));
	}

	function onSplitterPointerUp(_e: PointerEvent) {
		if (isDragging) {
			splitWidth = ghostPct;
		}
		isDragging = false;
	}
</script>

{#if isAuthRoute}
	<div class="auth-shell">
		{@render children()}
	</div>
{:else}
	<div class="app-shell">
		<!-- ── Main content area ────────────────────────── -->
		<div
			class="main-wrap"
			bind:this={containerEl}
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
			<div
				class="pane-container"
				class:split={splitActive}
				class:is-dragging={isDragging}
			>
				<!-- Primary pane — width committed on pointer-up, blurred while dragging -->
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
						onpointermove={onSplitterPointerMove}
						onpointerup={onSplitterPointerUp}
						onpointercancel={onSplitterPointerUp}
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
						></iframe>
					</div>

					<!-- Ghost divider: zero-cost position indicator during drag -->
					{#if isDragging}
						<div class="splitter-ghost" style="right: {ghostPct}%"></div>
					{/if}
				{/if}
			</div>

			<!-- Mobile bottom nav -->
			<nav class="bottom-nav" aria-label="Main navigation">
				<a
					href="/"
					class="bottom-nav-item"
					class:active={path === '/' || path.startsWith('/note')}
				>
					<span class="nav-icon" aria-hidden="true">
						<svg width="20" height="20" viewBox="0 0 16 16" fill="none">
							<rect x="2" y="2" width="12" height="2" rx="1" fill="currentColor"/>
							<rect x="2" y="6" width="9" height="2" rx="1" fill="currentColor"/>
							<rect x="2" y="10" width="11" height="2" rx="1" fill="currentColor"/>
							<rect x="2" y="14" width="7" height="1.5" rx="0.75" fill="currentColor"/>
						</svg>
					</span>
					<span class="bottom-nav-label">Notes</span>
				</a>
				<a
					href="/settings"
					class="bottom-nav-item"
					class:active={path === '/settings'}
				>
					<span class="nav-icon" aria-hidden="true">
						<svg width="20" height="20" viewBox="0 0 16 16" fill="none">
							<circle cx="8" cy="8" r="2.5" stroke="currentColor" stroke-width="1.5"/>
							<path d="M8 1v2M8 13v2M1 8h2M13 8h2M2.93 2.93l1.41 1.41M11.66 11.66l1.41 1.41M2.93 13.07l1.41-1.41M11.66 4.34l1.41-1.41" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
						</svg>
					</span>
					<span class="bottom-nav-label">Settings</span>
				</a>
			</nav>
		</div>
	</div>
{/if}

<style>
	/* ── Auth shell ───────────────────────────────────── */
	.auth-shell {
		min-height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		padding-top: max(env(safe-area-inset-top, 0px), 24px);
		padding-bottom: max(env(safe-area-inset-bottom, 0px), 24px);
		padding-left: 16px;
		padding-right: 16px;
		background: var(--bg);
		overflow-y: auto;
	}

	/* ── App shell ────────────────────────────────────── */
	.app-shell {
		display: flex;
		height: 100%;
		overflow: hidden;
		overscroll-behavior: none;
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
		/* Only apply safe area on TOP — no safe area padding on bottom */
		padding-top: max(env(safe-area-inset-top, 0px), 8px);
		padding-bottom: 8px;
		padding-left: 16px;
		padding-right: 16px;
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
		position: relative;
	}

	/* ── Main content (primary pane) ──────────────────── */
	.main-content {
		flex: 1;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
		overscroll-behavior: contain;
		min-width: 0;
		transition: width 0.05s ease;
		/* CSS container so children can query available width (split-pane responsive) */
		container-type: inline-size;
		container-name: main-pane;
	}

	/* In split mode, primary pane has explicit width set inline */
	.pane-container.split .main-content {
		flex: none;
	}

	/* Blur primary + secondary pane content while dragging — no layout reflow */
	.pane-container.is-dragging .main-content,
	.pane-container.is-dragging .split-pane {
		pointer-events: none;
		filter: blur(2px);
		opacity: 0.6;
		transition: none;
	}

	/* Ghost divider line: absolute, zero layout impact, shows where split will land */
	.splitter-ghost {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 2px;
		background: var(--accent);
		opacity: 0.7;
		pointer-events: none;
		z-index: 10;
		transform: translateX(50%);
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
		/* Expand touch target to 20px without affecting layout */
		touch-action: none;
	}

	/* Invisible wider hit area for touch */
	.splitter::before {
		content: '';
		position: absolute;
		inset: 0 -8px;
		z-index: 1;
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
		padding: max(env(safe-area-inset-top, 0px), 6px) 10px 6px;
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
		padding: 8px;
		min-width: 32px;
		min-height: 32px;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
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
		position: relative;
		background: var(--bg-elevated);
		border-top: 1px solid var(--border);
		/* Safe area for home indicator — zero on non-notch devices */
		/* padding-bottom: env(safe-area-inset-bottom, 0px); */
		padding-bottom: max(env(safe-area-inset-bottom, 0px), 24px);
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
