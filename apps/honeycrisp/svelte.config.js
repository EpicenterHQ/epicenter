import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * Where a build writes the static app, when not `build/`. `wrangler deploy`
 * publishes `build/`, which the desktop window loads too. (`.svelte-kit/`, which `vite preview`
 * serves, stays here: its server bundle resolves packages from this
 * folder.)
 */
const out = process.env.HONEYCRISP_BUILD_DIR;

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
	// `@epicenter/svelte`'s Recovery, which `<WhenOpen>` shows, reads
	// `$effect.pending()`, which async Svelte provides.
	compilerOptions: { experimental: { async: true } },
};

export default config;
