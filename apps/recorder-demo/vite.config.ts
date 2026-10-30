/**
 * The recorder demo: a static single-page app. `bun run build` writes it to
 * `dist/`, and any static host that answers unknown paths with
 * `index.html` (for `/auth/callback`) serves it. Dev and preview run on the
 * port its OAuth client is registered for, and only there.
 */
import { LOCAL_APPS } from '@epicenter/constants/apps';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

const { port } = LOCAL_APPS.RECORDER_DEMO;

export default defineConfig({
	plugins: [svelte()],
	server: { port, strictPort: true },
	preview: { port, strictPort: true },
	// The device's OPFS Worker is a module Worker.
	worker: { format: 'es' },
});
