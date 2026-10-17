/**
 * Sync Tests
 *
 * Drives the real Todos store's Sync mutation against a
 * production browser folder whose remote is the demo's real Git target: a
 * bare repository served by `git http-backend`, and a native checkout that
 * commits and pushes with system Git.
 *
 * Key behaviors:
 * - Sync waits for queued writes, so its checkpoint holds what was typed
 * - Independent edits of one todo merge without a review, and the cache
 *   shows the merged todo after the sync
 * - Competing edits merge into one commit this device wins, pushed, and the
 *   cache shows the merged todo
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterAll, afterEach, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openFolder } from '@epicenter/folder/browser';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	browserStorage,
	configureRemote,
	createTestStorage,
} from '../../../../packages/folder/src/browser-storage.test-support.js';
import {
	createGitHandler,
	type GitSession,
	prepareGitSession,
} from '../../../../packages/folder/src/git-demo-server.test-support.js';
import { git } from '../../../../packages/folder/src/git-http.test-support.js';
import { todosDefinition } from './definition.js';
import { cached, observe, quiet, rowEditor } from './query.test-support.js';

const { createTodos } = await import('./todos.svelte.ts');

const originalFetch = globalThis.fetch;
afterAll(() => {
	globalThis.fetch = originalFetch;
});

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

let count = 0;
const MILK = 'todos/milk.md';

/** Todos over a browser folder whose remote is a fresh demo session, with milk shared. */
async function openDemo() {
	const session = await prepareGitSession({ name: 'todos', port: 5990 });
	const handle = await createGitHandler(session);
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
		handle(new Request(input, init))) as typeof fetch;
	const storage = createTestStorage();
	const id = `sync-${count++}`;
	await configureRemote(storage, id, session.remoteUrl);
	const folder = expectOk(
		await openFolder({
			app: id,
			definition: todosDefinition,
			browser: {
				author: { name: 'Todos', email: 'todos@localhost' },
				...browserStorage(storage),
			},
		}),
	);
	const todos = createTodos(folder);
	cleanup.push(() => todos.close());
	cleanup.push(observe(todos));
	expectOk(
		await folder.tables.todos.create(
			{ fields: { title: 'Buy milk', done: false }, body: 'One carton.\n' },
			{ stem: 'milk' },
		),
	);
	expect(expectOk(await todos.sync.run())).toMatchObject({ kind: 'synced' });
	await quiet(todos);
	await git(
		session.nativeCheckout,
		'pull',
		'--quiet',
		'--ff-only',
		session.bare,
		'main',
	);
	return { todos, session };
}

/** The native checkout writes milk, commits, and pushes. */
async function pushMilk(session: GitSession, text: string) {
	const native = session.nativeCheckout;
	await writeFile(join(native, MILK), text);
	await git(native, 'commit', '--quiet', '-am', 'Edit elsewhere');
	await git(native, 'push', '--quiet', session.bare, 'main');
}

const titled = (title: string) => ({ title });

test('a sync waits for queued writes, so its checkpoint holds what was typed', async () => {
	const { todos, session } = await openDemo();
	rowEditor(todos, 'milk')(titled('Buy oat milk'));
	const synced = todos.sync.run();
	expect(expectOk(await synced)).toMatchObject({ kind: 'synced' });
	expect(await git(session.bare, 'show', `main:${MILK}`)).toContain(
		'title: Buy oat milk',
	);
});

test('independent edits merge without a review, and the cache shows the merged todo', async () => {
	const { todos, session } = await openDemo();
	rowEditor(todos, 'milk')(titled('Buy oat milk'));
	await quiet(todos);
	await pushMilk(
		session,
		'---\ntitle: Buy milk\ndone: false\n---\nTwo cartons.\n',
	);

	expect(expectOk(await todos.sync.run())).toMatchObject({ kind: 'synced' });
	await quiet(todos);
	expect(cached(todos, 'milk').row).toEqual({
		fields: { title: 'Buy oat milk', done: false },
		body: 'Two cartons.\n',
	});
});

test('competing edits merge into one commit this device wins, and the cache shows it', async () => {
	const { todos, session } = await openDemo();
	rowEditor(todos, 'milk')(titled('Buy oat milk'));
	await quiet(todos);
	await pushMilk(
		session,
		'---\ntitle: Buy soy milk\ndone: true\n---\nOne carton.\n',
	);

	expect(expectOk(await todos.sync.run())).toMatchObject({ kind: 'synced' });
	await quiet(todos);
	// The title both changed is this device's; what only the remote changed
	// merges in.
	expect(cached(todos, 'milk').row).toEqual({
		fields: { title: 'Buy oat milk', done: true },
		body: 'One carton.\n',
	});
	const remote = await git(session.bare, 'show', `main:${MILK}`);
	expect(remote).toContain('title: Buy oat milk');
	expect(await git(session.bare, 'log', '-1', '--format=%B', 'main')).toContain(
		`field="title" "${MILK}"`,
	);
});

test('Connect sends a first folder, gives the next one its todos, and asks before combining separate histories', async () => {
	const session = await prepareGitSession({ name: 'todos', port: 5990 });
	const handle = await createGitHandler(session);
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
		handle(new Request(input, init))) as typeof fetch;
	const open = async () => {
		const folder = expectOk(
			await openFolder({
				app: `connect-${count++}`,
				definition: todosDefinition,
				browser: {
					author: { name: 'Todos', email: 'todos@localhost' },
					...browserStorage(createTestStorage()),
				},
			}),
		);
		const todos = createTodos(folder);
		cleanup.push(() => todos.close());
		cleanup.push(observe(todos));
		return todos;
	};
	const titles = async (todos: Awaited<ReturnType<typeof open>>) =>
		expectOk(await todos.folder.tables.todos.list())
			.map(({ result }) => result.data?.row.fields.title)
			.sort();
	const url = session.remoteUrl;

	// A folder with todos connects to an empty remote: they are sent.
	const first = await open();
	expect(first.git.snapshot.remote).toBeUndefined();
	expectOk(await first.rows.create('Buy milk'));
	expect(expectOk(await first.sync.run({ url }))).toMatchObject({
		kind: 'synced',
	});
	expect(first.git.snapshot.remote?.url).toBe(url);

	// An empty folder connects: it takes the remote's todos.
	const second = await open();
	expect(expectOk(await second.sync.run({ url }))).toMatchObject({
		kind: 'synced',
	});
	expect(await titles(second)).toEqual(['Buy milk']);

	// A folder with a history of its own is not combined without consent.
	const third = await open();
	expectOk(await third.rows.create('Buy bread'));
	expect((await third.folder.git.commit()).status).toBe('committed');
	expect(expectErr(await third.sync.run({ url })).name).toBe('Unrelated');
	expect(await titles(third)).toEqual(['Buy bread']);
	expect(third.git.snapshot.remote?.url).toBe(url);
	expect(expectOk(await third.sync.run({ url, combine: true }))).toMatchObject({
		kind: 'synced',
	});
	expect(await titles(third)).toEqual(['Buy bread', 'Buy milk']);
});
