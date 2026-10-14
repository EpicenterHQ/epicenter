/**
 * The demo's Git handler and native CLI, exercised without binding a port:
 * the browser folder's HTTP requests go straight to the handler, which runs
 * the real `git http-backend` against the demo's bare repository.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFLICTS_NEED_SYNC } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/browser';
import { expectOk } from 'wellcrafted/testing';
import {
	browserStorage,
	configureRemote,
	createTestStorage,
} from '../../../packages/folder/src/browser-storage.test-support.js';
import { todosDefinition } from '../src/lib/definition.js';
import { createGitHandler, prepareGitSession } from './git-server.js';

const originalFetch = globalThis.fetch;
const env = {
	...process.env,
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_AUTHOR_NAME: 'Native',
	GIT_AUTHOR_EMAIL: 'native@localhost',
	GIT_COMMITTER_NAME: 'Native',
	GIT_COMMITTER_EMAIL: 'native@localhost',
};

beforeAll(() => {
	process.env.GIT_CONFIG_GLOBAL = '/dev/null';
	delete process.env.TODOS_DEMO_ROOT;
});
afterAll(() => {
	globalThis.fetch = originalFetch;
});

async function run(cwd: string, command: string[]) {
	const child = Bun.spawn(command, {
		cwd,
		env,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`${command.join(' ')}: ${stderr}${stdout}`);
	return stdout.trim();
}

test('browser push, native pull and push, then browser fast-forward through the demo handler', async () => {
	const session = await prepareGitSession(5999);
	const handle = await createGitHandler(session);
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
		handle(new Request(input, init))) as typeof fetch;

	expect(
		await (await handle(new Request('http://127.0.0.1:5999/session'))).json(),
	).toEqual(session);

	const storage = createTestStorage();
	await configureRemote(storage, 'demo', session.remoteUrl);
	const browser = expectOk(
		await openFolder({
			id: 'demo',
			definition: todosDefinition,
			browser: {
				author: { name: 'Todos', email: 'todos@localhost' },
				...browserStorage(storage),
			},
		}),
	);
	expectOk(
		await browser.tables.todos.create(
			{ fields: { title: 'Buy milk', done: false }, body: '' },
			{ stem: 'milk' },
		),
	);
	const first = await browser.git.commitAndPush();
	expect(first.commit.status).toBe('committed');
	expect(first.push.status).toBe('pushed');
	// Opening the folder published its epicenter.json beside the new row.
	expect(await run(session.bare, ['git', 'log', '--format=%s', 'main'])).toBe(
		'Update 2 files',
	);

	// The native checkout pulls from the bare repository with ordinary Git.
	const native = session.nativeCheckout;
	await run(native, ['git', 'pull', '--ff-only', session.bare, 'main']);
	expect(await readFile(join(native, 'todos/milk.md'), 'utf8')).toContain(
		'title: Buy milk',
	);

	// The native CLI completes the todo and pushes (to the bare path here).
	await run(native, ['git', 'remote', 'set-url', 'origin', session.bare]);
	const cli = JSON.parse(
		await run(join(import.meta.dir, '..'), [
			'bun',
			'scripts/native.ts',
			native,
			'complete',
			'milk',
		]),
	);
	expect(cli.history.commit.status).toBe('committed');
	expect(cli.history.push.status).toBe('pushed');
	const status = JSON.parse(
		await run(join(import.meta.dir, '..'), [
			'bun',
			'scripts/native.ts',
			native,
			'status',
		]),
	);
	expect(status.status.data.changes).toEqual([]);
	expect(status.todos).toEqual([
		{ path: 'todos/milk.md', stem: 'milk', title: 'Buy milk', done: true },
	]);

	// An ordinary native edit, commit, and push.
	await writeFile(
		join(native, 'todos/milk.md'),
		(await readFile(join(native, 'todos/milk.md'), 'utf8')).replace(
			'Buy milk',
			'Buy oat milk',
		),
	);
	await run(native, [
		'git',
		'commit',
		'--quiet',
		'-am',
		'Rename the milk todo',
	]);
	await run(native, ['git', 'push', '--quiet', session.bare, 'main']);

	// The browser fetches and fast-forwards explicitly.
	expectOk(await browser.git.fetch());
	const pulled = expectOk(await browser.git.pullFastForward());
	expect(pulled.status).toBe('fastForwarded');
	const entry = expectOk(await browser.tables.todos.get('milk'));
	if (!entry) throw new Error('Expected milk todo');
	expect(entry.row.fields).toEqual({
		title: 'Buy oat milk',
		done: true,
	});
	expect(
		expectOk(await browser.git.log(5)).map((commit) => commit.message.trim()),
	).toEqual(['Rename the milk todo', 'Update todos/milk.md', 'Update 2 files']);

	// Diverged history: the native CLI's pull applies only a fast-forward,
	// refuses with the folder's pointer to Sync, and writes nothing.
	expectOk(
		await browser.tables.todos.create(
			{ fields: { title: 'Buy bread', done: false }, body: '' },
			{ stem: 'bread' },
		),
	);
	expect((await browser.git.commitAndPush()).push.status).toBe('pushed');
	await writeFile(join(native, 'notes.txt'), 'Native only\n');
	await run(native, ['git', 'add', 'notes.txt']);
	await run(native, ['git', 'commit', '--quiet', '-m', 'Native only']);
	const before = await run(native, ['git', 'rev-parse', 'HEAD']);
	const child = Bun.spawn(['bun', 'scripts/native.ts', native, 'pull'], {
		cwd: join(import.meta.dir, '..'),
		env,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [pullOut, pullErr, pullCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(pullCode).toBe(1);
	expect(pullErr).toContain(CONFLICTS_NEED_SYNC);
	expect(JSON.parse(pullOut).pulled.error.name).toBe('Diverged');
	expect(await run(native, ['git', 'rev-parse', 'HEAD'])).toBe(before);
	await browser.close();
}, 60_000);
