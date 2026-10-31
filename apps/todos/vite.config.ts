import { APPS } from '@epicenter/constants/apps';
import { workspaceAppViteConfig } from '@epicenter/vite-config';
import { defineConfig, mergeConfig } from 'vite';

export default defineConfig(
	mergeConfig(workspaceAppViteConfig(APPS.TODOS), {
		// localhost, not 127.0.0.1: the API registers Todos' sign-in callback
		// at `http://localhost:5186`.
		server: { host: 'localhost' },
		preview: { port: APPS.TODOS.port, strictPort: true, host: 'localhost' },
		// The device's OPFS Worker is a module Worker.
		worker: { format: 'es' },
	}),
);
