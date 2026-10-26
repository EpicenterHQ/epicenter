/**
 * The folder's landed copy, ordered writes, outside reads, and close.
 * Each Saved answer follows the copy change; updates use the copy at their
 * turn, while outside writes that it has not heard about may be overwritten.
 */
import { describe, expect, test } from 'bun:test';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { SaveError } from './shared/errors.js';
import { createFolder, readRow } from './folder.js';
import { memoryHost, tick } from './testing.js';

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
});

describe('one ordered put per write', () => {
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

	test('failed put leaves the copy unchanged', async () => {
		const { notes, control } = await setup({ 'notes/a.md': note('title: A') });
		const error = SaveError.StorageFailed({ cause: 'disk full' }).error;
		control.failPut.set('notes/a.md', error);
		expect(expectErr(await notes.update('a', { body: 'Typed' }))).toBe(error);
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
