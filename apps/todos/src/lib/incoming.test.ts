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
 * - An interrupted sync leaves the files it wrote as changes (ADR-0545).
 *   Save version and editing go ahead, and the next Sync finishes it: the
 *   remote's content lands and the cache shows it
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterAll, afterEach, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseRow } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/browser';
import { $ } from 'bun';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	browserStorage,
	configureRemote,
	createTestStorage,
	opfsOf,
} from '../../../../packages/folder/src/browser-storage.test-support.js';
import {
	createGitHandler,
	type GitSession,
	prepareGitSession,
} from '../../../../packages/folder/src/git-demo-server.test-support.js';
import {
	GIT_ENV,
	git,
} from '../../../../packages/folder/src/git-http.test-support.js';
import { todosDefinition } from './definition.js';
import { cached, notesEditor, observe, quiet } from './query.test-support.js';
import type { Todos } from './todos.svelte.js';

const { createFolderContext } = await import('@epicenter/svelte/folder');

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

/**
 * A browser folder whose remote is a fresh demo session, opened by the app.
 * The returned `opfs` is the folder's stand-in storage, where a test injects
 * a fault.
 */
async function openDemo() {
	const session = await prepareGitSession({ name: 'todos', port: 5990 });
	const handle = await createGitHandler(session);
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
		handle(new Request(input, init))) as typeof fetch;
	const storage = createTestStorage();
	const id = `incoming-${count++}`;
	await configureRemote(storage, id, session.remoteUrl);
	const openTodos = async () => {
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
		const opened = createFolderContext(folder);
		const todos = createTodos(opened);
		const stop = observe(todos);
		cleanup.push(() => opened.close());
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
	await git(
		session.nativeCheckout,
		'pull',
		'--quiet',
		'--ff-only',
		session.bare,
		'main',
	);
}

/** The native checkout rewrites milk, adds bread, commits, and pushes. */
async function pushRemoteChanges(session: GitSession) {
	const native = session.nativeCheckout;
	await writeFile(join(native, MILK), MILK_REMOTE);
	await writeFile(join(native, BREAD), BREAD_REMOTE);
	await git(native, 'add', '-A');
	await git(native, 'commit', '--quiet', '-m', 'Edit elsewhere');
	await git(native, 'push', '--quiet', session.bare, 'main');
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

/**
 * A sync interrupted at the write of `todos/milk.md`: bread landed, milk did
 * not, and nothing records the update.
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
	notesEditor(todos, 'milk')('Three cartons.\n');
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
}, 60_000);

test('the remote-edit demo fixture pushes a hand edit that Sync brings in byte for byte', async () => {
	const { todos, session } = await openDemo();
	await shareMilk(todos, session);
	// The fixture pushes to the checkout's origin; here that is the bare path.
	await git(
		session.nativeCheckout,
		'remote',
		'set-url',
		'origin',
		session.bare,
	);
	const pushed =
		await $`bun scripts/remote-edit.ts ${session.nativeCheckout} milk ${'Buy oat milk'}`
			.cwd(join(import.meta.dir, '../..'))
			.env(GIT_ENV)
			.json();
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

test('an interrupted sync leaves changed files; Save version and editing go ahead, and the next Sync finishes it', async () => {
	const { todos, before, synced } = await interruptedSync();
	expect(expectErr(synced)).toMatchObject({ name: 'Publish', path: MILK });
	expect(await text(todos, MILK)).toBe(before);
	expect(await text(todos, BREAD)).toBe(BREAD_REMOTE);
	const status = expectOk(await todos.git.status.fetch());
	expect(status.changes).toEqual([{ path: BREAD, kind: 'add' }]);

	// Nothing is pending: editing and Save version go ahead.
	const created = expectOk(await todos.rows.create('Call mom'))!;
	await quiet(todos);
	const stem = created.path.slice('todos/'.length, -'.md'.length);
	notesEditor(todos, stem)('Today.\n');
	await quiet(todos);
	expect(expectOk(await todos.git.saveVersion()).status).toBe('committed');

	// The next Sync lands on the remote's content and keeps the local todo.
	expect(expectOk(await todos.sync.run())).toMatchObject({ kind: 'synced' });
	await quiet(todos);
	expect(await text(todos, MILK)).toBe(MILK_REMOTE);
	expect(await text(todos, BREAD)).toBe(BREAD_REMOTE);
	expect(await text(todos, created.path)).toContain('Today.');
	expect(cached(todos, 'milk').row.fields.title).toBe('Buy oat milk');
	expect(expectOk(await todos.git.status.fetch()).changes).toEqual([]);
}, 60_000);
