import { APPS } from '@epicenter/constants/apps';
import { hostAppViteConfig } from '@epicenter/vite-config';
import { defineConfig, mergeConfig } from 'vite';

export default defineConfig(
	mergeConfig(hostAppViteConfig(APPS.HONEYCRISP), {
		// SQLite's wasm loads relative to its own module, which pre-bundling would move.
		optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
		// The repository's worker is a module worker that imports SQLite.
		worker: { format: 'es' },
	}),
);
