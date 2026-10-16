/**
 * Native CLI Tests
 *
 * `scripts/native.ts` over the demo's native checkout, beside a browser
 * folder whose HTTP requests go straight to the demo's Git handler (no port),
 * which runs the real `git http-backend` against the demo's bare repository.
 *
 * Key behaviors:
 * - The CLI completes a todo the browser synced, and its Sync pushes it
 * - A native edit and push reaches the browser by Sync, a fast-forward
 * - With diverged history, the CLI's Sync merges both into one commit
 *
 * `packages/folder/src/git-demo-server.test.ts` covers the server itself.
 */
import { afterAll, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openFolder } from '@epicenter/folder/browser';
import { $ } from 'bun';
import { expectOk } from 'wellcrafted/testing';
import {
	browserStorage,
	configureRemote,
	createTestStorage,
} from '../../../packages/folder/src/browser-storage.test-support.js';
import {
	createGitHandler,
	prepareGitSession,
} from '../../../packages/folder/src/git-demo-server.test-support.js';
import {
	GIT_ENV,
	git,
} from '../../../packages/folder/src/git-http.test-support.js';
import { todosDefinition } from '../src/lib/definition.js';

const originalFetch = globalThis.fetch;
afterAll(() => {
	globalThis.fetch = originalFetch;
});

/** `bun scripts/native.ts <checkout> <command>`, run from the app. */
const native = (checkout: string, command: string) =>
	$`bun scripts/native.ts ${checkout} ${command.split(' ')}`
		.cwd(join(import.meta.dir, '..'))
		.env(GIT_ENV);

test('browser sync, native sync, then a browser fast-forward and a native merge through the demo handler', async () => {
	const session = await prepareGitSession({ name: 'todos', port: 5999 });
	const handle = await createGitHandler(session);
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
		handle(new Request(input, init))) as typeof fetch;

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
	expect(expectOk(await browser.sync.run()).kind).toBe('synced');
	// Opening the folder published its epicenter.json beside the new row.
	expect(await git(session.bare, 'log', '--format=%s', 'main')).toBe(
		'Update 2 files',
	);

	// The native checkout pulls from the bare repository with ordinary Git.
	const checkout = session.nativeCheckout;
	await git(checkout, 'pull', '--ff-only', session.bare, 'main');
	expect(await readFile(join(checkout, 'todos/milk.md'), 'utf8')).toContain(
		'title: Buy milk',
	);

	// The native CLI completes the todo and syncs (to the bare path here).
	await git(checkout, 'remote', 'set-url', 'origin', session.bare);
	const cli = await native(checkout, 'complete milk').json();
	expect(cli.sync.data.kind).toBe('synced');
	const status = await native(checkout, 'status').json();
	expect(status.status.data.changes).toEqual([]);
	expect(status.todos).toEqual([
		{ path: 'todos/milk.md', stem: 'milk', title: 'Buy milk', done: true },
	]);

	// An ordinary native edit, commit, and push.
	await writeFile(
		join(checkout, 'todos/milk.md'),
		(await readFile(join(checkout, 'todos/milk.md'), 'utf8')).replace(
			'Buy milk',
			'Buy oat milk',
		),
	);
	await git(checkout, 'commit', '--quiet', '-am', 'Rename the milk todo');
	await git(checkout, 'push', '--quiet', session.bare, 'main');

	// The browser's Sync is a fast-forward.
	expect(expectOk(await browser.sync.run()).kind).toBe('synced');
	const entry = expectOk(await browser.tables.todos.get('milk'));
	if (!entry) throw new Error('Expected milk todo');
	expect(entry.row.fields).toEqual({
		title: 'Buy oat milk',
		done: true,
	});
	expect(
		expectOk(await browser.git.log(5)).map((commit) => commit.message.trim()),
	).toEqual(['Rename the milk todo', 'Update todos/milk.md', 'Update 2 files']);

	// Diverged history: the native CLI's Sync merges both into one commit.
	expectOk(
		await browser.tables.todos.create(
			{ fields: { title: 'Buy bread', done: false }, body: '' },
			{ stem: 'bread' },
		),
	);
	expect(expectOk(await browser.sync.run()).kind).toBe('synced');
	const theirs = await git(session.bare, 'rev-parse', 'main');
	await writeFile(join(checkout, 'notes.txt'), 'Native only\n');
	await git(checkout, 'add', 'notes.txt');
	await git(checkout, 'commit', '--quiet', '-m', 'Native only');
	const mine = await git(checkout, 'rev-parse', 'HEAD');
	const merged = await native(checkout, 'sync').json();
	expect(merged.data.kind).toBe('synced');
	expect((await git(checkout, 'log', '-1', '--format=%P')).split(' ')).toEqual([
		mine,
		theirs,
	]);
	expect(await readFile(join(checkout, 'todos/bread.md'), 'utf8')).toContain(
		'title: Buy bread',
	);
	expect(await git(session.bare, 'rev-parse', 'main')).toBe(
		await git(checkout, 'rev-parse', 'HEAD'),
	);
	await browser.close();
}, 60_000);
