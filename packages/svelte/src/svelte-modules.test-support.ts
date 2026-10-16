/**
 * Compiles `.svelte.ts` runes modules, and the `.svelte.js` ones packages such
 * as runed ship, for Bun tests the way the Svelte Vite plugin does. Import this
 * first, then load runes modules with a dynamic `import()` so the plugin is
 * registered before they are loaded.
 *
 * Apps import it by relative path; it is test support, not part of the
 * package's exports.
 *
 * The page build resolves `svelte/reactivity` to its client classes. Bun's
 * default conditions pick the server ones, which are plain collections that
 * notify nothing, so a test that depends on that reactivity runs with
 * `--conditions=browser` to see what the page sees.
 */
import { compileModule } from 'svelte/compiler';

Bun.plugin({
	name: 'svelte-runes-module',
	setup(build) {
		build.onLoad({ filter: /\.svelte\.[jt]s$/ }, async ({ path }) => {
			const typescript = await Bun.file(path).text();
			// Dead-code elimination would drop a bare `void signal;`, which is how
			// a derived declares a dependency it does not otherwise read.
			const javascript = new Bun.Transpiler({
				loader: 'ts',
				deadCodeElimination: false,
			}).transformSync(typescript);
			const compiled = compileModule(javascript, {
				filename: path,
				generate: 'client',
			});
			return { contents: compiled.js.code, loader: 'js' };
		});
	},
});
