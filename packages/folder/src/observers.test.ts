/**
 * Observer Isolation Tests
 *
 * Change listeners and history subscribers are the application's code, called
 * from inside the folder's own saves. These tests pin that such code cannot
 * change what a save reports, and that closing fences it at once.
 *
 * Key behaviors:
 * - A listener or subscriber that throws does not reject a save whose bytes
 *   landed, does not change what the next commit records, and does not
 *   silence the listeners after it
 * - A listener that closes the folder, or stops another listener, fences the
 *   listeners after it within the same dispatch
 * - A browser relay that throws does not change a save's result
 * - A browser channel that cannot start is a returned `Unavailable`; a
 *   channel it constructed is closed, and no lock stays held
 *
 * See also:
 * - `tauri.test.ts` for the same rules on events from the desktop owner
 * - `files.test.ts` for which paths a hint names
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
import { openFolder as openBrowserFolder } from './browser.js';
import {
	browserStorage,
	createTestStorage,
	testBrowserStorage,
} from './browser-storage.test-support.js';
import { hashBytes } from './capture.js';
import { defineFolder, defineTable, type Folder, field } from './contract.js';
import { openNativeFolder } from './directory.test-support.js';
import { GIT_ENV, scratch } from './git-http.test-support.js';
import { useWebLocks } from './web-locks.test-support.js';

const definition = defineFolder({
	kv: { theme: field.string() },
	tables: { notes: defineTable({ fields: { title: field.string() } }) },
});
type Opened = Folder<typeof definition>;
const author = { name: 'Observers', email: 'observers@example.test' };
const encoder = new TextEncoder();

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

describe.each(['browser', 'directory'])('%s folder observers', (kind) => {
	async function open() {
		const folder =
			kind === 'browser'
				? expectOk(
						await openBrowserFolder({
							id: 'so.epicenter.observerstest',
							definition,
							browser: {
								author,
								...testBrowserStorage(),
							},
						}),
					)
				: await openNativeFolder({
						root: await scratch('observers-'),
						definition,
						git: { author },
					});
		opened.push(folder);
		return folder;
	}

	test('a listener that throws does not erase a save, its commit, or the listeners after it', async () => {
		const folder = await open();
		const heard: string[] = [];
		folder.onFilesChanged(() => {
			throw new Error('broken observer');
		});
		folder.onFilesChanged((paths) => heard.push(...paths));

		// Every kind of save announces from inside its own publication.
		const created = expectOk(
			await folder.files.create('note.txt', 'submitted'),
		);
		expect(created).toEqual({
			path: 'note.txt',
			sha256: await hashBytes(encoder.encode('submitted')),
		});
		const row = expectOk(
			await folder.tables.notes.create(
				{ fields: { title: 'A' }, body: '' },
				{ stem: 'a' },
			),
		);
		expectOk(
			await folder.tables.notes.replace(row, {
				fields: { title: 'B' },
				body: '',
			}),
		);
		expectOk(await folder.kv.set('theme', 'dark'));
		expectOk(await folder.files.create('audio/a.webm', new Uint8Array([1])));
		expectOk(
			await folder.tables.notes.create(
				{ fields: { title: 'B' }, body: '' },
				{ stem: 'b' },
			),
		);

		// The second listener heard everything the first one threw on.
		// The first save publishes the declaration before its own file.
		expect(heard).toEqual([
			'epicenter.json',
			'note.txt',
			'notes/a.md',
			'notes/a.md',
			'kv.json',
			'audio/a.webm',
			'notes/b.md',
		]);
		// And the next commit records every save.
		expect((await folder.git.commit()).status).toBe('committed');
		expect(expectOk(await folder.git.status()).changes).toEqual([]);
	});

	test('a history subscriber that throws does not reject a save or silence other subscribers', async () => {
		const folder = await open();
		expectOk(await folder.git.status());
		let throwing = false;
		folder.git.subscribe(() => {
			if (throwing) throw new Error('broken subscriber');
		});
		const seen: boolean[] = [];
		folder.git.subscribe((snapshot) =>
			seen.push(snapshot.activity.commit.active),
		);
		throwing = true;
		const before = seen.length;

		// The save marks the observation stale, which publishes a snapshot from
		// inside the save.
		expectOk(await folder.files.create('note.txt', 'submitted'));
		expect(seen.length).toBeGreaterThan(before);

		// A commit publishes its activity to the same subscribers.
		const during = seen.length;
		expect((await folder.git.commit()).status).toBe('committed');
		expect(seen.length).toBeGreaterThan(during);
		expect((await folder.git.commit()).status).toBe('unchanged');
	});

	test('a listener that closes the folder fences the listeners after it, and the save still reports', async () => {
		const folder = await open();
		const calls: number[] = [];
		let closing: Promise<void> | undefined;
		folder.onFilesChanged(() => {
			calls.push(1);
			closing = folder.close();
		});
		folder.onFilesChanged(() => calls.push(2));

		const created = expectOk(
			await folder.files.create('note.txt', 'submitted'),
		);
		expect(created.path).toBe('note.txt');
		expect(calls).toEqual([1]);
		await closing;
		// The save made no commit, so closing had none to wait for.
		expect(folder.git.snapshot.lastCommit).toBeUndefined();
		expect(calls).toEqual([1]);
	});

	test('a listener stopped, or added, during a dispatch is not called in it', async () => {
		const folder = await open();
		// A handle's first write publishes its declaration first, a dispatch of
		// its own; this test is about the dispatches after it.
		expectOk(await folder.files.create('first.txt', 'first'));
		const calls: string[] = [];
		let stopSecond = () => {};
		folder.onFilesChanged(() => {
			calls.push('first');
			stopSecond();
			folder.onFilesChanged(() => calls.push('added'));
		});
		stopSecond = folder.onFilesChanged(() => calls.push('second'));
		folder.onFilesChanged(() => calls.push('third'));

		expectOk(await folder.files.create('a.txt', 'a'));
		expect(calls).toEqual(['first', 'third']);

		// The one added during the first dispatch hears the next; the one
		// stopped stays stopped. (The first adds another each time.)
		calls.length = 0;
		expectOk(await folder.files.create('b.txt', 'b'));
		expect(calls).toEqual(['first', 'third', 'added']);
	});
});

describe('browser channel', () => {
	/** A channel class whose behavior a test chooses, recording what was done to it. */
	function channelClass(
		fail: 'construct' | 'unref' | 'listen' | 'post' | 'close',
	) {
		const log: string[] = [];
		class Channel {
			constructor(readonly name: string) {
				if (fail === 'construct') throw new Error('channel unavailable');
				log.push('constructed');
			}
			unref() {
				if (fail === 'unref') throw new Error('unref refused');
			}
			set onmessage(_listener: unknown) {
				if (fail === 'listen') throw new Error('listener refused');
				log.push('listening');
			}
			postMessage() {
				if (fail === 'post') throw new Error('relay refused');
				log.push('posted');
			}
			close() {
				log.push('closed');
				if (fail === 'close') throw new Error('close refused');
			}
		}
		return { Channel: Channel as unknown as typeof BroadcastChannel, log };
	}

	test.each([
		'construct',
		'unref',
		'listen',
	] as const)('a channel that fails to %s is a returned Unavailable, and what was opened is released', async (fail) => {
		const { Channel, log } = channelClass(fail);
		const environment = createTestStorage({ BroadcastChannel: Channel });

		const refused = expectErr(
			await openBrowserFolder({
				id: 'so.epicenter.observerstest',
				definition,
				browser: browserStorage(environment),
			}),
		);

		expect(refused.name).toBe('Unavailable');
		expect(refused.message).toContain(
			fail === 'construct'
				? 'channel unavailable'
				: fail === 'unref'
					? 'unref refused'
					: 'listener refused',
		);
		// A channel that was constructed was closed. Nothing is left held by a
		// failed open.
		expect(log.includes('closed')).toBe(fail !== 'construct');
		// The same storage opens normally afterward: nothing was left locked.
		const reopened = expectOk(
			await openBrowserFolder({
				id: 'so.epicenter.observerstest',
				definition,
				browser: browserStorage({ opfs: environment.opfs }),
			}),
		);
		await reopened.close();
	});

	test('a relay that throws does not change a save, its listeners, or its commit', async () => {
		const { Channel } = channelClass('post');
		const folder = expectOk(
			await openBrowserFolder({
				id: 'so.epicenter.observerstest',
				definition,
				browser: {
					author,
					...testBrowserStorage({ BroadcastChannel: Channel }),
				},
			}),
		);
		const heard: string[] = [];
		folder.onFilesChanged((paths) => heard.push(...paths));

		expectOk(await folder.files.create('note.txt', 'submitted'));
		expectOk(await folder.files.create('b.txt', 'b'));
		// The first save publishes the declaration before its own file.
		expect(heard).toEqual(['epicenter.json', 'note.txt', 'b.txt']);
		expect((await folder.git.commit()).status).toBe('committed');
		expect(expectOk(await folder.git.status()).changes).toEqual([]);
		await folder.close();
	});

	test('a channel that will not close is closed once, and close resolves', async () => {
		const { Channel, log } = channelClass('close');
		const folder = expectOk(
			await openBrowserFolder({
				id: 'so.epicenter.observerstest',
				definition,
				browser: {
					author,
					...testBrowserStorage({ BroadcastChannel: Channel }),
				},
			}),
		);
		expectOk(await folder.files.create('note.txt', 'submitted'));
		await folder.close();
		expect(log.filter((entry) => entry === 'closed')).toHaveLength(1);
	});

	test('a hint from another handle that arrives after close reaches no listener', async () => {
		const environment = createTestStorage({ BroadcastChannel });
		const open = async () =>
			expectOk(
				await openBrowserFolder({
					id: 'so.epicenter.observerstest',
					definition,
					browser: {
						author,
						...browserStorage(environment),
					},
				}),
			);
		const writer = await open();
		const reader = await open();
		opened.push(writer);
		const heard: string[] = [];
		reader.onFilesChanged((paths) => heard.push(...paths));

		// The message is posted while the reader is open and delivered after it
		// started closing.
		const saving = writer.files.create('late.txt', 'late');
		const closing = reader.close();
		expectOk(await saving);
		await closing;
		await Bun.sleep(20);
		expect(heard).toEqual([]);
	});
});

test('a cross-tab file hint marks history stale and makes no commit', async () => {
	const environment = createTestStorage({ BroadcastChannel });
	const open = async () =>
		expectOk(
			await openBrowserFolder({
				id: 'so.epicenter.observerstest',
				definition,
				browser: { author, ...browserStorage(environment) },
			}),
		);
	const reader = await open();
	const writer = await open();
	opened.push(reader, writer);
	// A handle's first write publishes its declaration first; this test is
	// about a write after it. Commit that first write once the reader has
	// heard it, so the folder starts clean.
	const seeded = Promise.withResolvers<void>();
	const stopSeeded = reader.onFilesChanged((paths) => {
		if (paths.includes('first.txt')) seeded.resolve();
	});
	expectOk(await writer.files.create('first.txt', 'first'));
	await seeded.promise;
	stopSeeded();
	expect((await reader.git.commit()).status).toBe('committed');
	const previousAttempt = reader.git.snapshot.lastCommit;
	expectOk(await reader.git.status());
	expect(reader.git.snapshot.files).toMatchObject({
		state: 'observed',
		stale: false,
		value: { changes: [] },
	});
	const heard = Promise.withResolvers<readonly string[]>();
	reader.onFilesChanged(heard.resolve);
	expectOk(
		await writer.files.create('external.txt', 'saved by another handle'),
	);
	expect(await heard.promise).toContain('external.txt');
	expect(reader.git.snapshot.files).toMatchObject({
		state: 'observed',
		stale: true,
	});
	expect(reader.git.snapshot.lastCommit).toBe(previousAttempt);
	expect(reader.git.snapshot.activity.commit.active).toBe(false);
	expect(expectOk(await reader.git.status()).changes).toEqual([
		{ path: 'external.txt', kind: 'add' },
	]);
	expect(reader.git.snapshot.lastCommit).toBe(previousAttempt);
});

// Commits need the shared lock; this runtime has none of its own.
useWebLocks();
