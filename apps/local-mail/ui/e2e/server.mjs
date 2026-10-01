/** Bun owns immutable test builds and HTTP listeners; Playwright owns test attempts. */

import { createHash } from 'node:crypto';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { build } from 'vite';

const temporary = await mkdtemp(join(tmpdir(), 'local-mail-build-'));
const port = Number(process.env.LOCAL_MAIL_TEST_PORT ?? 41770);
const servers = [];
let closing;
function close() {
	closing ??= (async () => {
		for (const server of servers) server.stop(true);
		await rm(temporary, { recursive: true, force: true });
	})();
	return closing;
}
for (const signal of ['SIGINT', 'SIGTERM']) {
	process.once(signal, () => {
		void close().then(() => process.exit(0));
	});
}
try {
	const config = join(temporary, 'vite.config.mts');
	await Bun.write(
		config,
		`import config from ${JSON.stringify(new URL('../vite.config.ts', import.meta.url).pathname)};
import { observeBoot } from ${JSON.stringify(new URL('../../../../packages/app-shell/smoke/observe-boot.mjs', import.meta.url).pathname)};
import { desktopWarning } from ${JSON.stringify(new URL('./desktop-warning.mjs', import.meta.url).pathname)};
export default { ...config, plugins: [...config.plugins, observeBoot(), desktopWarning()] };`,
	);
	const buildApp = Bun.spawn(
		['bun', 'x', 'vite', 'build', '--config', config],
		{
			cwd: new URL('../', import.meta.url).pathname,
			stdout: 'inherit',
			stderr: 'inherit',
		},
	);
	if ((await buildApp.exited) !== 0)
		throw new Error('Local Mail application build failed');
	const directory = join(temporary, 'routes');
	await cp(new URL('../dist/', import.meta.url).pathname, directory, {
		recursive: true,
	});
	const index = await Bun.file(join(directory, 'index.html')).text();
	const metadata = {
		indexSha256: createHash('sha256').update(index).digest('hex'),
	};
	{
		const root = new URL('../evidence/browser/', import.meta.url).pathname;
		const lib = new URL('../src/lib/', import.meta.url).pathname;
		await build({
			root,
			configFile: false,
			logLevel: 'warn',
			plugins: [tailwindcss(), svelte({ configFile: false })],
			resolve: {
				alias: [
					{ find: '$lib', replacement: lib },
					{
						find: '#platform/gmail-authorization',
						replacement: join(lib, 'platform/gmail-authorization.browser.ts'),
					},
				],
			},
			worker: { format: 'es' },
			build: { target: 'esnext', outDir: join(temporary, 'queries') },
		});
	}
	{
		const uiRequire = createRequire(
			new URL('../package.json', import.meta.url),
		);
		const sveltePackage = uiRequire('svelte/package.json');
		const svelteRoot = dirname(uiRequire.resolve('svelte/package.json'));
		const aliases = Object.entries(sveltePackage.exports).flatMap(
			([key, value]) => {
				const path =
					typeof value === 'string' ? value : (value.browser ?? value.default);
				return path
					? [
							{
								find: new RegExp(
									`^${key === '.' ? 'svelte' : `svelte/${key.slice(2)}`}$`,
								),
								replacement: join(svelteRoot, path),
							},
						]
					: [];
			},
		);

		const root = new URL('../evidence/gmail-authorization/', import.meta.url)
			.pathname;
		const built = await build({
			root,
			configFile: false,
			logLevel: 'warn',
			plugins: [svelte({ configFile: false })],
			resolve: { alias: aliases },
			build: {
				target: 'esnext',
				outDir: join(temporary, 'gmail'),
				rollupOptions: {
					input: {
						main: join(root, 'index.html'),
						consent: join(root, 'authorize.html'),
						callback: join(root, 'connected/index.html'),
					},
				},
			},
		});
		const bundles = Array.isArray(built) ? built : [built];
		if (
			bundles.some((bundle) =>
				bundle.output.some(
					(item) =>
						item.type === 'chunk' &&
						Object.keys(item.modules).some(
							(id) =>
								id.includes('/lib/application.') ||
								id.includes('/packages/app/src/'),
						),
				),
			)
		)
			throw new Error('Callback evidence unexpectedly imported an App owner.');
	}
	function serve(offset, folder, fallback) {
		const server = Bun.serve({
			hostname: 'localhost',
			port: port + offset,
			async fetch(request) {
				const path = new URL(request.url).pathname;
				if (offset === 0 && path === '/__evidence')
					return Response.json(metadata);
				const relative = fallback(path);
				const file = Bun.file(join(temporary, folder, relative));
				return (await file.exists())
					? new Response(file)
					: new Response('Missing asset', { status: 404 });
			},
		});
		servers.push(server);
	}
	// Separate origins preserve root-relative assets and callback-origin rejection.
	serve(1, 'queries', (path) => (path === '/' ? 'index.html' : path));
	serve(2, 'gmail', (path) =>
		path === '/'
			? 'index.html'
			: path === '/connected'
				? 'connected/index.html'
				: path,
	);
	servers.push(
		Bun.serve({
			hostname: 'localhost',
			port: port + 3,
			fetch: () =>
				new Response('<!doctype html><title>Other origin</title>', {
					headers: { 'content-type': 'text/html' },
				}),
		}),
	);
	// The readiness endpoint starts last, after every build and listener succeeds.
	serve(0, 'routes', (path) =>
		path.startsWith('/_app/') ? path : 'index.html',
	);
} catch (error) {
	await close();
	throw error;
}
