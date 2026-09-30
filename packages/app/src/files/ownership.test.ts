/**
 * Byte Ownership, Row Ownership, and Directory Tests
 *
 * Counterexamples at the folder's file boundary: bytes must be the caller's
 * bytes at call time, table operations must only touch literal rows and the
 * attachment they captured, and empty directories must behave as directories.
 *
 * Key behaviors:
 * - Raw writes and created attachments copy the caller's array before any
 *   await, so saved bytes and their version match what was passed
 * - Rename and delete refuse an attachment that appeared, changed extension,
 *   or became ambiguous after capture, before moving anything
 * - A stem is one literal segment; `todos/a/b.md` is not a row, while an
 *   externally written row with an invalid stem stays listable
 * - An empty directory lists, removes, and works from the terminal
 *
 * See also:
 * - `browser.test.ts` for table CRUD and history
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { defineStore, defineTable, field } from '../index.js';
import { type Folder, openBrowserFolder } from './index.js';
import { createFolderTerminal } from './terminal.js';
import { captureVersion } from './version.js';

const definition = defineStore({
	id: 'so.epicenter.todostest',
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
	const folder = await openBrowserFolder({
		id: 'ownership',
		definition,
		git: {
			author: { name: 'Owner', email: 'owner@example.test' },
			commitOnEdit: false,
		},
		indexedDb: { indexedDB: new IDBFactory(), IDBKeyRange },
	});
	opened.push(folder);
	return folder;
}

afterEach(async () => {
	for (const folder of opened.splice(0)) await folder.close();
});

describe('byte ownership', () => {
	test('a raw write owns its bytes before the caller can mutate them', async () => {
		const folder = await open();
		const content = encoder.encode('AAAA');
		const writing = folder.files.write('bytes.txt', content, {
			expected: 'absent',
		});
		content.set(encoder.encode('BBBB'));
		const written = await writing;
		const read = await folder.files.read('bytes.txt');
		expect(new TextDecoder().decode(read.data!.bytes)).toBe('AAAA');
		expect(written.data).toEqual(await captureVersion(encoder.encode('AAAA')));
		expect(read.data!.version).toEqual(written.data!);
	});

	test('a created attachment owns its bytes before the caller can mutate them', async () => {
		const folder = await open();
		const audio = new Uint8Array([1, 2, 3]);
		const creating = folder.tables.todos.create({
			stem: 'rec',
			fields: { title: 'Recording', done: false },
			attachment: { extension: 'opus', bytes: audio },
		});
		audio.set([9, 9, 9]);
		expect((await creating).error).toBeNull();
		const read = await folder.files.read('todos/rec.opus');
		expect([...read.data!.bytes]).toEqual([1, 2, 3]);
		expect(read.data!.version).toEqual(
			await captureVersion(new Uint8Array([1, 2, 3])),
		);
	});
});

describe('row ownership', () => {
	test('rename refuses an attachment that appeared, changed, or became ambiguous since capture', async () => {
		const folder = await open();
		const bare = (
			await folder.tables.todos.create({
				stem: 'plain',
				fields: { title: 'Plain', done: false },
			})
		).data!;
		// An attachment appears after the entry without one was captured.
		await folder.files.write('todos/plain.opus', 'late', {
			expected: 'absent',
		});
		expect((await folder.tables.todos.rename(bare, 'moved')).error?.name).toBe(
			'AmbiguousAttachment',
		);

		const owned = (
			await folder.tables.todos.create({
				stem: 'rec',
				fields: { title: 'Recording', done: false },
				attachment: { extension: 'opus', bytes: new Uint8Array([1]) },
			})
		).data!;
		// The owned attachment was replaced by one with another extension.
		await folder.files.move('todos/rec.opus', 'todos/rec.wav', {
			expected: 'any',
		});
		expect((await folder.tables.todos.rename(owned, 'rec2')).error?.name).toBe(
			'AmbiguousAttachment',
		);
		// A second candidate joined the owned one.
		await folder.files.move('todos/rec.wav', 'todos/rec.opus', {
			expected: 'any',
		});
		await folder.files.write('todos/rec.flac', 'x', { expected: 'absent' });
		expect((await folder.tables.todos.rename(owned, 'rec2')).error?.name).toBe(
			'AmbiguousAttachment',
		);
		expect((await folder.tables.todos.delete(owned)).error?.name).toBe(
			'AmbiguousAttachment',
		);

		// Nothing moved.
		const paths = (await folder.files.list()).data!.files.map(
			(file) => file.path,
		);
		expect(paths.sort()).toEqual([
			'todos/plain.md',
			'todos/plain.opus',
			'todos/rec.flac',
			'todos/rec.md',
			'todos/rec.opus',
		]);
	});

	test('stems are one literal segment; nested paths are not rows', async () => {
		const folder = await open();
		await folder.files.write(
			'todos/a/b.md',
			'---\ntitle: Nested\ndone: false\n---\n',
			{ expected: 'absent' },
		);
		expect((await folder.tables.todos.get('a/b')).error?.name).toBe(
			'InvalidStem',
		);
		expect((await folder.tables.todos.list()).data!.entries).toEqual([]);

		const real = (
			await folder.tables.todos.create({
				stem: 'real',
				fields: { title: 'Real', done: false },
			})
		).data!;
		const forged = { ...real, path: 'todos/a/b.md' };
		expect(
			(await folder.tables.todos.writeSource(forged, 'x')).error?.name,
		).toBe('InvalidPath');
		expect(
			(await folder.tables.todos.update(forged, { fields: { done: true } }))
				.error?.name,
		).toBe('InvalidPath');
		expect((await folder.tables.todos.delete(forged)).error?.name).toBe(
			'InvalidPath',
		);
		expect((await folder.tables.todos.rename(forged, 'c')).error?.name).toBe(
			'InvalidPath',
		);

		// An externally written row with an invalid stem stays listable and readable.
		await folder.files.write(
			'todos/bad .md',
			'---\ntitle: B\ndone: false\n---\n',
			{ expected: 'absent' },
		);
		const bad = (await folder.tables.todos.list()).data!.entries.find(
			(entry) => entry.path === 'todos/bad .md',
		)!;
		expect(bad.stem).toBeUndefined();
		expect(bad.issues?.[0]?.kind).toBe('filename');
		expect((await folder.tables.todos.get('bad ')).data?.path).toBe(
			'todos/bad .md',
		);
	});
});

describe('empty directories', () => {
	test('an empty directory lists, is removable, and works from the terminal', async () => {
		const folder = await open();
		expect((await folder.files.mkdir('empty')).error).toBeNull();
		expect((await folder.files.children('empty')).data).toEqual({
			files: [],
			directories: [],
		});
		expect((await folder.files.children('')).data!.directories).toEqual([
			'empty',
		]);
		expect((await folder.files.rmdir('empty')).error).toBeNull();
		expect((await folder.files.children('empty')).error?.name).toBe('NotFound');

		const terminal = createFolderTerminal(folder);
		const made = await terminal.exec('mkdir -p a/b && ls a && ls a/b');
		expect(made.stderr).toBe('');
		expect(made.stdout).toBe('b\n');
		const removed = await terminal.exec('rmdir a/b && ls a');
		expect(removed.stderr).toBe('');
		expect(removed.stdout).toBe('');
	});
});
