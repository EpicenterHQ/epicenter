import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, searchForWorkspaceRoot } from 'vite';

/**
 * In development, a POST to `/` (MCP) goes to a running `epicenter serve`
 * (EPICENTER_URL, default http://127.0.0.1:4747) and everything else stays
 * here. The proxy drops the page's Origin, which names this dev server and
 * would not match the one it forwards to.
 */
export default defineConfig({
	plugins: [sveltekit(), tailwindcss()],
	server: {
		fs: { allow: [searchForWorkspaceRoot(process.cwd())] },
		proxy: {
			'^/$': {
				target: process.env.EPICENTER_URL ?? 'http://127.0.0.1:4747',
				changeOrigin: true,
				bypass: (request) =>
					request.method === 'POST' ? undefined : request.url,
				configure: (proxy) =>
					proxy.on('proxyReq', (forwarded) => forwarded.removeHeader('origin')),
			},
		},
	},
});
