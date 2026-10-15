/**
 * Save Row Tests
 *
 * `saveRow` saves an edit of the Folders window through the engine's
 * `table.save`, which merges with another writer's newer file
 * (`packages/folder/src/save.test.ts` covers the merge itself). These pin
 * what the view is told.
 *
 * Key behaviors:
 * - A save over the bytes the row was read from is `saved`
 * - A save another writer overtook is `merged`, naming what it replaced
 * - A row another writer deleted, and a value the field does not admit,
 *   are `failed` with words for a person, and nothing is written
 * - `epicenter.json` keeps its bytes throughout
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
		return expectOk(await table.save(captured, row)).stored;
	};
	const declaration = () => readFile(join(root, 'epicenter.json'), 'utf8');
	return { folder, table, read, otherWriter, declaration };
}

test('a save over the row as read is saved', async () => {
	const { folder, table, read, declaration } = await setup();
	const captured = await read();
	const edited = structuredClone(captured.row);
	edited.fields.title = 'Renamed';

	const outcome = await saveRow({ table, captured, edited });

	expect(outcome.kind).toBe('saved');
	expect((await read()).row.fields.title).toBe('Renamed');
	expect(await declaration()).toBe(DECLARED);
	await folder.close();
});

test('a save another writer overtook is merged, and names what it replaced', async () => {
	const { folder, table, read, otherWriter, declaration } = await setup();
	const captured = await read();
	await otherWriter(captured, (row) => {
		row.fields.title = 'Theirs';
		row.fields.done = true;
	});
	const edited = structuredClone(captured.row);
	edited.fields.title = 'Mine';

	const outcome = await saveRow({ table, captured, edited });

	expect(outcome).toMatchObject({
		kind: 'merged',
		replaced: [{ kind: 'field', field: 'title', kept: 'Mine', theirs: 'Theirs' }],
	});
	expect((await read()).row.fields).toEqual({
		title: 'Mine',
		done: true,
		tags: ['a'],
	});
	expect(await declaration()).toBe(DECLARED);
	await folder.close();
});

test('a row another writer deleted is not recreated, and says so', async () => {
	const { folder, table, read } = await setup();
	const captured = await read();
	expectOk(await table.delete(captured));
	const edited = structuredClone(captured.row);
	edited.fields.title = 'Mine';

	const outcome = await saveRow({ table, captured, edited });

	expect(outcome).toEqual({
		kind: 'failed',
		message: 'Another window deleted this row, so your edit was not saved.',
	});
	expect(expectOk(await table.get('one'))).toBeUndefined();
	await folder.close();
});

test('a value the field does not admit is not saved, and says why', async () => {
	const { folder, table, read } = await setup();
	const captured = await read();
	const edited = structuredClone(captured.row);
	edited.fields.done = 'yes';

	const outcome = await saveRow({ table, captured, edited });

	expect(outcome.kind).toBe('failed');
	if (outcome.kind === 'failed') expect(outcome.message).toStartWith('Not saved: ');
	expect((await read()).row.fields.done).toBe(false);
	await folder.close();
});
