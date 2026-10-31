import { APPS } from '@epicenter/constants/apps';
import { workspaceAppViteConfig } from '@epicenter/vite-config';
import { defineConfig, mergeConfig } from 'vite';

export default defineConfig(
	mergeConfig(workspaceAppViteConfig(APPS.HONEYCRISP), {
		// localhost, not 127.0.0.1: the API registers Honeycrisp's sign-in
		// callback at `http://localhost:5175`.
		server: { host: 'localhost' },
		preview: {
			port: APPS.HONEYCRISP.port,
			strictPort: true,
			host: 'localhost',
		},
		// The device's OPFS Worker is a module Worker.
		worker: { format: 'es' },
	}),
);
