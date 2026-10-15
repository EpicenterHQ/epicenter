/**
 * Save Row Tests
 *
 * `saveRow` saves an edit of the Folders window at once, and merges it with
 * another writer's newer file when the save is overtaken.
 *
 * Key behaviors:
 * - A save over the bytes the row was read from lands as it is
 * - Over a row another writer changed in a different field, both changes land
 * - Where both changed one field, this edit wins, the other writer's other
 *   fields survive, and the outcome names the value it replaced
 * - Body edits merge by line
 * - A row another writer deleted is not recreated
 * - A row that keeps changing gives up after the bounded number of merges
 * - A value the field does not admit is refused with a reason
 * - `epicenter.json` keeps its bytes throughout
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PreparedFolderTable } from '@epicenter/folder';
import { openDataFolder } from '@epicenter/folder/bun';
import { expectOk } from 'wellcrafted/testing';
import { type AnyTable, type StoredAnyRow, saveRow } from './save-row';

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
	const root = await mkdtemp(join(tmpdir(), 'folders-save-row-'));
	roots.push(root);
	await writeFile(join(root, 'epicenter.json'), DECLARED);
	await mkdir(join(root, 'notes'));
	await writeFile(join(root, 'notes/one.md'), ROW);
	const folder = expectOk(await openDataFolder({ root, git: { author } }));
	const table = folder.tables.notes as AnyTable;
	const prepared = folder.definition.tables.notes as PreparedFolderTable;
	const read = async () => {
		const stored = expectOk(await table.get('one'));
		if (stored === undefined) throw new Error('the row is gone');
		return stored;
	};
	/** Another writer's save, which leaves `captured` stale. */
	const otherWriter = async (
		captured: StoredAnyRow,
		change: (row: StoredAnyRow['row']) => void,
	) => {
		const row = structuredClone(captured.row);
		change(row);
		return expectOk(await table.replace(captured, row));
	};
	const declaration = () => readFile(join(root, 'epicenter.json'), 'utf8');
	return { folder, table, prepared, read, otherWriter, declaration };
}

test('a save over the row as read lands', async () => {
	const { folder, table, prepared, read, declaration } = await setup();
	const captured = await read();
	const edited = structuredClone(captured.row);
	edited.fields.title = 'Renamed';

	const outcome = await saveRow({ table, prepared, captured, edited });

	expect(outcome.kind).toBe('saved');
	expect((await read()).row.fields).toEqual({
		title: 'Renamed',
		done: false,
		tags: ['a'],
	});
	expect(await declaration()).toBe(DECLARED);
	await folder.close();
});

test('another writer changed a different field: both changes land', async () => {
	const { folder, table, prepared, read, otherWriter, declaration } =
		await setup();
	const captured = await read();
	await otherWriter(captured, (row) => {
		row.fields.done = true;
	});
	const edited = structuredClone(captured.row);
	edited.fields.title = 'Mine';

	const outcome = await saveRow({ table, prepared, captured, edited });

	expect(outcome).toMatchObject({ kind: 'merged', replaced: [] });
	expect((await read()).row.fields).toEqual({
		title: 'Mine',
		done: true,
		tags: ['a'],
	});
	expect(await declaration()).toBe(DECLARED);
	await folder.close();
});

test('both changed one field: this edit wins and their other fields survive', async () => {
	const { folder, table, prepared, read, otherWriter, declaration } =
		await setup();
	const captured = await read();
	await otherWriter(captured, (row) => {
		row.fields.title = 'Theirs';
		row.fields.tags = ['a', 'b'];
	});
	const edited = structuredClone(captured.row);
	edited.fields.title = 'Mine';

	const outcome = await saveRow({ table, prepared, captured, edited });

	expect(outcome).toMatchObject({
		kind: 'merged',
		replaced: [{ kind: 'field', field: 'title', theirs: 'Theirs' }],
	});
	expect((await read()).row.fields).toEqual({
		title: 'Mine',
		done: false,
		tags: ['a', 'b'],
	});
	expect(await declaration()).toBe(DECLARED);
	await folder.close();
});

test('body edits to different lines merge by line', async () => {
	const { folder, table, prepared, read, otherWriter, declaration } =
		await setup();
	const captured = await read();
	await otherWriter(captured, (row) => {
		row.body = 'first\nsecond\nTHIRD\n';
	});
	const edited = structuredClone(captured.row);
	edited.body = 'FIRST\nsecond\nthird\n';

	const outcome = await saveRow({ table, prepared, captured, edited });

	expect(outcome).toMatchObject({ kind: 'merged', replaced: [] });
	expect((await read()).row.body).toBe('FIRST\nsecond\nTHIRD\n');
	expect(await declaration()).toBe(DECLARED);
	await folder.close();
});

test('body edits to the same line: this edit wins and says what it replaced', async () => {
	const { folder, table, prepared, read, otherWriter } = await setup();
	const captured = await read();
	await otherWriter(captured, (row) => {
		row.body = 'first\ntheirs\nthird\n';
		row.fields.done = true;
	});
	const edited = structuredClone(captured.row);
	edited.body = 'first\nmine\nthird\n';

	const outcome = await saveRow({ table, prepared, captured, edited });

	expect(outcome).toMatchObject({
		kind: 'merged',
		replaced: [{ kind: 'body', theirs: 'first\ntheirs\nthird\n' }],
	});
	const stored = await read();
	expect(stored.row.body).toBe('first\nmine\nthird\n');
	expect(stored.row.fields.done).toBe(true);
	await folder.close();
});

test('a row another writer deleted is not recreated', async () => {
	const { folder, table, prepared, read } = await setup();
	const captured = await read();
	expectOk(await table.delete(captured));
	const edited = structuredClone(captured.row);
	edited.fields.title = 'Mine';

	const outcome = await saveRow({ table, prepared, captured, edited });

	expect(outcome.kind).toBe('failed');
	expect(expectOk(await table.get('one'))).toBeUndefined();
	await folder.close();
});

test('a row that keeps changing gives up after the bounded merges', async () => {
	const { folder, table, prepared, read, declaration } = await setup();
	const captured = await read();
	// A writer that saves again before every attempt, so each merge is overtaken.
	let saves = 0;
	const busy: AnyTable = {
		...table,
		async replace(file, row) {
			const current = expectOk(await table.get('one'));
			if (current !== undefined) {
				const theirs = structuredClone(current.row);
				theirs.fields.tags = [
					...(theirs.fields.tags as string[]),
					`t${saves++}`,
				];
				expectOk(await table.replace(current, theirs));
			}
			return table.replace(file, row);
		},
	};
	const edited = structuredClone(captured.row);
	edited.fields.title = 'Mine';

	const outcome = await saveRow({
		table: busy,
		prepared,
		captured,
		edited,
		attempts: 2,
	});

	expect(outcome.kind).toBe('failed');
	expect((await read()).row.fields.title).toBe('One');
	expect(await declaration()).toBe(DECLARED);
	await folder.close();
});

test('a value the field does not admit is not saved, and says why', async () => {
	const { folder, table, prepared, read } = await setup();
	const captured = await read();
	const edited = structuredClone(captured.row);
	edited.fields.done = 'yes';

	const outcome = await saveRow({ table, prepared, captured, edited });

	expect(outcome).toMatchObject({ kind: 'failed' });
	expect((await read()).row.fields.done).toBe(false);
	await folder.close();
});
