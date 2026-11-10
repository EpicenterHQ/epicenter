import { basename, resolve } from 'node:path';
import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * The app's UI: a static single-page app with hash routes, a record's page
 * at its path (`index.html#/words/<word>.md`), built into the app's `ui/build/`,
 * which `epicenter serve` serves at `/<app>/` as files with no routing of its
 * own (ADR-0866). The app's folder name is the name it is served under, so the
 * base is that name whoever runs the build.
 *
 * @type {import('@sveltejs/kit').Config}
 */
export default {
	kit: {
		adapter: adapter(),
		router: { type: 'hash' },
		paths: { base: `/${basename(resolve('..'))}` },
	},
	preprocess: vitePreprocess(),
	compilerOptions: { experimental: { async: true } },
};
