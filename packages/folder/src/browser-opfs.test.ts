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
 * - `open` returns a Blob that keeps its bytes after the path is replaced
 * - Across handles: exactly one of two creates wins, and of two replacements
 *   from one capture exactly one wins and the other sees the winner's hash
 * - A write that fails before its close is `Io`; a close that throws is
 *   `Unconfirmed` whatever the path holds after, hinted, and committed as is
 * - Saves are not ordered by when they were asked for: a save entered first
 *   that lands after a later one stays, across handles
 * - Closing refuses new work; a save already begun returns its real outcome
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	defineFolder,
	defineTable,
	type Folder,
	field,
	openFolder,
} from './browser.js';
import { hashBytes } from './capture.js';
import {
	type MemoryOpfs,
	memoryOpfs,
	opfsEnvironment,
} from './opfs.test-support.js';
import { useWebLocks } from './web-locks.test-support.js';

useWebLocks();

const definition = defineFolder({
	kv: { theme: field.string() },
	tables: {
		notes: defineTable({ fields: { title: field.string() } }),
	},
});

const author = { name: 'Browser', email: 'browser@example.test' };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ROOT = 'Epicenter/local/test';

let opfs: MemoryOpfs;
const opened: Folder<typeof definition>[] = [];

function fresh() {
	opfs = memoryOpfs();
}
fresh();

async function open(
	options: {
		id?: string;
		hints?: boolean;
		scope?: Parameters<typeof openFolder>[0]['browser'] extends infer B
			? B extends { scope?: infer S }
				? S
				: never
			: never;
	} = {},
) {
	const folder = expectOk(
		await openFolder({
			id: options.id ?? 'test',
			definition,
			browser: {
				author,
				scope: options.scope,
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
		expectOk(await folder.files.create('notes/a.md', '# A\n'));
		expectOk(await folder.files.create('bytes.bin', allBytes));
		expectOk(await folder.files.create('empty.txt', ''));
		expectOk(await folder.files.mkdir('drafts/later'));

		const stored = opfs.files(ROOT);
		expect(decoder.decode(stored.get('notes/a.md'))).toBe('# A\n');
		expect(stored.get('bytes.bin')).toEqual(allBytes);
		expect(stored.get('empty.txt')).toEqual(new Uint8Array());
		expect(stored.has('.git/HEAD')).toBe(true);
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
		expect(expectErr(await folder.files.create('.git/HEAD', 'x')).name).toBe(
			'InvalidPath',
		);
		expect(expectErr(await folder.files.read('drafts')).name).toBe('NotAFile');
		expect(
			expectErr(await folder.files.create('bytes.bin/inner', 'x')).name,
		).toBe('NotADirectory');
		expect(expectErr(await folder.files.create('drafts', 'x')).name).toBe(
			'NotAFile',
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
		expectOk(await first.files.create('bytes.bin', allBytes));
		expectOk(await first.files.create('empty.txt', new Uint8Array()));
		expectOk(await first.files.create('ünïcode/ノート.md', 'text'));
		expectOk(await first.files.mkdir('empty/nested'));
		// Each save asked for a commit; this one answers any still waiting.
		await first.git.commit();
		const committed = expectOk(await first.git.log(5));
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
		expect(expectOk(await again.git.log(5))).toEqual(committed);
		expect(expectOk(await again.git.status()).changes).toEqual([]);
	});

	test('identity is the hash of the bytes read, not size or time', async () => {
		const folder = await open();
		const saved = expectOk(await folder.files.create('a.txt', 'aaaa'));
		await folder.git.commit();
		// Another writer changes the bytes without changing their size.
		opfs.put(`${ROOT}/a.txt`, encoder.encode('bbbb'));
		const read = expectOk(await folder.files.read('a.txt'));
		expect(read.sha256).toBe(await hashBytes(encoder.encode('bbbb')));
		const refused = expectErr(await folder.files.replace(saved, 'cccc'));
		expect(refused).toMatchObject({
			name: 'Conflict',
			actualSha256: read.sha256,
		});
		// Git sees the change too: stat caches are never trusted.
		expect(expectOk(await folder.git.paths())).toEqual([
			{ path: 'a.txt', index: ' ', worktree: 'M' },
		]);
	});

	test('status sees a committed file rewritten in the same second, at the same size or another', async () => {
		const folder = await open();
		expectOk(await folder.files.create('a.txt', 'aaaa'));
		await folder.git.commit();
		expect(expectOk(await folder.git.paths())).toEqual([]);
		for (const next of ['bbbb', 'cccccc']) {
			opfs.put(`${ROOT}/a.txt`, encoder.encode(next));
			expect(expectOk(await folder.git.paths())).toEqual([
				{ path: 'a.txt', index: ' ', worktree: 'M' },
			]);
			expect(expectOk(await folder.git.status()).changes).toEqual([
				{ path: 'a.txt', kind: 'modify' },
			]);
		}
		// Looking at status does not rewrite the index.
		const index = opfs.files(ROOT).get('.git/index');
		expectOk(await folder.git.paths());
		expect(opfs.files(ROOT).get('.git/index')).toEqual(index!);
	});

	test('an opened Blob keeps its bytes after the path is replaced', async () => {
		const folder = await open();
		const saved = expectOk(await folder.files.create('take.webm', allBytes));
		const blob = expectOk(await folder.files.open('take.webm'));
		// A raw snapshot of the same file stops reading once it is replaced.
		const root = await opfs.getDirectory();
		const handle = await (
			await (
				await (
					await root.getDirectoryHandle('Epicenter')
				).getDirectoryHandle('local')
			).getDirectoryHandle('test')
		).getFileHandle('take.webm');
		const snapshot = await handle.getFile();
		expectOk(await folder.files.replace(saved, 'replaced'));
		expect(new Uint8Array(await blob.arrayBuffer())).toEqual(allBytes);
		await expect(snapshot.arrayBuffer()).rejects.toMatchObject({
			name: 'NotReadableError',
		});
	});
});

describe('two handles on one directory', () => {
	test('of two creates of one path, exactly one wins', async () => {
		const [left, right] = [await open(), await open()];
		const results = await Promise.all([
			left.files.create('race.md', 'left'),
			right.files.create('race.md', 'right'),
		]);
		const winners = results.filter((result) => result.error === null);
		expect(winners).toHaveLength(1);
		expect(results.find((result) => result.error !== null)?.error?.name).toBe(
			'Exists',
		);
		const stored = decoder.decode(opfs.files(ROOT).get('race.md'));
		expect(['left', 'right']).toContain(stored);
		expect(winners[0]!.data).toMatchObject({
			sha256: await hashBytes(encoder.encode(stored)),
		});
	});

	test('of two replacements from one capture, exactly one wins and the loser sees its hash', async () => {
		const [left, right] = [await open(), await open()];
		const base = expectOk(await left.files.create('doc.md', 'base'));
		const results = await Promise.all([
			left.files.replace(base, 'left'),
			right.files.replace(base, 'right'),
		]);
		const won = results.find((result) => result.error === null);
		const lost = results.find((result) => result.error !== null);
		expect(won).toBeDefined();
		expect(lost?.error).toMatchObject({
			name: 'Conflict',
			expectedSha256: base.sha256,
			actualSha256: won!.data!.sha256,
		});
	});

	test('overwrite publishes whatever is there', async () => {
		const [left, right] = [await open(), await open()];
		expectOk(await left.files.create('log.txt', 'one'));
		expectOk(await right.files.overwrite('log.txt', 'two'));
		expect(
			decoder.decode(expectOk(await left.files.read('log.txt')).bytes),
		).toBe('two');
	});

	test('a move whose source is not removed reports it, and its landed destination is hinted to the other handle', async () => {
		const writer = await open({ hints: true });
		const reader = await open({ hints: true });
		const heard: string[] = [];
		reader.onFilesChanged((paths) => heard.push(...paths));
		const source = expectOk(await writer.files.create('from.md', 'bytes'));
		opfs.faults.remove = (path) =>
			path.endsWith('/from.md') ? 'fail' : undefined;
		expect(expectErr(await writer.files.move(source, 'to.md'))).toMatchObject({
			name: 'SourceNotRemoved',
			from: 'from.md',
			to: 'to.md',
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

describe('the last save to land on a path stays, whenever it was asked for', () => {
	test('a save entered first that lands after a later one stays', async () => {
		const [left, right] = [await open(), await open()];
		const held = holdNextDigest();
		const first = left.files.overwrite('order.md', 'first');
		await held.reached;
		expectOk(await right.files.overwrite('order.md', 'second'));
		held.release();
		expectOk(await first);
		expect(decoder.decode(opfs.files(ROOT).get('order.md'))).toBe('first');
	});

	test('a handle opened after the save began does not order it', async () => {
		const left = await open();
		const held = holdNextDigest();
		const first = left.files.overwrite('order.md', 'first');
		await held.reached;
		const reopened = await open();
		expectOk(await reopened.files.overwrite('order.md', 'second'));
		held.release();
		expectOk(await first);
		expect(decoder.decode(opfs.files(ROOT).get('order.md'))).toBe('first');
	});

	for (const held of ['source', 'destination'] as const)
		test(`an older overwrite of a later move's ${held} lands after it`, async () => {
			const [left, right] = [await open(), await open()];
			const moved = expectOk(await right.files.create('from.md', 'moved'));
			const digest = holdNextDigest();
			const older = left.files.overwrite(
				held === 'source' ? 'from.md' : 'to.md',
				'older',
			);
			await digest.reached;
			expectOk(await right.files.move(moved, 'to.md'));
			digest.release();
			expectOk(await older);
			const files = opfs.files(ROOT);
			if (held === 'source') {
				expect(decoder.decode(files.get('from.md'))).toBe('older');
				expect(decoder.decode(files.get('to.md'))).toBe('moved');
			} else {
				expect(files.has('from.md')).toBe(false);
				expect(decoder.decode(files.get('to.md'))).toBe('older');
			}
		});

	test('a guarded save entered first is refused once a later save changed the bytes it names', async () => {
		const [left, right] = [await open(), await open()];
		const read = expectOk(await left.files.create('order.md', 'base'));
		const held = holdNextDigest();
		const guarded = left.files.replace(read, 'from base');
		await held.reached;
		expectOk(await right.files.overwrite('order.md', 'second'));
		held.release();
		expect(expectErr(await guarded).name).toBe('Conflict');
		expect(decoder.decode(opfs.files(ROOT).get('order.md'))).toBe('second');
	});

	test('a later save whose outcome is unknown does not keep an older one out', async () => {
		const [left, right] = [await open(), await open()];
		const held = holdNextDigest();
		const first = left.files.overwrite('order.md', 'first');
		await held.reached;
		opfs.faults.close = (path) =>
			path.endsWith('/order.md') ? 'lost' : undefined;
		expect(
			expectErr(await right.files.overwrite('order.md', 'second')).name,
		).toBe('Unconfirmed');
		opfs.faults.close = undefined;
		held.release();
		expectOk(await first);
		expect(decoder.decode(opfs.files(ROOT).get('order.md'))).toBe('first');
	});

	test('saves to other paths, and refusals that wrote nothing, do not hold anything back', async () => {
		const [left, right] = [await open(), await open()];
		const held = holdNextDigest();
		const first = left.files.overwrite('one.md', 'one');
		await held.reached;
		expectOk(await right.files.overwrite('two.md', 'two'));
		expect(expectErr(await right.files.create('two.md', 'again')).name).toBe(
			'Exists',
		);
		held.release();
		expectOk(await first);
		expect(decoder.decode(opfs.files(ROOT).get('one.md'))).toBe('one');
	});
});

describe('outcomes a caller can rely on', () => {
	test('a write that throws before its stream closed is Io, and the new file is taken away again', async () => {
		const folder = await open();
		opfs.faults.write = (path) => (path.endsWith('/a.md') ? 'fail' : undefined);
		expect(expectErr(await folder.files.create('a.md', 'x')).name).toBe('Io');
		expect(opfs.files(ROOT).has('a.md')).toBe(false);
	});

	test('a new file that cannot be taken away again is Unconfirmed', async () => {
		const folder = await open();
		opfs.faults.write = (path) => (path.endsWith('/a.md') ? 'fail' : undefined);
		opfs.faults.remove = (path) =>
			path.endsWith('/a.md') ? 'fail' : undefined;
		expect(expectErr(await folder.files.create('a.md', 'x')).name).toBe(
			'Unconfirmed',
		);
		expect(opfs.files(ROOT).get('a.md')).toEqual(new Uint8Array());
	});

	test('a close that throws is Unconfirmed, whatever the path holds after: hinted, and committed as it is', async () => {
		for (const [fault, after] of [
			['fail', new Uint8Array()],
			// The bytes did land; the reply still says nothing of it.
			['lost', encoder.encode('x')],
		] as const) {
			const folder = await open({ hints: true });
			const other = await open({ hints: true });
			while (folder.git.snapshot.activity.commit.active) await Bun.sleep(5);
			await Bun.sleep(20);
			const previousAttempt = folder.git.snapshot.lastCommit;
			const heardHere: string[] = [];
			const heardThere: string[] = [];
			folder.onFilesChanged((paths) => heardHere.push(...paths));
			other.onFilesChanged((paths) => heardThere.push(...paths));
			opfs.faults.close = (path) =>
				path.endsWith('/a.md') ? fault : undefined;
			const result = await folder.files.create('a.md', 'x');
			opfs.faults.close = undefined;
			expect(expectErr(result).name).toBe('Unconfirmed');
			expect(opfs.files(ROOT).get('a.md')).toEqual(after);
			expect(heardHere).toEqual(['a.md']);
			for (let index = 0; index < 50 && heardThere.length === 0; index++)
				await Bun.sleep(5);
			expect(heardThere).toContain('a.md');
			// A commit records whatever the path holds, so one is asked for even
			// though nobody knows whether the bytes landed.
			for (
				let index = 0;
				index < 100 && folder.git.snapshot.lastCommit === previousAttempt;
				index++
			)
				await Bun.sleep(10);
			expect(folder.git.snapshot.lastCommit).not.toBe(previousAttempt);
			for (const each of opened.splice(0)) await each.close();
			fresh();
		}
	});

	test('a close that leaves neither the old nor the new bytes is Unconfirmed', async () => {
		const folder = await open();
		const base = expectOk(await folder.files.create('a.md', 'old'));
		opfs.faults.close = (path) =>
			path.endsWith('/a.md') ? { publish: encoder.encode('other') } : undefined;
		expect(expectErr(await folder.files.replace(base, 'new')).name).toBe(
			'Unconfirmed',
		);
	});

	test('closing refuses new saves; a save already publishing keeps its real outcome', async () => {
		const folder = await open();
		let closing: Promise<void> | undefined;
		// Closing starts while the save's stream is closing.
		opfs.faults.close = (path) => {
			if (path.endsWith('/begun.md')) closing ??= folder.close();
			return undefined;
		};
		expectOk(await folder.files.create('begun.md', 'kept'));
		expect(closing).toBeDefined();
		expect(expectErr(await folder.files.create('late.md', 'x')).name).toBe(
			'Closed',
		);
		await closing;
		expect(opfs.files(ROOT).has('begun.md')).toBe(true);
		expect(opfs.files(ROOT).has('late.md')).toBe(false);
	});
});

describe('scopes and history', () => {
	test('channels and owners are separate directories', async () => {
		const local = await open();
		const development = await open({ scope: { channel: 'development' } });
		const account = await open({
			scope: {
				channel: 'release',
				account: {
					authorityId: 'https://auth.example',
					principalId: asPrincipalId('p1'),
				},
			},
		});
		expectOk(await local.files.create('who.md', 'local'));
		expectOk(await development.files.create('who.md', 'development'));
		expectOk(await account.files.create('who.md', 'account'));
		expect(development.location).toEqual({
			kind: 'opfs',
			directory: 'Epicenter Dev/local/test',
		});
		expect(account.location.kind).toBe('opfs');
		const accountDirectory =
			account.location.kind === 'opfs' ? account.location.directory : '';
		expect(accountDirectory).toMatch(
			/^Epicenter\/accounts\/[0-9a-f]{64}\/test$/,
		);
		expect(
			decoder.decode(opfs.files('Epicenter Dev/local/test').get('who.md')),
		).toBe('development');
		expect(decoder.decode(opfs.files(accountDirectory).get('who.md'))).toBe(
			'account',
		);
		expect(decoder.decode(opfs.files(ROOT).get('who.md'))).toBe('local');
	});

	test('a folder ID a directory name cannot hold is escaped, not merged', async () => {
		const slashed = await open({ id: 'a/b' });
		const literal = await open({ id: 'a%2Fb' });
		expectOk(await slashed.files.create('x.md', 'slash'));
		expectOk(await literal.files.create('x.md', 'percent'));
		expect(
			decoder.decode(opfs.files('Epicenter/local/a%2Fb').get('x.md')),
		).toBe('slash');
		expect(
			decoder.decode(opfs.files('Epicenter/local/a%252Fb').get('x.md')),
		).toBe('percent');
	});

	test('automatic commits, status, and the shell work over the same files', async () => {
		const folder = await open();
		expectOk(
			await folder.tables.notes.create(
				{ fields: { title: 'First' }, body: '' },
				{ stem: 'first' },
			),
		);
		for (let index = 0; index < 200; index++) {
			if (folder.git.snapshot.lastCommit !== undefined) break;
			await Bun.sleep(5);
		}
		expect(folder.git.snapshot.lastCommit?.status).toBe('committed');
		const shell = folder.terminal();
		const listed = await shell.exec('cat notes/first.md && git status --short');
		expect(listed.stdout).toContain('title: First\n');
		expectOk(await folder.files.create('loose.txt', 'x'));
		const status = expectOk(await folder.git.status());
		expect(status.changes.map((change) => change.path)).toEqual(['loose.txt']);
	});
});
