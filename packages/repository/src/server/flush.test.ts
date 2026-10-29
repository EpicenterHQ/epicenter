/**
 * Flush State Machine Tests
 *
 * A flush must survive a crash at every step boundary, a second delivery,
 * a concurrent run, and an outside writer, against real Git (the Bun store),
 * as deployed spike 3 showed against Artifacts. After every case a fresh
 * instance over the same Store and Git reconciles: Git's `main` holds
 * exactly the live text, history is linear with one Git commit per recorded
 * flush and no two consecutive commits with one tree, nothing is applied
 * twice, a delete made during recovery is not undone, no staging ref is
 * left, and `git fsck --strict` is clean.
 *
 * Key behaviors:
 * - a crash after each of the six steps is finished by a fresh instance
 * - a merge that wrote a conflict block is its own Git commit
 * - a second flush at once joins the first; two instances flushing at once make one commit
 * - a `main` moved from outside stops the flush as diverged, its intent kept
 * - a Store with no history starts from Git's `main`, and flushes build on it
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBunGitStore } from '../bun/git.js';
import { openBunSqlite } from '../bun/sqlite.js';
import { commitId, type CommitFile } from '../core/commit.js';
import { ATTRIBUTES } from '../core/door.js';
import type { SqlDriver } from '../sql.js';
import type { FlushStep } from './flush.js';
import { type GitObjects, MAIN } from './git-store.js';
import { createMemoryGitStore } from './memory-git.js';
import { createServer, openServer, type Server, type Session } from './server.js';

const EPOCH = Date.UTC(2026, 9, 28, 12);
const STEPS: FlushStep[] = ['intended', 'staging-pushed', 'staged', 'main-moved', 'completed', 'staging-deleted'];
const alice: Session = { user: 'alice', role: 'writer' };
const bob: Session = { user: 'bob', role: 'writer' };
const note = (body: string) => `---\ntitle: A\n---\n${body}`;
const decoder = new TextDecoder();

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function bunGit() {
	const dir = await mkdtemp(join(tmpdir(), 'epicenter-flush-'));
	dirs.push(dir);
	const path = join(dir, 'repo.git');
	return { git: await openBunGitStore(path), path };
}

/** A live commit by `session` on `parent` (main by default). */
function push(server: Server, session: Session, files: CommitFile[], parent = server.main()) {
	const body = { parent, author: { user: session.user, device: 'laptop' }, time: new Date(EPOCH).toISOString(), files };
	return server.push({ id: commitId(body), ...body }, session);
}

/** Two notes, then a stale edit that merges with a conflict block, then an edit that resolves it. */
function seed(server: Server) {
	expect(push(server, alice, [{ path: 'notes/a.md', text: note('one\n') }, { path: 'notes/b.md', text: note('b\n') }])).toMatchObject({ kind: 'applied' });
	const base = server.main();
	expect(push(server, alice, [{ path: 'notes/a.md', text: note('two\n') }])).toMatchObject({ kind: 'applied' });
	expect(push(server, bob, [{ path: 'notes/a.md', text: note('three\n') }], base)).toMatchObject({ kind: 'merged' });
	expect(push(server, alice, [{ path: 'notes/a.md', text: note('two\nthree\n') }])).toMatchObject({ kind: 'applied' });
}

/** Git's `main` as texts, and its first-parent history. */
async function inGit(git: GitObjects) {
	const head = await git.readRef(MAIN);
	const files = new Map<string, string>();
	const log: { oid: string; tree: string; parents: string[] }[] = [];
	if (head === null) return { head, files, log };
	const commit = await git.readCommit(head);
	for (const [path, entry] of await git.readTree(commit?.tree ?? '')) files.set(path, decoder.decode((await git.readBlob(entry.oid)) ?? new Uint8Array()));
	for (let at: string | undefined = head; at !== undefined; ) {
		const info = await git.readCommit(at);
		if (info === null) break;
		log.unshift({ oid: at, tree: info.tree, parents: info.parents });
		at = info.parents[0];
	}
	return { head, files, log };
}

/** Everything a reconciled repository must hold. */
async function expectReconciled(server: Server, store: SqlDriver, git: GitObjects, path?: string) {
	const { files, log } = await inGit(git);
	expect(files).toEqual(new Map([['.gitattributes', ATTRIBUTES], ...server.snapshot()]));
	expect(log.every((commit, i) => commit.parents.length === (i === 0 ? 0 : 1))).toBe(true);
	for (let i = 1; i < log.length; i++) expect(log[i]?.tree).not.toBe(log[i - 1]?.tree);
	expect(log.map((commit) => commit.oid)).toEqual(store.all<{ oid: string }>('SELECT oid FROM flushes ORDER BY n').map((row) => row.oid));
	expect(store.all('SELECT * FROM journal')).toEqual([]);
	for (let n = 1; n <= log.length + 1; n++) expect(await git.readRef(`refs/heads/epicenter-staging-${n}`)).toBeNull();
	if (path !== undefined) {
		const fsck = Bun.spawnSync(['git', '-C', path, 'fsck', '--strict'], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
		expect(fsck.exitCode).toBe(0);
	}
}

describe('a crash at each step boundary', () => {
	for (const step of STEPS)
		test(`after '${step}', a fresh instance finishes the flush`, async () => {
			const { git, path } = await bunGit();
			const store = openBunSqlite();
			const crashing = createServer({
				store,
				git,
				clock: () => EPOCH,
				faults: (at) => {
					if (at === step) throw new Error(`crash after ${at}`);
				},
			});
			seed(crashing);
			await expect(crashing.flush()).rejects.toThrow(`crash after ${step}`);

			const fresh = createServer({ store, git, clock: () => EPOCH + 1_000 });
			// A live commit during recovery deletes the note the interrupted intent wrote.
			expect(push(fresh, alice, [{ path: 'notes/b.md', text: null }])).toMatchObject({ kind: 'applied' });
			const result = await fresh.flush();
			expect(result.kind).toBe('flushed');
			await expectReconciled(fresh, store, git, path);
			expect(fresh.read('notes/b.md')).toBeNull();
			const messages = (await inGit(git)).log.map((commit) => store.all<{ message: string }>('SELECT message FROM flushes WHERE oid = ?', [commit.oid])[0]?.message.split('\n')[0]);
			// The merge that wrote a block is its own commit; the resolution and the delete follow.
			expect(messages[0]).toBe("Merge bob's change into notes/a.md and 1 others");
			expect(messages.at(-1)).toBe('Edit notes/b.md');
			// Nothing is left to flush, and a second run writes nothing.
			expect(await fresh.flush()).toEqual({ kind: 'nothing' });
		});
});

test('a flush asked for twice at once runs once; two instances flushing at once make one Git commit', async () => {
	const { git, path } = await bunGit();
	const store = openBunSqlite();
	const one = createServer({ store, git, clock: () => EPOCH });
	push(one, alice, [{ path: 'notes/a.md', text: note('one\n') }]);
	const [first, second] = await Promise.all([one.flush(), one.flush()]);
	expect(first.kind).toBe('flushed');
	expect(second).toEqual({ kind: 'nothing' });

	push(one, alice, [{ path: 'notes/a.md', text: note('two\n') }]);
	const other = createServer({ store, git, clock: () => EPOCH });
	await Promise.all([one.flush(), other.flush()]);
	await expectReconciled(one, store, git, path);
	expect((await inGit(git)).log).toHaveLength(2);
});

test('a main moved from outside stops the flush as diverged, its intent kept and nothing overwritten', async () => {
	const git = createMemoryGitStore();
	const store = openBunSqlite();
	let crash = true;
	const server = createServer({
		store,
		git,
		clock: () => EPOCH,
		faults: (at) => {
			if (crash && at === 'staged') throw new Error('crash');
		},
	});
	push(server, alice, [{ path: 'notes/a.md', text: note('one\n') }]);
	await expect(server.flush()).rejects.toThrow('crash');
	crash = false;
	// Someone with a write token pushes straight to Git.
	const outside = await git.writeCommit({ tree: await git.writeTree(new Map()), parents: [], message: 'outside\n', author: { name: 'x', email: 'x@y' }, at: new Date(EPOCH) });
	expect(await git.updateRef(MAIN, outside, null)).toBe(true);
	expect(await server.flush()).toEqual({ kind: 'diverged', main: outside, expected: null });
	expect(await git.readRef(MAIN)).toBe(outside);
	expect(store.all<{ state: string }>('SELECT state FROM journal')).toEqual([{ state: 'diverged' }]);
	expect(await server.flush()).toMatchObject({ kind: 'diverged' });
});

test("a Store with no history starts from Git's main, and its next flush builds on it with .gitattributes", async () => {
	const { git, path } = await bunGit();
	const blob = await git.writeBlob(new TextEncoder().encode(note('from git\n')));
	const tree = await git.writeTree(new Map([['notes/a.md', { mode: '100644', oid: blob }]]));
	const head = await git.writeCommit({ tree, parents: [], message: 'start\n', author: { name: 'a', email: 'a@b' }, at: new Date(EPOCH) });
	await git.updateRef(MAIN, head, null);
	const store = openBunSqlite();
	const server = await openServer({ store, git, clock: () => EPOCH });
	expect(server.snapshot()).toEqual(new Map([['notes/a.md', note('from git\n')]]));
	expect(await server.flush()).toEqual({ kind: 'nothing' });
	push(server, alice, [{ path: 'notes/a.md', text: note('from git\nand live\n') }]);
	expect(await server.flush()).toMatchObject({ kind: 'flushed' });
	const { log, files } = await inGit(git);
	expect(files.get('notes/a.md')).toBe(note('from git\nand live\n'));
	expect(log.map((commit) => commit.parents)).toEqual([[], [head]]);
	expect(files.get('.gitattributes')).toBe(ATTRIBUTES);
	const fsck = Bun.spawnSync(['git', '-C', path, 'fsck', '--strict'], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
	expect(fsck.exitCode).toBe(0);
});

describe('a commit with a message', () => {
	/** A live commit with a message, by `session` from device `device`. */
	function said(server: Server, session: Session, files: CommitFile[], message: string, { parent = server.main(), device = 'claude' }: { parent?: string; device?: string } = {}) {
		const body = { parent, author: { user: session.user, device }, time: new Date(EPOCH).toISOString(), files, message };
		return server.push({ id: commitId(body), ...body }, session);
	}
	async function messages(git: GitObjects, store: SqlDriver) {
		return (await inGit(git)).log.map((commit) => store.all<{ message: string }>('SELECT message FROM flushes WHERE oid = ?', [commit.oid])[0]?.message ?? '');
	}

	test('is its own Git commit, with its message as the subject and its device named; what came before and after are commits of their own', async () => {
		const { git, path } = await bunGit();
		const store = openBunSqlite();
		const server = createServer({ store, git, clock: () => EPOCH });
		expect(push(server, alice, [{ path: 'notes/a.md', text: note('one\n') }])).toMatchObject({ kind: 'applied' });
		expect(said(server, alice, [{ path: 'notes/b.md', text: note('b\n') }, { path: 'notes/c.md', text: note('c\n') }], 'Summarize October\n\nTwo notes.')).toMatchObject({ kind: 'applied' });
		expect(push(server, bob, [{ path: 'notes/a.md', text: note('two\n') }])).toMatchObject({ kind: 'applied' });
		await server.flush();
		await expectReconciled(server, store, git, path);
		const all = await messages(git, store);
		expect(all.map((message) => message.split('\n')[0])).toEqual(['Edit notes/a.md', 'Summarize October', 'Edit notes/a.md']);
		expect(all[1]).toContain('Two notes.\n\nnotes/b.md\nnotes/c.md\n');
		expect(all[1]).toContain('Epicenter-Device: claude');
		expect(all[1]).toContain('Co-authored-by: alice <alice@users.epicenter.invalid>');
		expect(all[1]).not.toContain('bob');
	});

	test('merged over someone else\'s change, the merge that takes it in carries the message', async () => {
		const { git } = await bunGit();
		const store = openBunSqlite();
		const server = createServer({ store, git, clock: () => EPOCH });
		expect(push(server, alice, [{ path: 'notes/a.md', text: note('one\n') }])).toMatchObject({ kind: 'applied' });
		const base = server.main();
		expect(push(server, bob, [{ path: 'notes/a.md', text: note('one\nbob\n') }])).toMatchObject({ kind: 'applied' });
		expect(said(server, alice, [{ path: 'notes/b.md', text: note('b\n') }], 'Add b', { parent: base })).toMatchObject({ kind: 'merged' });
		await server.flush();
		expect((await messages(git, store)).map((message) => message.split('\n')[0])).toEqual(['Edit notes/a.md', 'Add b']);
	});

	test('that changes nothing on main makes no Git commit', async () => {
		const { git } = await bunGit();
		const store = openBunSqlite();
		const server = createServer({ store, git, clock: () => EPOCH });
		expect(push(server, alice, [{ path: 'notes/a.md', text: note('one\n') }])).toMatchObject({ kind: 'applied' });
		expect(said(server, alice, [{ path: 'notes/a.md', text: note('one\n') }], 'Nothing new')).toMatchObject({ kind: 'applied' });
		await server.flush();
		expect((await messages(git, store)).map((message) => message.split('\n')[0])).toEqual(['Edit notes/a.md']);
	});
});
