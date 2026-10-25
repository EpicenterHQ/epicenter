import { describe, expect, test } from 'bun:test';
import { Type } from 'typebox';
import { expectOk } from 'wellcrafted/testing';
import { SaveError } from '../shared/errors.js';
import { createFolder, type SaveFailure } from './folder.js';
import { memoryStorage, tick } from './memory-storage.test-support.js';

const tables = {
	notes: Type.Object({
		title: Type.String(),
		pinned: Type.Optional(Type.Boolean()),
	}),
};
const note = (fields: string, body = 'Body\n') =>
	`---\n${fields}\n---\n${body}`;
const THROTTLE = 20;

async function setup(initial: Record<string, string | Uint8Array> = {}) {
	const memory = memoryStorage(initial);
	const folder = expectOk(
		await createFolder(memory.storage, { tables, throttleMs: THROTTLE }),
	);
	return { ...memory, folder, notes: folder.tables.notes };
}

describe('opening', () => {
	test('reads every text file in one batch; media is listed, not read', async () => {
		const { folder, notes, log } = await setup({
			'notes/a.md': note('title: A'),
			'notes/b.md': note('title: B'),
			'audio/x.webm': new Uint8Array([1, 2, 3]),
		});
		expect(log.reads).toEqual([['notes/a.md', 'notes/b.md']]);
		expect(notes.rows.get().map((row) => row.fields?.title)).toEqual([
			'A',
			'B',
		]);
		expect(folder.file('audio/x.webm')).toMatchObject({
			mime: 'audio/webm',
			data: undefined,
			readError: null,
		});
		expect(expectOk(await folder.read('audio/x.webm'))).toEqual(
			new Uint8Array([1, 2, 3]),
		);
	});

	test('a failed first listing refuses to open', async () => {
		const memory = memoryStorage();
		memory.control.listFails = true;
		const opened = await createFolder(memory.storage, { tables });
		expect(opened.error?.name).toBe('ListFailed');
	});

	test('a row that does not read as one carries its issues', async () => {
		const { notes } = await setup({
			'notes/a.md': note('pinned: true'),
			'notes/b.md': new Uint8Array([0xff, 0xfe]),
		});
		expect(notes.row('a')?.issues?.[0]?.kind).toBe('schema');
		expect(notes.row('a')?.fields).toEqual({ pinned: true });
		expect(notes.row('b')?.issues?.[0]?.kind).toBe('not-text');
	});

	test('row(id) and rows answer the same objects', async () => {
		const { notes } = await setup({ 'notes/a.md': note('title: A') });
		expect(notes.row('a')).toBe(notes.rows.get()[0]);
	});
});

describe('the mirror shows what landed', () => {
	test('an update changes the mirror when it lands, not before', async () => {
		const { notes, text } = await setup({ 'notes/a.md': note('title: A') });
		const saved = notes.update('a', { fields: { pinned: true } });
		expect(notes.row('a')?.fields).toEqual({ title: 'A' });
		expect((await saved).error).toBeNull();
		expect(notes.row('a')?.fields).toEqual({ title: 'A', pinned: true });
		expect(text('notes/a.md')).toBe(note('title: A\npinned: true'));
	});

	test('a row that did not change keeps its object, and so do the others', async () => {
		const { notes } = await setup({
			'notes/a.md': note('title: A'),
			'notes/b.md': note('title: B'),
		});
		const [a, b] = notes.rows.get();
		await notes.update('a', { fields: { title: 'A2' } });
		const [a2, b2] = notes.rows.get();
		expect(a2).not.toBe(a);
		expect(b2).toBe(b);
	});

	test('a failed write tells its listener and leaves the mirror on the disk', async () => {
		const { folder, notes, control } = await setup({
			'notes/a.md': note('title: A'),
		});
		const failures: SaveFailure[] = [];
		folder.onSaveFailed((failure) => failures.push(failure));
		const error = SaveError.StorageFailed({ cause: 'disk full' }).error;
		control.failPut.set('notes/a.md', error);
		const saved = await notes.update('a', { body: 'Typed\n' });
		expect(saved.error).toBe(error);
		expect(notes.row('a')?.body).toBe('Body\n');
		expect(failures).toEqual([
			{ path: 'notes/a.md', attempted: note('title: A', 'Typed\n'), error },
		]);
	});
});

describe('patching', () => {
	test('a patch that changes no value writes nothing, even over hand-written YAML', async () => {
		const { notes, log } = await setup({
			'notes/a.md': note("title: 'A' # mine"),
		});
		expect(
			(await notes.update('a', { fields: { title: 'A' } })).error,
		).toBeNull();
		expect(log.puts).toEqual([]);
	});

	test('any other patch writes the canonical form: declared keys first, then the rest', async () => {
		const { notes, text } = await setup({
			'notes/a.md': note("zeta: 1 # theirs\npinned: false\ntitle: 'A'"),
		});
		await notes.update('a', { fields: { pinned: true } });
		expect(text('notes/a.md')).toBe(note('title: A\npinned: true\nzeta: 1'));
	});

	test('text without a fence is all body; a field patch gives it one', async () => {
		const { folder, notes, text } = await setup({
			'notes/a.md': 'Just text\n',
		});
		expect(notes.row('a')?.body).toBe('Just text\n');
		await notes.update('a', { fields: { title: 'A' } });
		expect(text('notes/a.md')).toBe(note('title: A', 'Just text\n'));
		expect(folder.file('notes/a.md')?.data).toBe(
			note('title: A', 'Just text\n'),
		);
	});

	test('a field set to undefined is removed', async () => {
		const { notes, text } = await setup({
			'notes/a.md': note('title: A\npinned: true'),
		});
		await notes.update('a', { fields: { pinned: undefined } });
		expect(text('notes/a.md')).toBe(note('title: A'));
	});

	test('frontmatter that does not parse refuses the patch', async () => {
		const { notes, log } = await setup({ 'notes/a.md': '---\ntitle: A\n' });
		expect((await notes.update('a', { body: 'x' })).error?.name).toBe(
			'Unparseable',
		);
		expect(log.puts).toEqual([]);
	});
});

describe('saving', () => {
	test('the first write goes at once; writes within the throttle merge into one', async () => {
		const { notes, log, text } = await setup({
			'notes/a.md': note('title: A'),
		});
		const first = notes.update('a', { body: 'One\n' });
		const second = notes.update('a', { body: 'Two\n' });
		const third = notes.update('a', { fields: { pinned: true } });
		expect(log.puts.length).toBe(1);
		expect((await first).error).toBeNull();
		expect((await second).error).toBeNull();
		expect((await third).error).toBeNull();
		expect(log.puts.length).toBe(2);
		expect(text('notes/a.md')).toBe(note('title: A\npinned: true', 'Two\n'));
	});

	test('an update applies to the file as it is when the save runs', async () => {
		const memory = memoryStorage({ 'notes/a.md': note('title: A') });
		const folder = expectOk(
			await createFolder(memory.storage, { tables, throttleMs: THROTTLE }),
		);
		let raced = false;
		memory.control.beforePut = () => {
			if (raced) return;
			raced = true;
			memory.outside('notes/a.md', note('title: Theirs'), { hint: false });
		};
		const saved = await folder.tables.notes.update('a', {
			fields: { pinned: true },
		});
		expect(saved.error).toBeNull();
		expect(memory.text('notes/a.md')).toBe(note('title: Theirs\npinned: true'));
		expect(folder.tables.notes.row('a')?.fields).toEqual({
			title: 'Theirs',
			pinned: true,
		});
	});

	test('three stale saves in a row answer KeptChanging', async () => {
		const memory = memoryStorage({ 'notes/a.md': note('title: A') });
		const folder = expectOk(
			await createFolder(memory.storage, { tables, throttleMs: THROTTLE }),
		);
		let n = 0;
		memory.control.beforePut = () =>
			memory.outside('notes/a.md', note(`title: T${++n}`), { hint: false });
		const saved = await folder.tables.notes.update('a', {
			fields: { pinned: true },
		});
		expect(saved.error?.name).toBe('KeptChanging');
		expect(memory.text('notes/a.md')).toBe(note('title: T3'));
	});

	test('create refuses a listed file, and a file made elsewhere first', async () => {
		const memory = memoryStorage({ 'notes/a.md': note('title: A') });
		const folder = expectOk(
			await createFolder(memory.storage, { tables, throttleMs: THROTTLE }),
		);
		const notes = folder.tables.notes;
		expect(
			(await notes.create('a', { fields: { title: 'Mine' } })).error?.name,
		).toBe('Exists');
		memory.control.beforePut = (path) => {
			if (path === 'notes/b.md')
				memory.outside('notes/b.md', note('title: Theirs'), { hint: false });
		};
		const made = await notes.create('b', { fields: { title: 'Mine' } });
		expect(made.error?.name).toBe('Exists');
		expect(notes.row('b')?.fields).toEqual({ title: 'Theirs' });
	});

	test('update refuses a row that is not there', async () => {
		const { notes } = await setup();
		expect((await notes.update('nope', { body: 'x' })).error?.name).toBe(
			'NothingToUpdate',
		);
	});

	test('an update right after create waits for it and applies over it', async () => {
		const { notes, text } = await setup();
		const made = notes.create('a', { fields: { title: '' } });
		const typed = notes.update('a', { fields: { title: 'Typed' } });
		expect((await made).error).toBeNull();
		expect((await typed).error).toBeNull();
		expect(text('notes/a.md')).toBe(note('title: Typed', ''));
	});

	test('delete removes the row when it lands', async () => {
		const { notes, folder } = await setup({ 'notes/a.md': note('title: A') });
		expect((await notes.delete('a')).error).toBeNull();
		expect(notes.row('a')).toBeUndefined();
		expect(folder.files.get()).toEqual([]);
	});

	test('saving is true while a write waits or is in flight', async () => {
		const { folder, notes } = await setup({ 'notes/a.md': note('title: A') });
		const seen: boolean[] = [];
		folder.saving.subscribe(() => seen.push(folder.saving.get()));
		await notes.update('a', { body: 'x' });
		expect(seen).toEqual([true, false]);
	});
});

describe('outside changes', () => {
	test('a hint rereads the file', async () => {
		const { notes, outside } = await setup({ 'notes/a.md': note('title: A') });
		outside('notes/a.md', note('title: Outside'));
		await tick();
		expect(notes.row('a')?.fields).toEqual({ title: 'Outside' });
	});

	test('checkpoint relists and reads what moved, without a hint', async () => {
		const { folder, notes, outside } = await setup({
			'notes/a.md': note('title: A'),
		});
		outside('notes/a.md', note('title: Moved'), { hint: false });
		outside('notes/b.md', note('title: New'), { hint: false });
		folder.checkpoint();
		await tick();
		expect(notes.rows.get().map((row) => row.fields?.title)).toEqual([
			'Moved',
			'New',
		]);
		outside('notes/a.md', null, { hint: false });
		folder.checkpoint();
		await tick();
		expect(notes.rows.get().map((row) => row.id)).toEqual(['b']);
	});

	test('a read that overlapped a write is dropped, and the path read again', async () => {
		const { notes, control, outside } = await setup({
			'notes/a.md': note('title: A'),
		});
		let release: () => void = () => {};
		control.readGate = new Promise((resolve) => {
			release = resolve;
		});
		// A hint starts a read that answers with the file before the write.
		outside('notes/a.md', note('title: Before'));
		await tick();
		control.readGate = undefined;
		const saved = notes.update('a', { body: 'Mine\n' });
		expect((await saved).error).toBeNull();
		release();
		await tick();
		await tick();
		expect(notes.row('a')?.fields).toEqual({ title: 'Before' });
		expect(notes.row('a')?.body).toBe('Mine\n');
	});
});

describe('closing', () => {
	test('close sends what waits, waits for it, then refuses writes', async () => {
		const { folder, notes, text, control } = await setup({
			'notes/a.md': note('title: A'),
		});
		void notes.update('a', { body: 'One\n' });
		const waiting = notes.update('a', { body: 'Two\n' });
		await folder.close();
		expect((await waiting).error).toBeNull();
		expect(text('notes/a.md')).toBe(note('title: A', 'Two\n'));
		expect(control.closed).toBe(true);
		expect((await notes.update('a', { body: 'Late' })).error?.name).toBe(
			'Closed',
		);
	});
});
