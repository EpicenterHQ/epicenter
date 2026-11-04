/**
 * The recorder demo: a static single-page app. `bun run build` writes it to
 * `dist/`, and any static host serves it. Dev and preview run on port 5214,
 * which the end-to-end suite serves it on too.
 */
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

const port = 5214;

export default defineConfig({
	plugins: [svelte()],
	server: { port, strictPort: true },
	preview: { port, strictPort: true },
	// The OPFS Worker is a module Worker.
	worker: { format: 'es' },
});
