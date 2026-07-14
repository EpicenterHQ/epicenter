import { defineConfig } from 'vite';

const rootEntry = new URL('./index.html', import.meta.url).pathname;
const versionOneEntry = new URL('./previous/v1/index.html', import.meta.url)
	.pathname;

const isolationHeaders = {
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
	server: { headers: isolationHeaders },
	preview: { headers: isolationHeaders },
	optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
	worker: { format: 'es' },
	build: {
		target: 'esnext',
		rollupOptions: {
			input: {
				current: rootEntry,
				previousVersionOne: versionOneEntry,
			},
		},
	},
});
