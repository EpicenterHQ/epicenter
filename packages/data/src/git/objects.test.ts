/**
 * Git Object Codec Tests
 *
 * Checks the inflated-object codec against native Git, which is the oracle:
 * every oid, tree, and commit here must be byte-for-byte what `git` computes
 * or accepts. Each native fixture lives in a fresh scratch repository under
 * the OS temp directory, with global and system config disabled.
 *
 * Key behaviors:
 * - hashObject matches `git hash-object` for blobs, trees, and commits
 * - writeTree matches `git mktree` byte for byte, including raw non-UTF8
 *   names and directory-as-`name/` ordering, and does not mutate its input
 * - native Git lists and fscks a nested tree with regular, executable,
 *   symlink, and gitlink entries; readTree round-trips native trees
 * - readCommit reads tree and every parent while skipping multiline extra
 *   headers and `parent` lines inside the message body
 * - writeCommit output is accepted by `git fsck --strict` with exact
 *   author, timezone, and multiline message
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	hashObject,
	readCommit,
	readTree,
	type TreeEntry,
	writeCommit,
	writeTree,
} from './objects.js';

const scratchDirs: string[] = [];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

afterAll(() => {
	for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** A fresh, isolated repository. Git never sees the user's config or any remote. */
function createRepo() {
	const dir = mkdtempSync(join(tmpdir(), 'epicenter-git-objects-'));
	scratchDirs.push(dir);
	const env = {
		PATH: process.env.PATH ?? '',
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_CONFIG_NOSYSTEM: '1',
	};
	function git(args: string[], stdin?: Uint8Array | string) {
		const result = Bun.spawnSync(['git', ...args], {
			cwd: dir,
			env,
			stdin:
				stdin === undefined
					? undefined
					: typeof stdin === 'string'
						? encoder.encode(stdin)
						: stdin,
		});
		if (result.exitCode !== 0) {
			throw new Error(
				`git ${args.join(' ')} failed: ${decoder.decode(result.stderr)}`,
			);
		}
		return result.stdout as Uint8Array;
	}
	const text = (args: string[], stdin?: Uint8Array | string) =>
		decoder.decode(git(args, stdin)).trimEnd();
	git(['init', '--quiet']);
	return { git, text };
}

function entry(mode: string, name: string | number[], oid: string): TreeEntry {
	return {
		mode,
		name:
			typeof name === 'string' ? encoder.encode(name) : Uint8Array.from(name),
		oid,
	};
}

/** `git mktree -z` input line for an entry: `<mode> <type> <oid>\t<name>\0`. */
function mktreeInput(entries: readonly TreeEntry[]) {
	const typeOf = (mode: string) =>
		mode === '40000' ? 'tree' : mode === '160000' ? 'commit' : 'blob';
	const chunks: number[] = [];
	for (const e of entries) {
		const line = encoder.encode(`${e.mode} ${typeOf(e.mode)} ${e.oid}\t`);
		chunks.push(...line, ...e.name, 0);
	}
	return Uint8Array.from(chunks);
}

describe('hashObject', () => {
	test('matches git hash-object for empty, non-ASCII, and binary blobs', async () => {
		const { text } = createRepo();
		const blobs = [
			new Uint8Array(),
			encoder.encode('café ☕ 日本語\n'),
			Uint8Array.from([0, 255, 10, 0, 128, 13, 10]),
		];
		for (const bytes of blobs) {
			const native = text(['hash-object', '--stdin'], bytes);
			expect(await hashObject({ type: 'blob', bytes })).toBe(native);
		}
	});

	test('matches git hash-object for tree and commit bytes this codec wrote', async () => {
		const { text } = createRepo();
		const blobOid = await hashObject({
			type: 'blob',
			bytes: encoder.encode('x'),
		});
		const tree = writeTree([entry('100644', 'x.txt', blobOid)]);
		const treeOid = await hashObject({ type: 'tree', bytes: tree });
		expect(treeOid).toBe(text(['hash-object', '-t', 'tree', '--stdin'], tree));

		const commit = writeCommit({
			tree: treeOid,
			parents: [],
			author: {
				name: 'Ada',
				email: 'ada@example.com',
				timestamp: 1_700_000_000,
			},
			message: 'first\n',
		});
		const commitOid = await hashObject({ type: 'commit', bytes: commit });
		expect(commitOid).toBe(
			text(['hash-object', '-t', 'commit', '--stdin'], commit),
		);
	});
});

describe('writeTree', () => {
	const blob = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
	const subtree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
	const commit = '1111111111111111111111111111111111111111';

	test('native git lists and fscks a nested tree with regular, executable, symlink, and gitlink entries', async () => {
		const { git, text } = createRepo();
		const file = text(['hash-object', '-w', '--stdin'], 'hello\n');
		const link = text(['hash-object', '-w', '--stdin'], 'docs/readme.md');
		const inner = text(
			['hash-object', '-w', '-t', 'tree', '--stdin'],
			writeTree([
				entry('100644', 'readme.md', file),
				entry('100755', 'run.sh', file),
			]),
		);
		const rootBytes = writeTree([
			entry('100644', 'notes.md', file),
			entry('40000', 'docs', inner),
			entry('120000', 'latest', link),
			entry('160000', 'vendor', commit),
		]);
		const root = text(
			['hash-object', '-w', '-t', 'tree', '--stdin'],
			rootBytes,
		);
		expect(root).toBe(await hashObject({ type: 'tree', bytes: rootBytes }));

		expect(text(['ls-tree', '-r', '-t', root]).split('\n')).toEqual([
			`040000 tree ${inner}\tdocs`,
			`100644 blob ${file}\tdocs/readme.md`,
			`100755 blob ${file}\tdocs/run.sh`,
			`120000 blob ${link}\tlatest`,
			`100644 blob ${file}\tnotes.md`,
			`160000 commit ${commit}\tvendor`,
		]);
		git(['fsck', '--strict', '--no-dangling']);
	});

	test('matches git mktree for raw non-UTF8 names and slash-aware directory order', () => {
		const { git } = createRepo();
		const entries = [
			entry('100644', [0xff, 0xfe, 0x41], blob),
			entry('100644', [0xc3], blob),
			entry('100644', 'é', blob),
			entry('100644', 'a', blob),
			entry('100644', 'a.b', blob),
			entry('100644', 'a-b', blob),
			entry('40000', 'a0', subtree),
			entry('40000', 'a', subtree),
			entry('100755', 'a+b', blob),
			entry('120000', 'a=b', blob),
		];
		// "a" the file and "a" the directory cannot coexist, so keep only the directory.
		const unique = entries.filter(
			(e) => !(e.mode === '100644' && decoder.decode(e.name) === 'a'),
		);
		const native = git(['mktree', '-z', '--missing'], mktreeInput(unique));
		const nativeTree = git(['cat-file', 'tree', decoder.decode(native).trim()]);

		expect(writeTree(unique)).toEqual(nativeTree);
		// Directory `a` compares as `a/` (0x2f): after `a+b`, `a-b`, `a.b`, before `a0` and `a=b`.
		const latin1 = (name: Uint8Array) => String.fromCharCode(...name);
		expect(readTree(writeTree(unique)).map((e) => latin1(e.name))).toEqual([
			'a+b',
			'a-b',
			'a.b',
			'a',
			'a0',
			'a=b',
			'Ã',
			'Ã©',
			'ÿþA',
		]);
	});

	test('does not mutate the caller array or names', () => {
		const entries = [entry('100644', 'b', blob), entry('100644', 'a', blob)];
		const snapshot = entries.map((e) => ({ ...e, name: Array.from(e.name) }));
		writeTree(entries);
		expect(entries.map((e) => ({ ...e, name: Array.from(e.name) }))).toEqual(
			snapshot,
		);
	});

	test('throws for an entry that would corrupt the tree', () => {
		expect(() => writeTree([entry('100644', 'a', 'ABC')])).toThrow(
			'tree entry oid',
		);
		expect(() => writeTree([entry('10x644', 'a', blob)])).toThrow('mode');
		expect(() => writeTree([entry('100644', [0x61, 0, 0x62], blob)])).toThrow(
			'NUL',
		);
		expect(() => writeTree([entry('100644', '', blob)])).toThrow('non-empty');
	});
});

describe('readTree', () => {
	test('round-trips a native tree with non-UTF8 names, preserving modes and oids', () => {
		const { git } = createRepo();
		const blob = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
		const input = [
			entry('100644', [0xff, 0x00 + 0x2e, 0x74], blob),
			entry('100755', 'bin', blob),
			entry('120000', 'link', blob),
			entry('160000', 'sub', '2222222222222222222222222222222222222222'),
			entry('40000', 'dir', '4b825dc642cb6eb9a060e54bf8d69288fbee4904'),
		];
		const nativeOid = decoder
			.decode(git(['mktree', '-z', '--missing'], mktreeInput(input)))
			.trim();
		const nativeBytes = git(['cat-file', 'tree', nativeOid]);

		const parsed = readTree(nativeBytes);
		expect(parsed.map((e) => e.mode).sort()).toEqual([
			'100644',
			'100755',
			'120000',
			'160000',
			'40000',
		]);
		expect(parsed.find((e) => e.name[0] === 0xff)?.name).toEqual(
			Uint8Array.from([0xff, 0x2e, 0x74]),
		);
		expect(writeTree(parsed)).toEqual(nativeBytes);
	});

	test('throws for a tree cut off before its oid', () => {
		const full = writeTree([
			entry('100644', 'a', 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'),
		]);
		expect(() => readTree(full.subarray(0, full.length - 1))).toThrow(
			'cut off',
		);
	});
});

describe('commits', () => {
	const tree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

	test('readCommit returns tree and both parents of a native merge commit', () => {
		const { git, text } = createRepo();
		const env = ['-c', 'user.name=N', '-c', 'user.email=n@example.com'];
		git(['hash-object', '-w', '-t', 'tree', '--stdin'], new Uint8Array());
		const first = text([...env, 'commit-tree', tree, '-m', 'one']);
		const second = text([...env, 'commit-tree', tree, '-m', 'two']);
		const merge = text([
			...env,
			'commit-tree',
			tree,
			'-p',
			first,
			'-p',
			second,
			'-m',
			'merge',
		]);

		expect(readCommit(git(['cat-file', 'commit', merge]))).toEqual({
			tree,
			parents: [first, second],
		});
		expect(readCommit(git(['cat-file', 'commit', first]))).toEqual({
			tree,
			parents: [],
		});
	});

	test('readCommit skips multiline gpgsig and ignores parent lines in the message body', async () => {
		const { text } = createRepo();
		const parent = 'a'.repeat(40);
		const bogus = 'b'.repeat(40);
		const bytes = encoder.encode(
			[
				`tree ${tree}`,
				`parent ${parent}`,
				'author A <a@example.com> 1700000000 +0000',
				'committer A <a@example.com> 1700000000 +0000',
				'gpgsig -----BEGIN PGP SIGNATURE-----',
				' ',
				` tree ${bogus}`,
				` parent ${bogus}`,
				' -----END PGP SIGNATURE-----',
				'',
				`subject\n\nparent ${bogus}\ntree ${bogus}\n`,
			].join('\n'),
		);

		expect(readCommit(bytes)).toEqual({ tree, parents: [parent] });
		// Native Git hashes the same bytes, so this is a commit shape Git itself accepts.
		expect(text(['hash-object', '-t', 'commit', '--stdin'], bytes)).toBe(
			await hashObject({ type: 'commit', bytes }),
		);
	});

	test('readCommit throws when the header has no tree', () => {
		expect(() =>
			readCommit(encoder.encode('author A <a@b> 1 +0000\n\nmsg\n')),
		).toThrow('no tree');
	});

	test('writeCommit is accepted by git fsck --strict and keeps author, timezone, parents, and multiline message', async () => {
		const { git, text } = createRepo();
		git(['hash-object', '-w', '-t', 'tree', '--stdin'], new Uint8Array());
		const parentBytes = writeCommit({
			tree,
			parents: [],
			author: {
				name: 'Ada',
				email: 'ada@example.com',
				timestamp: 1_700_000_000,
			},
			message: 'root\n',
		});
		const parentOid = text(
			['hash-object', '-w', '-t', 'commit', '--stdin'],
			parentBytes,
		);
		const otherOid = text(
			['hash-object', '-w', '-t', 'commit', '--stdin'],
			writeCommit({
				tree,
				parents: [],
				author: {
					name: 'Bo',
					email: 'bo@example.com',
					timestamp: 1_700_000_001,
				},
				message: 'other\n',
			}),
		);

		const message =
			'subject line\n\nbody paragraph\n  indented\n\nTrailer: value\n';
		const bytes = writeCommit({
			tree,
			parents: [parentOid, otherOid],
			author: {
				name: 'Zoë Ünï',
				email: 'z@example.com',
				timestamp: 1_700_000_123,
				timezoneOffset: 330,
			},
			message,
		});
		const oid = text(['hash-object', '-w', '-t', 'commit', '--stdin'], bytes);
		expect(oid).toBe(await hashObject({ type: 'commit', bytes }));
		git(['fsck', '--strict', '--no-dangling']);

		expect(text(['cat-file', 'commit', oid])).toBe(
			[
				`tree ${tree}`,
				`parent ${parentOid}`,
				`parent ${otherOid}`,
				'author Zoë Ünï <z@example.com> 1700000123 +0530',
				'committer Zoë Ünï <z@example.com> 1700000123 +0530',
				'',
				message.trimEnd(),
			].join('\n'),
		);
		expect(text(['log', '-1', '--format=%ai', oid])).toBe(
			'2023-11-15 03:45:23 +0530',
		);
	});

	test('writeCommit formats west-of-UTC and zero offsets as git does', () => {
		const author = { name: 'A', email: 'a@example.com', timestamp: 1 };
		const zoneOf = (timezoneOffset?: number) =>
			decoder
				.decode(
					writeCommit({
						tree,
						parents: [],
						author: { ...author, timezoneOffset },
						message: 'm',
					}),
				)
				.split('\n')[1]!
				.split(' ')
				.at(-1);
		expect(zoneOf(-480)).toBe('-0800');
		expect(zoneOf(0)).toBe('+0000');
		expect(zoneOf(undefined)).toBe('+0000');
		expect(zoneOf(-570)).toBe('-0930');
	});

	test('writeCommit throws for identity fields that would corrupt the header', () => {
		const base = { tree, parents: [], message: 'm' };
		const author = { name: 'A', email: 'a@example.com', timestamp: 1 };
		expect(() =>
			writeCommit({ ...base, author: { ...author, name: 'A\nB' } }),
		).toThrow('newline');
		expect(() =>
			writeCommit({ ...base, author: { ...author, email: 'a>b' } }),
		).toThrow('newline');
		expect(() =>
			writeCommit({ ...base, author: { ...author, timestamp: 1.5 } }),
		).toThrow('timestamp');
		expect(() => writeCommit({ ...base, tree: 'nope', author })).toThrow(
			'commit tree',
		);
	});
});
