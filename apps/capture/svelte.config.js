import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * Where a build writes the static app, when not `build/`: the end-to-end
 * stack builds against a test server into a scratch directory, so `build/`
 * only ever holds a real build.
 */
const out = process.env.CAPTURE_BUILD_DIR;

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		// A static single-page app: any host that answers unknown paths with
		// `index.html` (for `/auth/callback`) serves it.
		adapter: adapter({
			fallback: 'index.html',
			...(out && { pages: out, assets: out }),
		}),
		// `+layout.svelte` registers it, as a module in dev and classic in a
		// build, and never lets a refusal reach the page.
		serviceWorker: { register: false },
	},
	preprocess: vitePreprocess(),
};

export default config;
