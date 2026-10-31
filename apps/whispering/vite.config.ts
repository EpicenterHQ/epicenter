import { APPS } from '@epicenter/constants/apps';
import { desktopVariant, workspaceAppViteConfig } from '@epicenter/vite-config';
import { defineConfig, mergeConfig } from 'vite';
import devtoolsJson from 'vite-plugin-devtools-json';

export default defineConfig(
	// `bun run build:native` is the desktop window's build: its
	// `#platform/*` seams resolve to their `.tauri.ts` leaves.
	mergeConfig(
		mergeConfig(workspaceAppViteConfig(APPS.WHISPERING), desktopVariant()),
		{
			plugins: [devtoolsJson()],
			// localhost, not 127.0.0.1: the API registers Whispering's sign-in
			// callback at `http://localhost:1420`.
			server: { host: 'localhost' },
			preview: {
				port: APPS.WHISPERING.port,
				strictPort: true,
				host: 'localhost',
			},
			// The device's OPFS Worker is a module Worker.
			worker: { format: 'es' },
		},
	),
);
