/**
 * Sync Tests
 *
 * Drives the real Todos state module's Sync against a production browser
 * folder whose remote is the demo's real Git target: a bare repository
 * served by `git http-backend`, and a native checkout that commits and
 * pushes with system Git.
 *
 * Key behaviors:
 * - Independent edits of one todo merge without a review, and the open todo
 *   holding nothing unsaved takes the merged version
 * - Competing edits keep an attempt for the review and change nothing; the
 *   person's choice is applied, pushed, and shown in the open todo
 * - The review is modal: the open todo takes no input while it waits, no
 *   sync starts, and Cancel discards the attempt and gives the todo back
 * - A refused choice keeps the attempt with what to fix
 * - An open todo with a draft it could not save keeps the draft after Sync;
 *   its conflict prompt still decides
 */
import './svelte-modules.test-support.js';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openFolder } from '@epicenter/folder/browser';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	browserStorage,
	createTestStorage,
} from '../../../../packages/folder/src/browser-storage.test-support.js';
import {
	createGitHandler,
	type GitSession,
	prepareGitSession,
} from '../../server/git-server.js';
import { todosDefinition } from './definition.js';
import type { Todos } from './todos.svelte.js';

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

const opened: Todos[] = [];
afterEach(async () => {
	for (const todos of opened.splice(0)) await todos.close();
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
	const folder = expectOk(
		await openFolder({
			id: `sync-${count++}`,
			definition: todosDefinition,
			browser: {
				author: { name: 'Todos', email: 'todos@localhost' },
				remote: { url: session.remoteUrl, branch: 'main' },
				...browserStorage(createTestStorage()),
			},
		}),
	);
	const todos = createTodos(folder);
	opened.push(todos);
	await todos.check();
	expectOk(
		await folder.tables.todos.create(
			{ fields: { title: 'Buy milk', done: false }, body: 'One carton.\n' },
			{ stem: 'milk' },
		),
	);
	expect(expectOk(await todos.sync())).toMatchObject({ kind: 'synced' });
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

function todoSession(todos: Todos) {
	const item = todos.opened;
	if (item?.kind !== 'todo')
		throw new Error(`Expected an open todo, got ${item?.kind}`);
	return item.session;
}

test('independent edits merge without a review, and the open todo takes the result', async () => {
	const { todos, session } = await openDemo();
	await todos.open(MILK, 'todos');
	const milk = todoSession(todos);
	milk.edit((row) => {
		row.fields.title = 'Buy oat milk';
	});
	await milk.settled();
	await pushMilk(
		session,
		'---\ntitle: Buy milk\ndone: false\n---\nTwo cartons.\n',
	);

	expect(expectOk(await todos.sync())).toMatchObject({ kind: 'synced' });
	expect(todos.syncAttempt).toBeUndefined();
	expect(todoSession(todos).draft).toEqual({
		fields: { title: 'Buy oat milk', done: false },
		body: 'Two cartons.\n',
	});
});

test('competing edits wait for the review, and the choice is applied and shown', async () => {
	const { todos, session } = await openDemo();
	await todos.open(MILK, 'todos');
	const milk = todoSession(todos);
	milk.edit((row) => {
		row.fields.title = 'Buy oat milk';
	});
	await milk.settled();
	await pushMilk(
		session,
		'---\ntitle: Buy soy milk\ndone: false\n---\nOne carton.\n',
	);

	const needs = expectErr(await todos.sync());
	if (needs.name !== 'NeedsChoices')
		throw new Error(`Expected choices, got ${needs.message}`);
	const ran = needs.attempt;
	expect(todos.syncAttempt).toBe(ran);
	// The review is modal: the open todo takes no input while it waits.
	const typed = todoSession(todos);
	typed.edit((row) => {
		row.fields.title = 'Typed during the review';
	});
	expect(typed.draft.fields.title).toBe('Buy oat milk');
	expect(todoSession(todos).draft.fields.title).toBe('Buy oat milk');
	const [title] = ran.conflicts;
	expect(title).toMatchObject({
		kind: 'field',
		field: 'title',
		local: { present: true, value: 'Buy oat milk' },
		incoming: { present: true, value: 'Buy soy milk' },
	});

	// A refused choice keeps the attempt, with what to fix.
	const refused = expectErr(
		await todos.resolveSync(ran, { [title!.id]: { kind: 'remove' } }),
	);
	expect(refused.name).toBe('InvalidChoices');
	expect(todos.syncAttempt).toBe(ran);
	expect(todos.syncProblems.map((problem) => problem.conflictId)).toEqual([
		title!.id,
	]);

	const resolved = expectOk(
		await todos.resolveSync(ran, {
			[title!.id]: { kind: 'take', side: 'incoming' },
		}),
	);
	expect(resolved.kind).toBe('synced');
	expect(todos.syncAttempt).toBeUndefined();
	expect(todoSession(todos).draft.fields.title).toBe('Buy soy milk');
	expect(await run(session.bare, ['git', 'show', `main:${MILK}`])).toContain(
		'title: Buy soy milk',
	);
});

test('Cancel discards the attempt and gives the open todo back', async () => {
	const { todos, session } = await openDemo();
	await todos.open(MILK, 'todos');
	const milk = todoSession(todos);
	milk.edit((row) => {
		row.fields.title = 'Buy oat milk';
	});
	await milk.settled();
	await pushMilk(
		session,
		'---\ntitle: Buy soy milk\ndone: false\n---\nOne carton.\n',
	);
	expect((await todos.sync()).error?.name).toBe('NeedsChoices');
	expect((await todos.sync()).error?.name).toBe('Failed');

	todos.cancelSync();
	expect(todos.syncAttempt).toBeUndefined();
	todoSession(todos).edit((row) => {
		row.fields.title = 'Buy rice milk';
	});
	expect(todoSession(todos).draft.fields.title).toBe('Buy rice milk');
	expect((await todoSession(todos).settled()).status).toBe('saved');
});

test('an open todo with a draft it could not save keeps it after Sync', async () => {
	const { todos, session } = await openDemo();
	await todos.open(MILK, 'todos');
	const milk = todoSession(todos);
	// Another program changes the file, so the next save is a conflict.
	expectOk(
		await todos.folder.files.overwrite(
			MILK,
			'---\ntitle: Buy milk today\ndone: false\n---\nOne carton.\n',
		),
	);
	milk.edit((row) => {
		row.fields.title = 'Buy goat milk';
	});
	expect((await milk.settled()).status).toBe('error');
	await pushMilk(
		session,
		'---\ntitle: Buy milk\ndone: true\n---\nOne carton.\n',
	);

	expect(expectOk(await todos.sync())).toMatchObject({ kind: 'synced' });
	const after = todoSession(todos);
	expect(after).toBe(milk);
	expect(after.draft.fields.title).toBe('Buy goat milk');
	expect(after.state).toMatchObject({
		status: 'error',
		error: { name: 'Conflict' },
	});
	expect(await run(session.bare, ['git', 'show', `main:${MILK}`])).toContain(
		'title: Buy milk today',
	);
});
