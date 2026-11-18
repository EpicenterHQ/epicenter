/** Checks task creation, repairs, field patches, quoted notes, and deletion, each on a folder in a temporary directory. */
import { expectOk } from 'wellcrafted/testing';
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { folderOnDisk, Ok } from '@epicenter/app';
import tasks from './epicenter.ts';

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** Tasks on a folder in a new temporary directory holding `files`, and a way to read a file there. */
async function setup(files: Record<string, string> = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'tasks-'));
	dirs.push(dir);
	for (const [file, text] of Object.entries(files)) {
		await mkdir(dirname(join(dir, file)), { recursive: true });
		await writeFile(join(dir, file), text);
	}
	const { delete: remove, ...actions } = tasks({ folder: folderOnDisk(dir) }).actions;
	const read = (file: string) => readFile(join(dir, file), 'utf8').catch(() => undefined);
	return { ...actions, remove, read };
}
const path = 'data/tasks/a.md';
const front = '---\ntitle: "Water plants"\ndone: false\n---\n';
test('add writes a single-line title and due day with exact file layout', async () => {
	const { add, get, read } = await setup();
	const added = expectOk(await add({ title: 'Buy milk', due: '2026-11-12' }));
	expect(added).toMatchObject({ title: 'Buy milk', done: false, due: '2026-11-12' });
	expect(added.path).toBe(`data/tasks/${added.id}.md`);
	expect(await read(added.path)).toBe('---\ntitle: "Buy milk"\ndone: false\ndue: "2026-11-12"\n---\n');
	expect(expectOk(await get(added))).toEqual(added);
});
test('add keeps the first title line and the remaining lines before notes', async () => {
	const { add, read } = await setup();
	const added = expectOk(await add({ title: 'Call Mom\nabout the trip', notes: 'Ask about Sunday' }));
	expect(await read(added.path)).toBe('---\ntitle: "Call Mom"\ndone: false\n---\nabout the trip\n\nAsk about Sunday\n');
});
test('blank title returns Refused and writes no file', async () => {
	const { add, list } = await setup();
	expect((await add({ title: ' \n ' })).error?.name).toBe('Refused');
	expect(expectOk(await list({}))).toEqual([]);
});
test('list preserves malformed rows beside fitting rows, including bodies', async () => {
	const { list } = await setup({ [path]: front, 'data/tasks/b.md': '---\ntitle: "Broken"\ndone: "maybe"\n---\nNotes\n' });
	const rows = expectOk(await list({}));
	expect(rows).toHaveLength(2);
	expect(rows[0]).toEqual(Ok({ path, id: 'a', title: 'Water plants', done: false, body: '' }));
	expect(rows[1]?.error).toMatchObject({ name: 'Misfit', record: { title: 'Broken' } });
	expect(rows[1]?.error?.record).toHaveProperty('body', 'Notes\n');
});
test('plain patch repairs a bad field and returns the fitting record', async () => {
	const { get, patch, read } = await setup({ [path]: '---\ntitle: "Repair"\ndone: "maybe"\ndue: "nope"\n---\nNotes\n' });
	const before = await read(path);
	expect((await patch({ id: 'a', done: false })).error?.name).toBe('Misfit');
	expect(await read(path)).toBe(before);
	const repaired = expectOk(await patch({ id: 'a', done: false, due: null }));
	expect(repaired).toMatchObject({ title: 'Repair', done: false, body: 'Notes\n' });
	expect(expectOk(await get({ id: 'a' }))).toEqual(repaired);
});
test('invalid supplied titles return Misfit without writing', async () => {
	const { patch, read } = await setup({ [path]: front });
	for (const title of [' ', 'two\nlines'])
		expect((await patch({ id: 'a', title })).error?.name).toBe('Misfit');
	expect(await read(path)).toBe(front);
});
test('fields use the last write and stale quoted notes return Changed', async () => {
	const { get, patch, edit } = await setup({ [path]: front + 'Old notes\n' });
	expectOk(await patch({ id: 'a', title: 'Earlier' }));
	expectOk(await patch({ id: 'a', title: 'Mine', done: true, due: '2026-11-14' }));
	expectOk(await edit({ id: 'a', old: 'Old notes\n', new: 'New notes\n' }));
	expect((await edit({ id: 'a', old: 'Old notes\n', new: 'Stale' })).error?.name).toBe('Changed');
	expectOk(await patch({ id: 'a', done: false, due: null }));
	expect(expectOk(await get({ id: 'a' }))).toMatchObject({ title: 'Mine', done: false, body: 'New notes\n' });
	expectOk(await edit({ id: 'a', old: 'New notes\n', new: '' }));
	expect(expectOk(await get({ id: 'a' }))).toHaveProperty('body', '');
});
test('missing edit/get return Missing and delete wraps its boolean', async () => {
	const { get, edit, remove, read } = await setup({ [path]: front });
	expect(expectOk(await remove({ id: 'a' }))).toBe(true);
	expect(expectOk(await remove({ id: 'a' }))).toBe(false);
	expect((await get({ id: 'a' })).error?.name).toBe('Missing');
	expect((await edit({ id: 'a', old: 'Original', new: 'No' })).error?.name).toBe('Missing');
	expect(await read(path)).toBeUndefined();
});

test('two identical additions get distinct ids chosen inside the action', async () => {
	const { add, list } = await setup();
	const [first, second] = await Promise.all([
		add({ title: 'Repeat' }), add({ title: 'Repeat' }),
	]);
	expect(expectOk(first).id).not.toBe(expectOk(second).id);
	expect(expectOk(await list({}))).toHaveLength(2);
	expect(add.input.properties).not.toHaveProperty('id');
});
