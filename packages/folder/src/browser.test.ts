/**
 * Browser folders with real isomorphic-git objects, on the in-memory OPFS
 * stand-in (`browser-storage.test-support.ts`).
 *
 * A save makes no commit (ADR-0529): table, file, and shell writes stay
 * uncommitted until a commit is asked for, and staged authoring works through
 * the folder shell.
 * A table reads and writes one Markdown file per row and leaves every other
 * file alone.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as isogit from 'isomorphic-git';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	defineFolder,
	defineTable,
	type Folder,
	field,
	openFolder,
} from './browser.js';
import {
	browserStorage,
	configureRemote,
	createTestStorage,
	rawBrowserFolder,
	type TestStorage,
	testBrowserStorage,
} from './browser-storage.test-support.js';
import { createHistory } from './git/history.js';
import { overwrite } from './put.test-support.js';
import { parseRow } from './row-text.js';
import { mustRow } from './row-write.test-support.js';
import { useWebLocks } from './web-locks.test-support.js';

const definition = defineFolder({
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});

const author = { name: 'Browser', email: 'browser@example.test' };

let environment: TestStorage;
const opened: Folder<typeof definition>[] = [];

async function open(options: { app?: string } = {}) {
	environment ??= createTestStorage();
	const folder = expectOk(
		await openFolder({
			app: options.app ?? 'test',
			definition,
			browser: {
				author,
				...browserStorage(environment),
			},
		}),
	);
	opened.push(folder);
	return folder;
}

afterEach(async () => {
	for (const folder of opened.splice(0)) await folder.close();
	environment = createTestStorage();
});

describe('browser folder tables', () => {
	test('a repository previously opened on another branch refuses a new main history', async () => {
		environment = createTestStorage();
		const raw = await rawBrowserFolder({
			id: 'legacy-branch',
			storage: environment,
		});
		const backend = await raw.backend({ branch: 'backup' });
		const boundary = raw.boundary;
		const history = createHistory({
			backend,
			boundary,
			author,
		});
		await overwrite(boundary, 'legacy.txt', 'previous history');
		expect((await history.commit()).status).toBe('committed');
		const previous = await backend.readBranch();
		await history.close();
		const folder = await open({ app: 'legacy-branch' });
		expectOk(await folder.write('saved.txt', null, 'saved'));
		expect(await folder.git.commit()).toMatchObject({
			status: 'blocked',
			reason: 'HEAD is not on main',
		});
		expect(expectOk(await folder.files.read('saved.txt')).bytes).toEqual(
			new TextEncoder().encode('saved'),
		);
		expect(expectOk(await folder.git.log(10))).toEqual([]);
		expect(await backend.readBranch()).toBe(previous);
		await expect(
			backend.withObjects((access) =>
				isogit.resolveRef({ ...access, ref: 'refs/heads/main' }),
			),
		).rejects.toThrow();
	});

	test('creates, lists, sets, renames, and deletes canonical Markdown rows', async () => {
		const folder = await open();
		const created = mustRow(
			await folder.tables.todos.create(
				{ fields: { title: 'Buy milk', done: false }, body: 'Two liters.\n' },
				{ stem: 'milk' },
			),
		);

		expect(created.path).toBe('todos/milk.md');
		const raw = expectOk(await folder.files.read('todos/milk.md'));
		expect(
			expectOk(
				parseRow(definition.tables.todos, new TextDecoder().decode(raw.bytes)),
			),
		).toEqual(created.row);
		expect(raw.sha256).toEqual(created.sha256);

		const completed = mustRow(
			await folder.tables.todos.set('milk', { done: true }),
		);
		expect(completed.row).toEqual({
			fields: { title: 'Buy milk', done: true },
			body: 'Two liters.\n',
		});
		expect(expectOk(await folder.tables.todos.get('milk'))).toEqual(completed);

		const renamed = mustRow(
			await folder.tables.todos.rename('milk', 'groceries'),
		);
		expect(renamed).toEqual({ ...completed, path: 'todos/groceries.md' });

		expect((await folder.tables.todos.get('milk')).data).toBeUndefined();
		const listed = expectOk(await folder.tables.todos.list());
		expect(listed.map((item) => expectOk(item.result).path)).toEqual([
			'todos/groceries.md',
		]);

		expectOk(await folder.tables.todos.delete('groceries'));
		expect(expectOk(await folder.tables.todos.list())).toEqual([]);
	});

	test('create refuses an occupied stem, keeps names exactly, and refuses a path outside its table', async () => {
		const folder = await open();
		await folder.tables.todos.create(
			{ fields: { title: 'P', done: false }, body: '' },
			{ stem: 'Plan' },
		);
		expect(
			expectErr(
				await folder.tables.todos.create(
					{ fields: { title: 'Q', done: false }, body: '' },
					{ stem: 'Plan' },
				),
			).name,
		).toBe('Occupied');
		expect(expectOk(await folder.tables.todos.get('Plan'))?.row.fields).toEqual(
			{ title: 'P', done: false },
		);
		// Browser storage keeps names exactly: another spelling is another row.
		expect(
			mustRow(
				await folder.tables.todos.create(
					{ fields: { title: 'Q', done: false }, body: '' },
					{ stem: 'plan' },
				),
			).path,
		).toBe('todos/plan.md');
		expect(
			expectErr(
				await folder.tables.todos.create(
					{ fields: { title: 'Q', done: false }, body: '' },
					{ stem: '../x' },
				),
			).name,
		).toBe('InvalidPath');
		expect(
			expectErr(
				await folder.tables.todos.create(
					{ fields: { title: 3 as unknown as string, done: false }, body: '' },
					{ stem: 'ok' },
				),
			).name,
		).toBe('InvalidValues');
	});

	test('text that is not a valid row is InvalidRow with its exact text, and is repaired by a raw write from that text', async () => {
		const folder = await open();
		const source =
			'﻿---\r\ntitle: Kept # comment\r\ndone: maybe\r\nextra: unknown\r\n---\r\nBody\r\n';
		await folder.write('todos/odd.md', null, source);
		await folder.write('todos/broken.md', null, '---\ntitle: [\n---\n');
		await folder.write(
			'todos/bad.md',
			null,
			new Uint8Array([0xff, 0xfe, 0x00]),
		);
		const listed = expectOk(await folder.tables.todos.list());
		const item = (stem: string) =>
			listed.find((found) => found.stem === stem)!.result;
		expect(expectErr(item('bad')).name).toBe('InvalidUtf8');

		const odd = expectErr(item('odd'));
		if (odd.name !== 'InvalidRow') throw new Error(odd.message);
		expect(odd.path).toBe('todos/odd.md');
		expect(odd.text).toBe(source);
		expect(odd.issues.map((issue) => issue.field)).toEqual(['done']);
		expectOk(
			await folder.write(
				odd.path,
				odd.text,
				'---\ntitle: Kept\ndone: true\n---\nBody\n',
			),
		);
		expect(expectOk(await folder.tables.todos.get('odd'))?.row).toEqual({
			fields: { title: 'Kept', done: true },
			body: 'Body\n',
		});
		// That text is gone, and it is not a row, so a second write from it
		// merges by line: the edit wins where both changed the same lines.
		expectOk(
			await folder.write(
				odd.path,
				odd.text,
				'---\ntitle: Again\ndone: false\n---\n',
			),
		);
		expect(expectOk(await folder.tables.todos.get('odd'))?.row).toEqual({
			fields: { title: 'Again', done: false },
			body: '',
		});

		const broken = expectErr(item('broken'));
		if (broken.name !== 'InvalidRow') throw new Error(broken.message);
		// Text with no canonical form has exactly one issue.
		expect(broken.issues).toHaveLength(1);
		expectOk(
			await folder.write(
				broken.path,
				broken.text,
				'---\ntitle: Repaired\ndone: false\n---\n',
			),
		);
		expect(expectOk(await folder.tables.todos.get('broken'))?.row).toEqual({
			fields: { title: 'Repaired', done: false },
			body: '',
		});
	});

	test('same-stem siblings are ordinary files: a row is created beside them, and rename and delete leave them', async () => {
		const folder = await open();
		const audio = new Uint8Array([1, 2, 3]);
		// The audio exists first. It does not block the row that shares its stem.
		const opus = expectOk(await folder.write('todos/rec.opus', null, audio));
		expectOk(await folder.write('todos/rec.wav', null, new Uint8Array([9])));
		const receipt = mustRow(
			await folder.tables.todos.create(
				{ fields: { title: 'Recording', done: false }, body: '' },
				{ stem: 'rec' },
			),
		);
		// Siblings can also arrive after the row was captured.
		expectOk(await folder.write('todos/rec.flac', null, 'late'));
		const created = expectOk(await folder.tables.todos.get('rec'))!;
		expect(created).toEqual(receipt);
		// A stored row is the capture and its row: no attachment, no sibling.
		expect(Object.keys(created).sort()).toEqual([
			'path',
			'row',
			'sha256',
			'text',
		]);
		// Two siblings are not an ambiguity; the listed row is as valid as it was.
		const listed = expectOk(await folder.tables.todos.list());
		expect(listed.map((item) => expectOk(item.result))).toEqual([created]);

		expectOk(await folder.tables.todos.rename('rec', 'rec2'));
		expect(expectOk(await folder.files.children('todos')).files).toEqual([
			'.epicenter.json',
			'rec.flac',
			'rec.opus',
			'rec.wav',
			'rec2.md',
		]);

		const kept = expectOk(await folder.files.read('todos/rec.opus'));
		expect(kept.bytes).toEqual(audio);
		expect<string | undefined>(kept.sha256).toEqual(opus.file?.sha256);
		// Changing and moving a sibling cannot change what row deletion owns.
		expectOk(await folder.move('todos/rec.opus', 'todos/rec2.opus'));
		const changedAudio = expectOk(
			await folder.write('todos/rec2.opus', audio, 'rewritten'),
		);
		expectOk(await folder.tables.todos.delete('rec2'));
		expect(expectOk(await folder.files.children('todos')).files).toEqual([
			'.epicenter.json',
			'rec.flac',
			'rec.wav',
			'rec2.opus',
		]);
		const surviving = expectOk(await folder.files.read('todos/rec2.opus'));
		expect(new TextDecoder().decode(surviving.bytes)).toBe('rewritten');
		expect<string | undefined>(surviving.sha256).toEqual(
			changedAudio.file?.sha256,
		);

		// `rec.take.md` is its own row, not something `rec.md` owns.
		expectOk(
			await folder.write(
				'todos/rec.take.md',
				null,
				'---\ntitle: T\ndone: false\n---\n',
			),
		);
		expect(expectOk(await folder.tables.todos.get('rec.take'))).toMatchObject({
			path: 'todos/rec.take.md',
			row: { fields: { title: 'T', done: false }, body: '' },
		});
	});

	test('admits a reference field as a string that nothing checks or repairs', async () => {
		const withReference = defineFolder({
			tables: {
				lists: defineTable({ fields: { title: field.string() } }),
				todos: defineTable({
					fields: { title: field.string(), list: field.reference('lists') },
				}),
			},
		});
		const folder = expectOk(
			await openFolder({
				app: 'references',
				definition: withReference,
				browser: {
					author,
					...testBrowserStorage(),
				},
			}),
		);
		try {
			const { lists, todos } = folder.tables;
			// The schema is the whole check: a nonempty string, existing or not.
			expect(
				expectErr(
					await todos.create(
						{ fields: { title: 'T', list: '' }, body: '' },
						{ stem: 'empty' },
					),
				).name,
			).toBe('InvalidValues');
			expectOk(
				await todos.create(
					{ fields: { title: 'T', list: 'no-such-list' }, body: '' },
					{ stem: 'dangling' },
				),
			);
			expectOk(
				await lists.create(
					{ fields: { title: 'Home' }, body: '' },
					{ stem: 'home' },
				),
			);
			expectOk(
				await todos.create(
					{ fields: { title: 'M', list: 'home' }, body: '' },
					{ stem: 'milk' },
				),
			);

			// Renaming the row a reference names rewrites nothing that names it.
			expectOk(await lists.rename('home', 'house'));
			for (const [stem, list] of [
				['milk', 'home'],
				['dangling', 'no-such-list'],
			] as const) {
				const stored = expectOk(await todos.get(stem));
				expect(stored).toMatchObject({ row: { fields: { list } } });
			}
		} finally {
			await folder.close();
		}
	});

	test('a todo with an unresolvable alias is an InvalidRow, repaired by replacing its captured bytes', async () => {
		const folder = await open();
		const source = '---\ntitle: *missing\ndone: false\n---\nNotes stay.\n';
		await folder.write('todos/alias.md', null, source);
		const listed = expectOk(await folder.tables.todos.list());
		expect(listed).toHaveLength(1);
		const invalid = expectErr(listed[0]!.result);
		if (invalid.name !== 'InvalidRow') throw new Error(invalid.message);
		// The exact text is the repair baseline.
		expect(invalid.text).toBe(source);
		expect(invalid.issues[0].message).toContain('alias');

		expectOk(
			await folder.write(
				invalid.path,
				invalid.text,
				'---\ntitle: Fixed\ndone: false\n---\nNotes stay.\n',
			),
		);
		expect(expectOk(await folder.tables.todos.get('alias'))?.row).toEqual({
			fields: { title: 'Fixed', done: false },
			body: 'Notes stay.\n',
		});
	});
});

describe('browser folder persistence and history', () => {
	test('files, directories, and history survive reopening the folder', async () => {
		const first = await open();
		await first.tables.todos.create(
			{ fields: { title: 'Kept', done: false }, body: '' },
			{ stem: 'kept' },
		);
		await first.files.mkdir('empty/dir');
		expect(first.git.snapshot.lastCommit).toBeUndefined();
		expect((await first.git.commit()).status).toBe('committed');
		await first.close();

		const second = await open();
		expect(
			expectOk(await second.tables.todos.get('kept'))?.row.fields.title,
		).toBe('Kept');
		expect((await second.files.children('empty')).data!.directories).toEqual([
			'dir',
		]);
		const commits = expectOk(await second.git.log(10));

		expect(commits.map((commit) => commit.message)).toEqual([
			'Update 2 files\n',
		]);
		const status = expectOk(await second.git.status());

		expect(status.changes).toEqual([]);
	});

	test('file create, move, and remove make no commit; an explicit commit records each', async () => {
		const folder = await open();
		expectOk(await folder.write('notes/raw.txt', null, 'hello'));
		expect(folder.git.snapshot.activity.commit).toEqual({ active: false });
		expect(folder.git.snapshot.lastCommit).toBeUndefined();
		expect(await folder.git.commit()).toMatchObject({
			status: 'committed',
			message: 'Update 2 files',
		});
		expectOk(await folder.move('notes/raw.txt', 'moved.txt'));
		expect(expectOk(await folder.git.status()).changes).not.toEqual([]);
		expect((await folder.git.commit()).status).toBe('committed');
		expect(expectOk(await folder.git.status()).changes).toEqual([]);
		expectOk(await folder.write('moved.txt', null, null));
		expect(await folder.git.commit()).toMatchObject({
			status: 'committed',
			message: 'Delete moved.txt',
		});
		expect((await folder.git.log(10)).data).toHaveLength(3);
	});

	test('directories and refused content saves make no commit', async () => {
		const folder = await open();
		expectOk(await folder.files.mkdir('empty'));
		expectOk(await folder.files.rmdir('empty'));
		// An edit never recreates a file that is not there: it writes nothing.
		const missing = expectOk(await folder.write('missing.txt', '', 'x'));
		expect(missing.file).toBeNull();
		expect(folder.git.snapshot.lastCommit).toBeUndefined();
		expect(folder.git.snapshot.activity.commit).toEqual({ active: false });
	});

	test('subscribe delivers the cached snapshot synchronously, unknown before the first scan', async () => {
		const folder = await open();
		const seen: string[] = [];
		const unsubscribe = folder.git.subscribe((snapshot) =>
			seen.push(snapshot.files.state),
		);
		expect(seen).toEqual(['unknown']);
		await folder.git.status();
		expect(seen.at(-1)).toBe('observed');
		await folder.write('x.txt', null, 'x');
		const files = folder.git.snapshot.files;
		expect(files.state === 'observed' && files.stale).toBe(true);
		unsubscribe();
	});

	test('table and file saves make no commit; Save version commits', async () => {
		const folder = await open();
		await folder.tables.todos.create(
			{ fields: { title: 'M', done: false }, body: '' },
			{ stem: 'manual' },
		);
		expectOk(await folder.write('manual.txt', null, 'x'));
		await Bun.sleep(20);
		expect(folder.git.snapshot.lastCommit).toBeUndefined();
		expect((await folder.git.commit()).status).toBe('committed');
	});

	test('a stalled Sync blocks neither saves nor commits; close aborts it and settles', async () => {
		const originalFetch = globalThis.fetch;
		let requests = 0;
		globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
			requests++;
			return new Promise<Response>((_resolve, reject) =>
				init?.signal?.addEventListener('abort', () =>
					reject(new DOMException('The push was cancelled', 'AbortError')),
				),
			);
		}) as typeof fetch;
		try {
			environment = createTestStorage();
			await configureRemote(
				environment,
				'stall',
				'http://stall.test/remote.git',
			);
			const folder = expectOk(
				await openFolder({
					app: 'stall',
					definition,
					browser: {
						author,
						...browserStorage(environment),
					},
				}),
			);
			await folder.tables.todos.create(
				{ fields: { title: 'A', done: false }, body: '' },
				{ stem: 'a' },
			);
			expect((await folder.git.commit()).status).toBe('committed');
			expect(requests).toBe(0);
			const syncing = folder.sync.run();
			for (let index = 0; index < 200 && requests === 0; index++)
				await Bun.sleep(5);
			expect(folder.git.snapshot.activity.fetch.active).toBe(true);

			expectOk(
				await folder.tables.todos.create(
					{ fields: { title: 'B', done: false }, body: '' },
					{ stem: 'b' },
				),
			);

			expect(await folder.git.commit()).toMatchObject({
				status: 'committed',
				message: 'Add todos/b.md',
			});
			// That commit is local: nothing more was asked of the remote.
			expect(folder.git.snapshot.activity.fetch.active).toBe(true);

			await folder.close();
			expect((await syncing).error?.name).toBe('Closed');
			expect(folder.git.snapshot.activity.fetch).toEqual({ active: false });
			expect(requests).toBe(1);
			expect(expectErr(await folder.tables.todos.list()).name).toBe('Closed');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test('a checkpoint whose branch a competitor moved retries onto it, never forcing the branch', async () => {
		const raw = await rawBrowserFolder({ id: 'cas' });
		const boundary = raw.boundary;
		const backend = await raw.backend();
		let competitor: string | undefined;
		const history = createHistory({
			backend: {
				...backend,
				async casBranch(expected, next) {
					if (competitor !== undefined)
						return backend.casBranch(expected, next);
					// Another writer moves the branch between capture and publication.
					competitor = await backend.withObjects((access) =>
						isogit.writeCommit({
							...access,
							commit: {
								tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
								parent: [],
								author: { ...author, timestamp: 1, timezoneOffset: 0 },
								committer: { ...author, timestamp: 1, timezoneOffset: 0 },
								message: 'Competitor\n',
							},
						}),
					);
					await backend.withObjects((access) =>
						isogit.writeTree({ ...access, tree: [] }),
					);
					expect((await backend.casBranch(expected, competitor)).ok).toBe(true);
					return backend.casBranch(expected, next);
				},
			},
			boundary,
			author,
		});
		await overwrite(boundary, 'a.txt', 'a');
		const outcome = await history.commit();
		// The retry captured again and committed on top of the competitor.
		expect(outcome).toMatchObject({ status: 'committed', parent: competitor });
		if (outcome.status === 'committed')
			expect(await backend.readBranch()).toBe(outcome.oid);
		await history.close();
	});
});

// Commits need the shared lock; this runtime has none of its own.
useWebLocks();
