import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * Where a build writes the static app, when not `build/`: the end-to-end
 * stack builds against a test server into a scratch directory, and the
 * desktop window's build (`bun run build:native`) writes `build-desktop/`.
 */
const out = process.env.VOCAB_BUILD_DIR;

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
	},
	// The desktop window's `Startup` awaits its roots at the top level, under
	// the `(app)` layout's `<svelte:boundary>` (decision 94).
	compilerOptions: { experimental: { async: true } },
};

export default config;
