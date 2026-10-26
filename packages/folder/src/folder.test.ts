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

describe('one ordered put per write', () => {
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
	test('writes each operation in order and resolves after the copy shows it', async () => {
		const { folder, notes, log, text } = await setup({
			'notes/a.md': note('title: A'),
		});
		const first = notes.update('a', { body: 'First\n' });
		const second = notes.update('a', { body: 'Second\n' });
		const third = notes.update('a', { fields: { pinned: true } });
		expect(folder.saving()).toBe(true);
		expect(notes.row('a')?.body).toBe('Body\n');
		expectOk(await first);
		expect(notes.row('a')?.body).toBe('First\n');
		expectOk(await second);
		expect(notes.row('a')?.body).toBe('Second\n');
		expectOk(await third);
		expect(log.puts).toEqual([
			{ path: 'notes/a.md' },
			{ path: 'notes/a.md' },
			{ path: 'notes/a.md' },
		]);
		expect(text('notes/a.md')).toBe(note('title: A\npinned: true', 'Second\n'));
		expect(folder.saving()).toBe(false);
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

	test('create and update compose at their turns; create refuses only a file in the copy', async () => {
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
		expectOk(await notes.create('b', { fields: { title: 'Mine' } }));
		expect(text('notes/b.md')).toBe(note('title: Mine', ''));
		await folder.refresh();
		expect(
			expectErr(await notes.create('b', { fields: { title: 'Again' } })).name,
		).toBe('Exists');
		expect(log.puts).toHaveLength(3);
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

	test('an outside write after composition loses to the put', async () => {
		const { notes, control, outside, text } = await setup({
			'notes/a.md': note('title: A'),
		});
		control.beforePut = () =>
			outside('notes/a.md', note('title: Outside'), { hint: false });
		expectOk(await notes.update('a', { fields: { pinned: true } }));
		expect(text('notes/a.md')).toBe(note('title: A\npinned: true'));
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
