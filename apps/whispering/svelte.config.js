import { hostAppAdapterOptions } from '@epicenter/vite-config/host-app';
import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: staticAdapter(hostAppAdapterOptions()),
		// No `csp` block: adapter-static only emits an enforcing meta tag.
		// Epicenter sends the policy as a header, and the web deploy uses
		// `static/_headers`.
	},
	preprocess: vitePreprocess(),
};

export default config;
