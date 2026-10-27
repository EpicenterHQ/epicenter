/**
 * The folder's landed copy, ordered writes, outside reads, and close.
 * Each Saved answer follows the copy change; updates read storage at their
 * turn so an unheard outside change to another field survives.
 */
import { describe, expect, test } from 'bun:test';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	createFolder,
	describeIssue,
	describeIssues,
	readRow,
} from './folder.js';
import { SaveError } from './shared/errors.js';
import { memoryHost, ReadError, tick, until } from './testing.js';

const tables = {
	notes: Type.Object({
		title: Type.String(),
		pinned: Type.Optional(Type.Boolean()),
	}),
};
const note = (fields: string, body = 'Body\n') =>
	`---\n${fields}\n---\n${body}`;

async function setup(initial: Record<string, string | Uint8Array> = {}) {
	const memory = memoryHost(initial);
	const folder = expectOk(await createFolder(memory.storage, { tables }));
	return { ...memory, folder, notes: folder.tables.notes };
}

describe('opening and rows', () => {
	test('reads text and lists media without keeping its bytes', async () => {
		const { folder, notes, log } = await setup({
			'notes/a.md': note('title: A'),
			'notes/b.md': note('title: B'),
			'audio/x.webm': new Uint8Array([1, 2, 3]),
		});
		expect(log.reads).toEqual([['notes/a.md', 'notes/b.md']]);
		expect(notes.rows().map((row) => row.fields?.title)).toEqual(['A', 'B']);
		expect(notes.row('a')).toBe(notes.rows()[0]);
		expect(folder.file('audio/x.webm')?.data).toBeUndefined();
		expect(expectOk(await folder.read('audio/x.webm'))).toEqual(
			new Uint8Array([1, 2, 3]),
		);
	});

	test('keeps dotfiles and extensionless text, but fetches media on demand', async () => {
		const { folder, log } = await setup({
			'.gitignore': 'cache\n',
			Makefile: 'all:\n',
			'photo.heic': new Uint8Array([1, 2]),
		});
		expect(log.reads).toEqual([['.gitignore', 'Makefile']]);
		expect(folder.file('.gitignore')?.data).toBe('cache\n');
		expect(folder.file('Makefile')?.data).toBe('all:\n');
		expect(folder.file('photo.heic')?.data).toBeUndefined();
		expect(expectOk(await folder.read('photo.heic'))).toEqual(
			new Uint8Array([1, 2]),
		);
	});

	test('refuses a failed first listing and an invalid table', async () => {
		const failed = memoryHost();
		failed.control.listFails = true;
		expect(expectErr(await createFolder(failed.storage, { tables })).name).toBe(
			'Unavailable',
		);
		const invalid = memoryHost();
		expect(
			expectErr(
				await createFolder(invalid.storage, {
					tables: { 'bad/name': tables.notes },
				}),
			).name,
		).toBe('InvalidTable');
		expect(invalid.log.lists).toBe(0);
	});

	test('keeps row issues and reads a repair draft through the same schema', async () => {
		const { notes } = await setup({
			'notes/a.md': note('pinned: true'),
			'notes/b.md': new Uint8Array([0xff]),
		});
		expect(notes.row('a')?.issues?.[0]?.kind).toBe('schema');
		expect(notes.row('b')?.issues?.[0]?.kind).toBe('not-text');
		expect(readRow(note('title: Fixed'), tables.notes).issues).toBeNull();
	});

	test('writes lone surrogates as U+FFFD, and the copy shows what landed', async () => {
		const { folder, notes, text } = await setup({
			'notes/a.md': note('title: A'),
		});
		expectOk(await folder.write('draft.txt', 'Half \uD800'));
		expect(folder.file('draft.txt')?.data).toBe('Half \uFFFD');
		expect(text('draft.txt')).toBe('Half \uFFFD');
		expectOk(await notes.update('a', { fields: { title: 'T \uDC00' } }));
		expect(notes.row('a')?.fields?.title).toBe('T \uFFFD');
	});

	test('a new stamp with unchanged bytes keeps file and row identity', async () => {
		const source = note('title: A');
		const { folder, notes, outside } = await setup({ 'notes/a.md': source });
		const file = folder.file('notes/a.md');
		const row = notes.row('a');
		outside('notes/a.md', source);
		await until(() => notes.row('a') !== undefined && !folder.saving());
		await folder.refresh();
		expect(folder.file('notes/a.md')).toBe(file);
		expect(notes.row('a')).toBe(row);
	});

	test('a hint for a held file rereads it without relisting', async () => {
		const { folder, notes, outside, hint, log } = await setup({
			'notes/a.md': note('title: A'),
		});
		const lists = log.lists;
		const reads = log.reads.length;
		expectOk(await folder.write('notes/a.md', note('title: Mine')));
		hint(['notes/a.md']);
		await until(() => log.reads.length === reads + 1);
		await tick();
		expect(log.lists).toBe(lists);
		expect(notes.row('a')?.fields?.title).toBe('Mine');
		outside('notes/a.md', note('title: Outside'));
		await until(() => notes.row('a')?.fields?.title === 'Outside');
		await tick();
		expect(log.lists).toBe(lists);
		expect(log.reads.slice(reads)).toEqual([['notes/a.md'], ['notes/a.md']]);
	});

	test('unknown file, directory, and null hints relist', async () => {
		const { folder, notes, outside, hint, log } = await setup({
			'notes/a.md': note('title: A'),
		});
		outside('notes/new.md', note('title: New'), { hint: false });
		hint(['notes/new.md']);
		await until(() => notes.row('new') !== undefined);
		expect(log.lists).toBe(2);
		outside('notes/dir.md', note('title: Directory'), { hint: false });
		hint(['notes']);
		await until(() => notes.row('dir') !== undefined);
		expect(log.lists).toBe(3);
		outside('notes/a.md', note('title: Changed'), { hint: false });
		hint(null);
		await until(() => notes.row('a')?.fields?.title === 'Changed');
		expect(log.lists).toBe(4);
		expect(folder.files()).toHaveLength(3);
	});

	test('a hint for held media relists instead of reading its bytes', async () => {
		const { hint, log } = await setup({
			'notes/a.md': note('title: A'),
			'audio/take.webm': new Uint8Array([1, 2, 3]),
		});
		const lists = log.lists;
		const reads = log.reads.length;
		hint(['audio/take.webm']);
		await until(() => log.lists === lists + 1);
		await tick();
		expect(log.reads.length).toBe(reads);
	});

	test('a held file removal applies without relisting', async () => {
		const { notes, outside, log } = await setup({
			'notes/a.md': note('title: A'),
		});
		outside('notes/a.md', null);
		await until(() => notes.row('a') === undefined);
		await tick();
		expect(log.lists).toBe(1);
	});

	test('a read error on a held path relists to discover a replacement directory', async () => {
		const { notes, outside, hint, control, log } = await setup({
			'notes/a.md': note('title: A'),
		});
		outside('notes/a.md', null, { hint: false });
		outside('notes/a.md/child.md', note('title: Child'), { hint: false });
		control.failRead.set(
			'notes/a.md',
			ReadError.StorageFailed({ cause: 'path is a directory' }).error,
		);
		hint(['notes/a.md']);
		await until(() => log.lists === 2);
		expect(notes.row('a')).toBeUndefined();
		expect(log.reads.at(-1)).toEqual(['notes/a.md/child.md']);
	});

	test('describes issue locations and joins issue sentences', () => {
		const located = {
			kind: 'schema' as const,
			line: 3,
			path: ['title'],
			message: 'Required',
		};
		const general = {
			kind: 'frontmatter' as const,
			path: [],
			message: 'Invalid YAML',
		};
		expect(describeIssue(located)).toBe('Line 3: title: Required');
		expect(describeIssues([located, general])).toBe(
			'Line 3: title: Required Invalid YAML',
		);
	});
});

describe('based whole-file writes', () => {
	test('matching base puts the replacement after one fresh read', async () => {
		const base = note('title: A');
		const { folder, log, text } = await setup({ 'notes/a.md': base });
		expectOk(await folder.write('notes/a.md', note('title: B'), { base }));
		expect(text('notes/a.md')).toBe(note('title: B'));
		expect(log.reads).toEqual([['notes/a.md'], ['notes/a.md']]);
		expect(log.puts).toEqual([{ path: 'notes/a.md' }]);
	});

	test('stale base merges independent title and body changes', async () => {
		const base = note('title: A');
		const { folder, outside, text } = await setup({ 'notes/a.md': base });
		outside('notes/a.md', note('title: Outside'), { hint: false });
		expectOk(
			await folder.write('notes/a.md', note('title: A', 'Typed\n'), { base }),
		);
		expect(text('notes/a.md')).toBe(note('title: Outside', 'Typed\n'));
	});

	test('overlapping changes use the newer whole-file text', async () => {
		const base = note('title: A');
		const { folder, outside, text } = await setup({ 'notes/a.md': base });
		outside('notes/a.md', note('title: Outside'), { hint: false });
		expectOk(await folder.write('notes/a.md', note('title: Typed'), { base }));
		expect(text('notes/a.md')).toBe(note('title: Typed'));
	});

	test('a null base merges a file created before the turn', async () => {
		const { folder, outside, text } = await setup();
		outside('note.txt', 'Outside\n', { hint: false });
		expectOk(await folder.write('note.txt', 'Typed\n', { base: null }));
		expect(text('note.txt')).toBe('Outside\nTyped\n');
	});

	test('a changed checked put rereads and merges a concurrent update', async () => {
		const base = note('title: A');
		const { folder, control, outside, log, text } = await setup({
			'notes/a.md': base,
		});
		let raced = false;
		control.beforePut = (path) => {
			if (path !== 'notes/a.md' || raced) return;
			raced = true;
			outside(path, note('title: Outside'), { hint: false });
		};
		expectOk(
			await folder.write('notes/a.md', note('title: A', 'Typed\n'), { base }),
		);
		expect(log.puts).toHaveLength(2);
		expect(text('notes/a.md')).toBe(note('title: Outside', 'Typed\n'));
	});

	test('a based write never publishes unchecked after repeated changes', async () => {
		const { folder, control, log, outside, text } = await setup({
			'note.txt': 'A\n',
		});
		let changes = 0;
		control.beforePut = (path) => {
			if (path !== 'note.txt') return;
			outside(path, `A\nOutside ${++changes}\n`, { hint: false });
		};
		expectErr(await folder.write('note.txt', 'Typed\n', { base: 'A\n' }));
		expect(log.puts).toHaveLength(4);
		expect(text('note.txt')).toBe('A\nOutside 4\n');
	});

	test('a later based write carries text from a failed earlier write', async () => {
		const { folder, control, text } = await setup({ 'note.txt': 'A\nB\n' });
		control.failPut.set(
			'note.txt',
			expectErr(SaveError.StorageFailed({ cause: 'full' })),
		);
		expectErr(await folder.write('note.txt', 'A1\nB\n', { base: 'A\nB\n' }));
		control.failPut.clear();
		expectOk(await folder.write('note.txt', 'A1\nB2\n', { base: 'A1\nB\n' }));
		expect(text('note.txt')).toBe('A1\nB2\n');
	});

	test('a third based write carries text across two failed turns', async () => {
		const { folder, control, text } = await setup({ 'note.txt': 'A\nB\n' });
		control.failPut.set(
			'note.txt',
			expectErr(SaveError.StorageFailed({ cause: 'full' })),
		);
		expectErr(await folder.write('note.txt', 'A1\nB\n', { base: 'A\nB\n' }));
		expectErr(await folder.write('note.txt', 'A1\nB2\n', { base: 'A1\nB\n' }));
		control.failPut.clear();
		expectOk(
			await folder.write('note.txt', 'A1\nB2\nC\n', { base: 'A1\nB2\n' }),
		);
		expect(text('note.txt')).toBe('A1\nB2\nC\n');
	});

	test('a failed based write still preserves an outside change', async () => {
		const { folder, control, outside, text } = await setup({
			'note.txt': 'A\nB\n',
		});
		control.failPut.set(
			'note.txt',
			expectErr(SaveError.StorageFailed({ cause: 'full' })),
		);
		expectErr(await folder.write('note.txt', 'A1\nB\n', { base: 'A\nB\n' }));
		control.failPut.clear();
		outside('note.txt', 'A\nB\nOutside\n', { hint: false });
		expectOk(await folder.write('note.txt', 'A1\nB2\n', { base: 'A1\nB\n' }));
		expect(text('note.txt')).toBe('A1\nB2\nOutside\n');
	});

	test('absorbed writes retain the older base', async () => {
		const base = 'A\nB\n';
		const { folder, control, outside, log, text } = await setup({
			'note.txt': base,
		});
		const gate = Promise.withResolvers<void>();
		control.putGate = gate.promise;
		const blocker = folder.write('blocker.txt', 'Block');
		await until(() => log.puts.length === 1);
		const first = folder.write('note.txt', 'A1\nB\n', { base });
		const second = folder.write('note.txt', 'A1\nB2\n', { base: 'A1\nB\n' });
		expect(first).toBe(second);
		outside('note.txt', 'A\nB\nC\n', { hint: false });
		control.putGate = undefined;
		gate.resolve();
		expectOk(await blocker);
		expectOk(await first);
		expect(text('note.txt')).toBe('A1\nB2\nC\n');
	});

	test('independent based writes wait for separate turns and preserve both edits', async () => {
		const base = note('title: A');
		const { folder, control, log, text } = await setup({ 'notes/a.md': base });
		const gate = Promise.withResolvers<void>();
		control.putGate = gate.promise;
		const blocker = folder.write('blocker.txt', 'Block');
		await until(() => log.puts.length === 1);
		const title = folder.write('notes/a.md', note('title: First'), { base });
		const body = folder.write('notes/a.md', note('title: A', 'Second\n'), {
			base,
		});
		expect(title).not.toBe(body);
		control.putGate = undefined;
		gate.resolve();
		expectOk(await blocker);
		expectOk(await title);
		expectOk(await body);
		expect(text('notes/a.md')).toBe(note('title: First', 'Second\n'));
	});

	test('a based write after a waiting plain write keeps their order', async () => {
		const { folder, control, log, text } = await setup({
			'note.txt': 'A\nB\n',
		});
		const gate = Promise.withResolvers<void>();
		control.putGate = gate.promise;
		const blocker = folder.write('blocker.txt', 'Block');
		await until(() => log.puts.length === 1);
		const plain = folder.write('note.txt', 'A1\nB\n');
		const based = folder.write('note.txt', 'A1\nB2\n', { base: 'A1\nB\n' });
		expect(plain).not.toBe(based);
		control.putGate = undefined;
		gate.resolve();
		expectOk(await blocker);
		expectOk(await plain);
		expectOk(await based);
		expect(text('note.txt')).toBe('A1\nB2\n');
	});
});

describe('ordered writes with waiting path merge', () => {
	test('idle waits for the last queued write to land', async () => {
		const { folder, control, text } = await setup();
		let release: () => void = () => {};
		control.putGate = new Promise((resolve) => {
			release = resolve;
		});
		const first = folder.write('first.txt', 'First');
		const second = folder.write('second.txt', 'Second');
		let idle = false;
		const barrier = folder.idle().then(() => {
			idle = true;
		});
		await tick();
		expect(idle).toBe(false);
		control.putGate = undefined;
		release();
		await barrier;
		expect(idle).toBe(true);
		expect(text('second.txt')).toBe('Second');
		expectOk(await first);
		expectOk(await second);
	});
	test('waiting updates merge fields and body before the copy publishes', async () => {
		const { folder, notes, log, text } = await setup({
			'notes/a.md': note('title: A'),
		});
		const first = notes.update('a', { body: 'First\n' });
		const second = notes.update('a', { body: 'Second\n' });
		const third = notes.update('a', { fields: { pinned: true } });
		expect(folder.saving()).toBe(true);
		expect(notes.row('a')?.body).toBe('Body\n');
		expectOk(await first);
		expect(notes.row('a')?.body).toBe('Second\n');
		expectOk(await second);
		expect(notes.row('a')?.body).toBe('Second\n');
		expectOk(await third);
		expect(log.puts).toEqual([{ path: 'notes/a.md' }]);
		expect(text('notes/a.md')).toBe(note('title: A\npinned: true', 'Second\n'));
		expect(folder.saving()).toBe(false);
	});

	test('waiting writes merge and every caller gets the same landed answer', async () => {
		const { folder, log, text } = await setup();
		const first = folder.write('note.txt', 'First');
		const second = folder.write('note.txt', 'Second');
		expect(first).toBe(second);
		expectOk(await first);
		expect(text('note.txt')).toBe('Second');
		expect(log.puts).toEqual([{ path: 'note.txt' }]);
		await folder.idle();
		expect(folder.saving()).toBe(false);
	});

	test('waiting updates keep fields from both patches', async () => {
		const { notes, log, text } = await setup({
			'notes/a.md': note('title: A'),
		});
		const first = notes.update('a', { fields: { title: 'Renamed' } });
		const second = notes.update('a', { fields: { pinned: true } });
		expect(first).toBe(second);
		expectOk(await first);
		expect(text('notes/a.md')).toBe(note('title: Renamed\npinned: true'));
		expect(log.puts).toHaveLength(1);
	});

	test('merged updates read fresh storage at their one turn', async () => {
		const { folder, notes, control, outside, log, text } = await setup({
			'notes/a.md': note('title: A'),
		});
		let release: () => void = () => {};
		control.putGate = new Promise((resolve) => {
			release = resolve;
		});
		const blocker = folder.write('blocker.txt', 'Block');
		await until(() => log.puts.length === 1);
		const first = notes.update('a', { fields: { pinned: true } });
		const second = notes.update('a', { body: 'Typed\n' });
		expect(first).toBe(second);
		outside('notes/a.md', note('title: Outside'), { hint: false });
		control.putGate = undefined;
		release();
		expectOk(await blocker);
		expectOk(await first);
		expect(text('notes/a.md')).toBe(
			note('title: Outside\npinned: true', 'Typed\n'),
		);
		expect(log.reads).toEqual([['notes/a.md'], ['notes/a.md']]);
		expect(log.puts).toHaveLength(2);
	});

	test('merged callers share a failed answer', async () => {
		const { folder, control, log } = await setup();
		control.failPut.set(
			'note.txt',
			expectErr(SaveError.StorageFailed({ cause: 'full' })),
		);
		const first = folder.write('note.txt', 'First');
		const second = folder.write('note.txt', 'Second');
		expect(first).toBe(second);
		expect(expectErr(await first).name).toBe('StorageFailed');
		expect(expectErr(await second).name).toBe('StorageFailed');
		expect(log.puts).toEqual([{ path: 'note.txt' }]);
	});

	test('a started turn never merges with a later write', async () => {
		const { folder, control, log, text } = await setup();
		let release: () => void = () => {};
		control.putGate = new Promise((resolve) => {
			release = resolve;
		});
		const first = folder.write('note.txt', 'First');
		await until(() => log.puts.length === 1);
		const second = folder.write('note.txt', 'Second');
		expect(first).not.toBe(second);
		control.putGate = undefined;
		release();
		expectOk(await first);
		expect(text('note.txt')).toBe('First');
		expectOk(await second);
		expect(text('note.txt')).toBe('Second');
		expect(log.puts).toHaveLength(2);
	});

	test('a waiting write and update keep separate turns', async () => {
		const { folder, control, log, text } = await setup({
			'notes/a.md': note('title: A'),
		});
		let release: () => void = () => {};
		control.putGate = new Promise((resolve) => {
			release = resolve;
		});
		const blocker = folder.write('blocker.txt', 'Block');
		await until(() => log.puts.length === 1);
		const write = folder.write('notes/a.md', note('title: B'));
		const update = folder.tables.notes.update('a', {
			fields: { pinned: true },
		});
		expect(write).not.toBe(update);
		control.putGate = undefined;
		release();
		expectOk(await blocker);
		expectOk(await write);
		expectOk(await update);
		expect(log.puts.map(({ path }) => path)).toEqual([
			'blocker.txt',
			'notes/a.md',
			'notes/a.md',
		]);
		expect(text('notes/a.md')).toBe(note('title: B\npinned: true'));
	});

	test('updates with different schema key orders keep separate turns', async () => {
		const { folder, control, log } = await setup({
			'notes/a.md': note('title: A'),
		});
		let release: () => void = () => {};
		control.putGate = new Promise((resolve) => {
			release = resolve;
		});
		const blocker = folder.write('blocker.txt', 'Block');
		await until(() => log.puts.length === 1);
		const first = folder.update(
			'notes/a.md',
			{ fields: { title: 'B' } },
			{ schema: Type.Object({ title: Type.String(), pinned: Type.Boolean() }) },
		);
		const second = folder.update(
			'notes/a.md',
			{ fields: { pinned: true } },
			{ schema: Type.Object({ pinned: Type.Boolean(), title: Type.String() }) },
		);
		expect(first).not.toBe(second);
		control.putGate = undefined;
		release();
		await Promise.all([blocker, first, second]);
		expect(log.puts.map(({ path }) => path)).toEqual([
			'blocker.txt',
			'notes/a.md',
			'notes/a.md',
		]);
	});

	test('an intervening path does not prevent a waiting write from merging', async () => {
		const { folder, control, log } = await setup();
		let release: () => void = () => {};
		control.putGate = new Promise((resolve) => {
			release = resolve;
		});
		const blocker = folder.write('blocker.txt', 'Block');
		await until(() => log.puts.length === 1);
		const first = folder.write('note.txt', 'First');
		const other = folder.write('other.txt', 'Other');
		const last = folder.write('note.txt', 'Last');
		expect(first).toBe(last);
		control.putGate = undefined;
		release();
		await Promise.all([blocker, first, other, last]);
		expect(log.puts.map(({ path }) => path)).toEqual([
			'blocker.txt',
			'note.txt',
			'other.txt',
		]);
	});

	test('a queued hint reread does not prevent a waiting write from merging', async () => {
		const { folder, control, hint, log, text } = await setup({
			'note.txt': 'Old',
		});
		const gate = Promise.withResolvers<void>();
		control.putGate = gate.promise;
		const blocker = folder.write('blocker.txt', 'Block');
		await until(() => log.puts.length === 1);
		const first = folder.write('note.txt', 'First');
		hint(['note.txt']);
		const second = folder.write('note.txt', 'Second');
		expect(first).toBe(second);
		control.putGate = undefined;
		gate.resolve();
		await Promise.all([blocker, first, second]);
		expect(text('note.txt')).toBe('Second');
		expect(log.puts.map(({ path }) => path)).toEqual([
			'blocker.txt',
			'note.txt',
		]);
	});

	test('a move prevents waiting destination writes on either side from merging', async () => {
		const { folder, control, log, text } = await setup({
			'from.txt': 'Source',
		});
		const gate = Promise.withResolvers<void>();
		control.putGate = gate.promise;
		const blocker = folder.write('blocker.txt', 'Block');
		await until(() => log.puts.length === 1);
		const first = folder.write('to.txt', 'First');
		const move = folder.move('from.txt', 'to.txt');
		const last = folder.write('to.txt', 'Last');
		expect(first).not.toBe(last);
		control.putGate = undefined;
		gate.resolve();
		expectOk(await blocker);
		expectOk(await first);
		expect(expectErr(await move).name).toBe('Exists');
		expectOk(await last);
		expect(text('to.txt')).toBe('Last');
		expect(text('from.txt')).toBe('Source');
	});

	test('an unconditional same-text write keeps the row object', async () => {
		const { folder, notes, log } = await setup({
			'notes/a.md': note('title: A'),
		});
		const row = notes.row('a');
		expectOk(await folder.write('notes/a.md', note('title: A')));
		expect(log.puts).toEqual([{ path: 'notes/a.md' }]);
		expect(notes.row('a')).toBe(row);
		expect(notes.rows()[0]).toBe(row);
	});

	test('create and update compose at their turns; create refuses an unheard outside file', async () => {
		const { notes, outside, folder, text, log } = await setup();
		const made = notes.create('a', { fields: { title: 'A' } });
		const changed = notes.update('a', { fields: { pinned: true } });
		expectOk(await made);
		expectOk(await changed);
		expect(text('notes/a.md')).toBe(note('title: A\npinned: true', ''));
		expect(
			expectErr(await notes.create('a', { fields: { title: 'Again' } })).name,
		).toBe('Exists');
		outside('notes/b.md', note('title: Outside'), { hint: false });
		expect(
			expectErr(await notes.create('b', { fields: { title: 'Mine' } })).name,
		).toBe('Exists');
		expect(text('notes/b.md')).toBe(note('title: Outside'));
		await folder.refresh();
		expect(
			expectErr(await notes.create('b', { fields: { title: 'Again' } })).name,
		).toBe('Exists');
		expect(log.puts).toHaveLength(5);
	});

	test('update keeps an outside change already heard by the copy', async () => {
		const { notes, outside, text } = await setup({
			'notes/a.md': note('title: A'),
		});
		outside('notes/a.md', note('title: Outside'));
		await tick();
		expectOk(await notes.update('a', { fields: { pinned: true } }));
		expect(text('notes/a.md')).toBe(note('title: Outside\npinned: true'));
	});

	test('update preserves an outside field change the copy has not heard', async () => {
		const { notes, outside, text } = await setup({
			'notes/a.md': note('title: A'),
		});
		outside('notes/a.md', note('title: Outside'), { hint: false });
		expect(notes.row('a')?.fields?.title).toBe('A');
		expectOk(await notes.update('a', { fields: { pinned: true } }));
		expect(text('notes/a.md')).toBe(note('title: Outside\npinned: true'));
		expect(notes.row('a')?.fields?.title).toBe('Outside');
	});

	test('update refuses an outside deletion the copy has not heard', async () => {
		const { notes, outside, log } = await setup({
			'notes/a.md': note('title: A'),
		});
		outside('notes/a.md', null, { hint: false });
		expect(expectErr(await notes.update('a', { body: 'Changed' })).name).toBe(
			'NothingToUpdate',
		);
		expect(notes.row('a')).toBeUndefined();
		expect(log.puts).toEqual([]);
	});

	test('unchanged update refreshes an unheard outside change without writing', async () => {
		const { notes, outside, log } = await setup({
			'notes/a.md': note('title: A'),
		});
		outside('notes/a.md', note('title: Outside'), { hint: false });
		expectOk(await notes.update('a', { fields: { title: 'Outside' } }));
		expect(notes.row('a')?.fields?.title).toBe('Outside');
		expect(log.puts).toEqual([]);
	});

	test('update read failure returns StorageFailed without a put', async () => {
		const { notes, control, log } = await setup({
			'notes/a.md': note('title: A'),
		});
		control.failRead.set(
			'notes/a.md',
			ReadError.StorageFailed({ cause: 'read failed' }).error,
		);
		expect(expectErr(await notes.update('a', { body: 'Changed' })).name).toBe(
			'StorageFailed',
		);
		expect(notes.row('a')?.fields?.title).toBe('A');
		expect(log.puts).toEqual([]);
	});

	test('an outside write after composition is read again and both fields survive', async () => {
		const { notes, control, outside, text } = await setup({
			'notes/a.md': note('title: A'),
		});
		let raced = false;
		control.beforePut = () => {
			if (raced) return;
			raced = true;
			outside('notes/a.md', note('title: Outside'), { hint: false });
		};
		expectOk(await notes.update('a', { fields: { pinned: true } }));
		expect(text('notes/a.md')).toBe(note('title: Outside\npinned: true'));
	});

	test('three changed puts retry, then the fourth lands unconditionally', async () => {
		const { notes, control, outside, log, text } = await setup({
			'notes/a.md': note('title: A'),
		});
		let races = 0;
		control.beforePut = () => {
			if (races++ < 3)
				outside('notes/a.md', note(`title: Outside${races}`), { hint: false });
		};
		expectOk(await notes.update('a', { fields: { pinned: true } }));
		expect(log.puts).toHaveLength(4);
		expect(text('notes/a.md')).toBe(note('title: Outside3\npinned: true'));
	});

	test('move reads queued typing, refuses an occupied target, and keeps both files after failed removal', async () => {
		const { folder, control, text } = await setup();
		const typed = folder.write('draft.txt', 'Latest');
		const moved = folder.move('draft.txt', 'final.txt');
		expectOk(await typed);
		expectOk(await moved);
		expect(text('draft.txt')).toBeUndefined();
		expect(text('final.txt')).toBe('Latest');
		expect(expectErr(await folder.move('final.txt', 'final.txt')).name).toBe(
			'Exists',
		);
		expectOk(await folder.write('other.txt', 'Other'));
		expect(expectErr(await folder.move('final.txt', 'other.txt')).name).toBe(
			'Exists',
		);
		expect(text('final.txt')).toBe('Latest');
		control.failPut.set(
			'final.txt',
			expectErr(SaveError.StorageFailed({ cause: 'denied' })),
		);
		const failed = expectErr(await folder.move('final.txt', 'copy.txt'));
		expect(failed.name).toBe('MoveIncomplete');
		expect(text('final.txt')).toBe('Latest');
		expect(text('copy.txt')).toBe('Latest');
		expect(folder.file('final.txt')).toBeDefined();
		expect(folder.file('copy.txt')).toBeDefined();
	});

	test('a create whose stale reply reads back its own bytes landed', async () => {
		const memory = memoryHost();
		const put = memory.storage.put;
		memory.storage.put = async (path, bytes, expected) => {
			const result = await put(path, bytes, expected);
			return result.error === null && expected === 'absent'
				? SaveError.Changed({ path })
				: result;
		};
		const folder = expectOk(await createFolder(memory.storage, { tables }));
		expectOk(
			await folder.tables.notes.create('a', {
				fields: { title: 'A' },
				body: 'Saved',
			}),
		);
		expect(folder.tables.notes.row('a')?.body).toBe('Saved');
		expect(memory.text('notes/a.md')).toContain('Saved');
	});

	test('move accepts stale replies after both the copy and removal land', async () => {
		const memory = memoryHost({ 'from.txt': 'Moved' });
		const put = memory.storage.put;
		memory.storage.put = async (path, bytes, expected) => {
			const result = await put(path, bytes, expected);
			return result.error === null ? SaveError.Changed({ path }) : result;
		};
		const folder = expectOk(await createFolder(memory.storage, { tables }));
		expectOk(await folder.move('from.txt', 'to.txt'));
		expect(folder.file('from.txt')).toBeUndefined();
		expect(folder.file('to.txt')?.data).toBe('Moved');
		expect(memory.text('from.txt')).toBeUndefined();
		expect(memory.text('to.txt')).toBe('Moved');
	});

	test('move from a missing source explains what could not move', async () => {
		const { folder } = await setup();
		const error = expectErr(await folder.move('missing.txt', 'target.txt'));
		expect(error.name).toBe('NothingToMove');
		expect(error.message).toBe('There is no file at missing.txt to move');
	});

	test('no-op patch writes nothing; changed patch canonicalizes and removes undefined', async () => {
		const { notes, log, text } = await setup({
			'notes/a.md': note("zeta: 1 # comment\npinned: false\ntitle: 'A'"),
		});
		expectOk(await notes.update('a', { fields: { title: 'A' } }));
		expect(log.puts).toEqual([]);
		expectOk(await notes.update('a', { fields: { pinned: undefined } }));
		expect(text('notes/a.md')).toBe(note('title: A\nzeta: 1'));
	});

	test('missing, binary, and broken header updates refuse without a put', async () => {
		const { folder, log } = await setup({
			'bytes.md': new Uint8Array([0xff]),
			'broken.md': '---\ntitle: A\n',
		});
		expect(expectErr(await folder.update('gone.md', { body: 'x' })).name).toBe(
			'NothingToUpdate',
		);
		expect(expectErr(await folder.update('bytes.md', { body: 'x' })).name).toBe(
			'NotText',
		);
		expect(
			expectErr(await folder.update('broken.md', { body: 'x' })).name,
		).toBe('Unparseable');
		expect(log.puts).toEqual([]);
	});

	test('schema order applies to nested and root Markdown updates', async () => {
		const { folder, text } = await setup({
			'a.md': note('alpha: old\nzeta: old'),
			'x/y/z.md': note('title: Nested'),
		});
		const schema = Type.Object({ zeta: Type.String(), alpha: Type.String() });
		expectOk(
			await folder.update(
				'a.md',
				{ fields: { zeta: 'Z', alpha: 'A' } },
				{ schema },
			),
		);
		expect(text('a.md')).toBe(note('zeta: Z\nalpha: A'));
		expectOk(await folder.update('x/y/z.md', { body: 'Changed\n' }));
		expect(text('x/y/z.md')).toBe(note('title: Nested', 'Changed\n'));
	});

	test('valid UTF-8 bytes at a text path remain editable as text', async () => {
		const { folder, notes } = await setup();
		expectOk(
			await folder.write(
				'notes/a.md',
				new TextEncoder().encode(note('title: A')),
			),
		);
		expect(folder.file('notes/a.md')?.data).toBe(note('title: A'));
		expectOk(await notes.update('a', { fields: { pinned: true } }));
	});

	test('invalid table IDs refuse without touching storage', async () => {
		const { notes, log } = await setup();
		expect(expectErr(await notes.delete('sub/deep')).name).toBe('InvalidId');
		expect(log.puts).toEqual([]);
	});

	test('failed update put leaves the fresh outside value in the copy', async () => {
		const { notes, control, outside } = await setup({
			'notes/a.md': note('title: A'),
		});
		outside('notes/a.md', note('title: Outside'), { hint: false });
		const error = SaveError.StorageFailed({ cause: 'disk full' }).error;
		control.failPut.set('notes/a.md', error);
		expect(expectErr(await notes.update('a', { body: 'Typed' }))).toBe(error);
		expect(notes.row('a')?.fields?.title).toBe('Outside');
		expect(notes.row('a')?.body).toBe('Body\n');
	});
});

describe('reads and closing', () => {
	test('refresh relists additions, changes, and deletions', async () => {
		const { folder, notes, outside } = await setup({
			'notes/a.md': note('title: A'),
		});
		outside('notes/a.md', note('title: Moved'), { hint: false });
		outside('notes/b.md', note('title: New'), { hint: false });
		await folder.refresh();
		expect(notes.rows().map((row) => row.fields?.title)).toEqual([
			'Moved',
			'New',
		]);
		outside('notes/a.md', null, { hint: false });
		await folder.refresh();
		expect(notes.rows().map((row) => row.id)).toEqual(['b']);
	});

	test('a listing started before a create cannot erase its landed row', async () => {
		const { folder, notes, control, log } = await setup();
		let release: () => void = () => {};
		control.listGate = new Promise((resolve) => {
			release = resolve;
		});
		const refreshing = folder.refresh();
		await tick();
		expect(log.lists).toBe(2);
		const made = notes.create('a', { fields: { title: 'A' } });
		control.listGate = undefined;
		release();
		await refreshing;
		expectOk(await made);
		expect(notes.row('a')?.fields).toEqual({ title: 'A' });
	});

	test('close drains queued puts, releases the host, and refuses later writes', async () => {
		const { folder, notes, control, text } = await setup({
			'notes/a.md': note('title: A'),
		});
		let release: () => void = () => {};
		control.putGate = new Promise((resolve) => {
			release = resolve;
		});
		const first = notes.update('a', { body: 'First\n' });
		const last = notes.update('a', { body: 'Last\n' });
		const closing = folder.close();
		expect(expectErr(await notes.update('a', { body: 'Late' })).name).toBe(
			'Closed',
		);
		expect(control.closed).toBe(false);
		control.putGate = undefined;
		release();
		await closing;
		expectOk(await first);
		expectOk(await last);
		expect(text('notes/a.md')).toBe(note('title: A', 'Last\n'));
		expect(control.closed).toBe(true);
	});
});
