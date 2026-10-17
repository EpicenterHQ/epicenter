/**
 * Row Write Tests
 *
 * A table's `write` and `set` merge their change into the row as its file
 * holds it now (ADR-0576), over a real directory in Bun. The folder here is
 * opened by its own declaration, so every row is checked against
 * `epicenter.json`.
 *
 * Key behaviors:
 * - A write over the row as read lands as it is
 * - Over a row another writer changed in a different field, both changes land
 * - Where both changed one field, the write wins, and the other writer's
 *   other fields survive
 * - Body edits merge by line: neighboring lines both survive; where both
 *   changed the same lines the write wins there, and their other lines and
 *   fields survive
 * - Another writer's text that is not a row merges by line, and a result
 *   that is not a row is written for repair and answered as the file it is
 * - A value the field does not admit is `InvalidValues`, and nothing is
 *   written
 * - `epicenter.json` keeps its bytes throughout
 * - A `set` sets fields of the row as it is now: a field another writer
 *   changed between its read and its write survives, `set` wins the field
 *   it names, a field set to `undefined` is removed, and a row that is not
 *   there is not made
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openFolder } from './bun.js';
import type { FileTable, StoredRow } from './contract.js';
import type { AnyRow } from './row-merge.js';

type AnyTable = FileTable<Record<string, unknown>>;
type StoredAnyRow = StoredRow<Record<string, unknown>>;

const author = { name: 'Folders', email: 'folders@localhost' };

/** Hand-written, so any rewrite would change its bytes. */
const DECLARED = `{"title":"Notes","tables":{"notes":{"type":"object","properties":{"title":{"type":"string","x-field":{"kind":"string"}},"done":{"type":"boolean","x-field":{"kind":"boolean"}},"tags":{"type":"array","items":{"type":"string"},"x-field":{"kind":"tags"}}},"required":["title","done"]}}}`;

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
	const root = await mkdtemp(join(tmpdir(), 'folder-row-writes-'));
	roots.push(root);
	await writeFile(join(root, 'epicenter.json'), DECLARED);
	await mkdir(join(root, 'notes'));
	await writeFile(join(root, 'notes/one.md'), ROW);
	const folder = expectOk(await openFolder({ root, git: { author } }));
	const table = folder.tables.notes as AnyTable;
	const read = async () => {
		const stored = expectOk(await table.get('one'));
		if (stored === undefined) throw new Error('the row is gone');
		return stored;
	};
	/** Another writer's write, which leaves `captured` behind the file. */
	const otherWriter = async (
		captured: StoredAnyRow,
		change: (row: AnyRow) => void,
	) => {
		expectOk(await table.write('one', captured.row, edit(captured, change)));
		return read();
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

/** Write `change` of `captured`'s row into the row as it is now. */
const writeEdit = (
	table: AnyTable,
	captured: StoredAnyRow,
	change: (row: AnyRow) => void,
) => table.write('one', captured.row, edit(captured, change));

test('a write over the row as read lands', async () => {
	const { folder, table, read, declaration } = await setup();
	const captured = await read();

	expectOk(
		await writeEdit(table, captured, (row) => {
			row.fields.title = 'Renamed';
		}),
	);

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

	expectOk(
		await writeEdit(table, captured, (row) => {
			row.fields.title = 'Mine';
		}),
	);

	expect((await read()).row.fields).toEqual({
		title: 'Mine',
		done: true,
		tags: ['a'],
	});
	expect(await declaration()).toBe(DECLARED);
	await folder.close();
});

test('both changed one field: the write wins, and their other fields survive', async () => {
	const { folder, table, read, otherWriter } = await setup();
	const captured = await read();
	await otherWriter(captured, (row) => {
		row.fields.title = 'Theirs';
		row.fields.tags = ['a', 'b'];
	});

	expectOk(
		await writeEdit(table, captured, (row) => {
			row.fields.title = 'Mine';
		}),
	);

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

	expectOk(
		await writeEdit(table, captured, (row) => {
			row.body = 'FIRST (mine)\nsecond\nthird\n';
		}),
	);

	expect((await read()).row.body).toBe(
		'FIRST (mine)\nSECOND (theirs)\nthird\n',
	);
	await folder.close();
});

test('body edits to the same line: the write wins there, and their other lines and fields survive', async () => {
	const { folder, table, read, otherWriter } = await setup();
	const captured = await read();
	await otherWriter(captured, (row) => {
		row.body = 'ONE (theirs)\nsecond\nTHREE (theirs)\n';
		row.fields.done = true;
	});

	expectOk(
		await writeEdit(table, captured, (row) => {
			row.body = 'first\nsecond\nTHREE (mine)\n';
		}),
	);

	const stored = await read();
	expect(stored.row.body).toBe('ONE (theirs)\nsecond\nTHREE (mine)\n');
	expect(stored.row.fields.done).toBe(true);
	await folder.close();
});

test('another writer left text that is not a row: it merges by line, and a result that is not a row is left to repair', async () => {
	const { root, folder, table, read } = await setup();
	const captured = await read();
	const broken =
		'--- broken\ntitle: One\ndone: false\ntags: [a]\n---\nfirst\nsecond\nthird\n';
	await writeFile(join(root, 'notes/one.md'), broken);

	const written = expectOk(
		await writeEdit(table, captured, (row) => {
			row.body = 'first\nsecond\nthird\nfourth\n';
		}),
	);

	const text = await readFile(join(root, 'notes/one.md'), 'utf8');
	expect(written).toMatchObject({ name: 'InvalidRow', text });
	expect(text.startsWith('--- broken\n')).toBe(true);
	expect(text.endsWith('third\nfourth\n')).toBe(true);
	await folder.close();
});

test('a value the field does not admit is InvalidValues, and nothing is written', async () => {
	const { folder, table, read, otherWriter } = await setup();
	const captured = await read();
	const theirs = await otherWriter(captured, (row) => {
		row.fields.tags = ['b'];
	});

	const refused = expectErr(
		await writeEdit(table, captured, (row) => {
			row.fields.done = 'yes';
		}),
	);

	expect(refused.name).toBe('InvalidValues');
	expect((await read()).sha256).toBe(theirs.sha256);
	await folder.close();
});

/**
 * Another writer saves `texts[n]` right after the set's read number `n`,
 * before its write, for as many reads as there are texts.
 */
function writeAfterReads(table: AnyTable, root: string, texts: string[]) {
	const read = table.get;
	let reads = 0;
	table.get = async (stem) => {
		const result = await read(stem);
		const text = texts[reads++];
		if (text !== undefined) await writeFile(join(root, 'notes/one.md'), text);
		return result;
	};
}

test('a set over a change to another field made between its read and its write keeps both', async () => {
	const { root, folder, table, read } = await setup();
	writeAfterReads(table, root, [ROW.replace('done: false', 'done: true')]);

	expectOk(await table.set('one', { title: 'Mine' }));

	expect((await read()).row).toEqual({
		fields: { title: 'Mine', done: true, tags: ['a'] },
		body: 'first\nsecond\nthird\n',
	});
	await folder.close();
});

test('a set and another writer set one field: the set wins', async () => {
	const { root, folder, table, read } = await setup();
	writeAfterReads(table, root, [
		ROW.replace('title: One', 'title: Theirs').replace(
			'tags: [a]',
			'tags: [a, b]',
		),
	]);

	expectOk(await table.set('one', { title: 'Mine' }));

	expect((await read()).row.fields).toEqual({
		title: 'Mine',
		done: false,
		tags: ['a', 'b'],
	});
	await folder.close();
});

test('a set of a field to undefined removes it and keeps the body', async () => {
	const { folder, table, read } = await setup();

	expectOk(await table.set('one', { tags: undefined }));

	expect((await read()).row).toEqual({
		fields: { title: 'One', done: false },
		body: 'first\nsecond\nthird\n',
	});
	await folder.close();
});

test('a set where no row is makes none', async () => {
	const { root, folder, table } = await setup();

	expect(expectOk(await table.set('two', { title: 'Two' }))).toBeNull();

	expect(
		await readFile(join(root, 'notes/two.md'), 'utf8').catch(() => null),
	).toBe(null);
	await folder.close();
});

test('a set to a value the field does not admit is InvalidValues, and nothing is written', async () => {
	const { folder, table, read } = await setup();
	const before = await read();

	const refused = expectErr(await table.set('one', { done: 'yes' }));

	expect(refused.name).toBe('InvalidValues');
	expect((await read()).sha256).toBe(before.sha256);
	await folder.close();
});
