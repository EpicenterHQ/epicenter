import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APPS } from '@epicenter/constants/apps';
import { workspaceAppViteConfig } from '@epicenter/vite-config';
import { defaultClientConditions, defineConfig, mergeConfig } from 'vite';
import devtoolsJson from 'vite-plugin-devtools-json';

// The browser folder's Git runs on isomorphic-git, which expects Node's
// Buffer. `@epicenter/folder` owns that dependency, so resolve it from there.
const fromFolder = createRequire(
	pathToFileURL(fileURLToPath(import.meta.resolve('@epicenter/folder'))).href,
);

/**
 * The build the Epicenter desktop host serves, as an installed app
 * (ADR-0552); `src/routes/+layout.ts` prerenders it.
 */
const isEpicenterHost = process.env.EPICENTER_HOST === '1';

export default defineConfig(
	mergeConfig(workspaceAppViteConfig(APPS.WHISPERING), {
		plugins: [devtoolsJson()],
		resolve: {
			// Build-time selection over `#platform/workspace` in package.json
			// "imports". The spread is load-bearing: custom conditions REPLACE
			// Vite's defaults.
			...(isEpicenterHost && {
				conditions: ['epicenter-host', ...defaultClientConditions],
			}),
			alias: [
				// The page names the folder contract with the bare specifier. Each
				// build resolves that exact specifier to the entry its workspace
				// opens, so the host build carries no browser storage or Git
				// implementation and the browser build carries no desktop adapter.
				{
					find: /^@epicenter\/folder$/,
					replacement: isEpicenterHost
						? '@epicenter/folder/tauri'
						: '@epicenter/folder/browser',
				},
				// The same for the recorder: the host build records through the
				// shell's recorder plugin and carries no WebView microphone code.
				{
					find: /^@epicenter\/recorder$/,
					replacement: isEpicenterHost
						? '@epicenter/recorder/tauri'
						: '@epicenter/recorder/browser',
				},
				// The package directory, so both `buffer` and `buffer/` resolve.
				{ find: 'buffer', replacement: dirname(fromFolder.resolve('buffer/')) },
			],
		},
		define: {
			'import.meta.env.EPICENTER_HOST': JSON.stringify(
				isEpicenterHost ? '1' : '',
			),
		},
		server: { host: '127.0.0.1' },
		optimizeDeps: { include: ['buffer'] },
	}),
);
