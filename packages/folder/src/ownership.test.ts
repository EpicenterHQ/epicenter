/**
 * Byte Ownership, Row Files, and Directory Tests
 *
 * Counterexamples at the folder's file boundary: bytes must be the caller's
 * bytes at call time, table operations must touch only the literal row file,
 * and empty directories must behave as directories.
 *
 * Key behaviors:
 * - Every content verb copies the caller's array before any await, so saved
 *   bytes and the returned capture match what was passed
 * - Rename and delete change exactly one Markdown file, guarded by the
 *   captured sha256; a stale capture is a `Conflict`
 * - A stem is one literal segment; `todos/a/b.md` is not a row, while an
 *   externally written row with an invalid stem stays listable
 * - An empty directory lists and removes
 *
 * See also:
 * - `browser.test.ts` for table CRUD and history
 * - `files.test.ts` for captures and the file verbs
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	defineFolder,
	defineTable,
	type Folder,
	field,
	openFolder,
} from './browser.js';
import { testBrowserStorage } from './browser-storage.test-support.js';
import { hashBytes } from './capture.js';

const definition = defineFolder({
	kv: {},
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});
const opened: Folder<typeof definition>[] = [];
const encoder = new TextEncoder();

async function open() {
	const folder = expectOk(
		await openFolder({
			id: 'ownership',
			definition,
			browser: {
				author: { name: 'Owner', email: 'owner@example.test' },
				...testBrowserStorage(),
			},
		}),
	);
	opened.push(folder);
	return folder;
}

afterEach(async () => {
	for (const folder of opened.splice(0)) await folder.close();
});

describe('byte ownership', () => {
	test('create and save each own their bytes before the caller can mutate them', async () => {
		const folder = await open();
		const first = await hashBytes(encoder.encode('AAAA'));

		const content = encoder.encode('AAAA');
		const creating = folder.files.create('bytes.txt', content);
		content.set(encoder.encode('BBBB'));
		const created = expectOk(await creating);
		expect(created).toEqual({
			path: 'bytes.txt',
			sha256: first,
			bytes: encoder.encode('AAAA'),
		});
		const read = expectOk(await folder.files.read('bytes.txt'));
		expect(new TextDecoder().decode(read.bytes)).toBe('AAAA');
		expect(read.sha256).toEqual(first);

		const next = encoder.encode('CCCC');
		const saving = folder.files.save(created, next);
		next.set(encoder.encode('DDDD'));
		const replaced = expectOk(await saving).stored;
		expect(replaced.sha256).toEqual(await hashBytes(encoder.encode('CCCC')));
		expect(expectOk(await folder.files.read('bytes.txt')).bytes).toEqual(
			encoder.encode('CCCC'),
		);

		// The base is owned too: a caller changing the bytes it passed as the
		// base changes nothing about the save.
		const base = expectOk(await folder.files.read('bytes.txt'));
		const last = encoder.encode('EEEE');
		const again = folder.files.save(base, last);
		base.bytes.set(encoder.encode('XXXX'));
		last.set(encoder.encode('FFFF'));
		expect(expectOk(await again).stored.sha256).toEqual(
			await hashBytes(encoder.encode('EEEE')),
		);
		expect(
			new TextDecoder().decode(
				expectOk(await folder.files.read('bytes.txt')).bytes,
			),
		).toBe('EEEE');
	});

	test('a view over a larger buffer saves only the view, and a Node Buffer is copied, not aliased', async () => {
		const folder = await open();
		const backing = encoder.encode('--middle--');
		const view = backing.subarray(2, 8);
		const saving = folder.files.create('view.txt', view);
		backing.fill(0x21);
		expect(expectOk(await saving).sha256).toEqual(
			await hashBytes(encoder.encode('middle')),
		);
		expect(expectOk(await folder.files.read('view.txt')).bytes).toEqual(
			encoder.encode('middle'),
		);

		const buffer = Buffer.from('buffer bytes');
		const buffered = folder.files.create('buffer.txt', buffer);
		buffer.fill(0);
		expectOk(await buffered);
		expect(
			new TextDecoder().decode(
				expectOk(await folder.files.read('buffer.txt')).bytes,
			),
		).toBe('buffer bytes');
	});
});

describe('row files', () => {
	test('a stale capture is refused by its own sha256, and nothing else decides', async () => {
		const folder = await open();
		const row = expectOk(
			await folder.tables.todos.create(
				{ fields: { title: 'Row', done: false }, body: '' },
				{ stem: 'row' },
			),
		);
		expectOk(
			await folder.tables.todos.save(row, {
				fields: { title: 'Row', done: true },
				body: '',
			}),
		).stored;
		expect(expectErr(await folder.tables.todos.rename(row, 'next')).name).toBe(
			'Conflict',
		);
		expect(expectErr(await folder.tables.todos.delete(row)).name).toBe(
			'Conflict',
		);
		expect(expectOk(await folder.files.children('todos')).files).toEqual([
			'row.md',
		]);
	});

	test('stems are one literal segment; nested paths are not rows', async () => {
		const folder = await open();
		const nested = expectOk(
			await folder.files.create(
				'todos/a/b.md',
				'---\ntitle: Nested\ndone: false\n---\n',
			),
		);
		expect(expectErr(await folder.tables.todos.get('a/b')).name).toBe(
			'InvalidPath',
		);
		expect(expectOk(await folder.tables.todos.list())).toEqual([]);

		const real = expectOk(
			await folder.tables.todos.create(
				{ fields: { title: 'Real', done: false }, body: '' },
				{ stem: 'real' },
			),
		);
		expect(
			expectErr(
				await folder.tables.todos.save(nested, {
					fields: { title: 'X', done: true },
					body: '',
				}),
			).name,
		).toBe('InvalidPath');
		expect(expectErr(await folder.tables.todos.delete(nested)).name).toBe(
			'InvalidPath',
		);
		expect(expectErr(await folder.tables.todos.rename(nested, 'c')).name).toBe(
			'InvalidPath',
		);
		expect(expectErr(await folder.tables.todos.rename(real, 'a/b')).name).toBe(
			'InvalidPath',
		);

		// An externally written row with an unusual name is an ordinary row.
		await folder.files.create(
			'todos/bad .md',
			'---\ntitle: B\ndone: false\n---\n',
		);
		const listed = expectOk(await folder.tables.todos.list()).find(
			(item) => item.stem === 'bad ',
		);
		// A name is never a diagnostic.
		expect(expectOk(listed!.result)).toMatchObject({
			path: 'todos/bad .md',
			row: { fields: { title: 'B', done: false }, body: '' },
		});
		expect((await folder.tables.todos.get('bad ')).data?.path).toBe(
			'todos/bad .md',
		);
	});
});

describe('empty directories', () => {
	test('an empty directory lists and is removable', async () => {
		const folder = await open();
		expectOk(await folder.files.mkdir('empty'));
		expect((await folder.files.children('empty')).data).toEqual({
			files: [],
			directories: [],
		});
		expect((await folder.files.children('')).data!.directories).toEqual([
			'empty',
		]);
		expectOk(await folder.files.rmdir('empty'));
		expect(expectErr(await folder.files.children('empty')).name).toBe(
			'NotFound',
		);
	});
});
