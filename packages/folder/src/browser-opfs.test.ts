/**
 * Browser folders in the origin private file system, through the production
 * opener, over an in-memory OPFS (`opfs.test-support.ts`).
 *
 * Two handles on one environment stand in for two tabs: they share the
 * directory and the Web Locks. These tests show the folder's protocol; they
 * do not show that a browser's OPFS behaves like the stand-in. The page in
 * `evidence/opfs` runs the browser-dependent checks in a real browser.
 *
 * Key behaviors:
 * - One literal path is one stored file; empty directories are directories;
 *   `.git` holds private Git state and is never listed
 * - Exact bytes survive reopening; a read's identity is the SHA-256 of the
 *   bytes read, so a same-size rewrite in the same millisecond is noticed
 * - The bytes `files.read` returns stay after the path is replaced
 * - Across handles: exactly one of two creates wins, and two writes from one
 *   version both land, the second merged over the first, whose put was
 *   stale, so the writer acting last wins the line both changed
 * - A write that fails before its close is `Io`; a close that throws is
 *   unconfirmed whatever the path holds after (`Io`, its cause
 *   `Unconfirmed`), hinted, and committed as is
 * - Writes are not ordered by when they were asked for: a write entered
 *   first reads again and merges over a later one that landed while it
 *   prepared, and writes to other paths hold nothing back
 * - Closing refuses new work; a save already begun returns its real outcome
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	defineFolder,
	defineTable,
	type Folder,
	field,
	openFolder,
} from './browser.js';
import { formatDefinition } from './declaration.js';
import { hashBytes } from './hash.js';
import {
	type MemoryOpfs,
	memoryOpfs,
	opfsEnvironment,
} from './opfs.test-support.js';
import { put } from './put.test-support.js';
import { useWebLocks } from './web-locks.test-support.js';

useWebLocks();

const definition = defineFolder({
	tables: {
		notes: defineTable({ fields: { title: field.string() } }),
	},
});

const author = { name: 'Browser', email: 'browser@example.test' };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ROOT = 'test';

let opfs: MemoryOpfs;
const opened: Folder<typeof definition>[] = [];

function fresh() {
	opfs = memoryOpfs();
}
fresh();

async function open(options: { app?: string; hints?: boolean } = {}) {
	const folder = expectOk(
		await openFolder({
			app: options.app ?? 'test',
			definition,
			browser: {
				author,
				opfs: opfsEnvironment(opfs, {
					BroadcastChannel: options.hints ? BroadcastChannel : undefined,
				}),
			},
		}),
	);
	opened.push(folder);
	return folder;
}

afterEach(async () => {
	for (const folder of opened.splice(0)) await folder.close();
	fresh();
});

const allBytes = Uint8Array.from({ length: 256 }, (_, index) => index);

describe('one path is one stored file', () => {
	test('files and empty directories are literal entries; .git is private and unlisted', async () => {
		const folder = await open();
		expect(folder.location).toEqual({ kind: 'opfs', directory: ROOT });
		expectOk(await folder.write('notes/a.md', null, '# A\n'));
		expectOk(await folder.write('bytes.bin', null, allBytes));
		expectOk(await folder.write('empty.txt', null, ''));
		expectOk(await folder.files.mkdir('drafts/later'));

		const stored = opfs.files(ROOT);
		expect(decoder.decode(stored.get('notes/a.md'))).toBe('# A\n');
		expect(stored.get('bytes.bin')).toEqual(allBytes);
		expect(stored.get('empty.txt')).toEqual(new Uint8Array());
		// Saving creates no repository; the first commit does.
		expect(stored.has('.git/HEAD')).toBe(false);
		expect(opfs.directories(ROOT)).toContain('drafts/later');

		const listing = expectOk(await folder.files.list());
		expect(listing.files.map((file) => file.path)).toEqual([
			'bytes.bin',
			'empty.txt',
			'epicenter.json',
			'notes/a.md',
		]);
		expect(listing.directories).toEqual(['drafts', 'drafts/later', 'notes']);
		expect(expectOk(await folder.files.children(''))).toEqual({
			files: ['bytes.bin', 'empty.txt', 'epicenter.json'],
			directories: ['drafts', 'notes'],
		});
		expect(expectErr(await folder.write('.git/HEAD', null, 'x')).name).toBe(
			'InvalidPath',
		);
		expect(expectErr(await folder.files.read('drafts')).name).toBe('NotAFile');
		expect(
			expectErr(await folder.write('bytes.bin/inner', null, 'x')).name,
		).toBe('InvalidPath');
		expect(expectErr(await folder.write('drafts', null, 'x')).name).toBe(
			'InvalidPath',
		);
		expect(expectErr(await folder.files.rmdir('drafts')).name).toBe(
			'DirectoryNotEmpty',
		);
		expectOk(await folder.files.rmdir('drafts/later'));
		expect(expectOk(await folder.files.children('drafts'))).toEqual({
			files: [],
			directories: [],
		});
	});

	test('exact bytes, empty files, and empty directories survive reopening with history', async () => {
		const first = await open();
		expectOk(await first.write('bytes.bin', null, allBytes));
		expectOk(await first.write('empty.txt', null, new Uint8Array()));
		expectOk(await first.write('ünïcode/ノート.md', null, 'text'));
		expectOk(await first.files.mkdir('empty/nested'));
		const committed = await first.git.commit();
		expect(committed.status).toBe('committed');
		await first.close();

		const again = await open();
		expect(expectOk(await again.files.read('bytes.bin')).bytes).toEqual(
			allBytes,
		);
		expect(expectOk(await again.files.read('empty.txt')).bytes).toEqual(
			new Uint8Array(),
		);
		expect(
			decoder.decode(
				expectOk(await again.files.read('ünïcode/ノート.md')).bytes,
			),
		).toBe('text');
		expect(expectOk(await again.files.list()).directories).toContain(
			'empty/nested',
		);
		const log = expectOk(await again.git.log(5));
		expect(log.map((commit) => commit.oid)).toEqual([
			committed.status === 'committed' ? committed.oid : '',
		]);
		expect(expectOk(await again.git.status()).changes).toEqual([]);
	});

	test('identity is the hash of the bytes read, not size or time', async () => {
		const folder = await open();
		expectOk(await folder.write('a.txt', null, 'aaaa'));
		// Another writer changes the bytes without changing their size.
		opfs.put(`${ROOT}/a.txt`, encoder.encode('bbbb'));
		const read = expectOk(await folder.files.read('a.txt'));
		expect(read.sha256).toBe(await hashBytes(encoder.encode('bbbb')));
		// The write sees their change, and names the line it replaced.
		const written = expectOk(await folder.write('a.txt', 'aaaa', 'cccc'));
		expect(written.overridden).toEqual([
			{ kind: 'lines', part: 'text', line: 1, count: 1 },
		]);
		// Git sees the change too: stat caches are never trusted. The commit
		// records the bytes the path holds now.
		const committed = await folder.git.commit();
		expect(committed.status).toBe('committed');
		const [head] = expectOk(await folder.git.log(1));
		expect(head?.oid).toBe(
			committed.status === 'committed' ? committed.oid : undefined,
		);
		expect(expectOk(await folder.git.status()).changes).toEqual([]);
		opfs.put(`${ROOT}/a.txt`, encoder.encode('bbbc'));
		expect(expectOk(await folder.git.status()).changes).toEqual([
			{ path: 'a.txt', kind: 'modify' },
		]);
	});

	test('status sees a committed file rewritten in the same second, at the same size or another', async () => {
		const folder = await open();
		expectOk(await folder.write('a.txt', null, 'aaaa'));
		expect((await folder.git.commit()).status).toBe('committed');
		expect(expectOk(await folder.git.status()).changes).toEqual([]);
		for (const next of ['bbbb', 'cccccc']) {
			opfs.put(`${ROOT}/a.txt`, encoder.encode(next));
			expect(expectOk(await folder.git.status()).changes).toEqual([
				{ path: 'a.txt', kind: 'modify' },
			]);
		}
		// Looking at status does not rewrite the index.
		const index = opfs.files(ROOT).get('.git/index');
		expectOk(await folder.git.status());
		expect(opfs.files(ROOT).get('.git/index')).toEqual(index!);
	});

	test('the bytes a read returns stay after the path is replaced', async () => {
		const folder = await open();
		expectOk(await folder.write('take.webm', null, allBytes));
		const read = expectOk(await folder.files.read('take.webm'));
		// A raw snapshot of the same file stops reading once it is replaced.
		const root = await opfs.getDirectory();
		const handle = await (await root.getDirectoryHandle('test')).getFileHandle(
			'take.webm',
		);
		const snapshot = await handle.getFile();
		expectOk(await folder.write('take.webm', allBytes, 'replaced'));
		expect(read.bytes).toEqual(allBytes);
		await expect(snapshot.arrayBuffer()).rejects.toMatchObject({
			name: 'NotReadableError',
		});
	});
});

describe('two handles on one directory', () => {
	test('of two creates of one path, exactly one wins', async () => {
		const [left, right] = [await open(), await open()];
		const results = await Promise.all([
			left.write('race.md', null, 'left'),
			right.write('race.md', null, 'right'),
		]);
		const winners = results.filter((result) => result.error === null);
		expect(winners).toHaveLength(1);
		expect(results.find((result) => result.error !== null)?.error?.name).toBe(
			'Occupied',
		);
		const stored = decoder.decode(opfs.files(ROOT).get('race.md'));
		expect(['left', 'right']).toContain(stored);
		expect(winners[0]!.data?.file?.sha256).toBe(
			await hashBytes(encoder.encode(stored)),
		);
	});

	test('two writes from one version both land: the second merges over the first and wins the line both changed', async () => {
		const [left, right] = [await open(), await open()];
		expectOk(await left.write('doc.md', null, 'base'));
		const results = await Promise.all([
			left.write('doc.md', 'base', 'left'),
			right.write('doc.md', 'base', 'right'),
		]);
		const [first, second] = results.map((result) => expectOk(result));
		// The one that landed second read the first one's bytes and overrode them.
		const overrode = [first!, second!].filter(
			(written) => written.overridden.length > 0,
		);
		expect(overrode).toHaveLength(1);
		const stored = decoder.decode(opfs.files(ROOT).get('doc.md'));
		expect(overrode[0]!.file?.sha256).toBe(
			await hashBytes(encoder.encode(stored)),
		);
	});

	test('a move whose source is not removed fails with both paths holding the file, and its landed destination is hinted to the other handle', async () => {
		const writer = await open({ hints: true });
		const reader = await open({ hints: true });
		const heard: string[] = [];
		reader.onFilesChanged((paths) => heard.push(...paths));
		expectOk(await writer.write('from.md', null, 'bytes'));
		opfs.faults.remove = (path) =>
			path.endsWith('/from.md') ? 'fail' : undefined;
		expect(expectErr(await writer.move('from.md', 'to.md'))).toMatchObject({
			name: 'Io',
			path: 'from.md',
		});
		opfs.faults.remove = undefined;
		expect(decoder.decode(opfs.files(ROOT).get('to.md'))).toBe('bytes');
		expect(decoder.decode(opfs.files(ROOT).get('from.md'))).toBe('bytes');
		for (let index = 0; index < 50 && !heard.includes('to.md'); index++)
			await Bun.sleep(5);
		expect(heard).toContain('to.md');
	});
});

/**
 * Hold the next SHA-256 digest of this page until `release`, so a save
 * entered first is still preparing while a save entered after it lands.
 */
function holdNextDigest(skip = 0) {
	const digest = crypto.subtle.digest.bind(crypto.subtle);
	const reached = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	let holding = true;
	const spy = spyOn(crypto.subtle, 'digest').mockImplementation(
		async (algorithm, data) => {
			if (holding && skip-- === 0) {
				holding = false;
				reached.resolve();
				await released.promise;
			}
			return digest(algorithm, data);
		},
	);
	spies.push(() => spy.mockRestore());
	return { reached: reached.promise, release: () => released.resolve() };
}
const spies: (() => void)[] = [];
afterEach(() => {
	for (const restore of spies.splice(0)) restore();
});

describe('a write is not ordered by when it was asked for', () => {
	test('a write entered first reads again and merges over a later write that landed while it prepared', async () => {
		const [left, right] = [await open(), await open()];
		expectOk(await left.write('order.md', null, 'base'));
		const held = holdNextDigest();
		const first = left.write('order.md', 'base', 'from base');
		await held.reached;
		expectOk(await put(right, 'order.md', 'second'));
		held.release();
		// Its put, guarded by what it read, was stale: it read 'second' and
		// won the line both changed.
		expect(expectOk(await first).overridden).toEqual([
			{ kind: 'lines', part: 'text', line: 1, count: 1 },
		]);
		expect(decoder.decode(opfs.files(ROOT).get('order.md'))).toBe('from base');
	});

	test('writes to other paths, and refusals that wrote nothing, do not hold anything back', async () => {
		const [left, right] = [await open(), await open()];
		const held = holdNextDigest();
		const first = left.write('one.md', null, 'one');
		await held.reached;
		expectOk(await right.write('two.md', null, 'two'));
		expect(expectErr(await right.write('two.md', null, 'again')).name).toBe(
			'Occupied',
		);
		held.release();
		expectOk(await first);
		expect(decoder.decode(opfs.files(ROOT).get('one.md'))).toBe('one');
	});
});

describe('outcomes a caller can rely on', () => {
	test('a new file appears whole or not at all: a create cut off anywhere leaves nothing at its path', async () => {
		const scratch = (path: string) => path.includes('/.git/epicenter/scratch/');
		const cuts: [string, () => void][] = [
			[
				'a write',
				() =>
					(opfs.faults.write = (path) => (scratch(path) ? 'fail' : undefined)),
			],
			[
				'a close',
				() =>
					(opfs.faults.close = (path) => (scratch(path) ? 'fail' : undefined)),
			],
			[
				'a lost close reply',
				() =>
					(opfs.faults.close = (path) => (scratch(path) ? 'lost' : undefined)),
			],
			[
				'the move into place',
				() =>
					(opfs.faults.move = (path) =>
						path.endsWith('/a.md') ? 'fail' : undefined),
			],
		];
		for (const [where, cut] of cuts) {
			const folder = await open();
			cut();
			const refused = expectErr(await folder.write('a.md', null, 'x'));
			opfs.faults.write = undefined;
			opfs.faults.close = undefined;
			opfs.faults.move = undefined;
			expect([where, refused.name]).toEqual([where, 'Io']);
			expect(opfs.files(ROOT).has('a.md')).toBe(false);
			// What it staged is gone too.
			expect(
				[...opfs.files(ROOT).keys()].some((path) =>
					path.startsWith('.git/epicenter/scratch/'),
				),
			).toBe(false);
			expectOk(await folder.write('a.md', null, 'x'));
			expect(decoder.decode(opfs.files(ROOT).get('a.md'))).toBe('x');
			for (const each of opened.splice(0)) await each.close();
			fresh();
		}
	});

	test('a replacing close that throws is read back once: unconfirmed unless its bytes landed; told to other pages, and the next commit records what is there', async () => {
		for (const [fault, after, answer] of [
			['fail', encoder.encode('old'), 'Unconfirmed'],
			// The bytes did land; the reply was lost, and reading them back
			// confirms the save.
			['lost', encoder.encode('x'), 'saved'],
		] as const) {
			const folder = await open({ hints: true });
			const other = await open({ hints: true });
			expectOk(await folder.write('a.md', null, 'old'));
			await Bun.sleep(20);
			const heardHere: string[] = [];
			const heardThere: string[] = [];
			folder.onFilesChanged((paths) => heardHere.push(...paths));
			other.onFilesChanged((paths) => heardThere.push(...paths));
			opfs.faults.close = (path) =>
				path.endsWith('/a.md') ? fault : undefined;
			const result = await folder.write('a.md', 'old', 'x');
			opfs.faults.close = undefined;
			// A write reports a lost reply as `Io`, the storage failure its cause.
			const cause =
				result.error?.name === 'Io'
					? (result.error.cause as { name?: string })
					: undefined;
			expect(cause?.name ?? result.error?.name ?? 'saved').toBe(answer);
			expect(opfs.files(ROOT).get('a.md')).toEqual(after);
			// A page's own write is not reported to it; other pages hear it.
			expect(heardHere).toEqual([]);
			for (let index = 0; index < 50 && heardThere.length === 0; index++)
				await Bun.sleep(5);
			expect(heardThere).toContain('a.md');
			// The save made no commit. A commit records whatever the path holds.
			expect((await folder.git.commit()).status).toBe('committed');
			expect(expectOk(await folder.git.status()).changes).toEqual([]);
			for (const each of opened.splice(0)) await each.close();
			fresh();
		}
	});

	test('a close that leaves neither the old nor the new bytes is unconfirmed', async () => {
		const folder = await open();
		expectOk(await folder.write('a.md', null, 'old'));
		opfs.faults.close = (path) =>
			path.endsWith('/a.md') ? { publish: encoder.encode('other') } : undefined;
		expect(expectErr(await folder.write('a.md', 'old', 'new'))).toMatchObject({
			name: 'Io',
			cause: { name: 'Unconfirmed' },
		});
	});

	test('closing refuses new saves; a save already publishing keeps its real outcome', async () => {
		const folder = await open();
		let closing: Promise<void> | undefined;
		// Closing starts while the save's stream is closing.
		opfs.faults.close = (path) => {
			if (path.includes('/.git/epicenter/scratch/')) closing ??= folder.close();
			return undefined;
		};
		expectOk(await folder.write('begun.md', null, 'kept'));
		expect(closing).toBeDefined();
		expect(expectErr(await folder.write('late.md', null, 'x')).name).toBe(
			'Closed',
		);
		await closing;
		expect(opfs.files(ROOT).has('begun.md')).toBe(true);
		expect(opfs.files(ROOT).has('late.md')).toBe(false);
	});
});

describe('address and history', () => {
	test('a folder is the directory its ID names, made by its first write and not by opening', async () => {
		const folder = await open();
		expect(folder.location).toEqual({ kind: 'opfs', directory: 'test' });
		expect(opfs.directories()).toEqual([]);
		expect(expectOk(await folder.files.list())).toEqual({
			files: [],
			directories: [],
		});
		expect(expectOk(await folder.git.status()).changes).toEqual([]);
		expect(expectOk(await folder.git.log(10))).toEqual([]);
		expect(await folder.git.commit()).toMatchObject({ status: 'unchanged' });
		expect(opfs.directories()).toEqual([]);

		expectOk(await folder.write('who.md', null, 'first'));
		expect(decoder.decode(opfs.files('test').get('who.md'))).toBe('first');
		// The first commit creates the repository; reading writes nothing.
		expect(opfs.files('test').has('.git/HEAD')).toBe(false);
		expect((await folder.git.commit()).status).toBe('committed');
		expect(opfs.files('test').has('.git/HEAD')).toBe(true);
		const stored = () =>
			[...opfs.files('test')].map(([path, bytes]) => [path, [...bytes]]);
		const before = stored();
		expectOk(await folder.git.status());
		expectOk(await folder.git.log(10));
		expect(stored()).toEqual(before);
		expect(decoder.decode(opfs.files('test').get('epicenter.json'))).toBe(
			formatDefinition(definition),
		);
		const other = await open({ app: 'other' });
		expectOk(await other.write('who.md', null, 'other'));
		expect(decoder.decode(opfs.files('other').get('who.md'))).toBe('other');
	});

	test('an ID that cannot name one directory is refused, and nothing is opened', async () => {
		for (const id of ['', ' ', '.', '..', 'a/b', 'a\\b', 'a\u0000b'])
			expect(
				expectErr(
					await openFolder({
						app: id,
						definition,
						browser: { author, opfs: opfsEnvironment(opfs) },
					}),
				).name,
			).toBe('InvalidId');
		expect(opfs.directories()).toEqual([]);
	});

	test('commits and status work over the same files', async () => {
		const folder = await open();
		expectOk(
			await folder.tables.notes.create(
				{ fields: { title: 'First' }, body: '' },
				{ stem: 'first' },
			),
		);
		expect(folder.git.snapshot.lastCommit).toBeUndefined();
		expect((await folder.git.commit()).status).toBe('committed');
		expectOk(await folder.write('loose.txt', null, 'x'));
		const status = expectOk(await folder.git.status());
		expect(status.changes.map((change) => change.path)).toEqual(['loose.txt']);
	});
});
