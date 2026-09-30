/**
 * Compiles `.svelte.ts` runes modules for Bun tests the way the Svelte Vite
 * plugin does. Import this first, then load runes modules with a dynamic
 * `import()` so the plugin is registered before they are loaded.
 */
import { compileModule } from 'svelte/compiler';

Bun.plugin({
	name: 'svelte-runes-module',
	setup(build) {
		build.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
			const typescript = await Bun.file(path).text();
			const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(
				typescript,
			);
			const compiled = compileModule(javascript, {
				filename: path,
				generate: 'client',
			});
			return { contents: compiled.js.code, loader: 'js' };
		});
	},
});
