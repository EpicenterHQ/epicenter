/**
 * File Read, Write, and Move Tests
 *
 * `folder.files` reads files and keeps directories; a file's content changes
 * only through the one write, `folder.write(path, from, to)`, and a file
 * moves only through `folder.move(path, next)` (ADR-0576). The same cases
 * run against a browser folder and a directory folder, which is what the
 * desktop app opens.
 *
 * Key behaviors:
 * - A write from no file is placed only where none is: identical bytes
 *   already there are that create landed before, other bytes are
 *   `Occupied`; strings are written exactly
 * - A write to no file deletes whatever is there, and an edit of a file
 *   deleted since writes nothing
 * - A move carries the bytes to a vacant path and refuses an occupied one,
 *   `Occupied`
 * - Several changes are several calls: one that landed stays when a later
 *   one is refused
 * - Read bytes are detached from storage
 * - Invalid paths are refused before anything is published
 * - Table writes own their rows before awaiting
 * - A write reads the file it merges into, and nothing reads back what it
 *   wrote
 *
 * See also:
 * - `write.test.ts` for the merge and the lost race
 * - `ownership.test.ts` for byte copies at admission
 * - `browser-opfs.test.ts` for a move that keeps its source
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { FolderStorage } from './boundary.js';
import { openFolder as openBrowserFolder } from './browser.js';
import {
	locationOf,
	rawBrowserFolder,
	testBrowserStorage,
} from './browser-storage.test-support.js';
import {
	defineFolder,
	defineTable,
	type FilesChanged,
	type Folder,
	field,
} from './contract.js';
import { openNativeFolder } from './directory.test-support.js';
import {
	assembleFolder,
	createFileHints,
	type FolderHistory,
} from './folder.js';
import { GIT_ENV, scratch } from './git-http.test-support.js';
import { hashBytes } from './hash.js';
import { parseRow } from './row-text.js';
import { mustRow } from './row-write.test-support.js';

const definition = defineFolder({
	tables: {
		todos: defineTable({ fields: { title: field.string() } }),
	},
});
type Opened = Folder<typeof definition>;

const author = { name: 'Files', email: 'files@example.test' };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const versionOf = (text: string) => hashBytes(encoder.encode(text));

const originalEnv = { ...process.env };
beforeAll(() => {
	Object.assign(process.env, {
		GIT_CONFIG_GLOBAL: GIT_ENV.GIT_CONFIG_GLOBAL,
		GIT_CONFIG_NOSYSTEM: '1',
	});
});
afterAll(() => {
	for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'])
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
});

const opened: Opened[] = [];
afterEach(async () => {
	for (const folder of opened.splice(0)) await folder.close();
});

const openers: Record<string, () => Promise<Opened>> = {
	browser: async () =>
		expectOk(
			await openBrowserFolder({
				app: 'so.epicenter.filestest',
				definition,
				browser: {
					author,
					...testBrowserStorage(),
				},
			}),
		),
	directory: async () =>
		openNativeFolder({
			root: await scratch('files-verbs-'),
			definition,
			git: { author },
		}),
};

describe.each(Object.keys(openers))('%s folder files', (kind) => {
	async function open() {
		const folder = await openers[kind]!();
		opened.push(folder);
		return folder;
	}
	const text = async (folder: Opened, path: string) =>
		decoder.decode(expectOk(await folder.files.read(path)).bytes);

	test('a table write owns its rows before awaiting', async () => {
		const folder = await open();
		const table = folder.tables.todos;
		const from = { fields: { title: 'A' }, body: '' };
		expectOk(await table.create(from, { stem: 'a' }));
		const row = { fields: { title: 'Mine' }, body: '' };
		const writing = table.write('a', from, row);
		from.fields.title = 'Changed after the call';
		row.fields.title = 'Changed after the call';
		const written = mustRow(await writing);
		expect(written.row).toEqual({ fields: { title: 'Mine' }, body: '' });
		const landed = expectOk(await folder.files.read('todos/a.md'));
		expect(landed.sha256).toEqual(written.sha256);
		expect(
			expectOk(parseRow(definition.tables.todos, decoder.decode(landed.bytes))),
		).toEqual(written.row);

		const renamed = expectOk(await table.rename('a', 'b'));
		expect(renamed?.path).toBe('todos/b.md');
		expect(expectErr(await folder.files.read('todos/a.md')).name).toBe(
			'NotFound',
		);
		expectOk(await table.delete('b'));
		expect(expectOk(await table.get('b'))).toBeUndefined();
	});

	test('a create is placed only where no file is, and strings are written exactly', async () => {
		const folder = await open();
		const created = expectOk(await folder.write('a.txt', null, 'same'));
		expect(created).toEqual({
			path: 'a.txt',
			file: { bytes: encoder.encode('same'), sha256: await versionOf('same') },
			overridden: [],
		});
		// The same bytes there are that create landed before; others refuse it.
		expect(expectOk(await folder.write('a.txt', null, 'same'))).toEqual(
			created,
		);
		expect(expectErr(await folder.write('a.txt', null, 'other'))).toEqual({
			name: 'Occupied',
			message: "A file is already at 'a.txt'",
			path: 'a.txt',
		});
		expect(await text(folder, 'a.txt')).toBe('same');

		expectOk(await folder.write('a.txt', 'same', 'replaced'));
		// Strings are written exactly: no newline, BOM, or normalization is added.
		expect(expectOk(await folder.files.read('a.txt')).bytes).toEqual(
			encoder.encode('replaced'),
		);
	});

	test('a delete removes whatever is there, and an edit of a deleted file writes nothing', async () => {
		const folder = await open();
		expectOk(await folder.write('note.md', null, 'first'));
		expectOk(await folder.write('note.md', 'first', 'second'));
		// The deleter wins: a delete from a version the file moved past still goes.
		const deleted = expectOk(await folder.write('note.md', 'first', null));
		expect(deleted).toEqual({
			path: 'note.md',
			file: null,
			overridden: [{ kind: 'file', lost: 'theirs' }],
		});
		// A delete beats an edit it never saw: the edit writes nothing.
		expect(
			expectOk(await folder.write('note.md', 'second', 'back')).file,
		).toBeNull();
		expect(expectErr(await folder.files.read('note.md')).name).toBe('NotFound');
		// Deleting what is already gone is done.
		expectOk(await folder.write('note.md', null, null));
		expect(
			expectOk(await folder.files.list()).files.map((file) => file.path),
		).toEqual(['epicenter.json']);
	});

	test('a move carries the bytes to a vacant path and refuses an occupied one', async () => {
		const folder = await open();
		expectOk(await folder.write('a/from.txt', null, 'carried'));
		expectOk(await folder.write('b/taken.txt', null, 'in the way'));

		expect(
			expectErr(await folder.move('a/from.txt', 'b/taken.txt')),
		).toMatchObject({ name: 'Occupied', path: 'b/taken.txt' });
		expect(await text(folder, 'a/from.txt')).toBe('carried');

		const moved = expectOk(await folder.move('a/from.txt', 'b/to.txt'));
		expect(moved).toEqual({
			path: 'b/to.txt',
			file: {
				bytes: encoder.encode('carried'),
				sha256: await versionOf('carried'),
			},
			overridden: [],
		});
		expect(await text(folder, 'b/to.txt')).toBe('carried');
		expect(expectErr(await folder.files.read('a/from.txt')).name).toBe(
			'NotFound',
		);
		// A move from a path that holds no file is refused.
		expect(expectErr(await folder.move('a/from.txt', 'c.txt'))).toMatchObject({
			name: 'InvalidPath',
			path: 'a/from.txt',
		});
	});

	test('several changes are several calls: a write that landed stays when the next is refused', async () => {
		const folder = await open();
		expectOk(await folder.write('todos/take.md', null, 'not a row'));
		const audio = new Uint8Array([1, 2]);
		expectOk(await folder.write('audio/take.webm', null, audio));
		// The row that would name the audio cannot be written.
		const row = expectErr(
			await folder.tables.todos.create(
				{ fields: { title: 1 as never }, body: '' },
				{ stem: 'take' },
			),
		);
		expect(row).toMatchObject({ name: 'InvalidValues' });
		// Nothing undoes the audio; the caller decides what comes next.
		expect(expectOk(await folder.files.read('audio/take.webm')).bytes).toEqual(
			audio,
		);
		expect(await text(folder, 'todos/take.md')).toBe('not a row');
		expectOk(
			await folder.tables.todos.create(
				{ fields: { title: 'Take' }, body: '' },
				{ stem: 'take-2' },
			),
		);
	});

	test('read returns bytes detached from storage, with the SHA-256 that names them', async () => {
		const folder = await open();
		expectOk(await folder.write('raw.bin', null, new Uint8Array([1, 2, 3, 4])));
		const read = expectOk(await folder.files.read('raw.bin'));
		expect(Object.keys(read).sort()).toEqual(['bytes', 'sha256']);
		expect(read.sha256).toEqual(await hashBytes(new Uint8Array([1, 2, 3, 4])));

		read.bytes.fill(9);
		const again = expectOk(await folder.files.read('raw.bin'));
		expect([...again.bytes]).toEqual([1, 2, 3, 4]);
		expect(again.bytes).not.toBe(read.bytes);
		expect(read.sha256).toEqual(again.sha256);
	});

	test('invalid paths are refused before anything is published', async () => {
		const folder = await open();
		expectOk(await folder.write('a.txt', null, 'kept'));
		expect(expectErr(await folder.files.read('../outside.txt')).name).toBe(
			'InvalidPath',
		);
		expect(expectErr(await folder.write('.git/config', null, 'x')).name).toBe(
			'InvalidPath',
		);
		expect(expectErr(await folder.move('a.txt', '.git/a.txt')).name).toBe(
			'InvalidPath',
		);
		expect(await text(folder, 'a.txt')).toBe('kept');
	});

	test('the handle says where it is, and its own writes are not reported to it', async () => {
		const folder = await open();
		if (kind === 'browser')
			expect(folder.location).toEqual(locationOf('so.epicenter.filestest'));
		else expect(folder.location.kind).toBe('directory');

		// Whoever wrote holds the result (ADR-0548): a handle's listeners
		// hear changes it did not make.
		const heard: FilesChanged[] = [];
		const stop = folder.onFilesChanged((change) => heard.push(change));
		expectOk(await folder.files.list());
		expectOk(await folder.write('a.txt', null, 'a'));
		expectOk(await folder.move('a.txt', 'b.txt'));
		expectErr(await folder.write('b.txt', null, 'refused'));
		expectOk(
			await folder.tables.todos.create(
				{ fields: { title: 'R' }, body: '' },
				{ stem: 'row' },
			),
		);
		expect(heard).toEqual([]);
		stop();

		// Closing fences callbacks: stopping and closing leave nothing to call.
		const writing = folder.write('last.txt', null, 'last');
		const closing = folder.close();
		await Promise.all([writing, closing]);
		expect(heard).toEqual([]);
		expect(folder.onFilesChanged(() => {})).toBeInstanceOf(Function);
	});
});

describe('a write reads the file it merges into, and never reads back what it wrote', () => {
	/** A browser folder over a boundary whose reads the test watches. */
	async function instrumented() {
		const raw = await rawBrowserFolder({ id: 'reread' });
		const base = raw.boundary;
		const reads: string[] = [];
		const boundary: FolderStorage = {
			...base,
			read(path) {
				reads.push(path);
				return base.read(path);
			},
		};
		const history: FolderHistory = {
			snapshot: undefined as never,
			subscribe: () => () => {},
			status: unused,
			commit: unused,
			sync: {
				run: unused,
				connect: unused,
			},
			noteEdit: () => {},
			log: unused,
			close: async () => {},
		};
		const folder = assembleFolder<typeof definition>({
			id: 'reread',
			own: true,
			prepared: definition,
			storage: boundary,
			history,
			location: locationOf('reread'),
			hints: createFileHints(),
			release: async () => {},
		});
		opened.push(folder);
		return { folder, reads };
	}
	function unused(): never {
		throw new Error('this test uses no Git');
	}

	test('each write and move reads its own path before it puts', async () => {
		const { folder, reads } = await instrumented();
		expectOk(await folder.write('a.md', null, 'one'));
		expectOk(await folder.write('a.md', 'one', 'two'));
		expectOk(await folder.move('a.md', 'b.md'));
		expectOk(await folder.write('b.md', null, null));
		const row = mustRow(
			await folder.tables.todos.create(
				{ fields: { title: 'R' }, body: '' },
				{ stem: 'r' },
			),
		);
		expectOk(
			await folder.tables.todos.write('r', row.row, {
				fields: { title: 'S' },
				body: '',
			}),
		);
		expectOk(await folder.tables.todos.rename('r', 's'));
		expectOk(await folder.tables.todos.delete('s'));
		// Each write reads the file it merges into, and the declaration is read
		// before the first put (ADR-0508), once for the publication to replace
		// and once by its write; a table write reads its row once more to
		// start from the file's own spelling; a move reads the bytes it
		// carries; nothing reads back what it wrote.
		expect(reads).toEqual([
			'a.md',
			'epicenter.json',
			'epicenter.json',
			'a.md',
			'a.md',
			'b.md',
			'todos/r.md',
			'todos/r.md',
			'todos/r.md',
			'todos/r.md',
			'todos/s.md',
		]);
	});
});
