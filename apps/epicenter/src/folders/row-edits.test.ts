/**
 * Row Edit Tests
 *
 * The Folders window saves each edit against the row as it stood when the
 * person began the edit, so a read that lands while they edit cannot turn
 * another window's change into the base the edit silently replaces.
 *
 * Key behaviors:
 * - A refresh between edit start and save still merges against the
 *   edit-start row: their body lines survive beside this edit's
 * - Where both changed one field, this edit wins and the outcome names
 *   their value, even though the grid already showed it
 * - An edit begun before this window's own earlier save landed is saved
 *   over that save, with no merge reported
 * - A take forgets its begin
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PreparedFolderTable } from '@epicenter/folder';
import { openDataFolder } from '@epicenter/folder/bun';
import { expectOk } from 'wellcrafted/testing';
import { createRowEdits, editedRow, type RowEdit } from './row-edits';
import { type AnyTable, type StoredAnyRow, saveRow } from './save-row';

const author = { name: 'Folders', email: 'folders@localhost' };

const DECLARED = `{"title":"Notes","kv":{"type":"object","properties":{}},"tables":{"notes":{"type":"object","properties":{"title":{"type":"string","x-field":{"kind":"string"}},"done":{"type":"boolean","x-field":{"kind":"boolean"}}},"required":["title","done"]}}}`;

const ROW = '---\ntitle: One\ndone: false\n---\none\ntwo\nthree\nfour\nfive\n';

const originalEnv = { ...process.env };
const roots: string[] = [];
beforeAll(() => {
	Object.assign(process.env, {
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_CONFIG_NOSYSTEM: '1',
	});
});
afterAll(async () => {
	for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'])
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	await Promise.all(roots.map((root) => rm(root, { recursive: true })));
});

async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'folders-row-edits-'));
	roots.push(root);
	await writeFile(join(root, 'epicenter.json'), DECLARED);
	await mkdir(join(root, 'notes'));
	await writeFile(join(root, 'notes/one.md'), ROW);
	const folder = expectOk(await openDataFolder({ root, git: { author } }));
	const table = folder.tables.notes as AnyTable;
	const prepared = folder.definition.tables.notes as PreparedFolderTable;
	/** What the grid shows after a read: the row as it is now. */
	const refresh = async () => {
		const stored = expectOk(await table.get('one'));
		if (stored === undefined) throw new Error('the row is gone');
		return stored;
	};
	/** Another window's save over the row it read. */
	const otherWindow = async (change: (row: StoredAnyRow['row']) => void) => {
		const theirs = await refresh();
		const row = structuredClone(theirs.row);
		change(row);
		expectOk(await table.replace(theirs, row));
	};
	const edits = createRowEdits();
	/** Save `edit` as the Folders window does: from its begin, over this window's latest save. */
	const save = async (start: StoredAnyRow, edit: RowEdit) => {
		const base = edits.latest(start);
		const outcome = await saveRow({
			table,
			prepared,
			captured: base,
			edited: await editedRow(start, base, edit),
		});
		if (outcome.kind !== 'failed') edits.saved(base, outcome.stored);
		return outcome;
	};
	return { folder, edits, refresh, otherWindow, save };
}

test('a refresh between edit start and save still merges against the edit-start row', async () => {
	const { folder, edits, refresh, otherWindow, save } = await setup();
	// The person focuses the body box.
	edits.begin('notes', 'one', { kind: 'body' }, await refresh());
	await otherWindow((row) => {
		row.body = 'ONE (theirs)\ntwo\nthree\nfour\nfive\n';
	});
	// A focus or a file hint reads the row again; the grid now shows theirs.
	expect((await refresh()).row.body).toStartWith('ONE (theirs)');
	// The box still holds what the person typed over the row they began with.
	const start = edits.take('notes', 'one', { kind: 'body' });
	if (start === undefined) throw new Error('no begin was recorded');

	const outcome = await save(start, {
		kind: 'body',
		text: 'one\ntwo\nthree\nfour\nFIVE (mine)\n',
	});

	expect(outcome).toMatchObject({ kind: 'merged', replaced: [] });
	expect((await refresh()).row.body).toBe(
		'ONE (theirs)\ntwo\nthree\nfour\nFIVE (mine)\n',
	);
	await folder.close();
});

test('both changed one field during the edit: this edit wins and their value is named', async () => {
	const { folder, edits, refresh, otherWindow, save } = await setup();
	edits.begin(
		'notes',
		'one',
		{ kind: 'field', field: 'title' },
		await refresh(),
	);
	await otherWindow((row) => {
		row.fields.title = 'Theirs';
		row.fields.done = true;
	});
	await refresh();
	const start = edits.take('notes', 'one', { kind: 'field', field: 'title' });
	if (start === undefined) throw new Error('no begin was recorded');

	const outcome = await save(start, {
		kind: 'field',
		field: 'title',
		change: { kind: 'set', value: 'Mine' },
	});

	expect(outcome).toMatchObject({
		kind: 'merged',
		replaced: [{ kind: 'field', field: 'title', theirs: 'Theirs' }],
	});
	expect((await refresh()).row.fields).toEqual({ title: 'Mine', done: true });
	await folder.close();
});

test("an edit begun before this window's earlier save landed is saved over it, with no merge", async () => {
	const { folder, edits, refresh, save } = await setup();
	const shown = await refresh();
	// Two edits begin over the same row before either saves.
	edits.begin('notes', 'one', { kind: 'field', field: 'title' }, shown);
	edits.begin('notes', 'one', { kind: 'body' }, shown);
	const titleStart = edits.take('notes', 'one', {
		kind: 'field',
		field: 'title',
	});
	const bodyStart = edits.take('notes', 'one', { kind: 'body' });
	if (titleStart === undefined || bodyStart === undefined)
		throw new Error('no begin was recorded');

	const first = await save(titleStart, {
		kind: 'field',
		field: 'title',
		change: { kind: 'set', value: 'Mine' },
	});
	const second = await save(bodyStart, {
		kind: 'body',
		text: 'one\ntwo\nthree\nfour\nfive\nsix\n',
	});

	expect(first.kind).toBe('saved');
	expect(second.kind).toBe('saved');
	const stored = await refresh();
	expect(stored.row.fields.title).toBe('Mine');
	expect(stored.row.body).toBe('one\ntwo\nthree\nfour\nfive\nsix\n');
	await folder.close();
});

test('a take forgets its begin', async () => {
	const { folder, edits, refresh } = await setup();
	edits.begin('notes', 'one', { kind: 'body' }, await refresh());
	expect(edits.take('notes', 'one', { kind: 'body' })).toBeDefined();
	expect(edits.take('notes', 'one', { kind: 'body' })).toBeUndefined();
	await folder.close();
});
