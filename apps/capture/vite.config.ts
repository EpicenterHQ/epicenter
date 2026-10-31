import { APPS } from '@epicenter/constants/apps';
import { workspaceAppViteConfig } from '@epicenter/vite-config';
import {
	defaultClientConditions,
	defaultServerConditions,
	defineConfig,
	mergeConfig,
} from 'vite';

/**
 * The desktop window's build (`bun run build:native`) resolves Capture's
 * `#platform/*` seams (`package.json` "imports") to their `tauri` leaves:
 * the window's folder, no sign-in, no service worker. Every other build
 * gets the browser's. Custom conditions replace Vite's defaults, so the
 * default lists are spread after `tauri`.
 */
const desktop = process.env.EPICENTER_DESKTOP === '1';

export default defineConfig(
	mergeConfig(workspaceAppViteConfig(APPS.CAPTURE), {
		...(desktop && {
			resolve: { conditions: ['tauri', ...defaultClientConditions] },
			ssr: { resolve: { conditions: ['tauri', ...defaultServerConditions] } },
		}),
		// localhost, not 127.0.0.1: the API registers Capture's sign-in
		// callback at `http://localhost:5179`.
		server: { host: 'localhost' },
		preview: { port: APPS.CAPTURE.port, strictPort: true, host: 'localhost' },
		// The device's OPFS Worker is a module Worker.
		worker: { format: 'es' },
	}),
);
