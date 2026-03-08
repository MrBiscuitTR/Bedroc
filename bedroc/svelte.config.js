import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		// adapter-static: outputs a fully prerendered SPA to the build/ directory.
		// nginx in the bedroc container serves these static files.
		// The fallback option enables client-side routing (all paths → index.html).
		adapter: adapter({
			fallback: 'index.html',
		}),
	}
};

export default config;
