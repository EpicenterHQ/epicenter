import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
	optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
	worker: { format: 'es' },
	build: {
		target: 'esnext',
		outDir: 'dist/replica-layout',
		emptyOutDir: true,
		rollupOptions: {
			input: resolve(import.meta.dirname, 'replica-layout-index.html'),
		},
	},
});
