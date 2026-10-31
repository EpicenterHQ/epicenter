import { APPS } from '@epicenter/constants/apps';
import { desktopVariant, workspaceAppViteConfig } from '@epicenter/vite-config';
import { defineConfig, mergeConfig } from 'vite';

export default defineConfig(
	mergeConfig(
		// `bun run build:native` is the desktop window's build: its
		// `#platform/*` seams resolve to their `.tauri.ts` leaves.
		mergeConfig(workspaceAppViteConfig(APPS.TODOS), desktopVariant()),
		{
			// localhost, not 127.0.0.1: the API registers Todos' sign-in callback
			// at `http://localhost:5186`.
			server: { host: 'localhost' },
			preview: { port: APPS.TODOS.port, strictPort: true, host: 'localhost' },
		},
	),
);
