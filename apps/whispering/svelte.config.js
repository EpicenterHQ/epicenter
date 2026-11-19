import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * Where a build writes the static app, when not `build/`: the end-to-end
 * stack builds against a test server into a scratch directory.
 * (`.svelte-kit/`, which `vite preview` serves, stays here: its server
 * bundle resolves packages from this folder.)
 */
const out = process.env.WHISPERING_BUILD_DIR;

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: staticAdapter({
			fallback: 'index.html',
			...(out && { pages: out, assets: out }),
		}),
		// No `csp` block: the desktop app sets its policy in
		// `src-tauri/tauri.conf.json`, and the web build is not hosted.
	},
	preprocess: vitePreprocess(),
	// Async Svelte, as the component tests compile it
	// (`src/lib/svelte-dom.test-support.ts`).
	compilerOptions: { experimental: { async: true } },
};

export default config;
