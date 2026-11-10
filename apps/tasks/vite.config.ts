import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, searchForWorkspaceRoot } from 'vite';

/**
 * In development, `/mcp` goes to a running `epicenter serve`
 * (EPICENTER_URL, default http://127.0.0.1:4747).
 */
export default defineConfig({
	plugins: [sveltekit(), tailwindcss()],
	server: {
		fs: { allow: [searchForWorkspaceRoot(process.cwd())] },
		proxy: { '/mcp': process.env.EPICENTER_URL ?? 'http://127.0.0.1:4747' },
	},
});
