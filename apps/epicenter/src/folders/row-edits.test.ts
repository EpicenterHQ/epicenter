/**
 * Row Edit Tests
 *
 * The Folders window's edits of one opened folder, driven as the grid
 * drives them, against a folder opened by `@epicenter/folder/bun`
 * (`packages/folder/src/save.test.ts` covers the merge itself).
 *
 * Key behaviors:
 * - A draft's base is the row at its first change: a refresh after that
 *   shows "changed elsewhere", and the save still merges against the base
 * - A save that replaced their values names each one until dismissed, and
 *   "Restore theirs" saves their values back over the version it wrote
 * - Changes to different body lines both survive
 * - Putting back what a box showed drops the draft
 * - A failed save says why, drops the draft, and resets the editors
 */
import '../svelte-modules.test-support';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileTable } from '@epicenter/folder';
import { openDataFolder } from '@epicenter/folder/bun';
import { expectOk } from 'wellcrafted/testing';

const { createRowEdits, failureText } = await import('./row-edits.svelte');

const author = { name: 'Folders', email: 'folders@localhost' };

/** Hand-written, so any rewrite would change its bytes. */
const DECLARED = `{"title":"Notes","kv":{"type":"object","properties":{}},"tables":{"notes":{"type":"object","properties":{"title":{"type":"string"},"done":{"type":"boolean"}},"required":["title","done"]}}}`;

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

type Fields = Record<string, unknown>;

async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'folders-row-edits-'));
	roots.push(root);
	await writeFile(join(root, 'epicenter.json'), DECLARED);
	await mkdir(join(root, 'notes'));
	await writeFile(join(root, 'notes/one.md'), ROW);
	const folder = expectOk(await openDataFolder({ root, git: { author } }));
	const table = folder.tables.notes as FileTable<Fields>;
	/** What the cache holds after a read: the row as it is now. */
	const read = async () => {
		const stored = expectOk(await table.get('one'));
		if (stored === undefined) throw new Error('the row is gone');
		return stored;
	};
	/** Another window's edit of the row as it is now. */
	const otherWindow = async (
		change: (row: Awaited<ReturnType<typeof read>>['row']) => void,
	) => {
		const captured = await read();
		const row = structuredClone(captured.row);
		change(row);
		expectOk(await table.save(captured, row));
	};
	// The grid's save: the table's save mutation, which rejects with the error.
	const edits = createRowEdits(async (_name, { base, row }) => {
		const { data, error } = await table.save(base, row);
		if (error !== null) throw error;
		return data;
	});
	const text = () => readFile(join(root, 'notes/one.md'), 'utf8');
	return { folder, table, read, otherWindow, edits, text };
}

test('a refresh after the first change shows "changed elsewhere", and the save still merges', async () => {
	const { folder, read, otherWindow, edits, text } = await setup();
	const start = await read();
	expect(edits.changedElsewhere('notes', 'one', start)).toBe(false);

	// The first keystroke captures the base; another window saves meanwhile.
	edits.begin('notes', 'one', start);
	expect(edits.changedElsewhere('notes', 'one', start)).toBe(false);
	await otherWindow((row) => {
		row.fields.title = 'Theirs';
		row.fields.done = true;
	});
	const refreshed = await read();
	expect(edits.changedElsewhere('notes', 'one', refreshed)).toBe(true);

	edits.commit('notes', 'one', refreshed, (row) => {
		row.fields.title = 'Mine';
	});
	await edits.settled();

	// Their `done` survives; the competing title is named.
	expect((await read()).row.fields).toEqual({ title: 'Mine', done: true });
	expect(edits.notices).toHaveLength(1);
	expect(edits.notices[0]?.saved.replaced).toEqual([
		{ kind: 'field', field: 'title', kept: 'Mine', theirs: 'Theirs' },
	]);
	expect(edits.changedElsewhere('notes', 'one', await read())).toBe(false);
	expect(await text()).toContain('title: Mine');
	await folder.close();
});

test('Restore theirs saves their values back over the version just written', async () => {
	const { folder, read, otherWindow, edits } = await setup();
	edits.begin('notes', 'one', await read());
	await otherWindow((row) => {
		row.fields.title = 'Theirs';
		row.body = 'one\nTHEIRS\nthree\nfour\nfive\n';
	});
	edits.commit('notes', 'one', await read(), (row) => {
		row.fields.title = 'Mine';
		row.body = 'one\nMINE\nthree\nfour\nFIVE\n';
	});
	await edits.settled();
	const [notice] = edits.notices;
	if (notice === undefined) throw new Error('no notice');
	expect(notice.saved.replaced).toMatchObject([
		{ kind: 'field', field: 'title', kept: 'Mine', theirs: 'Theirs' },
		{
			kind: 'text',
			part: 'body',
			theirs: 'one\nTHEIRS\nthree\nfour\nFIVE\n',
			regions: [{ line: 1, kept: 'MINE\n', theirs: 'THEIRS\n' }],
		},
	]);

	edits.restore(notice);
	expect(edits.notices).toEqual([]);
	await edits.settled();

	// Their values return; this edit's change no one competed with stays.
	expect((await read()).row).toEqual({
		fields: { title: 'Theirs', done: false },
		body: 'one\nTHEIRS\nthree\nfour\nFIVE\n',
	});
	expect(edits.notices).toEqual([]);
	await folder.close();
});

test('changes to different body lines both survive, with nothing to restore', async () => {
	const { folder, read, otherWindow, edits } = await setup();
	edits.begin('notes', 'one', await read());
	await otherWindow((row) => {
		row.body = 'one\ntwo\nthree\nfour\nTheirs five\n';
	});
	edits.commit('notes', 'one', await read(), (row) => {
		row.body = 'Mine one\ntwo\nthree\nfour\nfive\n';
	});
	await edits.settled();

	expect((await read()).row.body).toBe(
		'Mine one\ntwo\nthree\nfour\nTheirs five\n',
	);
	expect(edits.notices).toEqual([]);
	await folder.close();
});

test('putting back what a box showed drops the draft', async () => {
	const { folder, read, otherWindow, edits } = await setup();
	edits.begin('notes', 'one', await read());
	edits.revert('notes', 'one');
	await otherWindow((row) => {
		row.fields.title = 'Theirs';
	});
	expect(edits.changedElsewhere('notes', 'one', await read())).toBe(false);

	// The next edit starts from the row as it is now, so nothing competes.
	edits.commit('notes', 'one', await read(), (row) => {
		row.fields.done = true;
	});
	await edits.settled();
	expect((await read()).row.fields).toEqual({ title: 'Theirs', done: true });
	expect(edits.notices).toEqual([]);
	await folder.close();
});

test('a failed save says why, drops the draft, and resets the editors', async () => {
	const { folder, table, read, edits } = await setup();
	const start = await read();
	edits.begin('notes', 'one', start);
	expectOk(await table.delete(start));
	edits.commit('notes', 'one', start, (row) => {
		row.fields.title = 'Mine';
	});
	await edits.settled();

	expect(edits.problem).toBe(
		'Another window deleted this row, so your edit was not saved.',
	);
	expect(edits.resets).toBe(1);
	expect(edits.changedElsewhere('notes', 'one', undefined)).toBe(false);
	expect(expectOk(await table.get('one'))).toBeUndefined();
	edits.dismissProblem();
	expect(edits.problem).toBeUndefined();
	await folder.close();
});

test('a failure that is not a table error is said as its message', () => {
	expect(failureText(new Error('host went away'))).toBe(
		'Not saved: host went away',
	);
	expect(failureText('odd')).toBe('Not saved: odd');
});
