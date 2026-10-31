import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * Where a build writes the static app, when not `build/`: the end-to-end
 * stack builds against a test server into a scratch directory.
 * (`.svelte-kit/`, which `vite preview` serves, stays here: its server
 * bundle resolves packages from this folder.)
 */
const out = process.env.WHISPERING_BUILD_DIR;

/**
 * The desktop window's build (`bun run build:native`) loads from disk, where
 * a service worker has no use: it names an entry that does not exist, so
 * none is built or registered there.
 */
const desktop = process.env.EPICENTER_DESKTOP === '1';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: staticAdapter({
			fallback: 'index.html',
			...(out && { pages: out, assets: out }),
		}),
		// No `csp` block: adapter-static only emits an enforcing meta tag. The
		// web deploy sends the policy as a header from `static/_headers`.
		// The web build's service worker (`src/service-worker.js`), which Kit
		// registers, reopens a page loaded once offline (decision 85).
		files: {
			serviceWorker: desktop ? 'src/no-service-worker' : 'src/service-worker',
		},
		serviceWorker: {
			// `_headers` is the host's, never served as a file.
			files: (file) => file !== '_headers' && !/\.DS_Store/.test(file),
		},
	},
	preprocess: vitePreprocess(),
	// `Startup` awaits this browser's files at the top level, under the
	// local layout's `<svelte:boundary>` (decision 94).
	compilerOptions: { experimental: { async: true } },
};

export default config;
