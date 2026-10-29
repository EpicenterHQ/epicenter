/**
 * The test site, served from 127.0.0.1: SQLite's wasm, and built for the
 * browser, the legacy repository's harness (at `/`), worker and storage
 * holder, and the replica host's harness (at `/replica`), worker, storage
 * holder and blob store checks.
 */
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const wasm = join(root, 'node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm');

export async function startSite() {
	const build = await Bun.build({
		entrypoints: [
			join(import.meta.dir, 'harness.ts'),
			join(import.meta.dir, 'holder.worker.ts'),
			join(root, 'src/browser/repository.worker.ts'),
			join(import.meta.dir, 'replica-harness.ts'),
			join(import.meta.dir, 'replica-holder.worker.ts'),
			join(import.meta.dir, 'objects.worker.ts'),
			join(root, 'src/hosts/browser/replica.worker.ts'),
		],
		target: 'browser',
		format: 'esm',
		naming: '[name].[ext]',
	});
	if (!build.success) throw new AggregateError(build.logs, 'The browser build failed');
	const scripts = new Map<string, string>();
	for (const output of build.outputs) {
		const file = output.path.split('/').at(-1) ?? '';
		const route =
			{
				'repository.worker.js': '/worker.js',
				'holder.worker.js': '/holder.js',
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
			if (script !== undefined) return new Response(script, { headers: { 'content-type': 'text/javascript' } });
			if (pathname === '/sqlite3.wasm') return new Response(Bun.file(wasm), { headers: { 'content-type': 'application/wasm' } });
			if (pathname === '/replica')
				return new Response('<!doctype html><title>Replica</title><script type="module" src="/replica-harness.js"></script>', { headers: { 'content-type': 'text/html' } });
			if (pathname === '/') return new Response('<!doctype html><title>Repository</title><script type="module" src="/harness.js"></script>', { headers: { 'content-type': 'text/html' } });
			return new Response('Not found', { status: 404 });
		},
	});
	return { url: server.url.href, stop: () => server.stop(true) };
}
