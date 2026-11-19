import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// A single-page app: every route renders in the browser from `index.html`.
	kit: { adapter: staticAdapter({ fallback: 'index.html' }) },
	preprocess: vitePreprocess(),
	compilerOptions: { runes: true },
};

export default config;
