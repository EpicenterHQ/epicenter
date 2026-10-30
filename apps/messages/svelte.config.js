import { hostAppAdapterOptions } from '@epicenter/vite-config/host-app';
import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: { adapter: staticAdapter(hostAppAdapterOptions()) },
	preprocess: vitePreprocess(),
};

export default config;
