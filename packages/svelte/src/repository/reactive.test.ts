/**
 * Reactive Repository Tests
 *
 * `reactive(repo)` over a repository on a replica in this process: each
 * read re-runs only when what it read changed.
 *
 * Key behaviors:
 * - A collection's reads re-run when that collection's notes change, not another's
 * - `status()` re-runs when the status changes; `revision()` after any change, for SQL reads
 * - An editor's draft and state are tracked
 */
import '../svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import { defineApp, openLocalRepository } from '@epicenter/repository/api';
import { openBunSqlite } from '@epicenter/repository/bun';
import { openReplica } from '@epicenter/repository/client';
import { Type } from 'typebox';
import { unwrap } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';

const { reactive, tracked } = await import('./index.js');
const { follow } = await import('../reactive.test-support.svelte.js');
const { flushSync } = await import('svelte');

const app = defineApp({
	todos: { path: 'todos/{stem}.md', schema: Type.Object({ title: Type.String() }) },
	folders: { path: 'folders/{stem}.md', schema: Type.Object({ name: Type.String() }) },
	entries: { path: 'journal/{stem}.md', schema: Type.Object({ title: Type.String() }), memory: false },
});
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function open() {
	const replica = unwrap(openReplica({ driver: openBunSqlite(), binding: { repository: 'r', server: null, account: null }, device: 'd', app, after: () => {}, now: () => 0 }));
	return reactive(openLocalRepository({ app, replica }));
}

test("a collection's reads re-run when its notes change, and not when another's do", async () => {
	const repo = open();
	const todos = follow(() => repo.todos.all().map((todo) => todo.fields.title));
	const folders = follow(() => repo.folders.all().length);
	const status = follow(() => repo.status().status);
	await settled();
	flushSync();
	expect(status.values).toEqual(['opening', 'open']);
	const foldersRuns = folders.values.length;
	expectOk(await repo.todos.create({ stem: 'milk' }, { fields: { title: 'Milk' } }));
	await settled();
	flushSync();
	expect(todos.values.at(-1)).toEqual(['Milk']);
	expect(folders.values).toHaveLength(foldersRuns);
	for (const run of [todos, folders, status]) run.stop();
});

test('revision() re-runs after any change, so a SQL read follows a collection kept out of memory', async () => {
	const repo = open();
	await settled();
	const revisions = follow(() => repo.revision());
	flushSync();
	expectOk(await repo.entries.create({ stem: '2026-01-01' }, { fields: { title: 'New year' } }));
	await settled();
	flushSync();
	expect(revisions.values.length).toBeGreaterThan(1);
	expect(expectOk(await repo.query('SELECT stem FROM entries'))).toEqual([{ stem: '2026-01-01' }]);
	revisions.stop();
});

test("an editor's draft and state are tracked", async () => {
	const repo = open();
	await settled();
	expectOk(await repo.todos.create({ stem: 'milk' }, { fields: { title: 'Milk' }, body: 'one\n' }));
	const editor = tracked(expectOk(await repo.todos.openEditor({ stem: 'milk' })));
	const drafts = follow(() => `${editor.state.status}:${editor.draft}`);
	flushSync();
	editor.editor.update('one two\n');
	flushSync();
	await settled();
	flushSync();
	// What a view shows, run by run (a re-run that reads the same value shows nothing new).
	expect(drafts.values.filter((value, index) => value !== drafts.values[index - 1])).toEqual(['saved:one\n', 'saving:one two\n', 'saved:one two\n']);
	expect(repo.todos.get({ stem: 'milk' })?.body).toBe('one two\n');
	drafts.stop();
	expectOk(await editor.editor.close());
});
