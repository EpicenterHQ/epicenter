import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * Where a build writes the static app, when not `build/` (which `bun run
 * start` serves): the end-to-end suite builds into a scratch directory.
 */
const out = process.env.MESSAGES_BUILD_DIR;

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		// A single-page app: `scripts/serve.ts` answers every route that is not
		// a file with `index.html`.
		adapter: staticAdapter({
			fallback: 'index.html',
			...(out && { pages: out, assets: out }),
		}),
	},
	preprocess: vitePreprocess(),
};

export default config;
