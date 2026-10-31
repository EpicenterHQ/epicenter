import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * Where a build writes the static app, when not `build/`: the end-to-end
 * stack builds against a test server into a scratch directory, so `build/`,
 * which the desktop shell loads (`frontendDist`), only ever holds a real
 * build. (`.svelte-kit/`, which `vite preview` serves, stays here: its
 * server bundle resolves packages from this folder.)
 */
const out = process.env.TODOS_BUILD_DIR;

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		// A static single-page app: any host that answers unknown paths with
		// `index.html` (for `/auth/callback`) serves it.
		adapter: adapter({
			fallback: 'index.html',
			...(out && { pages: out, assets: out }),
		}),
	},
	preprocess: vitePreprocess(),
	// The desktop root awaits its folder at the top level, under the page's
	// `<svelte:boundary>`.
	compilerOptions: { experimental: { async: true } },
};

export default config;
