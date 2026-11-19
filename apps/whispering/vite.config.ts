import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, searchForWorkspaceRoot } from 'vite';

/** The dev port `src-tauri/tauri.dev.conf.json` loads. */
const PORT = 1420;

export default defineConfig({
	plugins: [sveltekit(), tailwindcss()],
	server: {
		port: PORT,
		strictPort: true,
		host: 'localhost',
		// SvelteKit allows only the app's own folders; `@epicenter/ui` and
		// `@epicenter/app` are source in sibling workspace packages.
		fs: { allow: [searchForWorkspaceRoot(process.cwd())] },
	},
	// Tauri prints its own errors; keep Vite from clearing them.
	clearScreen: false,
});
