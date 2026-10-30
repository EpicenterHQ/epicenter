/**
 * Loopback Git Demo Server Tests
 *
 * The demo server behind `bun dev:todos` and `bun dev:git`, served on a real
 * loopback port and driven by system Git over smart HTTP. Todos serves a
 * fixed path its Vite proxy forwards; Git lab serves a seeded repository at a
 * path per root, so fresh experiments start separately in the browser.
 *
 * Key behaviors:
 * - The native checkout pushes to its origin, the session's remote URL
 * - `/session` answers the session; paths other than the remote are 404,
 *   and no CORS header is sent
 * - Fresh per-root sessions have distinct URLs, and Git clones the seed
 * - A reopened marked root keeps its URL and history; an unmarked one is refused
 */
import { afterEach, expect, test } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	createGitHandler,
	type GitDemo,
	type GitSession,
	prepareGitSession,
} from './git-demo-server.test-support.js';
import { git, scratch } from './git-http.test-support.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0)) await step();
});
const removing = (path: string) => () =>
	rm(path, { recursive: true, force: true });

/** A demo served on a free loopback port, so its remote URL is reachable. */
async function serve(demo: Omit<GitDemo, 'port'>) {
	let handle: (request: Request) => Promise<Response> = async () =>
		new Response('Not ready', { status: 503 });
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: (request) => handle(request),
	});
	const port = Number(server.url.port);
	const session = await prepareGitSession({ ...demo, port });
	handle = await createGitHandler(session);
	cleanup.push(() => server.stop(true), removing(session.root));
	return session;
}

test('a fixed-path demo serves its session, and the native checkout pushes to its origin', async () => {
	const session = await serve({ name: 'todos' });
	const base = `http://127.0.0.1:${session.port}`;
	expect(session.browserRemotePath).toBe('/git/todos.git');
	expect(session.remoteUrl).toBe(`${base}/git/todos.git`);
	expect((await (await fetch(`${base}/session`)).json()) as GitSession).toEqual(
		session,
	);

	const native = session.nativeCheckout;
	expect(await git(native, 'remote', 'get-url', 'origin')).toBe(
		session.remoteUrl,
	);
	await writeFile(join(native, 'note.txt'), 'native\n');
	await git(native, 'add', 'note.txt');
	await git(native, 'commit', '-qm', 'Native note');
	await git(native, 'push', '--quiet', 'origin', 'main');
	expect(await git(session.bare, 'show', 'main:note.txt')).toBe('native');

	expect((await fetch(`${base}/git/other.git/info/refs`)).status).toBe(404);
	expect(
		(
			await fetch(`${session.remoteUrl}/info/refs?service=git-upload-pack`)
		).headers.get('access-control-allow-origin'),
	).toBeNull();
}, 15_000);

const GIT_LAB = {
	name: 'git-lab',
	urlPerRoot: true,
	seed: { 'README.md': '# Git lab\n', 'notes/color.txt': 'color=blue\n' },
} as const;

test('fresh per-root sessions have distinct URLs, and Git clones the seed and pushes over HTTP', async () => {
	const first = await serve(GIT_LAB);
	const second = await prepareGitSession({ ...GIT_LAB, port: first.port });
	cleanup.push(removing(second.root));
	const client = await scratch('git-demo-client-');
	cleanup.push(removing(client));
	expect(first.remoteUrl).not.toBe(second.remoteUrl);
	await git(client, 'clone', '--quiet', first.remoteUrl, 'copy');
	const copy = join(client, 'copy');
	expect(await Bun.file(join(copy, 'notes/color.txt')).text()).toBe(
		'color=blue\n',
	);
	await writeFile(join(copy, 'pushed.txt'), 'explicit push\n');
	await git(copy, 'add', 'pushed.txt');
	await git(copy, 'commit', '-qm', 'Explicit push');
	await git(copy, 'push', '--quiet');
	expect(await git(first.bare, 'show', 'main:pushed.txt')).toBe(
		'explicit push',
	);
	// The other session's URL names a root this server does not serve.
	expect((await fetch(`${second.remoteUrl}/info/refs`)).status).toBe(404);
}, 15_000);

test('reopening a marked root keeps its remote URL and history; an unmarked directory is refused', async () => {
	const first = await prepareGitSession({ ...GIT_LAB, port: 5999 });
	cleanup.push(removing(first.root));
	const reopened = await prepareGitSession({
		...GIT_LAB,
		port: 5999,
		root: first.root,
	});
	expect(reopened.remoteUrl).toBe(first.remoteUrl);
	expect(await git(reopened.bare, 'rev-parse', 'main')).toBe(
		await git(first.bare, 'rev-parse', 'main'),
	);

	const unmarked = await scratch('git-demo-unmarked-');
	cleanup.push(removing(unmarked));
	await expect(
		prepareGitSession({ name: 'todos', port: 5999, root: unmarked }),
	).rejects.toThrow('.epicenter-todos-demo');
});
