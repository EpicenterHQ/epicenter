import { basename, dirname, join } from 'node:path';
import { build } from 'vite';
import { fixtureResponse, prepareFixture } from './fixture-git.js';
import { openNativeFiles } from './native-files.js';

const root =
	process.argv[2] ??
	'/private/tmp/epicenter-file-notebook-demo/desktop/Epicenter/accounts/demo';
const desktop = join(root, '../../..');
const account = basename(root);
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(account))
	throw new Error('Invalid account folder name');
const fixture = await prepareFixture(
	dirname(desktop),
	desktop,
	`http://127.0.0.1:${process.env.FILE_NOTEBOOK_PORT ?? 4317}/repo.git`,
);
const files = await openNativeFiles(root);
const appRoot = new URL('../', import.meta.url).pathname;
await build({ root: appRoot, logLevel: 'error' });
const html = await Bun.file(join(appRoot, 'dist/index.html')).text();

function wire(file: { path: string; bytes: Uint8Array; revision: string }) {
	return {
		path: file.path,
		revision: file.revision,
		bytes: Buffer.from(file.bytes).toString('base64'),
	};
}

async function command(args: string[], cwd = root) {
	const process = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	return { stdout, stderr, exitCode };
}

async function required(args: string[], cwd = desktop) {
	const result = await command(args, cwd);
	if (result.exitCode) throw new Error(result.stderr || result.stdout);
	return result;
}

const server = Bun.serve({
	hostname: '127.0.0.1',
	port: Number(process.env.FILE_NOTEBOOK_PORT ?? 4317),
	async fetch(request) {
		const url = new URL(request.url);
		const expectedOrigin = `http://127.0.0.1:${process.env.FILE_NOTEBOOK_PORT ?? 4317}`;
		if (request.headers.get('host') !== new URL(expectedOrigin).host)
			return new Response('Invalid host', { status: 403 });
		const git = await fixtureResponse(request, fixture, url.origin);
		if (git) return git;
		if (url.pathname === '/')
			return new Response(html, { headers: { 'Content-Type': 'text/html' } });
		if (/^\/assets\/[A-Za-z0-9_-]+\.js$/.test(url.pathname))
			return new Response(Bun.file(join(appRoot, 'dist', url.pathname)), {
				headers: { 'Content-Type': 'text/javascript' },
			});
		if (!url.pathname.startsWith('/api/'))
			return new Response('Not found', { status: 404 });
		const operation = url.pathname.slice(5);
		const mutation = new Set([
			'create',
			'replace',
			'publish-row',
			'terminal',
			'desktop-commit',
			'desktop-push',
			'desktop-pull',
		]).has(operation);
		if (request.method !== (mutation ? 'POST' : 'GET'))
			return new Response('Method not allowed', { status: 405 });
		if (
			mutation &&
			(request.headers.get('origin') !== expectedOrigin ||
				!request.headers.get('content-type')?.startsWith('application/json'))
		) {
			return new Response('Same-origin JSON request required', { status: 403 });
		}
		try {
			const body = request.method === 'POST' ? await request.text() : '';
			const input = body ? (JSON.parse(body) as Record<string, unknown>) : {};
			const path = String(input.path ?? url.searchParams.get('path') ?? '');
			const bytes = () =>
				Uint8Array.from(Buffer.from(String(input.bytes ?? ''), 'base64'));
			let result: unknown;
			switch (operation) {
				case 'list':
					result = await files.list();
					break;
				case 'snapshot':
					result = (await files.snapshot()).map(wire);
					break;
				case 'read': {
					const file = await files.read(path);
					result = file ? wire(file) : null;
					break;
				}
				case 'create':
					result = wire(await files.create(path, bytes()));
					break;
				case 'replace':
					result = wire(
						await files.replace(
							{
								path,
								revision: String(input.revision),
								bytes: new Uint8Array(),
							},
							bytes(),
						),
					);
					break;
				case 'publish-row': {
					const attachment = input.attachment as
						| { path: string; bytes: string }
						| undefined;
					await files.publishRow(
						String(input.rowPath),
						Uint8Array.from(Buffer.from(String(input.row), 'base64')),
						attachment && {
							path: attachment.path,
							bytes: Uint8Array.from(Buffer.from(attachment.bytes, 'base64')),
						},
					);
					result = { ok: true };
					break;
				}
				case 'terminal':
					result = await command(['/bin/bash', '-lc', String(input.command)]);
					break;
				case 'git-status':
					result = await command(['git', 'status', '--short'], desktop);
					break;
				case 'desktop-commit': {
					await required(['git', 'add', '--', `Epicenter/accounts/${account}`]);
					result = await required([
						'git',
						'commit',
						'-m',
						'Field notebook desktop edit',
					]);
					break;
				}
				case 'desktop-push':
					result = await required(['git', 'push', 'origin', 'main']);
					break;
				case 'desktop-pull': {
					const dirty = await required([
						'git',
						'status',
						'--porcelain',
						'--',
						`Epicenter/accounts/${account}`,
					]);
					if (dirty.stdout.trim())
						throw new Error('Desktop files have uncommitted changes');
					await required(['git', 'fetch', 'origin', 'main']);
					await required(['git', 'merge', '--ff-only', 'FETCH_HEAD']);
					result = await required(['git', 'lfs', 'pull']);
					break;
				}
				case 'location':
					result = { root, gitRoot: desktop, account };
					break;
				default:
					return new Response('Not found', { status: 404 });
			}
			return Response.json(result);
		} catch (error) {
			return Response.json(
				{ error: error instanceof Error ? error.message : String(error) },
				{ status: 409 },
			);
		}
	},
});

console.log(`Desktop file notebook: http://127.0.0.1:${server.port}`);
console.log(`Current native files: ${root}`);
