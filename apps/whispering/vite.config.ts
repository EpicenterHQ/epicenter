import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APPS } from '@epicenter/constants/apps';
import { workspaceAppViteConfig } from '@epicenter/vite-config';
import { defineConfig, mergeConfig } from 'vite';
import devtoolsJson from 'vite-plugin-devtools-json';

// The browser folder's Git runs on isomorphic-git, which expects Node's
// Buffer. `@epicenter/folder` owns that dependency, so resolve it from there.
const fromFolder = createRequire(
	pathToFileURL(fileURLToPath(import.meta.resolve('@epicenter/folder'))).href,
);

export default defineConfig(
	mergeConfig(workspaceAppViteConfig(APPS.WHISPERING), {
		plugins: [devtoolsJson()],
		resolve: {
			alias: [
				// The page names the folder contract with the bare specifier, and
				// that is built against the browser entry. The exact bare specifier
				// only: subpaths are left alone, so the desktop workspace's own
				// import of `@epicenter/folder/tauri` is the desktop adapter, in a
				// chunk a browser tab never loads.
				{
					find: /^@epicenter\/folder$/,
					replacement: '@epicenter/folder/browser',
				},
				// The package directory, so both `buffer` and `buffer/` resolve.
				{ find: 'buffer', replacement: dirname(fromFolder.resolve('buffer/')) },
			],
		},
		// Epicenter's installed build prerenders every page
		// (`src/routes/+layout.ts`).
		define: {
			'import.meta.env.EPICENTER_HOST': JSON.stringify(
				process.env.EPICENTER_HOST === '1' ? '1' : '',
			),
		},
		server: { host: '127.0.0.1' },
		optimizeDeps: { include: ['buffer'] },
	}),
);
