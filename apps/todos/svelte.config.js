import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// A static single-page app: any host that answers unknown paths with
	// `index.html` (for `/auth/callback`) serves it.
	kit: { adapter: adapter({ fallback: 'index.html' }) },
	preprocess: vitePreprocess(),
};

export default config;
