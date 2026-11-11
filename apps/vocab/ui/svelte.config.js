import { basename, resolve } from 'node:path';
import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * The app's UI: a static single-page app with hash routes, a record's page
 * at its path (`index.html#/data/words/<word>.md`), built into `ui/dist/`, which
 * `epicenter serve` serves at `/<app>/` as files with no routing of its
 * own (ADR-0866). SvelteKit writes the page's asset URLs from its base, so
 * the base is the path the UI is served at: `EPICENTER_BASE`, which
 * `epicenter` sets when it builds (`/<app>`), else the app folder's name, for
 * a build run by hand in the app (ADR-0860).
 *
 * @type {import('@sveltejs/kit').Config}
 */
export default {
	kit: {
		adapter: adapter({ pages: 'dist', assets: 'dist' }),
		router: { type: 'hash' },
		paths: {
			base: process.env.EPICENTER_BASE ?? `/${basename(resolve('..'))}`,
		},
	},
	preprocess: vitePreprocess(),
	compilerOptions: { experimental: { async: true } },
};
