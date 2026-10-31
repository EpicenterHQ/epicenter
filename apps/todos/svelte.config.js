import {
	desktopAppAdapterOptions,
	isDesktopAppBuild,
} from '@epicenter/vite-config/desktop-app';
import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter(desktopAppAdapterOptions()),
		serviceWorker: { register: !isDesktopAppBuild() },
	},
	preprocess: vitePreprocess(),
};

export default config;
