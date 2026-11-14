// @ts-check

import svelte from '@astrojs/svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	output: 'static', // Keep static for now, can change to 'server' if needed
	vite: {
		// Each workspace has its own physical vite install (same version), so the
		// plugin's `Plugin` type is nominally distinct from astro's expected
		// `PluginOption`. In a `.mjs` config the correct vite `PluginOption`
		// isn't nameable (astro's plugins resolve a different physical vite),
		// so cast to `any`; the `.ts` configs use the narrower `PluginOption[]`.
		// Drop the cast once the installs dedupe to one vite.
		plugins: /** @type {any} */ ([tailwindcss()]),
		resolve: {
			noExternal: ['bits-ui', 'runed', 'svelte-toolbelt'],
		},
	},
	integrations: [svelte()],
});
