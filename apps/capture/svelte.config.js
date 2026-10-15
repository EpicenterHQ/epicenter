// Every build is a client-only static SPA. The browser build writes `build/`
// and keeps its folder in OPFS. Epicenter's build (`EPICENTER_HOST=1`,
// ADR-0552) is the installed one: it writes `dist/` in this folder, which
// Epicenter keeps (ADR-0560), and is prerendered with relative paths, so it
// runs wherever the host serves it, and reaches a real directory through the
// host.
import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const isEpicenterHost = process.env.EPICENTER_HOST === '1';

export default {
	preprocess: vitePreprocess(),
	kit: {
		adapter: staticAdapter(
			isEpicenterHost
				? // Every route is prerendered (`src/routes/+layout.ts`); a
					// fallback page would load its assets from absolute paths.
					{ pages: 'dist', assets: 'dist' }
				: { fallback: 'index.html' },
		),
	},
};
