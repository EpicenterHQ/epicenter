import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		// The cloud UI is one root-based SPA covering every hosted browser
		// surface (/dashboard, /sign-in, /session/callback). The
		// fallback shell is deliberately NOT index.html: Workers static assets
		// auto-serve index.html for `/`, which would shadow the Worker's root
		// health endpoint. Server routes decide which URLs get the shell.
		adapter: staticAdapter({
			pages: 'build',
			assets: 'build',
			fallback: 'fallback.html',
		}),
		alias: {
			// Sibling Worker code (billing contracts, BILLING_ROUTES, BillingError).
			// Avoids `../../../../worker/...` and makes the deployment seam visible:
			// the UI knows it is bundled with this Worker, not a third-party API.
			$api: '../worker',
		},
	},
	preprocess: vitePreprocess(),
};

export default config;
