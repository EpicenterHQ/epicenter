import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// A single-page app: every address is the fallback page, which reads the repository from the URL.
	kit: { adapter: adapter({ fallback: 'index.html' }) },
	preprocess: vitePreprocess(),
};

export default config;
