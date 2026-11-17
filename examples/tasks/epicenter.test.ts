import { expectOk } from '@epicenter/app/testing';
import { expect, test } from 'bun:test';
import { createMemoryContext, inRun, Ok } from '@epicenter/app';
import app from './epicenter.ts';
const { add, get, list, set } = app.actions;
const path = 'data/tasks/a.md';
const front = '---\ntitle: "Water plants"\ndone: false\n---\n';
test('add writes a single-line title and due day with exact file layout', async () => {
	const context = createMemoryContext({});
	const added = expectOk(await inRun(context, () => add({ title: 'Buy milk', due: '2026-11-12' })));
	expect(added).toMatchObject({ title: 'Buy milk', done: false, due: '2026-11-12' });
	expect(added.path).toBe(`data/tasks/${added.time}.md`);
	expect(await context.folder.read(added.path)).toBe('---\ntitle: "Buy milk"\ndone: false\ndue: "2026-11-12"\n---\n');
	expect(expectOk(await inRun(context, () => get(added)))).toEqual(added);
});
test('add keeps the first title line and the remaining lines before notes', async () => {
	const context = createMemoryContext({});
	const added = expectOk(await inRun(context, () => add({ title: 'Call Mom\nabout the trip', notes: 'Ask about Sunday' })));
	expect(await context.folder.read(added.path)).toBe('---\ntitle: "Call Mom"\ndone: false\n---\nabout the trip\n\nAsk about Sunday\n');
});
test('blank title returns Refused and writes no file', async () => {
	const context = createMemoryContext({});
	expect((await inRun(context, () => add({ title: ' \n ' }))).error?.name).toBe('Refused');
	expect(expectOk(await inRun(context, () => list({})))).toEqual([]);
});
test('list preserves malformed rows beside fitting rows, without bodies', async () => {
	const context = createMemoryContext({ [path]: front, 'data/tasks/b.md': '---\ntitle: "Broken"\ndone: "maybe"\n---\nNotes\n' });
	const rows = expectOk(await inRun(context, () => list({})));
	expect(rows).toHaveLength(2);
	expect(rows[0]).toEqual(Ok({ path, time: 'a', title: 'Water plants', done: false }));
	expect(rows[1]?.error).toMatchObject({ name: 'Misfit', record: { title: 'Broken' } });
	expect(rows[1]?.error?.record).not.toHaveProperty('body');
});
test('plain set repairs a bad field and returns the fitting record', async () => {
	const context = createMemoryContext({ [path]: '---\ntitle: "Repair"\ndone: "maybe"\ndue: "nope"\n---\nNotes\n' });
	const before = await context.folder.read(path);
	expect((await inRun(context, () => set({ time: 'a', done: false }))).error?.name).toBe('Misfit');
	expect(await context.folder.read(path)).toBe(before);
	const repaired = expectOk(await inRun(context, () => set({ time: 'a', done: false, due: null })));
	expect(repaired).toMatchObject({ title: 'Repair', done: false, body: 'Notes\n' });
	expect(expectOk(await inRun(context, () => get({ time: 'a' })))).toEqual(repaired);
});
test('invalid supplied titles return Refused without writing', async () => {
	const context = createMemoryContext({ [path]: front });
	for (const title of [' ', 'two\nlines'])
		expect((await inRun(context, () => set({ time: 'a', title }))).error?.name).toBe('Refused');
	expect(await context.folder.read(path)).toBe(front);
});
test('fields and quoted notes persist; was and edit guards return Changed', async () => {
	const context = createMemoryContext({ [path]: front + 'Old notes\n' });
	expect((await inRun(context, () => set({ time: 'a', title: 'Mine', was: { title: 'Before' } }))).error).toMatchObject({ name: 'Changed', why: 'was' });
	expectOk(await inRun(context, () => set({ time: 'a', title: 'Mine', done: true, due: '2026-11-14', was: { title: 'Water plants' } })));
	expectOk(await inRun(context, () => set({ time: 'a', edit: { old: 'Old notes\n', new: 'New notes\n' } })));
	expect((await inRun(context, () => set({ time: 'a', edit: { old: 'Old notes\n', new: 'Stale' } }))).error?.name).toBe('Changed');
	expectOk(await inRun(context, () => set({ time: 'a', done: false, due: null })));
	expect(expectOk(await inRun(context, () => get({ time: 'a' })))).toMatchObject({ title: 'Mine', done: false, body: 'New notes\n' });
	expectOk(await inRun(context, () => set({ time: 'a', edit: { old: 'New notes\n', new: '' } })));
	expect(expectOk(await inRun(context, () => get({ time: 'a' })))).toHaveProperty('body', '');
});
test('missing set/get return Missing and delete wraps its boolean', async () => {
	const context = createMemoryContext({ [path]: front });
	expect(expectOk(await inRun(context, () => app.actions.delete({ time: 'a' })))).toBe(true);
	expect(expectOk(await inRun(context, () => app.actions.delete({ time: 'a' })))).toBe(false);
	expect((await inRun(context, () => get({ time: 'a' }))).error?.name).toBe('Missing');
	expect((await inRun(context, () => set({ time: 'a', edit: { old: '', new: 'No' } }))).error?.name).toBe('Missing');
	expect(await context.folder.read(path)).toBeUndefined();
});
