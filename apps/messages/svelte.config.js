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
		// Kit registers `src/service-worker.js`, which caches the built page so a
		// page loaded once reopens offline (decision 85). The desktop build does
		// not register it, so its page loads only while its program is running.
		serviceWorker: { register: process.env.EPICENTER_DESKTOP !== '1' },
		// A single-page app: `scripts/serve.ts` answers every route that is not
		// a file with `index.html`.
		adapter: staticAdapter({
			fallback: 'index.html',
			...(out && { pages: out, assets: out }),
		}),
	},
	preprocess: vitePreprocess(),
	// `Startup` awaits this browser's files at the top level, under the
	// layout's `<svelte:boundary>` (decision 94).
	compilerOptions: { experimental: { async: true } },
};

export default config;
