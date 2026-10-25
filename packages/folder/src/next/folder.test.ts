import { describe, expect, test } from 'bun:test';
import { Type } from 'typebox';
import { expectOk } from 'wellcrafted/testing';
import { SaveError } from '../shared/errors.js';
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
const THROTTLE = 20;

async function setup(initial: Record<string, string | Uint8Array> = {}) {
	const memory = memoryHost(initial);
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
		expect(notes.rows().map((row) => row.fields?.title)).toEqual(['A', 'B']);
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
		const memory = memoryHost();
		memory.control.listFails = true;
		const opened = await createFolder(memory.storage, { tables });
		expect(opened.error?.name).toBe('Unavailable');
	});

	test('an invalid table name refuses before listing', async () => {
		const memory = memoryHost();
		const opened = await createFolder(memory.storage, {
			tables: { 'bad/name': tables.notes },
		});
		expect(opened.error).toMatchObject({
			name: 'InvalidTable',
			table: 'bad/name',
		});
		expect(memory.log.lists).toBe(0);
	});

	test('a malformed Unicode table name is refused before listing', async () => {
		const memory = memoryHost();
		const opened = await createFolder(memory.storage, {
			tables: { '\ud800': tables.notes },
		});
		expect(opened.error).toMatchObject({
			name: 'InvalidTable',
			table: '\ud800',
		});
		expect(memory.log.lists).toBe(0);
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
		expect(notes.row('a')).toBe(notes.rows()[0]);
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
		const [a, b] = notes.rows();
		await notes.update('a', { fields: { title: 'A2' } });
		const [a2, b2] = notes.rows();
		expect(a2).not.toBe(a);
		expect(b2).toBe(b);
	});

	test('a failed write leaves the mirror on the disk', async () => {
		const { notes, control } = await setup({ 'notes/a.md': note('title: A') });
		const error = SaveError.StorageFailed({ cause: 'disk full' }).error;
		control.failPut.set('notes/a.md', error);
		const saved = await notes.update('a', { body: 'Typed\n' });
		expect(saved.error).toBe(error);
		expect(notes.row('a')?.body).toBe('Body\n');
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
	test('settled sends this path now without relisting and waits for later writes', async () => {
		const memory = memoryHost({ 'notes/a.md': note('title: A') });
		const folder = expectOk(
			await createFolder(memory.storage, { tables, throttleMs: 10_000 }),
		);
		let release: () => void = () => {};
		memory.control.putGate = new Promise((resolve) => {
			release = resolve;
		});
		const first = folder.tables.notes.update('a', { body: 'First\n' });
		const done = folder.settled('notes/a.md');
		let settled = false;
		void done.then(() => {
			settled = true;
		});
		await tick();
		expect(memory.log.puts).toHaveLength(1);
		const second = folder.tables.notes.update('a', { body: 'Second\n' });
		memory.control.putGate = undefined;
		release();
		let answered = false;
		void second.then(() => {
			answered = true;
		});
		await done;
		expect(settled).toBe(true);
		expect(answered).toBe(true);
		expect((await first).error).toBeNull();
		expect((await second).error).toBeNull();
		expect(memory.text('notes/a.md')).toBe(note('title: A', 'Second\n'));
		expect(memory.log.lists).toBe(1);
	});

	test('a quiet disk still throttles successive writes to one path', async () => {
		const memory = memoryHost({ 'notes/a.md': note('title: A') });
		const folder = expectOk(
			await createFolder(memory.storage, { tables, throttleMs: 100 }),
		);
		const saves = [];
		for (let index = 0; index < 20; index++) {
			saves.push(folder.tables.notes.update('a', { body: `${index}\n` }));
			await tick(20);
		}
		await folder.settled('notes/a.md');
		await Promise.all(saves);
		expect(memory.log.puts.length).toBeLessThanOrEqual(6);
		expect(memory.text('notes/a.md')).toBe(note('title: A', '19\n'));
	});

	test('onFailed reports one failed batch with its last typed text after Saved answers', async () => {
		const { folder, control } = await setup({ 'notes/a.md': note('title: A') });
		control.failPut.set(
			'notes/a.md',
			SaveError.StorageFailed({ cause: 'disk full' }).error,
		);
		const order: string[] = [];
		const failures: import('./folder.js').SaveFailure[] = [];
		folder.onFailed((failure) => {
			order.push('failure');
			failures.push(failure);
		});
		const first = folder.tables.notes.update('a', { body: 'First' });
		const second = folder.tables.notes.update('a', { body: 'Second' });
		void second.then(() => order.push('saved'));
		await Promise.all([first, second]);
		await folder.settled('notes/a.md');
		expect(order).toEqual(['saved', 'failure']);
		expect(failures).toMatchObject([{ path: 'notes/a.md', text: 'Second' }]);
		await folder.tables.notes.create('a', { fields: { title: 'Duplicate' } });
		await tick();
		expect(failures).toHaveLength(1);
	});
	test('writes queued before the first send fold into one', async () => {
		const { notes, log, text } = await setup({
			'notes/a.md': note('title: A'),
		});
		const first = notes.update('a', { body: 'One\n' });
		const second = notes.update('a', { body: 'Two\n' });
		const third = notes.update('a', { fields: { pinned: true } });
		expect(log.puts.length).toBe(0);
		expect((await first).error).toBeNull();
		expect((await second).error).toBeNull();
		expect((await third).error).toBeNull();
		expect(log.puts.length).toBe(1);
		expect(text('notes/a.md')).toBe(note('title: A\npinned: true', 'Two\n'));
	});

	test('an update applies to the file as it is when the save runs', async () => {
		const memory = memoryHost({ 'notes/a.md': note('title: A') });
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
		const memory = memoryHost({ 'notes/a.md': note('title: A') });
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
		const memory = memoryHost({ 'notes/a.md': note('title: A') });
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
		expect(folder.files()).toEqual([]);
	});

	test('saving is true while a write waits or is in flight', async () => {
		const { folder, notes } = await setup({ 'notes/a.md': note('title: A') });
		const seen: boolean[] = [];
		folder.subscribe(() => seen.push(folder.saving()));
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
		expect(notes.rows().map((row) => row.fields?.title)).toEqual([
			'Moved',
			'New',
		]);
		outside('notes/a.md', null, { hint: false });
		folder.checkpoint();
		await tick();
		expect(notes.rows().map((row) => row.id)).toEqual(['b']);
	});

	test('an older queued read finishes before a later write', async () => {
		const { notes, control, outside } = await setup({
			'notes/a.md': note('title: A'),
		});
		let release: () => void = () => {};
		control.readGate = new Promise((resolve) => {
			release = resolve;
		});
		outside('notes/a.md', note('title: Before'));
		await tick();
		const saved = notes.update('a', { body: 'Mine\n' });
		control.readGate = undefined;
		release();
		expect((await saved).error).toBeNull();
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

describe('serial mirror changes', () => {
	test('a listing started before a create cannot erase its landed row', async () => {
		const { folder, notes, control, log } = await setup();
		let release: () => void = () => {};
		control.listGate = new Promise((resolve) => {
			release = resolve;
		});
		folder.checkpoint();
		await tick();
		expect(log.lists).toBe(2);
		const made = notes.create('a', { fields: { title: 'A' } });
		control.listGate = undefined;
		release();
		expect((await made).error).toBeNull();
		expect(notes.row('a')?.fields).toEqual({ title: 'A' });
	});

	test('an older delayed read cannot overwrite a newer read', async () => {
		const { notes, outside, control, log } = await setup({
			'notes/a.md': note('title: A'),
		});
		let release: () => void = () => {};
		control.readGate = new Promise((resolve) => {
			release = resolve;
		});
		outside('notes/a.md', note('title: Older'));
		await tick();
		expect(log.reads.length).toBe(2);
		outside('notes/a.md', note('title: Newer'));
		control.readGate = undefined;
		release();
		await tick();
		expect(notes.row('a')?.fields).toEqual({ title: 'Newer' });
	});

	test('a refused create leaves a following update to apply over the existing file', async () => {
		const { notes, text, log } = await setup({
			'notes/a.md': note('title: A'),
		});
		const created = notes.create('a', { fields: { title: 'Mine' } });
		const updated = notes.update('a', { fields: { pinned: true } });
		expect((await created).error?.name).toBe('Exists');
		expect((await updated).error).toBeNull();
		expect(text('notes/a.md')).toBe(note('title: A\npinned: true'));
		expect(log.puts).toHaveLength(1);
	});

	test('unknown binary extensions are listed but not read or retained', async () => {
		const { folder, log } = await setup({
			'photo.heic': new Uint8Array([1]),
			'data.bin': new Uint8Array([2]),
		});
		expect(log.reads).toEqual([]);
		expect(folder.files().map((file) => file.path)).toEqual([
			'data.bin',
			'photo.heic',
		]);
		expect(
			(await folder.write('photo.png', new Uint8Array([3]))).error,
		).toBeNull();
		expect(folder.file('photo.png')?.data).toBeUndefined();
		expect((await folder.delete('photo.heic')).error).toBeNull();
		expect(folder.file('photo.heic')).toBeUndefined();
	});

	test('table delete rejects a nested id without deleting anything', async () => {
		const { notes, log } = await setup({ 'notes/a.md': note('title: A') });
		expect((await notes.delete('sub/deep')).error?.name).toBe('InvalidId');
		expect(log.puts).toEqual([]);
		expect(notes.row('a')).toBeDefined();
	});

	test('a folded batch sends one notice when it lands', async () => {
		const { folder, notes } = await setup({ 'notes/a.md': note('title: A') });
		const seen: string[][] = [];
		folder.subscribe(() => seen.push(notes.rows().map((row) => row.id)));
		const first = notes.update('a', { body: 'First\n' });
		const second = notes.update('a', { body: 'Second\n' });
		await Promise.all([first, second]);
		expect(seen).toEqual([['a'], ['a']]);
	});
});

test('checkpoint sends work waiting behind an in-flight send immediately', async () => {
	const memory = memoryHost({ 'notes/a.md': note('title: A') });
	const folder = expectOk(
		await createFolder(memory.storage, { tables, throttleMs: 10_000 }),
	);
	let release: () => void = () => {};
	memory.control.putGate = new Promise((resolve) => {
		release = resolve;
	});
	const first = folder.tables.notes.update('a', { body: 'First\n' });
	await tick();
	const second = folder.tables.notes.update('a', { body: 'Second\n' });
	folder.checkpoint();
	memory.control.putGate = undefined;
	release();
	expect((await first).error).toBeNull();
	expect((await second).error).toBeNull();
	expect(memory.log.puts).toHaveLength(2);
});

test('valid UTF-8 bytes written to a text path remain editable as text', async () => {
	const { folder, notes } = await setup();
	const bytes = new TextEncoder().encode(note('title: A'));
	expect((await folder.write('notes/a.md', bytes)).error).toBeNull();
	expect(folder.file('notes/a.md')?.data).toBe(note('title: A'));
	expect(notes.row('a')?.issues).toBeNull();
	expect(
		(await notes.update('a', { fields: { pinned: true } })).error,
	).toBeNull();
});

test('a relist becomes visible after all its reads finish', async () => {
	const { folder, notes, outside, control, log } = await setup({
		'notes/a.md': note('title: A'),
		'notes/b.md': note('title: B'),
	});
	let release: () => void = () => {};
	control.readGate = new Promise((resolve) => {
		release = resolve;
	});
	outside('notes/a.md', null, { hint: false });
	outside('notes/b.md', note('title: Changed'), { hint: false });
	folder.checkpoint();
	await tick();
	expect(log.reads).toHaveLength(2);
	expect(folder.file('notes/a.md')).toBeDefined();
	expect(folder.files().map((file) => file.path)).toEqual([
		'notes/a.md',
		'notes/b.md',
	]);
	expect(notes.row('b')?.fields).toEqual({ title: 'B' });
	control.readGate = undefined;
	release();
	await tick();
	expect(folder.file('notes/a.md')).toBeUndefined();
	expect(notes.row('b')?.fields).toEqual({ title: 'Changed' });
});

describe('folder-level structured updates', () => {
	test('updates root and nested Markdown files', async () => {
		const { folder, text } = await setup({
			'a.md': note('title: Root'),
			'x/y/z.md': note('title: Nested'),
		});
		expect(
			(await folder.update('a.md', { fields: { pinned: true } })).error,
		).toBeNull();
		expect(
			(await folder.update('x/y/z.md', { body: 'Changed\n' })).error,
		).toBeNull();
		expect(text('a.md')).toBe(note('pinned: true\ntitle: Root'));
		expect(text('x/y/z.md')).toBe(note('title: Nested', 'Changed\n'));
	});

	test('two updates inside the throttle both land', async () => {
		const { folder, text } = await setup({ 'a.md': note('title: A') });
		const first = folder.update('a.md', { fields: { alpha: 'A' } });
		const second = folder.update('a.md', { fields: { beta: 'B' } });
		expect((await first).error).toBeNull();
		expect((await second).error).toBeNull();
		expect(text('a.md')).toBe(note('alpha: A\nbeta: B\ntitle: A'));
	});

	test('missing path refuses NothingToUpdate', async () => {
		const { folder, log } = await setup();
		expect((await folder.update('missing.md', { body: 'X' })).error?.name).toBe(
			'NothingToUpdate',
		);
		expect(log.puts).toEqual([]);
	});

	test('schema order wins when given, and unknown keys sort otherwise', async () => {
		const { folder, text } = await setup({
			'a.md': note('alpha: old\nzeta: old'),
		});
		const schema = Type.Object({ zeta: Type.String(), alpha: Type.String() });
		expect(
			(
				await folder.update(
					'a.md',
					{ fields: { zeta: 'Z', alpha: 'A' } },
					{ schema },
				)
			).error,
		).toBeNull();
		expect(text('a.md')).toBe(note('zeta: Z\nalpha: A'));
		expect(
			(await folder.update('a.md', { fields: { zeta: 'ZZ' } })).error,
		).toBeNull();
		expect(text('a.md')).toBe(note('alpha: A\nzeta: ZZ'));
	});

	test('a Saved answer follows the mirror change', async () => {
		const { folder, notes } = await setup();
		expect(
			(await notes.create('new', { fields: { title: 'Now' } })).error,
		).toBeNull();
		expect(notes.row('new')?.fields).toEqual({ title: 'Now' });
		expect(folder.file('notes/new.md')?.data).toBe(note('title: Now', ''));
	});
});

test('dotfiles and extensionless files are kept at open', async () => {
	const { folder, log } = await setup({
		'.gitignore': 'node_modules\n',
		Makefile: 'all:\n',
		'photo.heic': new Uint8Array([1, 2, 3]),
	});
	expect(log.reads).toEqual([['.gitignore', 'Makefile']]);
	expect(folder.file('.gitignore')?.data).toBe('node_modules\n');
	expect(folder.file('Makefile')?.data).toBe('all:\n');
	expect(folder.file('photo.heic')?.data).toBeUndefined();
});

describe('readRow', () => {
	test('reads text as the mirror reads a saved row', () => {
		const valid = readRow(note('title: A'), tables.notes);
		expect(valid).toEqual({
			fields: { title: 'A' },
			body: 'Body\n',
			issues: null,
		});
		const broken = readRow(note('pinned: true'), tables.notes);
		expect(broken.issues?.[0]?.kind).toBe('schema');
	});
});
