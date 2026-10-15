/**
 * Save Tests
 *
 * `table.save` writes an edit over the bytes it started from, and merges it
 * with another writer's newer file when the file changed (ADR-0551). The
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
 *   and the result names the body with theirs winning there, which
 *   `restoreTheirs` saves back
 * - A capture without the content it names is `UnknownBase`, and nothing is
 *   written
 * - A row another writer deleted is `NotFound`, and not recreated
 * - Another writer's text that is not a row merges by line; a merge that
 *   does not read as a row is `InvalidRow`, and their text stays
 * - `{ merge: false }` answers `Conflict` instead of merging
 * - A value the field does not admit is `InvalidValues`, and nothing is
 *   written
 * - `epicenter.json` keeps its bytes throughout
 * - An update sets and unsets fields of the row as it is now: a field
 *   another writer changed between its read and its write survives, because
 *   the update tries again on their row; the update wins the field it set
 *   and replaces nothing; an unset field is removed; a missing row is
 *   `NotFound`; a value the field does not admit is `InvalidValues`; and a
 *   row that changes on every attempt is `KeptChanging`
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openDataFolder } from './bun.js';
import {
	type AnyRow,
	type FileTable,
	restoreTheirs,
	type StoredRow,
	WRITE_ATTEMPTS,
} from './contract.js';

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

test('body edits to the same line: the edit wins there, says what it replaced, and theirs can be restored', async () => {
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
			kind: 'text',
			part: 'body',
			kept: 'ONE (theirs)\nsecond\nTHREE (mine)\n',
			// Theirs winning where both changed, with the edit's other lines.
			theirs: 'ONE (theirs)\nsecond\nTHREE (theirs)\n',
			regions: [
				{ line: 2, kept: 'THREE (mine)\n', theirs: 'THREE (theirs)\n' },
			],
		},
	]);
	const stored = await read();
	expect(stored.row.body).toBe('ONE (theirs)\nsecond\nTHREE (mine)\n');
	expect(stored.row.fields.done).toBe(true);
	// What the result names is enough to put theirs back, in one save.
	const restore = restoreTheirs(saved);
	expect(restore.base).toBe(saved.stored);
	const restored = expectOk(await table.save(restore.base, restore.row));
	expect(restored).toMatchObject({ merged: false, replaced: [] });
	expect((await read()).row.body).toBe(
		'ONE (theirs)\nsecond\nTHREE (theirs)\n',
	);
	await folder.close();
});

test('a capture without the content it names is UnknownBase, and nothing is written', async () => {
	const { folder, table, read } = await setup();
	const captured = await read();
	const row = edit(captured, (row) => {
		row.fields.title = 'Mine';
	});

	for (const base of [
		{ path: captured.path, sha256: captured.sha256 },
		{ ...captured, text: `${captured.text}edited in place` },
	])
		expect(
			expectErr(await table.save(base as StoredAnyRow, row)),
		).toMatchObject({ name: 'UnknownBase', path: captured.path });
	expect((await read()).sha256).toBe(captured.sha256);
	await folder.close();
});

test('an unmerged save of a row another writer changed is Conflict', async () => {
	const { folder, table, read, otherWriter } = await setup();
	const captured = await read();
	const theirs = await otherWriter(captured, (row) => {
		row.fields.done = true;
	});

	const refused = expectErr(
		await table.save(
			captured,
			edit(captured, (row) => {
				row.fields.title = 'Mine';
			}),
			{ merge: false },
		),
	);

	expect(refused).toMatchObject({
		name: 'Conflict',
		expectedSha256: captured.sha256,
		actualSha256: theirs.sha256,
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

test('another writer left text that is not a row: it merges by line', async () => {
	const { root, folder, table, read } = await setup();
	const captured = await read();
	// Their lines compete with the edit's title, which wins there.
	await writeFile(
		join(root, 'notes/one.md'),
		'---\ntitle: [unfinished\n---\nfirst\nsecond\nthird\n',
	);

	const saved = expectOk(
		await table.save(
			captured,
			edit(captured, (row) => {
				row.fields.title = 'Mine';
			}),
		),
	);

	expect(saved.merged).toBe(true);
	expect(saved.replaced).toMatchObject([{ kind: 'text', part: 'file' }]);
	expect(saved.stored.row.fields).toEqual({
		title: 'Mine',
		done: false,
		tags: ['a'],
	});
	await folder.close();
});

test('a merge with text that is not a row that does not read as one: InvalidRow, and their text stays', async () => {
	const { root, folder, table, read } = await setup();
	const captured = await read();
	// Their broken opening fence does not compete with the edit's title.
	const broken =
		'--- broken\ntitle: One\ndone: false\ntags: [a]\n---\nfirst\nsecond\nthird\n';
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

/**
 * Another writer saves `texts[n]` right after the update's read number `n`,
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

test('an update over a change to another field made between its read and its write keeps both', async () => {
	const { root, folder, table, read } = await setup();
	writeAfterReads(table, root, [ROW.replace('done: false', 'done: true')]);

	const saved = expectOk(await table.update('one', { set: { title: 'Mine' } }));

	expect(saved).toMatchObject({ merged: false, replaced: [] });
	expect((await read()).row).toEqual({
		fields: { title: 'Mine', done: true, tags: ['a'] },
		body: 'first\nsecond\nthird\n',
	});
	await folder.close();
});

test('an update and another writer set one field: the update wins', async () => {
	const { root, folder, table, read } = await setup();
	writeAfterReads(table, root, [
		ROW.replace('title: One', 'title: Theirs').replace(
			'tags: [a]',
			'tags: [a, b]',
		),
	]);

	const saved = expectOk(await table.update('one', { set: { title: 'Mine' } }));

	expect(saved.replaced).toEqual([]);
	expect((await read()).row.fields).toEqual({
		title: 'Mine',
		done: false,
		tags: ['a', 'b'],
	});
	await folder.close();
});

test('an update that unsets a field removes it and keeps the body', async () => {
	const { folder, table, read } = await setup();

	expectOk(await table.update('one', { unset: ['tags'] }));

	expect((await read()).row).toEqual({
		fields: { title: 'One', done: false },
		body: 'first\nsecond\nthird\n',
	});
	await folder.close();
});

test('an update of a row that is not there is NotFound, and creates nothing', async () => {
	const { root, folder, table } = await setup();

	const refused = expectErr(
		await table.update('two', { set: { title: 'Two' } }),
	);

	expect(refused).toMatchObject({ name: 'NotFound', path: 'notes/two.md' });
	expect(
		await readFile(join(root, 'notes/two.md'), 'utf8').catch(() => null),
	).toBe(null);
	await folder.close();
});

test('an update to a value the field does not admit is InvalidValues, and nothing is written', async () => {
	const { folder, table, read } = await setup();
	const before = await read();

	const refused = expectErr(
		await table.update('one', { set: { done: 'yes' } }),
	);

	expect(refused.name).toBe('InvalidValues');
	expect((await read()).sha256).toBe(before.sha256);
	await folder.close();
});

test('an update that meets another change on every attempt is KeptChanging, and writes nothing of its own', async () => {
	const { root, folder, table, read } = await setup();
	const theirs = [1, 2, 3].map((n) =>
		ROW.replace('title: One', `title: Theirs ${n}`),
	);
	writeAfterReads(table, root, theirs);

	const refused = expectErr(await table.update('one', { set: { done: true } }));

	expect(refused).toMatchObject({
		name: 'KeptChanging',
		path: 'notes/one.md',
		attempts: WRITE_ATTEMPTS,
	});
	expect((await read()).row.fields).toEqual({
		title: 'Theirs 3',
		done: false,
		tags: ['a'],
	});
	await folder.close();
});
