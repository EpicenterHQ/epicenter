/**
 * The test site, served from 127.0.0.1: SQLite's wasm, and built for the
 * browser, the replica host's harness (at `/replica`), worker, storage
 * holder and blob store checks, and the repository API's page (at `/api`),
 * a Svelte app compiled here as the Svelte Vite plugin would.
 */
import { join } from 'node:path';
import type { BunPlugin } from 'bun';
import { compile, compileModule } from 'svelte/compiler';

const root = join(import.meta.dir, '..');
const wasm = join(
	root,
	'node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm',
);

/** Svelte components and runes modules, compiled for the browser. */
const svelte: BunPlugin = {
	name: 'svelte',
	setup(build) {
		build.onLoad({ filter: /\.svelte$/ }, async ({ path }) => ({
			contents: compile(await Bun.file(path).text(), {
				filename: path,
				generate: 'client',
				css: 'injected',
			}).js.code,
			loader: 'js',
		}));
		build.onLoad({ filter: /\.svelte\.[jt]s$/ }, async ({ path }) => {
			const javascript = new Bun.Transpiler({
				loader: 'ts',
				deadCodeElimination: false,
			}).transformSync(await Bun.file(path).text());
			return {
				contents: compileModule(javascript, {
					filename: path,
					generate: 'client',
				}).js.code,
				loader: 'js',
			};
		});
	},
};

export async function startSite() {
	const build = await Bun.build({
		entrypoints: [
			join(import.meta.dir, 'replica-harness.ts'),
			join(import.meta.dir, 'replica-holder.worker.ts'),
			join(import.meta.dir, 'objects.worker.ts'),
			join(root, 'src/hosts/browser/replica.worker.ts'),
			join(import.meta.dir, 'api-harness.ts'),
		],
		plugins: [svelte],
		target: 'browser',
		format: 'esm',
		naming: '[name].[ext]',
	});
	if (!build.success)
		throw new AggregateError(build.logs, 'The browser build failed');
	const scripts = new Map<string, string>();
	for (const output of build.outputs) {
		const file = output.path.split('/').at(-1) ?? '';
		const route =
			{
				'replica.worker.js': '/replica-worker.js',
				'replica-holder.worker.js': '/replica-holder.js',
				'objects.worker.js': '/objects.js',
			}[file] ?? `/${file}`;
		scripts.set(route, await output.text());
	}
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			const { pathname } = new URL(request.url);
			const script = scripts.get(pathname);
			if (script !== undefined)
				return new Response(script, {
					headers: { 'content-type': 'text/javascript' },
				});
			if (pathname === '/sqlite3.wasm')
				return new Response(Bun.file(wasm), {
					headers: { 'content-type': 'application/wasm' },
				});
			if (pathname === '/replica')
				return new Response(
					'<!doctype html><title>Replica</title><script type="module" src="/replica-harness.js"></script>',
					{ headers: { 'content-type': 'text/html' } },
				);
			if (pathname === '/api')
				return new Response(
					'<!doctype html><title>Todos</title><script type="module" src="/api-harness.js"></script>',
					{ headers: { 'content-type': 'text/html' } },
				);
			return new Response('Not found', { status: 404 });
		},
	});
	return { url: server.url.href, stop: () => server.stop(true) };
}
