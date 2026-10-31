import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: staticAdapter({ fallback: 'index.html' }),
		// No `csp` block: adapter-static only emits an enforcing meta tag. The
		// web deploy sends the policy as a header from `static/_headers`.
	},
	preprocess: vitePreprocess(),
};

export default config;
