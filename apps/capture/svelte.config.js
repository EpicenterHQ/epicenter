import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const isEpicenterHost = process.env.EPICENTER_HOST === '1';

export default {
	preprocess: vitePreprocess(),
	kit: {
		adapter: staticAdapter({
			...(isEpicenterHost && {
				pages: '../epicenter/dist/capture',
				assets: '../epicenter/dist/capture',
			}),
			fallback: 'index.html',
		}),
		...(isEpicenterHost && { paths: { base: '/apps/capture' } }),
	},
};
