/**
 * Save Tests
 *
 * `table.save` writes an edit over the bytes it started from, and merges it
 * with another writer's newer file when the file changed (ADR-0548). The
 * folder here is opened by its own declaration, so every row is checked
 * against `epicenter.json`.
 *
 * Key behaviors:
 * - A save over the bytes the row was read from lands as it is
 * - Over a row another writer changed in a different field, both changes land
 * - Where both changed one field, the edit wins, the other writer's other
 *   fields survive, and the result names the value it replaced and the one
 *   it kept
 * - Body edits merge by line: neighboring lines both survive; where both
 *   changed the same lines the edit wins there, their other lines survive,
 *   and the result names their replaced lines and where the kept ones stand
 * - A capture with no row as read has no base: the edit wins wherever the
 *   two differ, and says so
 * - A row another writer deleted is `NotFound`, and not recreated
 * - Another writer's text that is not a row is `InvalidRow`, and kept
 * - A value the field does not admit is `InvalidValues`, and nothing is
 *   written
 * - `epicenter.json` keeps its bytes throughout
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openDataFolder } from './bun.js';
import type { AnyRow, FileTable, StoredRow } from './contract.js';

type AnyTable = FileTable<Record<string, unknown>>;
type StoredAnyRow = StoredRow<Record<string, unknown>>;

const author = { name: 'Folders', email: 'folders@localhost' };

/** Hand-written, so any rewrite would change its bytes. */
const DECLARED = `{"title":"Notes","kv":{"type":"object","properties":{}},"tables":{"notes":{"type":"object","properties":{"title":{"type":"string","x-field":{"kind":"string"}},"done":{"type":"boolean","x-field":{"kind":"boolean"}},"tags":{"type":"array","items":{"type":"string"},"x-field":{"kind":"tags"}}},"required":["title","done"]}}}`;

const ROW =
	'---\ntitle: One\ndone: false\ntags: [a]\n---\nfirst\nsecond\nthird\n';

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

/** A data folder with one row, opened by its own declaration. */
async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'folder-save-'));
	roots.push(root);
	await writeFile(join(root, 'epicenter.json'), DECLARED);
	await mkdir(join(root, 'notes'));
	await writeFile(join(root, 'notes/one.md'), ROW);
	const folder = expectOk(await openDataFolder({ root, git: { author } }));
	const table = folder.tables.notes as AnyTable;
	const read = async () => {
		const stored = expectOk(await table.get('one'));
		if (stored === undefined) throw new Error('the row is gone');
		return stored;
	};
	/** Another writer's save, which leaves `captured` stale. */
	const otherWriter = async (
		captured: StoredAnyRow,
		change: (row: AnyRow) => void,
	) => {
		const row = structuredClone(captured.row);
		change(row);
		return expectOk(await table.save(captured, row)).stored;
	};
	const declaration = () => readFile(join(root, 'epicenter.json'), 'utf8');
	return { root, folder, table, read, otherWriter, declaration };
}

/** `captured`'s row with `change` made to a copy. */
function edit(captured: StoredAnyRow, change: (row: AnyRow) => void) {
	const row = structuredClone(captured.row);
	change(row);
	return row;
}

test('a save over the row as read lands', async () => {
	const { folder, table, read, declaration } = await setup();
	const captured = await read();

	const saved = expectOk(
		await table.save(
			captured,
			edit(captured, (row) => {
				row.fields.title = 'Renamed';
			}),
		),
	);

	expect(saved).toMatchObject({ merged: false, replaced: [] });
	expect((await read()).row.fields).toEqual({
		title: 'Renamed',
		done: false,
		tags: ['a'],
	});
	expect(await declaration()).toBe(DECLARED);
	await folder.close();
});

test('another writer changed a different field: both changes land', async () => {
	const { folder, table, read, otherWriter, declaration } = await setup();
	const captured = await read();
	await otherWriter(captured, (row) => {
		row.fields.done = true;
	});

	const saved = expectOk(
		await table.save(
			captured,
			edit(captured, (row) => {
				row.fields.title = 'Mine';
			}),
		),
	);

	expect(saved).toMatchObject({ merged: true, replaced: [] });
	expect((await read()).row.fields).toEqual({
		title: 'Mine',
		done: true,
		tags: ['a'],
	});
	expect(await declaration()).toBe(DECLARED);
	await folder.close();
});

test('both changed one field: the edit wins, says what it replaced, and their other fields survive', async () => {
	const { folder, table, read, otherWriter } = await setup();
	const captured = await read();
	await otherWriter(captured, (row) => {
		row.fields.title = 'Theirs';
		row.fields.tags = ['a', 'b'];
	});

	const saved = expectOk(
		await table.save(
			captured,
			edit(captured, (row) => {
				row.fields.title = 'Mine';
			}),
		),
	);

	expect(saved).toMatchObject({
		merged: true,
		replaced: [
			{ kind: 'field', field: 'title', kept: 'Mine', theirs: 'Theirs' },
		],
	});
	expect((await read()).row.fields).toEqual({
		title: 'Mine',
		done: false,
		tags: ['a', 'b'],
	});
	await folder.close();
});

test('body edits to neighboring lines both survive', async () => {
	const { folder, table, read, otherWriter } = await setup();
	const captured = await read();
	await otherWriter(captured, (row) => {
		row.body = 'first\nSECOND (theirs)\nthird\n';
	});

	const saved = expectOk(
		await table.save(
			captured,
			edit(captured, (row) => {
				row.body = 'FIRST (mine)\nsecond\nthird\n';
			}),
		),
	);

	expect(saved).toMatchObject({ merged: true, replaced: [] });
	expect((await read()).row.body).toBe(
		'FIRST (mine)\nSECOND (theirs)\nthird\n',
	);
	await folder.close();
});

test('body edits to the same line: the edit wins there, and says where and what it replaced', async () => {
	const { folder, table, read, otherWriter } = await setup();
	const captured = await read();
	await otherWriter(captured, (row) => {
		row.body = 'ONE (theirs)\nsecond\nTHREE (theirs)\n';
		row.fields.done = true;
	});

	const saved = expectOk(
		await table.save(
			captured,
			edit(captured, (row) => {
				row.body = 'first\nsecond\nTHREE (mine)\n';
			}),
		),
	);

	expect(saved.replaced).toEqual([
		{
			kind: 'body',
			line: 2,
			kept: 'THREE (mine)\n',
			theirs: 'THREE (theirs)\n',
		},
	]);
	const stored = await read();
	expect(stored.row.body).toBe('ONE (theirs)\nsecond\nTHREE (mine)\n');
	expect(stored.row.fields.done).toBe(true);
	// What the result names is enough to put theirs back.
	const { line, kept, theirs } = saved.replaced[0] as Extract<
		(typeof saved.replaced)[number],
		{ kind: 'body' }
	>;
	const lines = stored.row.body.split(/(?<=\n)/);
	expect(lines.slice(line, line + 1).join('')).toBe(kept);
	lines.splice(line, 1, theirs);
	expect(lines.join('')).toBe('ONE (theirs)\nsecond\nTHREE (theirs)\n');
	await folder.close();
});

test('a capture with no row as read has no base: the edit wins where the two differ, and says so', async () => {
	const { folder, table, read, otherWriter } = await setup();
	const captured = await read();
	await otherWriter(captured, (row) => {
		row.fields.done = true;
	});

	const saved = expectOk(
		await table.save(
			{ path: captured.path, sha256: captured.sha256 },
			edit(captured, (row) => {
				row.fields.title = 'Mine';
			}),
		),
	);

	expect(saved.replaced).toEqual(
		expect.arrayContaining([
			{ kind: 'field', field: 'title', kept: 'Mine', theirs: 'One' },
			{ kind: 'field', field: 'done', kept: false, theirs: true },
		]),
	);
	expect((await read()).row.fields).toEqual({
		title: 'Mine',
		done: false,
		tags: ['a'],
	});
	await folder.close();
});

test('a row another writer deleted is NotFound, and not recreated', async () => {
	const { folder, table, read } = await setup();
	const captured = await read();
	expectOk(await table.delete(captured));

	const refused = expectErr(
		await table.save(
			captured,
			edit(captured, (row) => {
				row.fields.title = 'Mine';
			}),
		),
	);

	expect(refused.name).toBe('NotFound');
	expect(expectOk(await table.get('one'))).toBeUndefined();
	await folder.close();
});

test('another writer left text that is not a row: InvalidRow, and their text stays', async () => {
	const { root, folder, table, read } = await setup();
	const captured = await read();
	const broken = '---\ntitle: [unfinished\n---\n';
	await writeFile(join(root, 'notes/one.md'), broken);

	const refused = expectErr(
		await table.save(
			captured,
			edit(captured, (row) => {
				row.fields.title = 'Mine';
			}),
		),
	);

	expect(refused).toMatchObject({ name: 'InvalidRow', text: broken });
	expect(await readFile(join(root, 'notes/one.md'), 'utf8')).toBe(broken);
	await folder.close();
});

test('a value the field does not admit is InvalidValues, and nothing is written', async () => {
	const { folder, table, read, otherWriter } = await setup();
	const captured = await read();
	const theirs = await otherWriter(captured, (row) => {
		row.fields.tags = ['b'];
	});

	const refused = expectErr(
		await table.save(
			captured,
			edit(captured, (row) => {
				row.fields.done = 'yes';
			}),
		),
	);

	expect(refused.name).toBe('InvalidValues');
	expect((await read()).sha256).toBe(theirs.sha256);
	await folder.close();
});
