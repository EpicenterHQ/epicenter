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
			input: {
				index: resolve(import.meta.dirname, 'index.html'),
				splitReplicaConformanceWorker: resolve(
					import.meta.dirname,
					'split-replica-conformance-worker.ts',
				),
			},
		},
	},
});
