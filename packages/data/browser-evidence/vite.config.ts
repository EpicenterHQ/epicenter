import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
	server: { hmr: false },
	optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
	worker: { format: 'es' },
	build: {
		target: 'esnext',
		outDir: 'dist',
		emptyOutDir: true,
		rollupOptions: {
			input: resolve(import.meta.dirname, 'index.html'),
		},
	},
});
