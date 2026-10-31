import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * Which variant this build is, fixed at build time: the web app (the
 * default, rooted at `src/routes`), or the desktop app's page
 * (`HONEYCRISP_DESKTOP=1`, `bun run build:desktop-page`), rooted at
 * `src/desktop`. Each root chooses its store and renders the same
 * `HoneycrispApp`; neither build carries the other's root, and nothing asks
 * at run time which one it is.
 */
const desktop = process.env.HONEYCRISP_DESKTOP === '1';

/**
 * Where a build writes the static app. The desktop page goes to
 * `build-desktop/`, which the shell loads (`frontendDist`), so `build/`,
 * which `wrangler deploy` publishes, only ever holds the web app. The
 * end-to-end stack builds the web app against a test server into a scratch
 * directory (`HONEYCRISP_BUILD_DIR`). (`.svelte-kit/`, which `vite preview`
 * serves, stays here: its server bundle resolves packages from this folder.)
 */
const out = desktop ? 'build-desktop' : process.env.HONEYCRISP_BUILD_DIR;

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		// A static single-page app: any host that answers unknown paths with
		// `index.html` (for `/auth/callback`) serves it.
		adapter: adapter({
			fallback: 'index.html',
			...(out && { pages: out, assets: out }),
		}),
		// SvelteKit marks `files` deprecated (still supported; it recommends
		// separate packages instead). One route tree per variant is what keeps
		// each build to its own root.
		...(desktop && { files: { routes: 'src/desktop' } }),
		// The desktop window loads its page from disk, where a service worker
		// has no use.
		serviceWorker: { register: !desktop },
	},
	preprocess: vitePreprocess(),
};

export default config;
