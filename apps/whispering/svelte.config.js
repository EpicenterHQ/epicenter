// The SPA is static assets either way. The default output stays at `build/`,
// which is the dev and unhosted `bun run build` artifact; the Epicenter build
// writes into the host's packaged asset tree and serves the SPA below its
// stable loopback route.
// See: https://v2.tauri.app/start/frontend/sveltekit/ for more info
import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const isEpicenterHost = process.env.EPICENTER_HOST === '1';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: staticAdapter({
			...(isEpicenterHost && {
				pages: '../epicenter/dist/whispering',
				assets: '../epicenter/dist/whispering',
			}),
			fallback: 'index.html', // SPA fallback for dynamic routes
		}),
		...(isEpicenterHost && { paths: { base: '/apps/whispering' } }),
		// No `csp` block here on purpose. adapter-static prerenders every page,
		// and SvelteKit's prerender path only ever emits the *enforcing*
		// `<meta http-equiv="content-security-policy">` tag: `reportOnly` is
		// never read when `state.prerendering` is true (see
		// @sveltejs/kit/src/runtime/server/page/render.js). There is no way to
		// get a Report-Only trial out of `kit.csp` for this app. The CSP for
		// this deploy is delivered entirely via `static/_headers` (a real
		// `Content-Security-Policy-Report-Only` HTTP header on Cloudflare
		// Workers Static Assets) instead. Epicenter likewise owns CSP in its
		// outer Bun host. See `static/_headers` and the Epicenter server policy.
	},

	// Consult https://svelte.dev/docs/kit/integrations
	// for more information about preprocessors
	preprocess: vitePreprocess(),

	vitePlugin: {
		inspector: {
			// This block owns dev-tooling behavior, not geometry. The toggle
			// inherits the plugin default 'top-right', the corner left free by
			// the current chrome (sidebar on the left, full-width BottomNav at
			// the bottom). The app must never reposition #svelte-inspector-host:
			// earlier CSS overrides keyed to nav z-index broke twice when the nav
			// changed. To move or disable it per-machine, set an env var instead
			// (the plugin gives it top precedence), e.g.
			// SVELTE_INSPECTOR_OPTIONS='{"toggleButtonPos":"top-left"}'
			holdMode: true,
			showToggleButton: 'always',
			toggleKeyCombo: 'alt-x',
		},
	},
};

export default config;
