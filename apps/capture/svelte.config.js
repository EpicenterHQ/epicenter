import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * A static single-page view with hash routes (`index.html#/c/<id>`), so
 * `epicenter serve` serves `build/` as files with no routing of its own. It
 * mounts an app's view at `/<app>/`, which install passes as VIEW_BASE.
 *
 * @type {import('@sveltejs/kit').Config}
 */
export default {
	kit: {
		adapter: adapter(),
		router: { type: 'hash' },
		paths: { base: process.env.VIEW_BASE ?? '' },
	},
	preprocess: vitePreprocess(),
	compilerOptions: { experimental: { async: true } },
};
