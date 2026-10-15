/**
 * Compiles `.svelte.ts` runes modules, and the `.svelte.js` ones packages
 * such as runed ship, for Bun tests the way the Svelte Vite plugin does. Import this first, then load runes modules with a dynamic
 * `import()` so the plugin is registered before they are loaded.
 *
 * The page build resolves `svelte/reactivity` to its client classes. Bun's
 * default conditions pick the server ones, which are plain collections that
 * notify nothing, so the test script runs with `--conditions=browser` and a
 * test sees the reactivity the page has.
 */
import { compileModule } from 'svelte/compiler';

Bun.plugin({
	name: 'svelte-runes-module',
	setup(build) {
		build.onLoad({ filter: /\.svelte\.[jt]s$/ }, async ({ path }) => {
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
