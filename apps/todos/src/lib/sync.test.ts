/**
 * Sync Tests
 *
 * Drives the real Todos store's Sync and Apply mutations against a
 * production browser folder whose remote is the demo's real Git target: a
 * bare repository served by `git http-backend`, and a native checkout that
 * commits and pushes with system Git.
 *
 * Key behaviors:
 * - Sync waits for queued writes, so its checkpoint holds what was typed
 * - Independent edits of one todo merge without a review, and the cache
 *   shows the merged todo after the sync
 * - Competing edits fail with `NeedsChoices` and write nothing; refused
 *   choices are `InvalidChoices` and keep the attempt; Apply settles it,
 *   pushes, and the cache shows the choice
 *
 * The review's Cancel lives in the page; `TodosView.mounted.test.ts` covers it.
 */
import './svelte-modules.test-support.js';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
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
} from '../../server/git-server.js';
import { todosDefinition } from './definition.js';
import { cached, observe, quiet, rowEditor } from './query.test-support.js';

const { createTodos } = await import('./todos.svelte.ts');

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

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

let count = 0;
const MILK = 'todos/milk.md';

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

/** Todos over a browser folder whose remote is a fresh demo session, with milk shared. */
async function openDemo() {
	const session = await prepareGitSession(5990);
	const handle = await createGitHandler(session);
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
		handle(new Request(input, init))) as typeof fetch;
	const storage = createTestStorage();
	const id = `sync-${count++}`;
	await configureRemote(storage, id, session.remoteUrl);
	const folder = expectOk(
		await openFolder({
			id,
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
	await run(session.nativeCheckout, [
		'git',
		'pull',
		'--quiet',
		'--ff-only',
		session.bare,
		'main',
	]);
	return { todos, session };
}

/** The native checkout writes milk, commits, and pushes. */
async function pushMilk(session: GitSession, text: string) {
	const native = session.nativeCheckout;
	await writeFile(join(native, MILK), text);
	await run(native, ['git', 'commit', '--quiet', '-am', 'Edit elsewhere']);
	await run(native, ['git', 'push', '--quiet', session.bare, 'main']);
}

const titled = (title: string) => ({ title });

test('a sync waits for queued writes, so its checkpoint holds what was typed', async () => {
	const { todos, session } = await openDemo();
	rowEditor(todos, 'milk')(titled('Buy oat milk'));
	const synced = todos.sync.run();
	expect(expectOk(await synced)).toMatchObject({ kind: 'synced' });
	expect(await run(session.bare, ['git', 'show', `main:${MILK}`])).toContain(
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

test('competing edits need choices and write nothing; refused choices keep the attempt, and Apply settles it', async () => {
	const { todos, session } = await openDemo();
	rowEditor(todos, 'milk')(titled('Buy oat milk'));
	await quiet(todos);
	await pushMilk(
		session,
		'---\ntitle: Buy soy milk\ndone: false\n---\nOne carton.\n',
	);

	const needs = expectErr(await todos.sync.run());
	if (needs.name !== 'NeedsChoices')
		throw new Error(`Expected choices, got ${needs.message}`);
	const { attempt } = needs;
	await quiet(todos);
	expect(cached(todos, 'milk').row.fields.title).toBe('Buy oat milk');
	const [title] = attempt.conflicts;
	expect(title).toMatchObject({
		kind: 'field',
		field: 'title',
		local: { present: true, value: 'Buy oat milk' },
		incoming: { present: true, value: 'Buy soy milk' },
	});

	// A refused choice keeps the attempt, with what to fix.
	const refused = expectErr(
		await todos.sync.apply({
			attempt,
			choices: { [title!.id]: { kind: 'remove' } },
		}),
	);
	if (refused.name !== 'InvalidChoices')
		throw new Error(`Expected invalid choices, got ${refused.message}`);
	expect(refused.problems.map((problem) => problem.conflictId)).toEqual([
		title!.id,
	]);

	const resolved = expectOk(
		await todos.sync.apply({
			attempt,
			choices: { [title!.id]: { kind: 'take', side: 'incoming' } },
		}),
	);
	expect(resolved.kind).toBe('synced');
	await quiet(todos);
	expect(cached(todos, 'milk').row.fields.title).toBe('Buy soy milk');
	expect(await run(session.bare, ['git', 'show', `main:${MILK}`])).toContain(
		'title: Buy soy milk',
	);
});

test('Connect sends a first folder, gives the next one its todos, and asks before combining separate histories', async () => {
	const session = await prepareGitSession(5990);
	const handle = await createGitHandler(session);
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
		handle(new Request(input, init))) as typeof fetch;
	const open = async () => {
		const folder = expectOk(
			await openFolder({
				id: `connect-${count++}`,
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
