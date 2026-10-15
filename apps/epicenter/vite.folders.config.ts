/**
 * Build the Folders window's page. The host serves it from its own asset
 * tree below `/apps/folders/`, as it serves every compiled application, so
 * this build emits ordinary assets under that base rather than one document.
 */

import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	root: fileURLToPath(new URL('./src/folders', import.meta.url)),
	base: '/apps/folders/',
	plugins: [
		tailwindcss(),
		svelte({
			configFile: fileURLToPath(new URL('./svelte.config.js', import.meta.url)),
		}),
	],
	build: {
		outDir: fileURLToPath(new URL('./dist/folders', import.meta.url)),
		emptyOutDir: true,
	},
});
