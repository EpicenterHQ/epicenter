/**
 * File Verb and Capture Tests
 *
 * `folder.files` names the condition a write publishes under through its
 * verb, and identifies the file a conditional verb acts on with a capture: a
 * plain `{ path, sha256 }` value, which a read, a create, and a save return
 * with the bytes it names. The same cases run against a browser folder and a
 * directory folder, which is what the desktop app opens.
 *
 * Key behaviors:
 * - `create` is exclusive, even over identical bytes
 * - `remove` and `move` refuse a stale capture and change nothing; `save`
 *   with `{ merge: false }` does too, and a save never recreates a file
 * - A save's base must carry the content it names, or it is `UnknownBase`
 * - A save's capture is computed from the bytes it was given and is never
 *   read back: a writer that lands right behind the save does not change it
 * - A moved file's capture is the captured hash at the new path
 * - Captures are frozen, serializable, and never follow the file
 * - Read bytes are detached from storage
 * - Table `save`, `rename`, and `delete` own their capture and row before
 *   awaiting, and a table save is never read back either
 * - Several changes are several calls: one that landed stays when a later
 *   one is refused
 *
 * See also:
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
import { hashBytes } from './capture.js';
import {
	defineFolder,
	defineTable,
	type FileCapture,
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
import { formatRow, parseRow } from './row-text.js';
import { overwrite } from './put.test-support.js';
import { mustRow } from './row-write.test-support.js';

const definition = defineFolder({
	kv: {},
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
				id: 'so.epicenter.filestest',
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

describe.each(Object.keys(openers))('%s folder file verbs', (kind) => {
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

	test('create is exclusive even over identical bytes, and returns the bytes it saved', async () => {
		const folder = await open();
		const created = expectOk(await folder.files.create('a.txt', 'same'));
		expect(created).toEqual({
			path: 'a.txt',
			sha256: await versionOf('same'),
			bytes: encoder.encode('same'),
		});

		// Identical content does not prove who wrote it: still refused.
		const again = expectErr(await folder.files.create('a.txt', 'same'));
		expect(again).toMatchObject({ name: 'Exists', path: 'a.txt' });
		expect(expectErr(await folder.files.create('a.txt', 'other')).name).toBe(
			'Exists',
		);
		expect(await text(folder, 'a.txt')).toBe('same');

		const over = expectOk(await folder.files.save(created, 'replaced'));
		expect(over).toEqual({
			stored: {
				path: 'a.txt',
				sha256: await versionOf('replaced'),
				bytes: encoder.encode('replaced'),
			},
			merged: false,
		});
		// Strings are saved exactly: no newline, BOM, or normalization is added.
		expect(expectOk(await folder.files.read('a.txt')).bytes).toEqual(
			encoder.encode('replaced'),
		);
	});

	test('remove, move, and an unmerged save refuse a stale capture and leave every byte alone', async () => {
		const folder = await open();
		const first = expectOk(await folder.files.create('note.md', 'first'));
		const second = expectOk(await folder.files.save(first, 'second')).stored;

		const stale = expectErr(
			await folder.files.save(first, 'from stale', { merge: false }),
		);
		expect(stale).toMatchObject({
			name: 'Conflict',
			path: 'note.md',
			expectedSha256: first.sha256,
			actualSha256: second.sha256,
		});
		expect(expectErr(await folder.files.remove(first)).name).toBe('Conflict');
		expect(expectErr(await folder.files.move(first, 'moved.md')).name).toBe(
			'Conflict',
		);
		expect(await text(folder, 'note.md')).toBe('second');
		expect(expectErr(await folder.files.read('moved.md')).name).toBe(
			'NotFound',
		);

		// A capture of a file that is gone is refused, never recreated.
		expectOk(await folder.files.remove(second));
		expect(expectErr(await folder.files.save(second, 'back')).name).toBe(
			'NotFound',
		);
		expect(
			expectErr(await folder.files.save(second, 'back', { merge: false })).name,
		).toBe('Conflict');
		expect(expectErr(await folder.files.remove(second)).name).toBe('NotFound');
		expect(expectErr(await folder.files.move(second, 'x.md')).name).toBe(
			'NotFound',
		);
		expect(
			expectOk(await folder.files.list()).files.map((file) => file.path),
		).toEqual(['epicenter.json']);
	});

	test('a move keeps the captured hash at the new path and refuses an occupied destination', async () => {
		const folder = await open();
		const source = expectOk(await folder.files.create('a/from.txt', 'carried'));
		expectOk(await folder.files.create('b/taken.txt', 'in the way'));

		expect(
			expectErr(await folder.files.move(source, 'b/taken.txt')),
		).toMatchObject({ name: 'Exists', path: 'b/taken.txt' });
		expect(await text(folder, 'a/from.txt')).toBe('carried');

		const moved = expectOk(await folder.files.move(source, 'b/to.txt'));
		expect(moved).toEqual({ path: 'b/to.txt', sha256: source.sha256 });
		expect(await text(folder, 'b/to.txt')).toBe('carried');
		// The moved capture, with the bytes it moved, is the base of the next edit.
		expectOk(
			await folder.files.save(
				{ ...moved, bytes: source.bytes },
				'edited after the move',
			),
		);
		// The old capture names a path that no longer holds the file.
		expect(expectErr(await folder.files.save(source, 'x')).name).toBe(
			'NotFound',
		);
	});

	test('several changes are several calls: a save that landed stays when the next is refused', async () => {
		const folder = await open();
		expectOk(await folder.files.create('todos/take.md', 'not a row'));
		const audio = expectOk(
			await folder.files.create('audio/take.webm', new Uint8Array([1, 2])),
		);
		// The row that would name the audio cannot be written.
		const row = expectErr(
			await folder.tables.todos.create(
				{ fields: { title: 1 as never }, body: '' },
				{ stem: 'take' },
			),
		);
		expect(row).toMatchObject({ name: 'InvalidValues' });
		// Nothing undoes the audio; the caller decides what comes next.
		expect(expectOk(await folder.files.read('audio/take.webm'))).toMatchObject(
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

	test('captures are frozen plain values that never follow the file, and survive serialization', async () => {
		const folder = await open();
		const saved = expectOk(await folder.files.create('draft.md', 'one'));
		expect(Object.isFrozen(saved)).toBe(true);
		expect(Object.keys(saved)).toEqual(['path', 'sha256', 'bytes']);
		const snapshot = structuredClone(saved);

		const next = expectOk(await folder.files.save(saved, 'two')).stored;
		expectOk(await folder.files.save(next, 'three'));
		// Later saves returned new captures; the first one is what it was.
		expect(saved).toEqual(snapshot);
		expect(saved.sha256).toEqual(await versionOf('one'));
		expect(next.sha256).toEqual(await versionOf('two'));

		// A capture that crossed JSON, as it would a bridge, still identifies
		// bytes: its content travels as text.
		const read = expectOk(await folder.files.read('draft.md'));
		const wired = JSON.parse(
			JSON.stringify({
				path: read.path,
				sha256: read.sha256,
				text: decoder.decode(read.bytes),
			}),
		) as FileCapture & { text: string };
		expect(wired).toEqual({
			path: 'draft.md',
			sha256: await versionOf('three'),
			text: 'three',
		});
		const viaWire = expectOk(await folder.files.save(wired, 'four')).stored;
		expect(viaWire.sha256).toEqual(await versionOf('four'));

		// A caller mutating the object it passed cannot move the baseline.
		const loose = { path: 'draft.md', sha256: viaWire.sha256, text: 'four' };
		const saving = folder.files.save(loose, 'five');
		loose.path = 'elsewhere.md';
		loose.sha256 = '0'.repeat(64);
		loose.text = 'not the base';
		expect(expectOk(await saving).stored).toEqual({
			path: 'draft.md',
			sha256: await versionOf('five'),
			bytes: encoder.encode('five'),
		});
	});

	test('read returns bytes detached from storage, with the capture that identifies them', async () => {
		const folder = await open();
		expectOk(
			await folder.files.create('raw.bin', new Uint8Array([1, 2, 3, 4])),
		);
		const read = expectOk(await folder.files.read('raw.bin'));
		expect(read.path).toBe('raw.bin');
		expect(read.sha256).toEqual(await hashBytes(new Uint8Array([1, 2, 3, 4])));

		read.bytes.fill(9);
		const again = expectOk(await folder.files.read('raw.bin'));
		expect([...again.bytes]).toEqual([1, 2, 3, 4]);
		expect(again.bytes).not.toBe(read.bytes);
		// The capture did not change with the array it came with.
		expect(read.sha256).toEqual(again.sha256);
		// But its content no longer hashes to it, so it is no base for a save.
		expect(expectErr(await folder.files.save(read, 'text now')).name).toBe(
			'UnknownBase',
		);
		expectOk(await folder.files.save(again, 'text now'));
	});

	test('invalid paths and captures are refused before anything is published', async () => {
		const folder = await open();
		expectOk(await folder.files.create('a.txt', 'kept'));
		expect(expectErr(await folder.files.read('../outside.txt')).name).toBe(
			'InvalidPath',
		);
		expect(expectErr(await folder.files.create('.git/config', 'x')).name).toBe(
			'InvalidPath',
		);
		const pathOnly = { path: 'a.txt' } as unknown as FileCapture;
		// A capture without its content names bytes nothing can merge from.
		const contentless = {
			path: 'a.txt',
			sha256: await versionOf('kept'),
		} as unknown as FileCapture & { text: string };
		expect(expectErr(await folder.files.save(contentless, 'x'))).toMatchObject({
			name: 'UnknownBase',
			path: 'a.txt',
		});
		for (const refused of [
			(await folder.files.save(pathOnly as typeof contentless, 'x')).error,
			(await folder.files.remove(pathOnly)).error,
			(await folder.files.move(pathOnly, 'b.txt')).error,
		])
			expect(refused).toMatchObject({
				name: 'InvalidPath',
				reason: 'the capture has no valid SHA-256',
			});
		expect(await text(folder, 'a.txt')).toBe('kept');
	});

	test('the handle says where it is, and its own saves are not reported to it', async () => {
		const folder = await open();
		if (kind === 'browser')
			expect(folder.location).toEqual(locationOf('so.epicenter.filestest'));
		else expect(folder.location.kind).toBe('directory');

		// Whoever saved holds the result (ADR-0548): a handle's listeners
		// hear changes it did not make.
		const heard: FilesChanged[] = [];
		const stop = folder.onFilesChanged((change) => heard.push(change));
		expectOk(await folder.files.list());
		const made = expectOk(await folder.files.create('a.txt', 'a'));
		expectOk(await folder.files.move(made, 'b.txt'));
		expectErr(await folder.files.create('b.txt', 'refused'));
		expectOk(
			await folder.tables.todos.create(
				{ fields: { title: 'R' }, body: '' },
				{ stem: 'row' },
			),
		);
		expect(heard).toEqual([]);
		stop();

		// Closing fences callbacks: stopping and closing leave nothing to call.
		const saving = folder.files.create('last.txt', 'last');
		const closing = folder.close();
		await Promise.all([saving, closing]);
		expect(heard).toEqual([]);
		expect(folder.onFilesChanged(() => {})).toBeInstanceOf(Function);
	});
});

describe('a save never reads its bytes back', () => {
	/** A browser folder over a boundary the test can watch and interfere with. */
	async function instrumented() {
		const raw = await rawBrowserFolder({ id: 'reread' });
		const base = raw.boundary;
		const reads: string[] = [];
		let afterApply: (() => Promise<void>) | undefined;
		const boundary: FolderStorage = {
			...base,
			read(path) {
				reads.push(path);
				return base.read(path);
			},
			async put(path, bytes, ifMatch) {
				const result = await base.put(path, bytes, ifMatch);
				// Runs after the save landed and before its caller hears of it.
				await afterApply?.();
				return result;
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
			prepared: definition,
			publishes: true,
			storage: boundary,
			history,
			location: locationOf('reread'),
			hints: createFileHints(),
			release: async () => {},
		});
		opened.push(folder);
		return {
			folder,
			base,
			reads,
			/** Another writer lands right behind the next save. */
			raceNextSave(path: string, content: string) {
				afterApply = async () => {
					afterApply = undefined;
					await overwrite(base, path, content);
				};
			},
		};
	}
	function unused(): never {
		throw new Error('this test uses no Git');
	}

	test('file writes read nothing after publishing, and a table write reads only its own rows', async () => {
		const { folder, reads } = await instrumented();
		const created = expectOk(await folder.files.create('a.md', 'one'));
		const saved = expectOk(await folder.files.save(created, 'two')).stored;
		const moved = expectOk(await folder.files.move(saved, 'b.md'));
		expectOk(await folder.files.remove(moved));
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
		// The declaration's read comes before the first save (ADR-0508); a
		// move reads the bytes it carries before it writes them; a table write
		// reads the file it merges into; nothing reads back what it wrote.
		expect(new Set(reads)).toEqual(
			new Set(['epicenter.json', 'a.md', 'todos/r.md', 'todos/s.md']),
		);
	});

	test('a writer that lands behind a save does not change the capture the save returns', async () => {
		const { folder, raceNextSave } = await instrumented();
		const base = expectOk(await folder.files.create('note.md', 'base'));

		raceNextSave('note.md', 'raced in behind\n');
		const mine = expectOk(await folder.files.save(base, 'mine')).stored;
		// The capture is the bytes this save was given. It is not what a reread
		// would have found, which by now is the other writer's bytes.
		expect(mine.sha256).toEqual(await versionOf('mine'));
		const observed = expectOk(await folder.files.read('note.md'));
		expect(decoder.decode(observed.bytes)).toBe('raced in behind\n');
		expect(observed.sha256).not.toEqual(mine.sha256);

		// So the next save built on `mine` does not silently overwrite bytes
		// this editor never saw: unmerged it is refused, and merged it wins
		// the lines both changed.
		expect(
			expectErr(
				await folder.files.save(mine, 'next draft\n', { merge: false }),
			),
		).toMatchObject({
			name: 'Conflict',
			expectedSha256: mine.sha256,
			actualSha256: observed.sha256,
		});
		const merged = expectOk(await folder.files.save(mine, 'next draft\n'));
		expect(merged.merged).toBe(true);
		expect(
			decoder.decode(expectOk(await folder.files.read('note.md')).bytes),
		).toBe('next draft\n');

		// The same holds for a moved file. A table row merges instead.
		raceNextSave('moved.md', 'raced the move');
		const moved = expectOk(await folder.files.move(merged.stored, 'moved.md'));
		expect(moved.sha256).toEqual(merged.stored.sha256);
		expect(expectErr(await folder.files.remove(moved)).name).toBe('Conflict');

		raceNextSave('todos/r.md', '---\ntitle: Theirs\n---\n');
		const row = mustRow(
			await folder.tables.todos.create(
				{ fields: { title: 'Mine' }, body: '' },
				{ stem: 'r' },
			),
		);
		expect(row.row).toEqual({ fields: { title: 'Mine' }, body: '' });
		expect(row.sha256).toEqual(
			await versionOf(expectOk(formatRow(definition.tables.todos, row.row))),
		);
		// An explicit get is the new observation; it never acknowledges the draft.
		const current = expectOk(await folder.tables.todos.get('r'));
		expect(current!.row.fields).toEqual({ title: 'Theirs' });
		// A write merges with what is there instead, from the row it started
		// from, and wins the field both changed.
		expectOk(
			await folder.tables.todos.write('r', row.row, {
				fields: { title: 'Again' },
				body: '',
			}),
		);
		expect(expectOk(await folder.tables.todos.get('r'))!.row.fields).toEqual({
			title: 'Again',
		});
	});
});
