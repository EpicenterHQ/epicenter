import { fileURLToPath } from 'node:url';
import { workspaceAppViteConfig } from '@epicenter/vite-config';
import { defineConfig, mergeConfig } from 'vite';

export const TODOS_UI_PORT = 5186;
const gitOrigin =
	process.env.TODOS_GIT_ORIGIN ??
	`http://127.0.0.1:${process.env.TODOS_GIT_PORT ?? '5187'}`;

export default defineConfig(
	mergeConfig(workspaceAppViteConfig({ port: TODOS_UI_PORT }), {
		resolve: {
			alias: {
				// isomorphic-git and its SHA-1 dependency expect Node's Buffer.
				buffer: fileURLToPath(import.meta.resolve('buffer/')),
				// just-bash's browser bundle imports gzip helpers the terminal never enables.
				'node:zlib': fileURLToPath(
					new URL('./src/lib/shims/zlib.ts', import.meta.url),
				),
			},
		},
		server: {
			host: '127.0.0.1',
			// The loopback Git backend is same-origin through this proxy, so the
			// browser needs no CORS or credentials for smart HTTP.
			proxy: { '/git': { target: gitOrigin, changeOrigin: false } },
		},
		optimizeDeps: { include: ['buffer'] },
	}),
);
