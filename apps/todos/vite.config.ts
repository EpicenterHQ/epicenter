import { fileURLToPath } from 'node:url';
import { workspaceAppViteConfig } from '@epicenter/vite-config';
import { defaultClientConditions, defineConfig, mergeConfig } from 'vite';

export const TODOS_UI_PORT = 5186;
const gitOrigin =
	process.env.TODOS_GIT_ORIGIN ??
	`http://127.0.0.1:${process.env.TODOS_GIT_PORT ?? '5187'}`;

/** A build the Epicenter desktop host serves: built in, or installed. */
const isEpicenterHost = process.env.EPICENTER_HOST === '1';
/** The installed build (ADR-0552); `src/routes/+layout.ts` prerenders it. */
const isInstalled = process.env.EPICENTER_INSTALLED === '1';

export default defineConfig(
	mergeConfig(workspaceAppViteConfig({ port: TODOS_UI_PORT }), {
		resolve: {
			// Build-time selection over `#platform/folder` in package.json
			// "imports". The spread is load-bearing: custom conditions REPLACE
			// Vite's defaults.
			...(isEpicenterHost && {
				conditions: ['epicenter-host', ...defaultClientConditions],
			}),
			alias: [
				// Shared modules import the folder contract from the bare specifier.
				// Each build resolves that exact specifier to the entry its leaf
				// opens, so the host build carries no browser storage or Git
				// implementation and the browser build carries no desktop adapter.
				{
					find: /^@epicenter\/folder$/,
					replacement: isEpicenterHost
						? '@epicenter/folder/tauri'
						: '@epicenter/folder/browser',
				},
				// isomorphic-git and its SHA-1 dependency expect Node's Buffer.
				{
					find: /^buffer$/,
					replacement: fileURLToPath(import.meta.resolve('buffer/')),
				},
			],
		},
		server: {
			host: '127.0.0.1',
			// The loopback Git backend is same-origin through this proxy, so the
			// browser needs no CORS or credentials for smart HTTP.
			proxy: { '/git': { target: gitOrigin, changeOrigin: false } },
		},
		define: {
			'import.meta.env.EPICENTER_INSTALLED': JSON.stringify(
				isInstalled ? '1' : '',
			),
		},
		optimizeDeps: { include: ['buffer'] },
	}),
);
