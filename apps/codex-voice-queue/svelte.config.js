import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// Sync and build run in separate processes. Overlapping sync with the default
		// Date.now() name can change the payload global and blank the page.
		// Version polling is unused, so a constant name costs nothing.
		version: { name: 'codex-voice-queue' },
		adapter: adapter({
			pages: 'build',
			assets: 'build',
			fallback: 'index.html',
		}),
	},
};

export default config;
