/**
 * Compiles `.svelte` and `.svelte.ts` files for the browser with the app's
 * own Svelte, in production mode, with experimental async, and resolves
 * packages by their `svelte` and `browser` conditions. bun-plugin-svelte
 * cannot pass `experimental` and compiles for hot reload unless NODE_ENV is
 * production.
 */
import type { BunPlugin } from 'bun';
import { compile, compileModule } from 'svelte/compiler';

const ts = new Bun.Transpiler({ loader: 'ts' });

export const svelte: BunPlugin = {
	name: 'svelte',
	setup(build) {
		build.config.conditions = ['svelte', 'browser'];
		build.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
			const { js } = compile(await Bun.file(path).text(), {
				filename: path,
				generate: 'client',
				css: 'injected',
				experimental: { async: true },
			});
			return { contents: js.code, loader: 'ts' };
		});
		build.onLoad({ filter: /\.svelte\.[jt]s$/ }, async ({ path }) => {
			const source = await Bun.file(path).text();
			const { js } = compileModule(
				path.endsWith('.ts') ? ts.transformSync(source) : source,
				{
					filename: path,
					generate: 'client',
					experimental: { async: true },
				},
			);
			return { contents: js.code, loader: 'js' };
		});
	},
};
