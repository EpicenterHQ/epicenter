import { plugin } from 'bun';
import { compileModule } from 'svelte/compiler';

// Compile rune modules for DOM-free queue tests; --conditions browser selects Svelte's client reactivity.
plugin({
	name: 'svelte-runes',
	setup(build) {
		build.onLoad({ filter: /\.svelte\.(ts|js)$/ }, async ({ path }) => {
			const source = await Bun.file(path).text();
			const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(
				source,
			);
			return {
				contents: compileModule(javascript, {
					filename: path,
					generate: 'client',
				}).js.code,
				loader: 'js',
			};
		});
	},
});
