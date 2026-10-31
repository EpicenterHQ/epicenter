import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * The desktop program's pages (`EPICENTER_DESKTOP=1`, `build:native`):
 * a root of their own (`src/desktop`) that opens the folder its shell bound
 * to the window, written to `build-desktop/` for `src-tauri` to load. The
 * web build's routes (`src/routes`) and output (`build/`) are untouched by
 * it, so neither build carries the other's root.
 */
const desktop = process.env.EPICENTER_DESKTOP === '1';

/**
 * Where a build writes the static app, when not its default: the end-to-end
 * stack builds against a test server into a scratch directory.
 */
const out =
	process.env.VOCAB_BUILD_DIR ?? (desktop ? 'build-desktop' : undefined);

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// A static single-page app: any host that answers unknown paths with
		// `index.html` (for `/auth/callback`) serves it.
		adapter: staticAdapter({
			fallback: 'index.html',
			...(out && { pages: out, assets: out }),
		}),
		...(desktop && { files: { routes: 'src/desktop' } }),
	},
};

export default config;
