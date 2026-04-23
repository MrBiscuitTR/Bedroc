import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));
const commitHash = (() => {
	try { return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim(); }
	catch { return 'unknown'; }
})();

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	define: {
		__APP_VERSION__: JSON.stringify(pkg.version),
		__COMMIT_HASH__: JSON.stringify(commitHash),
	},
});
