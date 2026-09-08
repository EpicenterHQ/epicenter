import { APPS } from '@epicenter/constants/apps';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Dashboard is same-origin with API: in prod, served as static assets from
// `api.epicenter.so/dashboard`; in dev, the proxy below routes /api and /auth
// to the local Worker so the browser only sees same-origin requests.
const DASHBOARD_DEV_PORT = 5178;

export default defineConfig({
	plugins: [sveltekit(), tailwindcss()],
	// The chart and shared tooltip must read the same LayerChart context.
	resolve: { dedupe: ['layerchart'] },
	server: {
		port: DASHBOARD_DEV_PORT,
		strictPort: true,
		proxy: {
			// Forward API requests to the local Hono dev server
			'/api': {
				target: `http://localhost:${APPS.API.port}`,
				changeOrigin: true,
			},
			// Everything under /auth is a Better Auth API endpoint (sign-in/social,
			// sign-out, session/*, passkey/*, get-session), so the whole
			// prefix forwards to the Worker. The hosted auth UI pages (/sign-in,
			// /session/callback) live at root and are served by SvelteKit directly, so
			// neither collides with this proxy.
			'/auth': {
				target: `http://localhost:${APPS.API.port}`,
				changeOrigin: true,
			},
		},
	},
});
