/**
 * Incoming Update Tests
 *
 * Drives the real Todos store against a production browser folder whose
 * remote is the demo's real Git target: a bare repository served by
 * `git http-backend`, and an ordinary native checkout that commits and
 * pushes with system Git. The folder runs on the in-memory OPFS stand-in,
 * so a sync can be interrupted at one file write, leaving what a closed tab
 * would.
 *
 * Key behaviors:
 * - Sync brings remote content in byte for byte, frontmatter the app does
 *   not declare and comments included; the cache shows it after the sync,
 *   and an edit writes the standard form and keeps the undeclared keys
 * - An interrupted sync is reported and never resumed: reads and reopening
 *   only read it. Sync and Save version wait; editing continues
 * - Recovery runs only when asked. A path in neither state is named,
 *   nothing is written, and the update stays pending until the file holds
 *   one of its versions; then recovery finishes and the cache shows it
 * - Recovery waits for queued writes before it runs
 */
import './svelte-modules.test-support.js';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseRow } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/browser';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	browserStorage,
	createTestStorage,
	opfsOf,
} from '../../../../packages/folder/src/browser-storage.test-support.js';
import {
	createGitHandler,
	type GitSession,
	prepareGitSession,
} from '../../server/git-server.js';
import { todosDefinition } from './definition.js';
import {
	cached,
	observe,
	quiet,
	rowEditor,
	shown,
} from './query.test-support.js';
import {
	INCOMING_WAITS,
	incomingLine,
	recoveryLine,
	syncOutcomeLine,
} from './status.js';
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

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

let count = 0;
const MILK = 'todos/milk.md';
const BREAD = 'todos/bread.md';
/** The row as another computer rewrote it: a comment, and keys Todos does not declare. */
const MILK_REMOTE = `---
# Edited on another computer
title: Buy oat milk
done: true
owner: sam
labels: [home, weekly]
---
Two cartons.
`;
const BREAD_REMOTE = '---\ntitle: Bake bread\ndone: false\n---\n';

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

/**
 * A browser folder whose remote is a fresh demo session, opened by the app.
 * The returned `opfs` is the folder's stand-in storage, where a test injects
 * a fault.
 */
async function openDemo() {
	const session = await prepareGitSession(5990);
	const handle = await createGitHandler(session);
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
		handle(new Request(input, init))) as typeof fetch;
	const storage = createTestStorage();
	const id = `incoming-${count++}`;
	const openTodos = async () => {
		const folder = expectOk(
			await openFolder({
				id,
				definition: todosDefinition,
				browser: {
					author: { name: 'Todos', email: 'todos@localhost' },
					remote: { url: session.remoteUrl, branch: 'main' },
					...browserStorage(storage),
				},
			}),
		);
		const todos = createTodos(folder);
		const stop = observe(todos);
		cleanup.push(() => todos.close());
		cleanup.push(stop);
		await quiet(todos);
		return todos;
	};
	return {
		session,
		opfs: opfsOf(storage),
		openTodos,
		todos: await openTodos(),
	};
}

/** The app creates a milk todo and syncs it; the native checkout pulls it. */
async function shareMilk(todos: Todos, session: GitSession) {
	expectOk(
		await todos.folder.tables.todos.create(
			{ fields: { title: 'Buy milk', done: false }, body: '' },
			{ stem: 'milk' },
		),
	);
	await todos.refresh();
	await quiet(todos);
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
}

/** The native checkout rewrites milk, adds bread, commits, and pushes. */
async function pushRemoteChanges(session: GitSession) {
	const native = session.nativeCheckout;
	await writeFile(join(native, MILK), MILK_REMOTE);
	await writeFile(join(native, BREAD), BREAD_REMOTE);
	await run(native, ['git', 'add', '-A']);
	await run(native, ['git', 'commit', '--quiet', '-m', 'Edit elsewhere']);
	await run(native, ['git', 'push', '--quiet', session.bare, 'main']);
}

async function text(todos: Todos, path: string) {
	const read = await todos.folder.files.read(path);
	return read.error ? undefined : new TextDecoder().decode(read.data.bytes);
}

/** A row with the keys the app does not declare in view. */
type AnyRow = { fields: Record<string, unknown>; body: string };

/** The row `text` reads as, undeclared keys included. */
function rowOf(text: string): AnyRow {
	return expectOk(parseRow(todosDefinition.tables.todos, text));
}

const noted =
	(body: string) =>
	<T extends { body: string }>(row: T): T => ({ ...row, body });

/**
 * A sync interrupted at the write of `todos/milk.md`: bread may have landed,
 * milk did not, and the update is pending.
 */
async function interruptedSync() {
	const demo = await openDemo();
	const { todos, session, opfs } = demo;
	await shareMilk(todos, session);
	const before = (await text(todos, MILK))!;
	await pushRemoteChanges(session);
	let failed = false;
	opfs.faults.write = (path) => {
		if (failed || !path.endsWith(`/${MILK}`)) return undefined;
		failed = true;
		return 'fail';
	};
	const synced = await todos.sync.run();
	opfs.faults.write = undefined;
	await quiet(todos);
	return { ...demo, before, synced };
}

test('a sync brings remote changes in byte for byte, the cache shows them, and an edit keeps the undeclared keys', async () => {
	const { todos, session } = await openDemo();
	await shareMilk(todos, session);
	expect(cached(todos, 'milk').row.fields.title).toBe('Buy milk');
	await pushRemoteChanges(session);

	expect(expectOk(await todos.sync.run())).toMatchObject({ kind: 'synced' });
	await quiet(todos);
	expect(await text(todos, MILK)).toBe(MILK_REMOTE);
	expect(await text(todos, BREAD)).toBe(BREAD_REMOTE);
	expect(cached(todos, 'milk').row as AnyRow).toEqual({
		fields: {
			title: 'Buy oat milk',
			done: true,
			owner: 'sam',
			labels: ['home', 'weekly'],
		},
		body: 'Two cartons.\n',
	});
	expect(cached(todos, 'bread').row.fields.title).toBe('Bake bread');

	// A write saves the standard form, and the undeclared keys stay.
	rowEditor(todos, 'milk')(noted('Three cartons.\n'));
	await quiet(todos);
	expect(rowOf((await text(todos, MILK))!)).toEqual({
		fields: {
			title: 'Buy oat milk',
			done: true,
			owner: 'sam',
			labels: ['home', 'weekly'],
		},
		body: 'Three cartons.\n',
	});
	expect(incomingLine(todos.git.snapshot)).toBeUndefined();
}, 60_000);

test('the remote-edit demo fixture pushes a hand edit that Sync brings in byte for byte', async () => {
	const { todos, session } = await openDemo();
	await shareMilk(todos, session);
	// The fixture pushes to the checkout's origin; here that is the bare path.
	await run(session.nativeCheckout, [
		'git',
		'remote',
		'set-url',
		'origin',
		session.bare,
	]);
	const pushed = JSON.parse(
		await run(join(import.meta.dir, '../..'), [
			'bun',
			'scripts/remote-edit.ts',
			session.nativeCheckout,
			'milk',
			'Buy oat milk',
		]),
	);
	expect(pushed.path).toBe(MILK);
	expect(pushed.source).toContain('owner: sam');

	expect(expectOk(await todos.sync.run())).toMatchObject({ kind: 'synced' });
	await quiet(todos);
	expect(await text(todos, MILK)).toBe(pushed.source);
	expect(cached(todos, 'milk').row.fields).toMatchObject({
		title: 'Buy oat milk',
		done: true,
	});
}, 60_000);

test('an interrupted sync is reported and never resumed: Sync and Save version wait, editing continues, and reopening only reads it', async () => {
	const { todos, opfs, before, synced, openTodos } = await interruptedSync();
	expect(expectErr(synced)).toMatchObject({
		name: 'Merge',
		error: { name: 'Partial' },
	});
	const pending = todos.git.snapshot.pendingIncoming;
	expect(pending?.state).toBe('recorded');
	expect(incomingLine(todos.git.snapshot)).toMatchObject({
		label: 'Incoming update not finished',
		tone: 'error',
	});
	expect(await text(todos, MILK)).toBe(before);

	// History waits; the folder says so, and nothing is changed.
	expect(expectOk(await todos.git.saveVersion()).status).toBe('blocked');
	const waits = await todos.sync.run();
	expect(expectErr(waits)).toMatchObject({
		name: 'Checkpoint',
		outcome: { status: 'blocked' },
	});
	expect(syncOutcomeLine(waits, todos.git.snapshot)).toMatchObject({
		label: 'Sync waits',
		detail: INCOMING_WAITS,
	});
	expect(await text(todos, MILK)).toBe(before);

	// Editing continues.
	const created = expectOk(await todos.rows.create('Call mom'));
	await quiet(todos);
	const stem = created.path.slice('todos/'.length, -'.md'.length);
	rowEditor(todos, stem)(noted('Today.\n'));
	await quiet(todos);
	expect(await text(todos, created.path)).toContain('Today.');

	// Reads only read the record; they resume nothing.
	await todos.queryClient.invalidateQueries({ queryKey: ['todos'] });
	await quiet(todos);
	expect(todos.git.snapshot.pendingIncoming).toEqual(pending);
	expect(await text(todos, MILK)).toBe(before);

	// Reopening the folder reads the same record and resumes nothing.
	const files = [...opfs.files()].length;
	await todos.close();
	const again = await openTodos();
	for (
		let tries = 0;
		tries < 50 && !again.git.snapshot.pendingIncoming;
		tries++
	)
		await Bun.sleep(5);
	expect(again.git.snapshot.pendingIncoming).toEqual(pending);
	expect(await text(again, MILK)).toBe(before);
	expect([...opfs.files()].length).toBe(files);
}, 60_000);

test('recovery names a path in neither state and writes nothing, until the file holds one of its versions; then it finishes and the cache shows it', async () => {
	const { todos, before } = await interruptedSync();
	const pending = todos.git.snapshot.pendingIncoming;
	expect(pending?.state).toBe('recorded');

	// Milk is still at its before state; the person edits it to a third one.
	rowEditor(todos, 'milk')(noted('My own note.\n'));
	await quiet(todos);
	const third = (await text(todos, MILK))!;

	const refused = await todos.git.recoverIncoming();
	expect(refused).toMatchObject({
		error: { name: 'RecoveryRefused', paths: [MILK] },
	});
	const line = recoveryLine(refused);
	expect(line.label).toBe('Incoming update not recovered');
	expect(line.detail).toContain(MILK);
	expect(todos.git.snapshot.pendingIncoming).toEqual(pending);
	expect(await text(todos, MILK)).toBe(third);

	// The person makes it hold the version from before the update, with
	// another program, and returns to Todos.
	expectOk(await todos.folder.files.overwrite(MILK, before));
	await todos.refresh();
	await quiet(todos);
	expect(await text(todos, MILK)).toBe(before);

	// Now the update finishes, and every view reads what it wrote.
	const recovered = await todos.git.recoverIncoming();
	expect(recovered).toMatchObject({ data: { status: 'completed' } });
	await quiet(todos);
	expect(todos.git.snapshot.pendingIncoming).toBeUndefined();
	expect(await text(todos, MILK)).toBe(MILK_REMOTE);
	expect(cached(todos, 'milk').row.fields.title).toBe('Buy oat milk');
	expect(incomingLine(todos.git.snapshot)).toBeUndefined();
	// History continues.
	expect(expectOk(await todos.git.saveVersion()).status).not.toBe('blocked');
}, 60_000);

test('recovery waits for queued writes before it runs', async () => {
	const { todos } = await interruptedSync();
	const created = expectOk(await todos.rows.create('Call mom'));
	await quiet(todos);
	const stem = created.path.slice('todos/'.length, -'.md'.length);
	// The next write of a row is held until the test lets it go.
	const table = todos.folder.tables.todos;
	const replace = table.replace;
	const gate = Promise.withResolvers<void>();
	const order: string[] = [];
	table.replace = async (...args) => {
		await gate.promise;
		const written = await replace(...args);
		order.push('written');
		return written;
	};
	rowEditor(todos, stem)(noted('Today.\n'));
	const recovering = todos.git.recoverIncoming().then((recovered) => {
		order.push('recovered');
		return recovered;
	});
	await Bun.sleep(20);
	expect(order).toEqual([]);

	gate.resolve();
	expect(await recovering).toMatchObject({ data: { status: 'completed' } });
	table.replace = replace;
	expect(order).toEqual(['written', 'recovered']);
	expect(await text(todos, created.path)).toContain('Today.');
	expect(await text(todos, MILK)).toBe(MILK_REMOTE);
}, 60_000);
