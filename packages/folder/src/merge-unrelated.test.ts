/**
 * Unrelated Histories and Conflict Versions
 *
 * `mergeIncoming` refuses heads that share no commit unless the caller asks
 * for `allowUnrelatedHistories`; then it merges over an empty base, as
 * `git merge --allow-unrelated-histories` does. `versions` asks a refused
 * conflict to carry each conflicted file's bytes on both sides. These run the
 * real browser backend and isomorphic-git on the in-memory OPFS stand-in.
 *
 * Key behaviors:
 * - By default unrelated heads are `UnsupportedHistory` with `bases: 0`, and
 *   nothing is written
 * - Allowed, disjoint roots merge into one commit whose parents are both
 *   heads, so both roots stay reachable; root `kv.json` merges by key
 * - Allowed, the same path with different bytes is a conflict that writes
 *   nothing, and identical files on both sides are not
 * - `versions` carries both sides' stored bytes, `null` for a missing side
 * - Several merge bases are refused even when unrelated histories are allowed
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as isogit from 'isomorphic-git';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { rawBrowserFolder } from './browser-storage.test-support.js';
import { hashBytes } from './capture.js';
import type { GitBackend } from './git/backend.js';
import { createHistory } from './git/history.js';
import { writeCommitObject, writeFilesTree } from './git/objects.js';

const author = { name: 'Merger', email: 'merger@example.test' };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Tree = Record<string, string>;

async function setup() {
	const raw = await rawBrowserFolder({ id: 'unrelated' });
	const boundary = raw.boundary;
	const backend: GitBackend = await raw.backend({
		remote: { url: 'http://unused.test/remote.git', branch: 'main' },
	});
	const landed: string[] = [];
	const history = createHistory({
		backend,
		boundary,
		author,
		landed: (paths) => landed.push(...paths),
	});
	async function write(path: string, value: string) {
		const bytes = encoder.encode(value);
		expectOk(
			await boundary.apply([
				{ kind: 'overwrite', path, bytes, sha256: await hashBytes(bytes) },
			]),
		);
	}
	async function commit() {
		const outcome = await history.commit();
		if (outcome.status !== 'committed')
			throw new Error(`Expected a commit, got ${outcome.status}`);
		return outcome.oid;
	}
	/** A commit another owner made: exactly `tree`, with these parents. */
	function commitOf(parents: string[], tree: Tree) {
		return backend.withObjects(async (access) =>
			writeCommitObject(access, {
				tree: await writeFilesTree(
					access,
					new Map(
						Object.entries(tree).map(([path, value]) => [
							path,
							encoder.encode(value),
						]),
					),
				),
				parents,
				message: 'Another owner',
				author,
			}),
		);
	}
	function track(oid: string) {
		return backend.withObjects((access) =>
			isogit.writeRef({
				...access,
				ref: 'refs/remotes/origin/main',
				value: oid,
				force: true,
			}),
		);
	}
	async function read(path: string) {
		return decoder.decode(expectOk(await boundary.read(path)).bytes);
	}
	function parents(oid: string) {
		return backend.withObjects(
			async (access) =>
				(await isogit.readCommit({ ...access, oid })).commit.parent,
		);
	}
	async function settledDump() {
		expectOk(await history.paths());
		return raw.dump();
	}
	/** Commit `ours` locally, and record a separate root holding `theirs` as fetched. */
	async function unrelated({ ours, theirs }: { ours: Tree; theirs: Tree }) {
		for (const [path, value] of Object.entries(ours)) await write(path, value);
		const oursOid = await commit();
		const theirsOid = await commitOf([], theirs);
		await track(theirsOid);
		return { ours: oursOid, theirs: theirsOid };
	}
	return {
		raw,
		backend,
		history,
		landed,
		write,
		commit,
		commitOf,
		track,
		read,
		parents,
		settledDump,
		unrelated,
		close: () => history.close(),
	};
}

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
	for (const item of opened.splice(0)) await item.close();
});
async function folder() {
	const made = await setup();
	opened.push(made);
	return made;
}

describe('unrelated histories', () => {
	test('are refused by default with no merge base, and nothing is written', async () => {
		const made = await folder();
		const sides = await made.unrelated({
			ours: { 'local.md': 'local\n' },
			theirs: { 'remote.md': 'remote\n' },
		});
		const before = await made.settledDump();

		const refused = expectErr(await made.history.mergeIncoming());

		expect(refused).toMatchObject({
			name: 'UnsupportedHistory',
			head: sides.ours,
			fetched: sides.theirs,
			bases: 0,
		});
		expect(await made.raw.dump()).toEqual(before);
		expect(await made.backend.readBranch()).toBe(sides.ours);
		expect(made.landed).toEqual([]);
	});

	test('allowed, disjoint roots merge into one commit with both heads as parents', async () => {
		const made = await folder();
		const sides = await made.unrelated({
			ours: { 'local.md': 'local\n', 'kv.json': '{"theme":"dark"}' },
			theirs: { 'remote.md': 'remote\n', 'kv.json': '{"lang":"zh"}' },
		});

		const merged = expectOk(
			await made.history.mergeIncoming({ allowUnrelatedHistories: true }),
		);

		expect(merged).toMatchObject({
			status: 'merged',
			from: sides.ours,
			fetched: sides.theirs,
		});
		if (merged.status !== 'merged') return;
		expect([...merged.changedPaths].sort()).toEqual(['kv.json', 'remote.md']);
		expect(await made.backend.readBranch()).toBe(merged.to);
		expect(await made.parents(merged.to)).toEqual([sides.ours, sides.theirs]);
		// Both roots stay in history.
		expect(await made.parents(sides.ours)).toEqual([]);
		expect(await made.parents(sides.theirs)).toEqual([]);
		expect(await made.read('local.md')).toBe('local\n');
		expect(await made.read('remote.md')).toBe('remote\n');
		expect(await made.read('kv.json')).toBe(
			'{\n  "lang": "zh",\n  "theme": "dark"\n}\n',
		);
		expect(expectOk(await made.history.status()).changes).toEqual([]);
		expect(expectOk(await made.history.paths())).toEqual([]);
	});

	test('allowed, one path with different bytes on each side conflicts and writes nothing', async () => {
		const made = await folder();
		const sides = await made.unrelated({
			ours: { 'same.md': 'shared\n', 'note.md': 'mine\n' },
			theirs: { 'same.md': 'shared\n', 'note.md': 'theirs\n', 'new.md': 'x\n' },
		});
		const before = await made.settledDump();

		const refused = expectErr(
			await made.history.mergeIncoming({
				allowUnrelatedHistories: true,
				versions: true,
			}),
		);

		expect(refused.name).toBe('Conflicted');
		if (refused.name !== 'Conflicted') return;
		expect(refused.conflicts).toEqual([{ reason: 'content', path: 'note.md' }]);
		expect(
			refused.versions?.map((version) => ({
				path: version.path,
				ours: version.ours && decoder.decode(version.ours),
				theirs: version.theirs && decoder.decode(version.theirs),
			})),
		).toEqual([{ path: 'note.md', ours: 'mine\n', theirs: 'theirs\n' }]);
		expect(await made.raw.dump()).toEqual(before);
		expect(await made.backend.readBranch()).toBe(sides.ours);
		expect(made.landed).toEqual([]);
	});

	test('several merge bases are refused even when unrelated histories are allowed', async () => {
		const made = await folder();
		await made.write('a.md', 'x\n');
		const base = await made.commit();
		const left = await made.commitOf([base], { 'a.md': 'x\n', 'b.md': '1\n' });
		const right = await made.commitOf([base], { 'a.md': 'x\n', 'c.md': '1\n' });
		const ours: Tree = {
			'a.md': 'x\n',
			'b.md': '1\n',
			'c.md': '1\n',
			'd.md': 'o\n',
		};
		const oursOid = await made.commitOf([left, right], ours);
		const theirsOid = await made.commitOf([right, left], {
			'a.md': 'x\n',
			'b.md': '1\n',
			'c.md': '1\n',
			'e.md': 't\n',
		});
		for (const [path, value] of Object.entries(ours))
			await made.write(path, value);
		expect((await made.backend.casBranch(base, oursOid)).ok).toBe(true);
		// Resets the index to the moved branch; the files already match it.
		expect((await made.history.commit()).status).toBe('unchanged');
		await made.track(theirsOid);
		const before = await made.settledDump();

		const refused = expectErr(
			await made.history.mergeIncoming({ allowUnrelatedHistories: true }),
		);

		expect(refused).toMatchObject({ name: 'UnsupportedHistory', bases: 2 });
		expect(await made.raw.dump()).toEqual(before);
	});
});

describe('conflict versions', () => {
	test('carry both stored sides, null where one side deleted the file, only when asked', async () => {
		const made = await folder();
		await made.write('kept.md', 'base\n');
		await made.write('gone.md', 'base\n');
		const base = await made.commit();
		const theirs = await made.commitOf([base], {
			'kept.md': 'remote\n',
			'gone.md': 'changed remotely\n',
		});
		await made.write('kept.md', 'local\n');
		expectOk(
			await made.raw.boundary.apply([{ kind: 'remove', path: 'gone.md' }]),
		);
		await made.commit();
		await made.track(theirs);

		const plain = expectErr(await made.history.mergeIncoming());
		expect(plain.name).toBe('Conflicted');
		if (plain.name !== 'Conflicted') return;
		expect(plain.versions).toBeUndefined();

		const described = expectErr(
			await made.history.mergeIncoming({ versions: true }),
		);
		if (described.name !== 'Conflicted') throw new Error(described.name);
		expect(
			described.versions?.map((version) => ({
				path: version.path,
				ours: version.ours && decoder.decode(version.ours),
				theirs: version.theirs && decoder.decode(version.theirs),
			})),
		).toEqual([
			{ path: 'gone.md', ours: null, theirs: 'changed remotely\n' },
			{ path: 'kept.md', ours: 'local\n', theirs: 'remote\n' },
		]);
	});
});
