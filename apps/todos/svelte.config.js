// A client-only SPA: the folder lives in the browser's IndexedDB.
import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: staticAdapter({ fallback: 'index.html' }),
	},
	preprocess: vitePreprocess(),
};

export default config;
