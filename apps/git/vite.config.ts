import { fileURLToPath } from 'node:url';
import { workspaceAppViteConfig } from '@epicenter/vite-config';
import { defineConfig, mergeConfig } from 'vite';
export default defineConfig(
	mergeConfig(workspaceAppViteConfig({ port: 5190 }), {
		resolve: {
			alias: [
				{
					find: /^@epicenter\/folder$/,
					replacement: process.env.GIT_DESKTOP
						? '@epicenter/folder/tauri'
						: '@epicenter/folder/browser',
				},
				{
					find: /^buffer$/,
					replacement: fileURLToPath(import.meta.resolve('buffer/')),
				},
			],
		},
		server: {
			host: '127.0.0.1',
			proxy: {
				'/git': { target: 'http://127.0.0.1:5191' },
				'/demo': {
					target: 'http://127.0.0.1:5191',
					rewrite: (path: string) => path.replace(/^\/demo/, ''),
				},
			},
		},
		optimizeDeps: { include: ['buffer'] },
	}),
);
