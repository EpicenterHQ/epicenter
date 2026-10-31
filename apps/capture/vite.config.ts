import { APPS } from '@epicenter/constants/apps';
import { desktopVariant, workspaceAppViteConfig } from '@epicenter/vite-config';
import { defineConfig, mergeConfig } from 'vite';

export default defineConfig(
	mergeConfig(
		// `bun run build:native` is the desktop window's build: its
		// `#platform/*` seams resolve to their `.tauri.ts` leaves.
		mergeConfig(workspaceAppViteConfig(APPS.CAPTURE), desktopVariant()),
		{
			// localhost, not 127.0.0.1: the API registers Capture's sign-in
			// callback at `http://localhost:5179`.
			server: { host: 'localhost' },
			preview: { port: APPS.CAPTURE.port, strictPort: true, host: 'localhost' },
			// The device's OPFS Worker is a module Worker.
			worker: { format: 'es' },
		},
	),
);
