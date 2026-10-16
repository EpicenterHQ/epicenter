/**
 * Observer Isolation Tests
 *
 * Change listeners and history subscribers are the application's code,
 * called from inside the folder's own work. These tests pin that such code
 * cannot change what a save reports, and that closing fences it at once.
 *
 * Key behaviors:
 * - A listener or subscriber that throws does not reject a save whose bytes
 *   landed, does not change what the next commit records, and does not
 *   silence the listeners after it
 * - A listener that closes the folder, or stops another listener, fences the
 *   listeners after it within the same dispatch
 * - In a browser, pages of one origin tell each other the paths they write,
 *   and a page resumed from being frozen or from the back-forward cache
 *   hears everything; returning to a window reports nothing
 * - A browser relay that throws does not change a save's result
 * - A browser channel that cannot start is a returned `Unavailable`; a
 *   channel it constructed is closed, and no lock stays held
 *
 * See also:
 * - `files.test.ts`: a handle's own saves are not reported to it
 * - `tauri-directory.test.ts`: the desktop's change event
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
import {
	defineFolder,
	defineTable,
	type FilesChanged,
	type Folder,
	field,
} from './contract.js';
import { openNativeFolder } from './directory.test-support.js';
import { createFileHints } from './folder.js';
import { GIT_ENV, scratch } from './git-http.test-support.js';
import { useWebLocks } from './web-locks.test-support.js';

const definition = defineFolder({
	kv: { theme: field.string() },
	tables: { notes: defineTable({ fields: { title: field.string() } }) },
});
type Opened = Folder<typeof definition>;
const author = { name: 'Observers', email: 'observers@example.test' };

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
		expectOk(await folder.write('note.txt', null, 'submitted'));
		expect(seen.length).toBeGreaterThan(before);

		// A commit publishes its activity to the same subscribers.
		const during = seen.length;
		expect((await folder.git.commit()).status).toBe('committed');
		expect(seen.length).toBeGreaterThan(during);
		expect((await folder.git.commit()).status).toBe('unchanged');
	});
});

describe('change listener dispatch', () => {
	test('a listener that throws does not silence the listeners after it', () => {
		const hints = createFileHints();
		const heard: FilesChanged[] = [];
		hints.subscribe(() => {
			throw new Error('broken observer');
		});
		hints.subscribe((change) => heard.push(change));
		hints.report(['a.md']);
		hints.report('everything');
		// An empty report is no change.
		hints.report([]);
		expect(heard).toEqual([['a.md'], 'everything']);
	});

	test('a listener that closes fences the listeners after it', () => {
		const hints = createFileHints();
		const calls: number[] = [];
		hints.subscribe(() => {
			calls.push(1);
			hints.close();
		});
		hints.subscribe(() => calls.push(2));
		hints.report(['a.md']);
		hints.report(['b.md']);
		expect(calls).toEqual([1]);
		// Closed: a new listener is never called.
		hints.subscribe(() => calls.push(3));
		hints.report(['c.md']);
		expect(calls).toEqual([1]);
	});

	test('a listener stopped, or added, during a dispatch is not called in it', () => {
		const hints = createFileHints();
		const calls: string[] = [];
		let stopSecond = () => {};
		hints.subscribe(() => {
			calls.push('first');
			stopSecond();
			hints.subscribe(() => calls.push('added'));
		});
		stopSecond = hints.subscribe(() => calls.push('second'));
		hints.subscribe(() => calls.push('third'));

		hints.report(['a.txt']);
		expect(calls).toEqual(['first', 'third']);

		// The one added during the first dispatch hears the next; the one
		// stopped stays stopped. (The first adds another each time.)
		calls.length = 0;
		hints.report(['b.txt']);
		expect(calls).toEqual(['first', 'third', 'added']);
	});
});

describe('browser pages', () => {
	/** Two handles on one origin's storage, which tell each other their writes. */
	async function pages(page?: {
		window?: EventTarget;
		document?: EventTarget;
	}) {
		const environment = createTestStorage({ BroadcastChannel });
		const open = async (withPage?: typeof page) =>
			expectOk(
				await openBrowserFolder({
					id: 'so.epicenter.observerstest',
					definition,
					browser: {
						author,
						opfs: {
							...browserStorage(environment).opfs!,
							page: withPage,
						},
					},
				}),
			);
		const writer = await open();
		const reader = await open(page);
		opened.push(writer, reader);
		return { writer, reader };
	}

	/** What `folder` hears until `paths` all arrived, or a short wait passed. */
	async function hear(folder: Opened, work: () => Promise<unknown>) {
		const heard: FilesChanged[] = [];
		const stop = folder.onFilesChanged((change) => heard.push(change));
		await work();
		for (let tries = 0; tries < 20; tries++) await Bun.sleep(5);
		stop();
		return heard;
	}

	test('a write in one page reaches the other as its paths, and a throwing listener there changes nothing', async () => {
		const { writer, reader } = await pages();
		reader.onFilesChanged(() => {
			throw new Error('broken observer');
		});
		const heard = await hear(reader, async () => {
			expectOk(await writer.write('note.txt', null, 'submitted'));
			expectOk(
				await writer.tables.notes.create(
					{ fields: { title: 'A' }, body: '' },
					{ stem: 'a' },
				),
			);
			expectOk(await writer.tables.notes.set('a', { title: 'B' }));
			expectOk(await writer.kv.set('theme', 'dark'));
		});
		// The first save publishes the declaration before its own file.
		expect(heard.flat()).toEqual([
			'epicenter.json',
			'note.txt',
			'notes/a.md',
			'notes/a.md',
			'kv.json',
		]);
		// The writer heard none of its own writes, and its commit records them.
		expect((await writer.git.commit()).status).toBe('committed');
		expect(expectOk(await writer.git.status()).changes).toEqual([]);
	});

	test('a page resumed from being frozen or from the back-forward cache hears everything; returning to it hears nothing', async () => {
		const window = new EventTarget();
		const document = new EventTarget();
		const { reader } = await pages({ window, document });
		const pageshow = (persisted: boolean) =>
			Object.assign(new Event('pageshow'), { persisted });
		const heard = await hear(reader, async () => {
			window.dispatchEvent(new Event('focus'));
			document.dispatchEvent(new Event('visibilitychange'));
			window.dispatchEvent(pageshow(false));
			window.dispatchEvent(pageshow(true));
			document.dispatchEvent(new Event('resume'));
		});
		expect(heard).toEqual(['everything', 'everything']);
		// Closing stops listening to the page.
		await reader.close();
		const late: FilesChanged[] = [];
		reader.onFilesChanged((change) => late.push(change));
		document.dispatchEvent(new Event('resume'));
		expect(late).toEqual([]);
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
		expectOk(await folder.write('note.txt', null, 'submitted'));
		expectOk(await folder.write('b.txt', null, 'b'));
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
		expectOk(await folder.write('note.txt', null, 'submitted'));
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
		const heard: FilesChanged[] = [];
		reader.onFilesChanged((change) => heard.push(change));

		// The message is posted while the reader is open and delivered after it
		// started closing.
		const saving = writer.write('late.txt', null, 'late');
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
	const stopSeeded = reader.onFilesChanged((change) => {
		if (change !== 'everything' && change.includes('first.txt'))
			seeded.resolve();
	});
	expectOk(await writer.write('first.txt', null, 'first'));
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
	const heard = Promise.withResolvers<FilesChanged>();
	reader.onFilesChanged(heard.resolve);
	expectOk(await writer.write('external.txt', null, 'saved by another handle'));
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
