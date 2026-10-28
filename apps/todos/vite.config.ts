import { hostAppViteConfig } from '@epicenter/vite-config';
import { defineConfig, mergeConfig } from 'vite';

export default defineConfig(
	mergeConfig(hostAppViteConfig({ port: 5186 }), {
		server: { host: '127.0.0.1' },
		// SQLite's wasm loads relative to its own module, which pre-bundling would move.
		optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
		// The repository's worker is a module worker that imports SQLite.
		worker: { format: 'es' },
	}),
);
