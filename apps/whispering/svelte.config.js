// A client-only static SPA. The browser build writes `build/` and keeps its
// folder in OPFS. Epicenter's build (`EPICENTER_HOST=1`, ADR-0552) is the
// installed one: it writes `dist/` in this folder, which Epicenter keeps
// (ADR-0560), and is prerendered with relative paths, so it runs wherever the
// host serves it and reaches a real directory through the host.
import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const isEpicenterHost = process.env.EPICENTER_HOST === '1';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: staticAdapter(
			isEpicenterHost
				? // Every route is prerendered (`src/routes/+layout.ts`); a
					// fallback page would load its assets from absolute paths.
					{ pages: 'dist', assets: 'dist' }
				: { fallback: 'index.html' },
		),
		// No `csp` block: adapter-static only emits an enforcing meta tag.
		// Epicenter sends the policy as a header, and the web deploy uses
		// `static/_headers`.
	},

	preprocess: vitePreprocess(),
};

export default config;
