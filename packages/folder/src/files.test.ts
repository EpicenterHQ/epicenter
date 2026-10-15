/**
 * File Verb and Capture Tests
 *
 * `folder.files` names the condition a save publishes under through its verb,
 * and identifies the file a conditional verb acts on with a capture: a plain
 * `{ path, sha256 }` value. The same cases run against a browser folder and
 * a directory folder, which is what the desktop app opens.
 *
 * Key behaviors:
 * - `create` is exclusive, even over identical bytes; `overwrite` is not
 * - `replace`, `remove`, and `move` refuse a stale capture and change nothing
 * - A save's capture is computed from the bytes it was given and is never
 *   read back: a writer that lands right behind the save does not change it
 * - A moved file's capture is the captured hash at the new path
 * - Captures are frozen, serializable, and never follow the file
 * - Read bytes are detached from storage
 * - Table `replace`, `rename`, and `delete` own their capture and row before
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
import type { FileBoundary } from './boundary.js';
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

	test('table mutations own their capture and row before awaiting', async () => {
		const folder = await open();
		const table = folder.tables.todos;
		const entry = expectOk(
			await table.create({ fields: { title: 'A' }, body: '' }, { stem: 'a' }),
		);
		const capture = { path: entry.path, sha256: entry.sha256 };
		const row = { fields: { title: 'Mine' }, body: '' };
		const saving = table.replace(capture, row);
		capture.sha256 = 'f'.repeat(64);
		row.fields.title = 'Changed after the call';
		const saved = expectOk(await saving);
		expect(saved.path).toBe(entry.path);
		expect(saved.row).toEqual({ fields: { title: 'Mine' }, body: '' });
		const landed = expectOk(await folder.files.read(entry.path));
		expect(landed.sha256).toEqual(saved.sha256);
		expect(
			expectOk(parseRow(definition.tables.todos, decoder.decode(landed.bytes))),
		).toEqual(saved.row);

		const moving = { path: saved.path, sha256: saved.sha256 };
		const renamed = table.rename(moving, 'b');
		moving.sha256 = 'f'.repeat(64);
		expect(expectOk(await renamed)).toEqual({
			path: 'todos/b.md',
			sha256: saved.sha256,
		});
		expect(expectOk(await folder.files.read('todos/b.md')).sha256).toEqual(
			saved.sha256,
		);
		expect(expectErr(await folder.files.read(entry.path)).name).toBe(
			'NotFound',
		);

		const deleting = { path: 'todos/b.md', sha256: saved.sha256 };
		const removing = table.delete(deleting);
		deleting.sha256 = 'f'.repeat(64);
		expectOk(await removing);
		expect(expectOk(await table.get('b'))).toBeUndefined();
	});

	test('create is exclusive even over identical bytes; overwrite is unconditional', async () => {
		const folder = await open();
		const created = expectOk(await folder.files.create('a.txt', 'same'));
		expect(created).toEqual({
			path: 'a.txt',
			sha256: await versionOf('same'),
		});

		// Identical content does not prove who wrote it: still refused.
		const again = expectErr(await folder.files.create('a.txt', 'same'));
		expect(again).toMatchObject({ name: 'Exists', path: 'a.txt' });
		expect(expectErr(await folder.files.create('a.txt', 'other')).name).toBe(
			'Exists',
		);
		expect(await text(folder, 'a.txt')).toBe('same');

		const over = expectOk(await folder.files.overwrite('a.txt', 'replaced'));
		expect(over.sha256).toEqual(await versionOf('replaced'));
		const fresh = expectOk(await folder.files.overwrite('new.txt', 'made'));
		expect(fresh).toEqual({
			path: 'new.txt',
			sha256: await versionOf('made'),
		});
		// Strings are saved exactly: no newline, BOM, or normalization is added.
		expect(expectOk(await folder.files.read('a.txt')).bytes).toEqual(
			encoder.encode('replaced'),
		);
	});

	test('replace, remove, and move refuse a stale capture and leave every byte alone', async () => {
		const folder = await open();
		const first = expectOk(await folder.files.create('note.md', 'first'));
		const second = expectOk(await folder.files.replace(first, 'second'));

		const stale = expectErr(await folder.files.replace(first, 'from stale'));
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
		expect(expectErr(await folder.files.replace(second, 'back')).name).toBe(
			'Conflict',
		);
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
		// The moved capture is the working baseline for the next edit.
		expectOk(await folder.files.replace(moved, 'edited after the move'));
		// The old capture names a path that no longer holds the file.
		expect(expectErr(await folder.files.replace(source, 'x')).name).toBe(
			'Conflict',
		);
	});

	test('several changes are several calls: a save that landed stays when the next is refused', async () => {
		const folder = await open();
		// Another writer already holds the row's path.
		expectOk(await folder.files.create('todos/take.md', 'not a row'));
		const audio = expectOk(
			await folder.files.create('audio/take.webm', new Uint8Array([1, 2])),
		);
		const row = expectErr(
			await folder.tables.todos.create(
				{ fields: { title: 'Take' }, body: '' },
				{ stem: 'take' },
			),
		);
		expect(row).toMatchObject({ name: 'Exists', path: 'todos/take.md' });
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
		expect(Object.keys(saved)).toEqual(['path', 'sha256']);
		const snapshot = structuredClone(saved);

		const next = expectOk(await folder.files.replace(saved, 'two'));
		expectOk(await folder.files.replace(next, 'three'));
		// Later saves returned new captures; the first one is what it was.
		expect(saved).toEqual(snapshot);
		expect(saved.sha256).toEqual(await versionOf('one'));
		expect(next.sha256).toEqual(await versionOf('two'));

		// A capture that crossed JSON, as it would a bridge, still identifies bytes.
		const read = expectOk(await folder.files.read('draft.md'));
		const { bytes: _bytes, ...readCapture } = read;
		const wired = JSON.parse(JSON.stringify(readCapture)) as FileCapture;
		expect(wired).toEqual({
			path: 'draft.md',
			sha256: await versionOf('three'),
		});
		const viaWire = expectOk(await folder.files.replace(wired, 'four'));
		expect(viaWire.sha256).toEqual(await versionOf('four'));

		// A caller mutating the object it passed cannot move the baseline.
		const loose = { path: 'draft.md', sha256: viaWire.sha256 };
		const replacing = folder.files.replace(loose, 'five');
		loose.path = 'elsewhere.md';
		loose.sha256 = '0'.repeat(64);
		expect(expectOk(await replacing)).toEqual({
			path: 'draft.md',
			sha256: await versionOf('five'),
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
		// The whole read value is a usable target: only its path and sha256 count.
		expectOk(await folder.files.replace(read, 'text now'));
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
		for (const refused of [
			await folder.files.replace(pathOnly, 'x'),
			await folder.files.remove(pathOnly),
			await folder.files.move(pathOnly, 'b.txt'),
		])
			expect(expectErr(refused)).toMatchObject({
				name: 'InvalidPath',
				reason: 'the capture has no valid SHA-256',
			});
		expect(await text(folder, 'a.txt')).toBe('kept');
	});

	test('the handle says where it is, and hints name the paths its saves reached', async () => {
		const folder = await open();
		if (kind === 'browser')
			expect(folder.location).toEqual(locationOf('so.epicenter.filestest'));
		else expect(folder.location.kind).toBe('directory');

		// Subscribed before the first read, so nothing falls between them.
		const heard: string[] = [];
		const stop = folder.onFilesChanged((paths) => heard.push(...paths));
		expectOk(await folder.files.list());
		const made = expectOk(await folder.files.create('a.txt', 'a'));
		const moved = expectOk(await folder.files.move(made, 'b.txt'));
		expectErr(await folder.files.create('b.txt', 'refused'));
		expectOk(
			await folder.tables.todos.create(
				{ fields: { title: 'R' }, body: '' },
				{ stem: 'row' },
			),
		);
		// The first save publishes the declaration before its own file.
		expect(heard).toEqual([
			'epicenter.json',
			'a.txt',
			'a.txt',
			'b.txt',
			'todos/row.md',
		]);

		stop();
		expectOk(await folder.files.remove(moved));
		expect(heard).toHaveLength(5);

		// Closing fences callbacks: a listener hears nothing more, however
		// the close and the last save interleave.
		const late: string[] = [];
		folder.onFilesChanged((paths) => late.push(...paths));
		const saving = folder.files.create('last.txt', 'last');
		const closing = folder.close();
		await Promise.all([saving, closing]);
		expect(late).toEqual([]);
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
		const boundary: FileBoundary = {
			...base,
			read(path) {
				reads.push(path);
				return base.read(path);
			},
			readMany(paths) {
				reads.push(...paths);
				return base.readMany(paths);
			},
			open(path) {
				reads.push(path);
				return base.open(path);
			},
			async apply(changes) {
				const result = await base.apply(changes);
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
			commitAndPush: unused,
			push: unused,
			fetch: unused,
			pullFastForward: unused,
			mergeIncoming: unused,
			recoverIncoming: unused,
			sync: {
				run: unused,
				resolve: unused,
				connect: unused,
			},
			paths: unused,
			stage: unused,
			commitStaged: unused,
			diff: unused,
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
					const bytes = encoder.encode(content);
					expectOk(
						await base.apply([
							{
								kind: 'overwrite',
								path,
								bytes,
								sha256: await hashBytes(bytes),
							},
						]),
					);
				};
			},
		};
	}
	function unused(): never {
		throw new Error('this test uses no Git');
	}

	test('create, replace, overwrite, move, and a table save read nothing after publishing', async () => {
		const { folder, reads } = await instrumented();
		const created = expectOk(await folder.files.create('a.md', 'one'));
		const replaced = expectOk(await folder.files.replace(created, 'two'));
		const moved = expectOk(await folder.files.move(replaced, 'b.md'));
		expectOk(await folder.files.overwrite('b.md', 'three'));
		expectOk(
			await folder.files.remove({
				...moved,
				sha256: await versionOf('three'),
			}),
		);
		const row = expectOk(
			await folder.tables.todos.create(
				{ fields: { title: 'R' }, body: '' },
				{ stem: 'r' },
			),
		);
		const saved = expectOk(
			await folder.tables.todos.replace(row, {
				fields: { title: 'S' },
				body: '',
			}),
		);
		const renamed = expectOk(await folder.tables.todos.rename(saved, 's'));
		expectOk(await folder.tables.todos.delete(renamed));
		// The one read is the declaration's, before the first save (ADR-0508).
		expect(reads).toEqual(['epicenter.json']);
	});

	test('a writer that lands behind a save does not change the capture the save returns', async () => {
		const { folder, raceNextSave } = await instrumented();
		const base = expectOk(await folder.files.create('note.md', 'base'));

		raceNextSave('note.md', 'raced in behind');
		const mine = expectOk(await folder.files.replace(base, 'mine'));
		// The capture is the bytes this save was given. It is not what a reread
		// would have found, which by now is the other writer's bytes.
		expect(mine.sha256).toEqual(await versionOf('mine'));
		const observed = expectOk(await folder.files.read('note.md'));
		expect(decoder.decode(observed.bytes)).toBe('raced in behind');
		expect(observed.sha256).not.toEqual(mine.sha256);

		// So the next save built on `mine` is refused, instead of silently
		// overwriting bytes this editor never saw.
		expect(
			expectErr(await folder.files.replace(mine, 'next draft')),
		).toMatchObject({
			name: 'Conflict',
			expectedSha256: mine.sha256,
			actualSha256: observed.sha256,
		});

		// The same holds for a moved file and for a table row.
		raceNextSave('moved.md', 'raced the move');
		const moved = expectOk(await folder.files.move(observed, 'moved.md'));
		expect(moved.sha256).toEqual(observed.sha256);
		expect(expectErr(await folder.files.remove(moved)).name).toBe('Conflict');

		raceNextSave('todos/r.md', '---\ntitle: Theirs\n---\n');
		const row = expectOk(
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
		expect(
			expectErr(
				await folder.tables.todos.replace(row, {
					fields: { title: 'Again' },
					body: '',
				}),
			).name,
		).toBe('Conflict');
	});
});
