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
	mergeConfig(workspaceAppViteConfig(APPS.HONEYCRISP), {
		resolve: {
			// Build-time selection over `#platform/notes-host` in package.json
			// "imports". The spread is load-bearing: custom conditions REPLACE
			// Vite's defaults.
			...(isEpicenterHost && {
				conditions: ['epicenter-host', ...defaultClientConditions],
			}),
			alias: [
				// Shared code imports the folder contract from the bare specifier.
				// Each build resolves that exact specifier to its one adapter, so
				// the host page carries no browser storage or Git, and the
				// browser page no desktop adapter. Subpaths are left alone.
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
