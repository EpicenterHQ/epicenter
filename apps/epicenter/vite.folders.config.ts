/**
 * Build the Folders window's page. The shell serves it on the
 * `epicenter-app` scheme below `/folders/` (ADR-0561), so this build emits
 * ordinary assets under that base.
 */

import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	root: fileURLToPath(new URL('./src/folders', import.meta.url)),
	base: '/folders/',
	plugins: [
		tailwindcss(),
		svelte({
			configFile: fileURLToPath(new URL('./svelte.config.js', import.meta.url)),
		}),
	],
	resolve: {
		alias: [
			// Shared modules import the folder contract from the bare specifier.
			// This page runs only in the desktop shell, so that exact specifier
			// resolves to the desktop entry and the build carries no browser
			// storage or Git implementation.
			{ find: /^@epicenter\/folder$/, replacement: '@epicenter/folder/tauri' },
		],
	},
	build: {
		outDir: fileURLToPath(new URL('./dist/folders', import.meta.url)),
		emptyOutDir: true,
	},
});
