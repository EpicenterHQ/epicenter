import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
	root: import.meta.dirname,
	optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
	worker: { format: 'es' },
	build: {
		target: 'esnext',
		outDir: resolve(import.meta.dirname, 'dist/replica-layout-complete'),
		emptyOutDir: true,
		rollupOptions: {
			input: resolve(
				import.meta.dirname,
				'replica-layout-complete-index.html',
			),
		},
	},
});
