/**
 * Browser Merge Tests
 *
 * `mergeIncoming` merges the fetched remote head into a clean browser folder
 * with one two-parent commit, published with its files, index, and branch.
 * These run the real browser backend and isomorphic-git on the in-memory
 * OPFS stand-in; the journey also fetches over real Git smart HTTP and
 * reopens the folder.
 *
 * Key behaviors:
 * - Independent root KV keys merge into sorted `kv.json`; the commit's
 *   parents are exactly the pinned head and the pinned fetched commit
 * - Competing root keys, a deleted versus changed `kv.json`, and a nested
 *   `kv.json` merged by lines return structured conflicts and write nothing
 * - A two-sided change to bytes isomorphic-git would not merge faithfully
 *   (invalid UTF-8, a lone carriage return) is a conflict; one-sided binary
 *   changes keep their exact bytes
 * - A save to an unchanged path, a new file at an incoming path, staging, or
 *   a branch move between planning and publication refuses the whole update
 * - A directory folder refuses the same conflicts with its files, index,
 *   and branch untouched, and merges independent changes in one commit
 * - A merge another Git program began blocks commits, staged commits, and
 *   incoming updates until it is finished with Git
 *
 * See also:
 * - `sync.test.ts` for settling conflicts
 * - `kv-merge.test.ts` for the key-level merge itself
 * - `git/history-ordering.test.ts` for incoming updates that land partly
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as isogit from 'isomorphic-git';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openFolder as openBrowserFolder } from './browser.js';
import {
	browserStorage,
	configureRemote,
	createTestStorage,
	rawBrowserFolder,
	type TestStorage,
} from './browser-storage.test-support.js';
import { hashBytes } from './capture.js';
import { defineFolder, type Folder, field } from './contract.js';
import { openNativeFolder } from './directory.test-support.js';
import type { GitBackend } from './git/backend.js';
import { GITDIR, WORKDIR } from './git/browser-backend.js';
import { createHistory } from './git/history.js';
import { writeCommitObject, writeFilesTree } from './git/objects.js';
import {
	createBareRemote,
	GIT_ENV,
	git,
	gitHttpFetch,
	initWithOrigin,
	scratch,
} from './git-http.test-support.js';

const author = { name: 'Merger', email: 'merger@example.test' };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytesOf = (value: string | Uint8Array) =>
	typeof value === 'string' ? encoder.encode(value) : value;

type Tree = Record<string, string | Uint8Array>;

/** A browser folder whose fetched head is whatever commit a test names. */
async function setup(
	overrides: (real: GitBackend) => Partial<GitBackend> = () => ({}),
) {
	const raw = await rawBrowserFolder({ id: 'merge' });
	const boundary = raw.boundary;
	const real = await raw.backend({
		remote: { url: 'http://unused.test/remote.git', branch: 'main' },
	});
	const backend: GitBackend = { ...real, ...overrides(real) };
	const landed: string[] = [];
	const history = createHistory({
		backend,
		boundary,
		author,
		landed: (paths) => landed.push(...paths),
	});

	async function write(path: string, value: string | Uint8Array) {
		const bytes = bytesOf(value);
		expectOk(
			await boundary.apply([
				{ kind: 'overwrite', path, bytes, sha256: await hashBytes(bytes) },
			]),
		);
	}
	async function remove(path: string) {
		expectOk(await boundary.apply([{ kind: 'remove', path }]));
	}
	/** Commit the folder as it is, through the ordinary whole-folder commit. */
	async function commit() {
		const outcome = await history.commit();
		if (outcome.status !== 'committed')
			throw new Error(`Expected a commit, got ${outcome.status}`);
		return outcome.oid;
	}
	/** A commit another owner made: exactly `tree` on top of `parent`. */
	function commitOf(parent: string, tree: Tree) {
		return real.withObjects(async (access) =>
			writeCommitObject(access, {
				tree: await writeFilesTree(
					access,
					new Map(
						Object.entries(tree).map(([path, value]) => [path, bytesOf(value)]),
					),
				),
				parents: [parent],
				message: 'Another owner',
				author,
			}),
		);
	}
	/** Record `oid` as the fetched remote head, as a fetch would. */
	function track(oid: string) {
		return real.withObjects((access) =>
			isogit.writeRef({
				...access,
				ref: 'refs/remotes/origin/main',
				value: oid,
				force: true,
			}),
		);
	}
	async function read(path: string) {
		return expectOk(await boundary.read(path)).bytes;
	}
	function parents(oid: string) {
		return real.withObjects(
			async (access) =>
				(await isogit.readCommit({ ...access, oid })).commit.parent,
		);
	}
	/**
	 * Every live file and directory of the folder, hashed. Objects are left out:
	 * a refused merge may leave unreachable ones, which change nothing a
	 * person or Git reads.
	 */
	const dump = () => raw.dump();
	/** The live state, after one status look has refreshed the index's stat cache. */
	async function settledDump() {
		expectOk(await history.paths());
		return dump();
	}

	/**
	 * Commit `base`, then `theirs` on it as the fetched head, then `ours` as
	 * the local head. Each side names every file it has.
	 */
	async function diverge({
		base,
		ours,
		theirs,
	}: {
		base: Tree;
		ours: Tree;
		theirs: Tree;
	}) {
		for (const [path, value] of Object.entries(base)) await write(path, value);
		const baseOid = await commit();
		const theirsOid = await commitOf(baseOid, theirs);
		for (const path of Object.keys(base))
			if (!(path in ours)) await remove(path);
		for (const [path, value] of Object.entries(ours)) await write(path, value);
		const oursOid = await commit();
		await track(theirsOid);
		return { base: baseOid, ours: oursOid, theirs: theirsOid };
	}

	return {
		raw,
		real,
		history,
		landed,
		write,
		remove,
		read,
		parents,
		dump,
		settledDump,
		diverge,
		close: () => history.close(),
	};
}

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
	for (const item of opened.splice(0)) await item.close();
});

async function folder(overrides?: (real: GitBackend) => Partial<GitBackend>) {
	const made = await setup(overrides);
	opened.push(made);
	return made;
}

/** Expect a merge refused with `name`, and nothing live changed by it. */
async function refusedUntouched(
	made: Awaited<ReturnType<typeof setup>>,
	head: string,
) {
	const before = await made.settledDump();
	const refused = expectErr(await made.history.mergeIncoming());
	expect(await made.dump()).toEqual(before);
	expect(await made.real.readBranch()).toBe(head);
	expect(made.landed).toEqual([]);
	return refused;
}

describe('root kv.json', () => {
	test('independent keys merge into sorted kv.json under a commit with both original parents', async () => {
		const made = await folder();
		const sides = await made.diverge({
			base: {
				'kv.json': '{"theme":"light","lang":"en"}\n',
				'notes.md': 'notes\n',
			},
			ours: {
				'kv.json': '{"theme":"dark","lang":"en"}\n',
				'notes.md': 'notes\n',
			},
			theirs: {
				'kv.json': '{ "lang": "zh", "theme": "light" }',
				'notes.md': 'notes\n',
			},
		});

		const merged = expectOk(await made.history.mergeIncoming());

		expect(merged).toMatchObject({
			status: 'merged',
			from: sides.ours,
			fetched: sides.theirs,
			changedPaths: ['kv.json'],
		});
		if (merged.status !== 'merged') return;
		expect(await made.real.readBranch()).toBe(merged.to);
		expect(await made.parents(merged.to)).toEqual([sides.ours, sides.theirs]);
		expect(decoder.decode(await made.read('kv.json'))).toBe(
			'{\n  "lang": "zh",\n  "theme": "dark"\n}\n',
		);
		expect(decoder.decode(await made.read('notes.md'))).toBe('notes\n');
		expect(expectOk(await made.history.paths())).toEqual([]);
		expect(expectOk(await made.history.status()).changes).toEqual([]);
		expect(made.landed).toEqual(['kv.json']);
		expect(made.history.snapshot.lastMerge?.result).toEqual({
			data: merged,
			error: null,
		});
	});

	test('competing values for one key are a structured conflict that writes nothing', async () => {
		const made = await folder();
		const sides = await made.diverge({
			base: { 'kv.json': '{"theme":"light","lang":"en"}' },
			ours: { 'kv.json': '{"theme":"dark","lang":"en"}' },
			theirs: { 'kv.json': '{"theme":"blue","lang":"zh"}' },
		});

		const refused = await refusedUntouched(made, sides.ours);

		expect(refused.name).toBe('Conflicted');
		if (refused.name !== 'Conflicted') return;
		expect(refused.conflicts).toEqual([
			{
				reason: 'kvKey',
				path: 'kv.json',
				key: 'theme',
				base: '"light"',
				ours: '"dark"',
				theirs: '"blue"',
			},
		]);
		expect(made.history.snapshot.lastMerge?.result.error?.name).toBe(
			'Conflicted',
		);
	});

	test('both sides adding kv.json merge by key', async () => {
		const made = await folder();
		const sides = await made.diverge({
			base: { 'notes.md': 'notes\n' },
			ours: { 'notes.md': 'notes\n', 'kv.json': '{"theme":"dark"}' },
			theirs: { 'notes.md': 'notes\n', 'kv.json': '{"lang":"zh"}' },
		});

		const merged = expectOk(await made.history.mergeIncoming());

		expect(merged.status).toBe('merged');
		expect(await made.parents((await made.real.readBranch()) ?? '')).toEqual([
			sides.ours,
			sides.theirs,
		]);
		expect(decoder.decode(await made.read('kv.json'))).toBe(
			'{\n  "lang": "zh",\n  "theme": "dark"\n}\n',
		);
	});

	test('a deletion merges against an unchanged kv.json and conflicts with changed values', async () => {
		const deleted = await folder();
		await deleted.diverge({
			base: { 'kv.json': '{"theme":"light"}', 'a.md': 'a\n' },
			ours: { 'a.md': 'a\n' },
			theirs: { 'kv.json': '{"theme":"light"}', 'a.md': 'a\n', 'b.md': 'b\n' },
		});
		expect(expectOk(await deleted.history.mergeIncoming())).toMatchObject({
			status: 'merged',
			changedPaths: ['b.md'],
		});
		expect((await deleted.history.paths()).data).toEqual([]);
		expect(expectOk(await deleted.history.status()).changes).toEqual([]);
		expect(decoder.decode(await deleted.read('b.md'))).toBe('b\n');
		expect(Object.keys(await deleted.dump())).not.toContain('contents:kv.json');

		const competing = await folder();
		const sides = await competing.diverge({
			base: { 'kv.json': '{"theme":"light"}' },
			ours: {},
			theirs: { 'kv.json': '{"theme":"dark"}' },
		});
		const refused = await refusedUntouched(competing, sides.ours);
		expect(refused).toMatchObject({
			name: 'Conflicted',
			conflicts: [{ reason: 'kvFile', path: 'kv.json' }],
		});
	});

	test('a nested kv.json merges by lines, so separate keys on one line conflict', async () => {
		const made = await folder();
		const sides = await made.diverge({
			base: {
				'kv.json': '{"a":1,"b":1}',
				'archive/kv.json': '{"a":1,"b":1}\n',
			},
			ours: {
				'kv.json': '{"a":2,"b":1}',
				'archive/kv.json': '{"a":2,"b":1}\n',
			},
			theirs: {
				'kv.json': '{"a":1,"b":2}',
				'archive/kv.json': '{"a":1,"b":2}\n',
			},
		});

		const refused = await refusedUntouched(made, sides.ours);

		// The root file alone would have merged; only the nested one conflicts.
		expect(refused).toMatchObject({
			name: 'Conflicted',
			conflicts: [{ reason: 'content', path: 'archive/kv.json' }],
		});
	});
});

describe('ordinary files', () => {
	test('independent line edits merge, and a one-sided binary change keeps its exact bytes', async () => {
		const made = await folder();
		const audio = Uint8Array.from([0xff, 0x00, 0xfe, 0x0d, 0x80, 0x00, 0x0a]);
		const changedAudio = Uint8Array.from([0xff, 0x00, 0x01, 0x0d, 0x0d, 0xc3]);
		const sides = await made.diverge({
			base: { 'notes.md': 'one\ntwo\nthree\nfour\nfive\n', 'take.bin': audio },
			ours: { 'notes.md': 'ONE\ntwo\nthree\nfour\nfive\n', 'take.bin': audio },
			theirs: {
				'notes.md': 'one\ntwo\nthree\nfour\nFIVE\n',
				'take.bin': changedAudio,
			},
		});

		const merged = expectOk(await made.history.mergeIncoming());

		expect(merged).toMatchObject({
			status: 'merged',
			from: sides.ours,
			fetched: sides.theirs,
			changedPaths: ['notes.md', 'take.bin'],
		});
		expect(decoder.decode(await made.read('notes.md'))).toBe(
			'ONE\ntwo\nthree\nfour\nFIVE\n',
		);
		expect(await made.read('take.bin')).toEqual(changedAudio);
		expect(expectOk(await made.history.paths())).toEqual([]);
	});

	test('two-sided edits to bytes that are not UTF-8 are refused before isomorphic-git decodes them', async () => {
		// isomorphic-git 1.38.5 merges these cleanly into EF BF BD where the FF
		// was; Git keeps the FF.
		const made = await folder();
		const file = (left: string, right: string) =>
			Uint8Array.from([
				0xff,
				...encoder.encode(`\n${left}\nkeep1\nkeep2\nkeep3\n${right}\n`),
			]);
		const sides = await made.diverge({
			base: {
				'raw.txt': file('left0', 'right0'),
				'cr.txt': 'a\rb\nkeep\nkeep\nkeep\nz\n',
			},
			ours: {
				'raw.txt': file('left1', 'right0'),
				'cr.txt': 'A\rb\nkeep\nkeep\nkeep\nz\n',
			},
			theirs: {
				'raw.txt': file('left0', 'right1'),
				'cr.txt': 'a\rb\nkeep\nkeep\nkeep\nZ\n',
			},
		});

		const refused = await refusedUntouched(made, sides.ours);

		// A lone carriage return is a line break isomorphic-git's split drops.
		expect(refused).toMatchObject({
			name: 'Conflicted',
			conflicts: [
				{ reason: 'binary', path: 'cr.txt' },
				{ reason: 'binary', path: 'raw.txt' },
			],
		});
		expect(await made.read('raw.txt')).toEqual(file('left1', 'right0'));
	});

	test('a deletion against a change, and competing lines, are reported together', async () => {
		const made = await folder();
		const sides = await made.diverge({
			base: { 'gone.md': 'kept\n', 'both.md': 'base\n' },
			ours: { 'both.md': 'ours\n' },
			theirs: { 'gone.md': 'changed\n', 'both.md': 'theirs\n' },
		});

		const refused = await refusedUntouched(made, sides.ours);

		expect(refused).toMatchObject({
			name: 'Conflicted',
			conflicts: [
				{ reason: 'content', path: 'both.md' },
				{ reason: 'deleted', path: 'gone.md', deletedBy: 'ours' },
			],
		});
	});

	test('a merge attribute that changes how a path merges is refused', async () => {
		const made = await folder();
		const sides = await made.diverge({
			base: {
				'.gitattributes': '*.md merge=union\n',
				'a.md': '1\n2\n3\n4\n5\n',
			},
			ours: {
				'.gitattributes': '*.md merge=union\n',
				'a.md': 'x\n2\n3\n4\n5\n',
			},
			theirs: {
				'.gitattributes': '*.md merge=union\n',
				'a.md': '1\n2\n3\n4\ny\n',
			},
		});

		const refused = await refusedUntouched(made, sides.ours);

		expect(refused).toMatchObject({
			name: 'Unmergeable',
			paths: ['a.md'],
		});
	});

	test('a fast-forward is still a fast-forward', async () => {
		const made = await folder();
		await made.write('a.md', 'a\n');
		const base = await (async () => {
			const outcome = await made.history.commit();
			return outcome.status === 'committed' ? outcome.oid : '';
		})();
		const next = await made.real.withObjects(async (access) =>
			writeCommitObject(access, {
				tree: await writeFilesTree(
					access,
					new Map([['a.md', encoder.encode('b\n')]]),
				),
				parents: [base],
				message: 'Next',
				author,
			}),
		);
		await made.real.withObjects((access) =>
			isogit.writeRef({
				...access,
				ref: 'refs/remotes/origin/main',
				value: next,
				force: true,
			}),
		);
		expect(expectOk(await made.history.mergeIncoming())).toEqual({
			status: 'fastForwarded',
			from: base,
			to: next,
			changedPaths: ['a.md'],
		});
	});
});

describe('publication baseline', () => {
	const SIDES = {
		base: { 'kv.json': '{"theme":"light","lang":"en"}', 'quiet.md': 'quiet\n' },
		ours: { 'kv.json': '{"theme":"dark","lang":"en"}', 'quiet.md': 'quiet\n' },
		theirs: {
			'kv.json': '{"theme":"light","lang":"zh"}',
			'quiet.md': 'quiet\n',
			'incoming.md': 'incoming\n',
		},
	};

	/**
	 * Merge with `meanwhile` run after planning and before publication, and
	 * expect the whole update refused with the live state exactly as
	 * `meanwhile` left it.
	 */
	async function interrupted(
		meanwhile: (made: Awaited<ReturnType<typeof setup>>) => Promise<void>,
	) {
		let made!: Awaited<ReturnType<typeof setup>>;
		let before: Record<string, string> | undefined;
		made = await folder((real) => ({
			async publishIncoming(plan) {
				await meanwhile(made);
				before = await made.dump();
				return real.publishIncoming(plan);
			},
		}));
		const sides = await made.diverge(SIDES);
		expectOk(await made.history.paths());
		const refused = expectErr(await made.history.mergeIncoming());
		expect(before).toBeDefined();
		expect(await made.dump()).toEqual(before!);
		expect(made.landed).toEqual([]);
		return { made, sides, refused };
	}

	test('a save to a path the merge does not change refuses it', async () => {
		const { made, sides, refused } = await interrupted((made) =>
			made.write('quiet.md', 'saved meanwhile\n'),
		);
		expect(refused).toMatchObject({
			name: 'Refused',
			error: { name: 'Conflict', path: 'quiet.md' },
		});
		expect(await made.real.readBranch()).toBe(sides.ours);
		expect(decoder.decode(await made.read('quiet.md'))).toBe(
			'saved meanwhile\n',
		);
	});

	test('a new file at a path the merge adds refuses it', async () => {
		const { made, sides, refused } = await interrupted((made) =>
			made.write('incoming.md', 'mine\n'),
		);
		expect(refused).toMatchObject({
			name: 'Refused',
			error: { name: 'Exists', path: 'incoming.md' },
		});
		expect(await made.real.readBranch()).toBe(sides.ours);
		expect(decoder.decode(await made.read('incoming.md'))).toBe('mine\n');
	});

	test('staging between the clean check and the index capture refuses it', async () => {
		let armed = false;
		let afterStage: Record<string, string> | undefined;
		let made!: Awaited<ReturnType<typeof setup>>;
		made = await folder((real) => ({
			async indexMatchesHead(captured) {
				const clean = await real.indexMatchesHead(captured);
				if (armed) {
					armed = false;
					await made.write('kv.json', '{"theme":"staged","lang":"en"}');
					await real.stage(['kv.json']);
					await made.write('kv.json', SIDES.ours['kv.json']);
					afterStage = await made.dump();
				}
				return clean;
			},
		}));
		const sides = await made.diverge(SIDES);
		armed = true;
		const refused = expectErr(await made.history.mergeIncoming());
		expect(refused.name).toBe('StagedChanges');
		expect(await made.real.readBranch()).toBe(sides.ours);
		expect(await made.dump()).toEqual(afterStage!);
	});

	test('staging after the clean check refuses it', async () => {
		const { made, sides, refused } = await interrupted((made) =>
			made.real.withObjects((access) =>
				isogit.remove({ ...access, dir: WORKDIR, filepath: 'quiet.md' }),
			),
		);
		expect(refused.name).toBe('StagedChanges');
		expect(await made.real.readBranch()).toBe(sides.ours);
	});

	test('a branch move after planning refuses it', async () => {
		let moved: string | undefined;
		const { made, refused } = await interrupted(async (made) => {
			moved = (await made.real.readRemoteTracking())!;
			const head = await made.real.readBranch();
			expect((await made.real.casBranch(head, moved)).ok).toBe(true);
		});
		expect(refused).toMatchObject({
			name: 'BranchMoved',
			actual: moved,
			filesApplied: false,
		});
		expect(decoder.decode(await made.read('kv.json'))).toBe(
			SIDES.ours['kv.json'],
		);
	});
});

describe('the browser journey', () => {
	const definition = defineFolder({
		kv: { theme: field.string(), lang: field.string() },
		tables: {},
	});
	type Opened = Folder<typeof definition>;
	const originalFetch = globalThis.fetch;
	const originalEnv = { ...process.env };
	beforeAll(() => {
		Object.assign(process.env, {
			GIT_CONFIG_GLOBAL: GIT_ENV.GIT_CONFIG_GLOBAL,
			GIT_CONFIG_NOSYSTEM: '1',
		});
	});
	afterAll(() => {
		globalThis.fetch = originalFetch;
		for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'])
			if (originalEnv[key] === undefined) delete process.env[key];
			else process.env[key] = originalEnv[key];
	});

	async function open(environment: TestStorage): Promise<Opened> {
		await configureRemote(
			environment,
			'so.epicenter.mergetest',
			'http://git.test/remote.git',
		);
		const opened = expectOk(
			await openBrowserFolder({
				id: 'so.epicenter.mergetest',
				definition,
				browser: {
					author,
					...browserStorage(environment),
				},
			}),
		);
		return opened;
	}

	test('fetched light/zh and local dark/en merge to dark/zh, and stay merged after reopening', async () => {
		const root = await scratch('merge-journey-');
		const bare = await createBareRemote(root);
		globalThis.fetch = await gitHttpFetch(root);
		const environment = createTestStorage();
		let folder = await open(environment);
		try {
			expectOk(await folder.kv.set('theme', 'light'));
			expectOk(await folder.kv.set('lang', 'en'));
			expect((await folder.git.commitAndPush()).push.status).toBe('pushed');

			// Another program changes the language and pushes.
			const upstream = join(root, 'upstream');
			await git(root, 'clone', '--quiet', bare, upstream);
			await writeFile(
				join(upstream, 'kv.json'),
				'{\n\t"theme": "light",\n\t"lang": "zh"\n}\n',
			);
			await git(upstream, 'commit', '--quiet', '-am', 'Chinese');
			await git(upstream, 'push', '--quiet', 'origin', 'main');
			const remoteHead = await git(bare, 'rev-parse', 'main');

			// This folder changes the theme and commits without pushing.
			expectOk(await folder.kv.set('theme', 'dark'));
			const local = await folder.git.commit();
			if (local.status !== 'committed') throw new Error(local.status);
			const fetched = expectOk(await folder.git.fetch()).oid;
			expect(fetched).toBe(remoteHead);
			expect(expectErr(await folder.git.pullFastForward()).name).toBe(
				'Diverged',
			);

			const merged = expectOk(await folder.git.mergeIncoming());
			expect(merged).toMatchObject({
				status: 'merged',
				from: local.oid,
				fetched: remoteHead,
				changedPaths: ['kv.json'],
			});
			const [head] = expectOk(await folder.git.log(1));
			expect(head?.parents).toEqual([local.oid, remoteHead]);
			expect(
				decoder.decode(expectOk(await folder.files.read('kv.json')).bytes),
			).toBe('{\n  "lang": "zh",\n  "theme": "dark"\n}\n');
			expect(expectOk(await folder.git.paths())).toEqual([]);
			expect(expectOk(await folder.git.status()).changes).toEqual([]);
			// Nothing was pushed.
			expect(await git(bare, 'rev-parse', 'main')).toBe(remoteHead);

			await folder.close();
			folder = await open(environment);
			expect(expectOk(await folder.kv.get())?.values).toEqual({
				theme: 'dark',
				lang: 'zh',
			});
			expect(expectOk(await folder.git.log(1))[0]?.oid).toBe(head?.oid);
			expect(expectOk(await folder.git.status()).changes).toEqual([]);
			expect(expectOk(await folder.git.paths())).toEqual([]);
		} finally {
			await folder.close();
		}
	});
});

test('a directory folder refuses a conflict by default and changes nothing', async () => {
	const root = await scratch('merge-directory-');
	const bare = await createBareRemote(root);
	const local = join(root, 'local');
	await mkdir(local);
	await initWithOrigin(local, bare);
	const definition = defineFolder({
		kv: {},
		tables: {},
	});
	const directory = await openNativeFolder({
		root: local,
		definition,
		git: { author },
	});
	try {
		expectOk(await directory.files.create('a.md', 'base\n'));
		expect((await directory.git.commitAndPush()).push.status).toBe('pushed');
		const upstream = join(root, 'upstream');
		await git(root, 'clone', '--quiet', bare, upstream);
		await writeFile(join(upstream, 'a.md'), 'theirs\n');
		await git(upstream, 'commit', '--quiet', '-am', 'Theirs');
		await git(upstream, 'push', '--quiet', 'origin', 'main');
		expectOk(await directory.files.overwrite('a.md', 'ours\n'));
		const ours = await directory.git.commit();
		if (ours.status !== 'committed') throw new Error(ours.status);
		expectOk(await directory.git.fetch());
		const index = await readFile(join(local, '.git/index'));

		expect(expectErr(await directory.git.mergeIncoming())).toMatchObject({
			name: 'Conflicted',
			conflicts: [{ reason: 'content', path: 'a.md' }],
		});
		expect(await git(local, 'rev-parse', 'main')).toBe(ours.oid);
		expect(await readFile(join(local, 'a.md'), 'utf8')).toBe('ours\n');
		expect(await readFile(join(local, '.git/index'))).toEqual(index);
		expect(await git(local, 'status', '--porcelain')).toBe('');
	} finally {
		await directory.close();
	}
});

/** A directory folder over a fresh remote, and a clone that pushes to it. */
async function directoryWithUpstream() {
	const root = await scratch('merge-directory-');
	const bare = await createBareRemote(root);
	const local = join(root, 'local');
	await mkdir(local);
	await initWithOrigin(local, bare);
	const directory = await openNativeFolder({
		root: local,
		definition: defineFolder({ kv: {}, tables: {} }),
		git: { author },
	});
	opened.push(directory);
	expectOk(await directory.files.create('a.md', 'one\ntwo\nthree\n'));
	expect((await directory.git.commitAndPush()).push.status).toBe('pushed');
	const upstream = join(root, 'upstream');
	await git(root, 'clone', '--quiet', bare, upstream);
	return {
		directory,
		local,
		async push(path: string, text: string) {
			await writeFile(join(upstream, path), text);
			await git(upstream, 'commit', '--quiet', '-am', 'Upstream');
			await git(upstream, 'push', '--quiet', 'origin', 'main');
		},
	};
}

test('a directory folder merges independent changes in one commit with both parents', async () => {
	const { directory, local, push } = await directoryWithUpstream();
	await push('a.md', 'one\ntwo\nTHREE\n');
	expectOk(await directory.files.overwrite('a.md', 'ONE\ntwo\nthree\n'));
	const ours = await directory.git.commit();
	if (ours.status !== 'committed') throw new Error(ours.status);
	expectOk(await directory.git.fetch());

	const merged = expectOk(await directory.git.mergeIncoming());
	if (merged.status !== 'merged') throw new Error(merged.status);
	expect(await readFile(join(local, 'a.md'), 'utf8')).toBe('ONE\ntwo\nTHREE\n');
	expect(
		(await git(local, 'rev-list', '--parents', '-n', '1', 'main')).split(' '),
	).toEqual([merged.to, ours.oid, merged.fetched]);
	expect(await git(local, 'status', '--porcelain')).toBe('');
});

test('a merge another Git program began blocks commits and updates until Git finishes it', async () => {
	const { directory, local, push } = await directoryWithUpstream();
	await push('a.md', 'one\ntwo\nTHREE\n');
	expectOk(await directory.git.fetch());
	const head = await git(local, 'rev-parse', 'main');
	await writeFile(join(local, '.git/MERGE_HEAD'), `${head}\n`);
	expectOk(await directory.files.overwrite('a.md', 'ONE\ntwo\nthree\n'));

	const commit = await directory.git.commit();
	expect(commit).toMatchObject({ status: 'blocked' });
	if (commit.status === 'blocked')
		expect(commit.reason).toContain(
			'a Git operation is in progress (MERGE_HEAD)',
		);
	expect(expectErr(await directory.git.mergeIncoming()).name).toBe('Blocked');
	expectOk(await directory.git.stage(['a.md']));
	expect(expectErr(await directory.git.commitStaged('Mine')).message).toContain(
		'MERGE_HEAD',
	);
	expect(await git(local, 'rev-parse', 'main')).toBe(head);
});

test('a browser folder with a merge left by an earlier version is blocked, not finished', async () => {
	const made = await folder();
	await made.write('a.md', 'base\n');
	const head = await (async () => {
		const outcome = await made.history.commit();
		if (outcome.status !== 'committed') throw new Error(outcome.status);
		return outcome.oid;
	})();
	await made.real.withObjects(({ fs }) =>
		fs.promises.writeFile(`${GITDIR}/MERGE_HEAD`, `${head}\n`),
	);
	await made.write('a.md', 'changed\n');
	const outcome = await made.history.commit();
	expect(outcome.status).toBe('blocked');
	if (outcome.status === 'blocked')
		expect(outcome.reason).toContain('a Git merge is in progress');
	expect(await made.real.readBranch()).toBe(head);
});
