import { fileURLToPath } from 'node:url';
import { APPS } from '@epicenter/constants/apps';
import { workspaceAppViteConfig } from '@epicenter/vite-config';
import { defaultClientConditions, defineConfig, mergeConfig } from 'vite';

/**
 * The build the Epicenter desktop host serves, as an installed app
 * (ADR-0552); `src/routes/+layout.ts` prerenders it.
 */
const isEpicenterHost = process.env.EPICENTER_HOST === '1';

export default defineConfig(
	mergeConfig(workspaceAppViteConfig(APPS.CAPTURE), {
		resolve: {
			// Build-time selection over `#platform/*` in package.json "imports".
			// The spread is load-bearing: custom conditions REPLACE Vite's defaults.
			...(isEpicenterHost && {
				conditions: ['epicenter-host', ...defaultClientConditions],
			}),
			alias: [
				// Each build opens one kind of folder, and its leaf imports that
				// entry by name. The bare specifier, which `@epicenter/capture`
				// imports the shared contract from, follows it, so the other
				// adapter is not emitted. Exact match only: subpaths are untouched.
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
		define: {
			'import.meta.env.EPICENTER_HOST': JSON.stringify(
				isEpicenterHost ? '1' : '',
			),
		},
		optimizeDeps: { include: ['buffer'] },
	}),
);
