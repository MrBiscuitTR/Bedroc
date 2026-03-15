/**
 * lib/stores/theme.svelte.ts — Theme (dark/light) state.
 *
 * Persists the user's theme preference to localStorage.
 * Applies a `data-theme` attribute to <html> for CSS targeting.
 */

const LS_THEME_KEY = 'bedroc_theme';

function loadTheme(): 'dark' | 'light' {
  if (typeof localStorage === 'undefined') return 'dark';
  // 1. Explicit user preference
  const stored = localStorage.getItem(LS_THEME_KEY);
  if (stored === 'light') return 'light';
  if (stored === 'dark') return 'dark';
  // 2. System preference (no stored value)
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  // 3. Default dark
  return 'dark';
}

let _theme = $state<'dark' | 'light'>(loadTheme());

export const theme = {
  get value() { return _theme; },
  get isLight() { return _theme === 'light'; },
};

export function setTheme(t: 'dark' | 'light'): void {
  _theme = t;
  localStorage.setItem(LS_THEME_KEY, t);
  document.documentElement.setAttribute('data-theme', t);
}

export function toggleTheme(): void {
  setTheme(_theme === 'dark' ? 'light' : 'dark');
}

/** Call once on app mount to apply the persisted theme to <html>. */
export function initTheme(): void {
  document.documentElement.setAttribute('data-theme', _theme);
}
