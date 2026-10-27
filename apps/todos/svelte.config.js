import adapter from '@sveltejs/adapter-static';
import { hostAppAdapterOptions, isHostAppBuild } from '@epicenter/vite-config/host-app';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter(hostAppAdapterOptions()),
		serviceWorker: { register: !isHostAppBuild() },
	},
	preprocess: vitePreprocess(),
};

export default config;
