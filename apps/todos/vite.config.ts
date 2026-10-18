import { installedAppViteConfig } from '@epicenter/vite-config';
import { defineConfig, mergeConfig } from 'vite';

export const TODOS_UI_PORT = 5186;
const gitOrigin =
	process.env.TODOS_GIT_ORIGIN ??
	`http://127.0.0.1:${process.env.TODOS_GIT_PORT ?? '5187'}`;

export default defineConfig(
	mergeConfig(installedAppViteConfig({ port: TODOS_UI_PORT }), {
		server: {
			host: '127.0.0.1',
			// The loopback Git backend is same-origin through this proxy, so the
			// browser needs no CORS or credentials for smart HTTP.
			proxy: { '/git': { target: gitOrigin, changeOrigin: false } },
		},
	}),
);
