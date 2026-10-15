// Every build is a client-only static SPA. The browser build writes `build/`
// and keeps its folder in OPFS. Epicenter's built-in build writes into the
// host's packaged asset tree, below the route the host serves it from. The
// installed build (`EPICENTER_INSTALLED=1`, ADR-0552) writes `dist/` in this
// folder, where `epicenter.app.json` says its output is, and is prerendered
// with relative paths, so it runs wherever the host serves it. Both Epicenter
// builds reach a real directory through the host.
import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const isEpicenterHost = process.env.EPICENTER_HOST === '1';
const isInstalled = process.env.EPICENTER_INSTALLED === '1';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: staticAdapter(
			isInstalled
				? // Every route is prerendered (`src/routes/+layout.ts`); a
					// fallback page would load its assets from absolute paths.
					{ pages: 'dist', assets: 'dist' }
				: {
						...(isEpicenterHost && {
							pages: '../epicenter/dist/todos',
							assets: '../epicenter/dist/todos',
						}),
						fallback: 'index.html',
					},
		),
		...(isEpicenterHost && !isInstalled && { paths: { base: '/apps/todos' } }),
	},
	preprocess: vitePreprocess(),
};

export default config;
