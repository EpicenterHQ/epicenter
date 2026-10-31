import { APPS } from '@epicenter/constants/apps';
import { workspaceAppViteConfig } from '@epicenter/vite-config';
import {
	defaultClientConditions,
	defaultServerConditions,
	defineConfig,
	mergeConfig,
} from 'vite';
import devtoolsJson from 'vite-plugin-devtools-json';

/**
 * The desktop app's build (`bun run build:native`) resolves Whispering's
 * `#platform/*` seams (`package.json` "imports") to their `tauri` leaves:
 * the folder the shell bound, the shell's microphone, the credential store,
 * and sign-in through the shell. Every other build gets the browser's.
 * Custom conditions replace Vite's defaults, so the default lists are
 * spread after `tauri`.
 */
const desktop = process.env.EPICENTER_DESKTOP === '1';

export default defineConfig(
	mergeConfig(workspaceAppViteConfig(APPS.WHISPERING), {
		...(desktop && {
			resolve: { conditions: ['tauri', ...defaultClientConditions] },
			ssr: { resolve: { conditions: ['tauri', ...defaultServerConditions] } },
		}),
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
	}),
);
