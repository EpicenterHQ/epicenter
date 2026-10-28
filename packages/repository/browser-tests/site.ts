/**
 * The test site: the harness, the repository worker and the storage holder
 * built for the browser, and SQLite's wasm, served from 127.0.0.1.
 */
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const wasm = join(root, 'node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm');

export async function startSite() {
	const build = await Bun.build({
		entrypoints: [join(import.meta.dir, 'harness.ts'), join(import.meta.dir, 'holder.worker.ts'), join(root, 'src/browser/repository.worker.ts')],
		target: 'browser',
		format: 'esm',
		naming: '[name].[ext]',
	});
	if (!build.success) throw new AggregateError(build.logs, 'The browser build failed');
	const scripts = new Map<string, string>();
	for (const output of build.outputs) {
		const file = output.path.split('/').at(-1) ?? '';
		const route = { 'repository.worker.js': '/worker.js', 'holder.worker.js': '/holder.js' }[file] ?? `/${file}`;
		scripts.set(route, await output.text());
	}
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			const { pathname } = new URL(request.url);
			const script = scripts.get(pathname);
			if (script !== undefined) return new Response(script, { headers: { 'content-type': 'text/javascript' } });
			if (pathname === '/sqlite3.wasm') return new Response(Bun.file(wasm), { headers: { 'content-type': 'application/wasm' } });
			if (pathname === '/') return new Response('<!doctype html><title>Repository</title><script type="module" src="/harness.js"></script>', { headers: { 'content-type': 'text/html' } });
			return new Response('Not found', { status: 404 });
		},
	});
	return { url: server.url.href, stop: () => server.stop(true) };
}
