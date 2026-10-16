/**
 * Build Settings' page (the `home` window). The shell serves it on the
 * `epicenter-app` scheme below `/home/` (ADR-0561), so this build emits
 * ordinary assets under that base.
 */

import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	// Absolute, so the build works regardless of the invoking cwd (a relative
	// root resolves against process.cwd(), not this file).
	root: fileURLToPath(new URL('./src/ui', import.meta.url)),
	base: '/home/',
	plugins: [
		tailwindcss(),
		// The plugin resolves svelte.config.js against the Vite root (src/ui),
		// so point it back at the package-root config explicitly.
		svelte({
			configFile: fileURLToPath(new URL('./svelte.config.js', import.meta.url)),
		}),
	],
	build: {
		outDir: fileURLToPath(new URL('./dist/home', import.meta.url)),
		emptyOutDir: true,
	},
});
