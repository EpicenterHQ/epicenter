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
	},
	preprocess: vitePreprocess(),
};

export default config;
