/**
 * Push-as-merge Tests
 *
 * A `git push` whose old value is Git's `main` is taken while live history
 * runs ahead of Git: its change merges into live `main` like any batch (all
 * text merges, a blob by compare-and-swap), Git's `main` moves to exactly
 * the pushed commit, and the next flush exports the live side as a side
 * chain from the push's old value joined by a two-parent commit whose first
 * parent is the pushed commit. Each case runs against real Git (a bare
 * repository through the Bun store) and ends with `git fsck --strict`.
 *
 * Key behaviors:
 * - a push behind live main is merged; Git's main is the pushed commit and the journal claims no live edit Git lacks
 * - a save that lands during the push's Git checks is merged, not a refusal
 * - a stale blob replace refuses the whole push with its path; Git does not move
 * - conflict cuts and a labelled commit made before the push stay in Git's history
 * - a second push from the first pushed commit, before the export, merges against the first push's tree
 * - a retry of an accepted push is answered accepted and is not applied twice
 * - a join is Epicenter's commit, with every writer it merges in as a co-author
 * - a join waits under the window like all live history; a push on a dropped one flushes first
 * - a flush makes the same few Git requests however many commits it writes, so a push behind it waits for no more
 * - a crash at each step of the push, or of the export, leaves one answer and the same history
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBunGitStore } from '../bun/git.js';
import { openBunSqlite } from '../bun/sqlite.js';
import { type CommitFile, commitId } from '../core/commit.js';
import { findConflicts } from '../core/conflict.js';
import { ATTRIBUTES } from '../core/door.js';
import { writePointer } from '../core/markdown.js';
import type { SqlDriver } from '../sql.js';
import type { FlushStep } from './flush.js';
import { type CommitInfo, type GitObjects, type GitObjectWrites, MAIN } from './git-store.js';
import { createServer, LIMITS, type Server, type Session } from './server.js';

const EPOCH = Date.UTC(2026, 9, 30, 12);
const alice: Session = { user: 'alice', role: 'writer' };
const bob: Session = { user: 'bob', role: 'writer' };
const agent: Session = { user: 'agent', role: 'writer' };
const note = (body: string) => `---\ntitle: A\n---\n${body}`;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const STEPS: FlushStep[] = ['intended', 'staging-pushed', 'staged', 'main-moved', 'completed', 'staging-deleted'];

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function world() {
	const dir = await mkdtemp(join(tmpdir(), 'epicenter-receive-'));
	dirs.push(dir);
	const path = join(dir, 'repo.git');
	const git = await openBunGitStore(path);
	const store = openBunSqlite();
	const clock = { now: EPOCH };
	const open = (faults?: (step: FlushStep) => void, over: GitObjects = git) => createServer({ store, git: over, clock: () => clock.now, ...(faults === undefined ? {} : { faults }) });
	const crashingAt = (step: FlushStep) =>
		open((at) => {
			if (at === step) throw new Error(`crash after ${at}`);
		});
	return { path, git, store, clock, open, crashingAt, server: open() };
}

/** A live save by `session` on `parent` (main by default). */
function save(server: Server, session: Session, files: CommitFile[], { parent = server.main() }: { parent?: string } = {}) {
	const body = { parent, author: { user: session.user, device: 'laptop' }, time: new Date(EPOCH).toISOString(), files };
	return server.push({ id: commitId(body), ...body }, session);
}

/** A clone's commit on `parent` with `changes` to its tree, written as a transport would before asking. */
async function commitOn(git: GitObjects & GitObjectWrites, parent: string, changes: Record<string, string | null>, message = 'pushed\n') {
	const tree = await git.readTree((await git.readCommit(parent))?.tree ?? '');
	for (const [path, text] of Object.entries(changes)) {
		if (text === null) tree.delete(path);
		else tree.set(path, { mode: '100644', oid: await git.writeBlob(encoder.encode(text)) });
	}
	return git.writeCommit({ tree: await git.writeTree(tree), parents: [parent], message, author: { name: 'agent', email: 'agent@example.com' }, at: new Date(EPOCH) });
}

const receive = (server: Server, old: string | null, next: string, session = agent) => server.receive({ ref: MAIN, old, next }, session);
const gitMain = async (git: GitObjects) => (await git.readRef(MAIN)) as string;

/** Every commit reachable from `head` through any parent. */
async function reachable(git: GitObjects, head: string) {
	const found = new Map<string, CommitInfo>();
	const stack = [head];
	while (stack.length > 0) {
		const oid = stack.pop() as string;
		if (found.has(oid)) continue;
		const info = await git.readCommit(oid);
		if (info === null) throw new Error(`missing commit ${oid}`);
		found.set(oid, info);
		stack.push(...info.parents);
	}
	return found;
}

/** The first-parent history from `head`, newest first. */
async function firstParents(git: GitObjects, head: string) {
	const out: string[] = [];
	for (let at: string | undefined = head; at !== undefined; at = (await git.readCommit(at))?.parents[0]) out.push(at);
	return out;
}

/** A Git commit's files as texts. */
async function textsAt(git: GitObjects, oid: string) {
	const out = new Map<string, string>();
	const info = await git.readCommit(oid);
	for (const [path, entry] of await git.readTree(info?.tree ?? '')) out.set(path, decoder.decode((await git.readBlob(entry.oid)) ?? new Uint8Array()));
	return out;
}

const meta = (store: SqlDriver, key: string) => store.all<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key])[0]?.value ?? null;

/** `git log --graph` of main, one subject per line. */
export function graphOf(path: string) {
	const run = Bun.spawnSync(['git', '-C', path, 'log', '--graph', '--format=%h %s', MAIN], { env: ENV });
	return decoder.decode(run.stdout);
}

/**
 * Everything an exported push must hold once a flush ran: Git's main has
 * the live tree; every pushed commit is in its history; no commit that
 * descends from a pushed commit holds a path the push changed at its
 * pre-push value (no commit appears to revert it); the journal and the
 * pending joins are empty and Git holds all of live history; no staging
 * ref is left; and `git fsck --strict` is clean.
 */
async function expectExported(server: Server, store: SqlDriver, git: GitObjects, path: string, pushes: { old: string; next: string }[]) {
	const head = await gitMain(git);
	expect(await textsAt(git, head)).toEqual(new Map([['.gitattributes', ATTRIBUTES], ...server.snapshot()]));
	const all = await reachable(git, head);
	const ancestry = new Map<string, Set<string>>();
	for (const oid of all.keys()) ancestry.set(oid, new Set((await reachable(git, oid)).keys()));
	for (const [i, { old, next }] of pushes.entries()) {
		expect(all.has(next)).toBe(true);
		const before = await textsAt(git, old);
		const after = await textsAt(git, next);
		const changed = [...new Set([...before.keys(), ...after.keys()])].filter((p) => before.get(p) !== after.get(p));
		// A later push may undo this one on purpose; only commits before it are held to this push's change.
		const later = pushes.slice(i + 1).map((push) => push.next);
		for (const [oid, ancestors] of ancestry) {
			if (oid === next || !ancestors.has(next) || later.some((l) => ancestors.has(l))) continue;
			const texts = await textsAt(git, oid);
			for (const p of changed) expect({ oid, path: p, text: texts.get(p) }).not.toEqual({ oid, path: p, text: before.get(p) });
		}
	}
	expect(store.all('SELECT * FROM journal')).toEqual([]);
	expect(meta(store, 'joins')).toBeNull();
	expect(Number(meta(store, 'flushed'))).toBe(Number(meta(store, 'top')));
	const refs = decoder.decode(Bun.spawnSync(['git', '-C', path, 'for-each-ref', '--format=%(refname)'], { env: ENV }).stdout);
	expect(refs.trim()).toBe(MAIN);
	expect(Bun.spawnSync(['git', '-C', path, 'fsck', '--strict'], { env: ENV }).exitCode).toBe(0);
}

/** A flushed repository with two notes: Git's main is `old`. */
async function flushedWorld() {
	const w = await world();
	expect(save(w.server, alice, [{ path: 'notes/a.md', text: note('one\n') }, { path: 'notes/b.md', text: note('b\n') }])).toMatchObject({ kind: 'applied' });
	await w.server.flush();
	return { ...w, old: await gitMain(w.git) };
}

describe('a push behind live main', () => {
	test('is merged: Git main is the pushed commit, and the journal claims no live edit Git lacks', async () => {
		const { server, git, store, path, old } = await flushedWorld();
		const flushed = meta(store, 'flushed');
		expect(save(server, bob, [{ path: 'notes/b.md', text: note('b by bob\n') }])).toMatchObject({ kind: 'applied' });
		const next = await commitOn(git, old, { 'agent/log.md': note('step 1\n') });
		expect(await receive(server, old, next)).toMatchObject({ kind: 'accepted', main: next, head: next, merged: true, published: true });
		expect(await gitMain(git)).toBe(next);
		// Git holds the push, not bob's edit: the flushed place stays where it was.
		expect(meta(store, 'flushed')).toBe(flushed);
		expect(server.read('notes/b.md')).toBe(note('b by bob\n'));
		expect(server.read('agent/log.md')).toBe(note('step 1\n'));

		expect(await server.flush()).toMatchObject({ kind: 'flushed' });
		const head = await gitMain(git);
		const merge = await git.readCommit(head);
		expect(merge?.parents[0]).toBe(next);
		// The second parent is bob's edit, a side chain from the push's old value.
		const side = await git.readCommit(merge?.parents[1] as string);
		expect(side?.parents).toEqual([old]);
		expect((await textsAt(git, merge?.parents[1] as string)).get('notes/b.md')).toBe(note('b by bob\n'));
		await expectExported(server, store, git, path, [{ old, next }]);
	});

	test('with nothing live ahead of Git, is applied and fast-forwards as before', async () => {
		const { server, git, store, path, old } = await flushedWorld();
		const next = await commitOn(git, old, { 'agent/log.md': note('step 1\n') });
		expect(await receive(server, old, next)).toMatchObject({ kind: 'accepted', main: next, merged: false });
		expect(meta(store, 'flushed')).toBe(meta(store, 'top'));
		expect(await server.flush()).toEqual({ kind: 'nothing' });
		await expectExported(server, store, git, path, [{ old, next }]);
	});

	test('a save that lands during the push’s Git checks is merged, not a refusal', async () => {
		const { git, store, path, old, open } = await flushedWorld();
		const next = await commitOn(git, old, { 'agent/log.md': note('step 1\n') });
		let server: Server | undefined;
		let landed = false;
		const racing: GitObjects = {
			...git,
			readBlob: async (oid) => {
				if (!landed && server !== undefined) {
					landed = true;
					expect(save(server, bob, [{ path: 'notes/b.md', text: note('typed meanwhile\n') }])).toMatchObject({ kind: 'applied' });
				}
				return git.readBlob(oid);
			},
		};
		server = open(undefined, racing);
		expect(await receive(server, old, next)).toMatchObject({ kind: 'accepted', main: next, merged: true });
		expect(landed).toBe(true);
		expect(server.read('notes/b.md')).toBe(note('typed meanwhile\n'));
		expect(server.read('agent/log.md')).toBe(note('step 1\n'));
		await server.flush();
		await expectExported(server, store, git, path, [{ old, next }]);
	});

	test('a stale blob replace refuses the whole push with its path, and Git does not move', async () => {
		const w = await world();
		const v1 = { oid: '1'.repeat(64), size: 3 };
		const v2 = { oid: '2'.repeat(64), size: 3 };
		const v3 = { oid: '3'.repeat(64), size: 3 };
		for (const v of [v1, v2, v3]) w.server.upload(v.oid, v.size);
		save(w.server, alice, [{ path: 'notes/a.md', text: note('one\n') }, { path: 'audio/r.wav', text: writePointer(v1) }]);
		await w.server.flush();
		const old = await gitMain(w.git);
		expect(save(w.server, bob, [{ path: 'audio/r.wav', text: writePointer(v2) }])).toMatchObject({ kind: 'applied' });
		const next = await commitOn(w.git, old, { 'audio/r.wav': writePointer(v3), 'notes/c.md': note('c\n') });
		expect(await receive(w.server, old, next)).toMatchObject({ kind: 'refused', code: 'live', path: 'audio/r.wav' });
		expect(await gitMain(w.git)).toBe(old);
		expect(w.server.read('audio/r.wav')).toBe(writePointer(v2));
		expect(w.server.read('notes/c.md')).toBeNull();
		// A push that leaves the blob alone lands.
		const other = await commitOn(w.git, old, { 'notes/c.md': note('c\n') });
		expect(await receive(w.server, old, other)).toMatchObject({ kind: 'accepted', merged: true });
		await w.server.flush();
		await expectExported(w.server, w.store, w.git, w.path, [{ old, next: other }]);
	});

	test('a stale old value is refused as main-moved, and nothing is taken', async () => {
		const { server, git, old } = await flushedWorld();
		save(server, bob, [{ path: 'notes/b.md', text: note('b2\n') }]);
		await server.flush();
		const next = await commitOn(git, old, { 'agent/log.md': note('step 1\n') });
		expect(await receive(server, old, next)).toMatchObject({ kind: 'refused', code: 'main-moved' });
		expect(server.read('agent/log.md')).toBeNull();
	});
});

describe('history', () => {
	test('conflict cuts made before the push stay in Git; the push overlapping a note merges into a block', async () => {
		const { server, git, store, path, old, open } = await flushedWorld();
		const base = server.main();
		expect(save(server, alice, [{ path: 'notes/a.md', text: note('two\n') }])).toMatchObject({ kind: 'applied' });
		expect(save(server, bob, [{ path: 'notes/a.md', text: note('three\n') }], { parent: base })).toMatchObject({ kind: 'merged' });
		const blocked = server.read('notes/a.md') as string;
		expect(findConflicts(blocked)).toHaveLength(1);
		expect(save(server, alice, [{ path: 'notes/a.md', text: note('two\nthree\n') }])).toMatchObject({ kind: 'applied' });
		expect(save(server, bob, [{ path: 'notes/b.md', text: note('b\n') }])).toMatchObject({ kind: 'applied' });

		// The push changes a.md's line (which people changed too) and adds an independent file; a save lands during its checks.
		const next = await commitOn(git, old, { 'notes/a.md': note('one, pushed\n'), 'notes/c.md': note('c\n') });
		let landed = false;
		let racingServer: Server | undefined;
		const racing: GitObjects = {
			...git,
			readBlob: async (oid) => {
				if (!landed && racingServer !== undefined) {
					landed = true;
					save(racingServer, alice, [{ path: 'notes/d.md', text: note('d\n') }]);
				}
				return git.readBlob(oid);
			},
		};
		racingServer = open(undefined, racing);
		expect(await receive(racingServer, old, next)).toMatchObject({ kind: 'accepted', main: next, merged: true });
		const merged = server.read('notes/a.md') as string;
		expect(merged).toContain('one, pushed');
		expect(merged).toContain('two');
		expect(findConflicts(merged)).toHaveLength(1);

		await server.flush();
		await expectExported(server, store, git, path, [{ old, next }]);
		const all = await reachable(git, await gitMain(git));
		const texts = await Promise.all([...all.keys()].map((oid) => textsAt(git, oid)));
		// The block bob's stale edit wrote is a Git commit of its own, on the side chain.
		expect(texts.some((t) => t.get('notes/a.md') === blocked)).toBe(true);
		const graph = graphOf(path);
		expect(graph).toContain('Merge live edits into');
	});

	test('a second push from the first pushed commit, before the export, merges against the first push’s tree', async () => {
		const { server, git, store, path, old } = await flushedWorld();
		save(server, bob, [{ path: 'notes/b.md', text: note('b by bob\n') }]);
		const first = await commitOn(git, old, { 'agent/log.md': note('step 1\n'), 'agent/tmp.md': note('scratch\n') });
		expect(await receive(server, old, first)).toMatchObject({ kind: 'accepted', merged: true, head: first });
		save(server, bob, [{ path: 'notes/b.md', text: note('b by bob, again\n') }]);
		// The pusher builds on its own pushed commit, as `git push` twice does: it deletes what its first push added.
		const second = await commitOn(git, first, { 'agent/log.md': note('step 1\nstep 2\n'), 'agent/tmp.md': null });
		expect(await receive(server, first, second)).toMatchObject({ kind: 'accepted', main: second, merged: true, head: second });
		expect(server.read('agent/tmp.md')).toBeNull();
		expect(server.read('agent/log.md')).toBe(note('step 1\nstep 2\n'));
		expect(server.read('notes/b.md')).toBe(note('b by bob, again\n'));
		// A third, with no live edit since the second.
		const third = await commitOn(git, second, { 'agent/log.md': note('step 1\nstep 2\nstep 3\n') });
		expect(await receive(server, second, third)).toMatchObject({ kind: 'accepted', main: third, merged: true });

		await server.flush();
		const head = await gitMain(git);
		expect((await git.readCommit(head))?.parents[0]).toBe(third);
		// Git's first-parent history runs through every push.
		expect(await firstParents(git, head)).toEqual(expect.arrayContaining([third, second, first, old]));
		await expectExported(server, store, git, path, [
			{ old, next: first },
			{ old: first, next: second },
			{ old: second, next: third },
		]);
	});

	test('a retry of an accepted push is answered accepted and is not applied twice', async () => {
		const { server, git, store, path, old } = await flushedWorld();
		save(server, bob, [{ path: 'notes/b.md', text: note('b2\n') }]);
		const next = await commitOn(git, old, { 'agent/log.md': note('step 1\n') });
		expect(await receive(server, old, next)).toMatchObject({ kind: 'accepted', merged: true });
		const made = server.history().commits;
		expect(await receive(server, old, next)).toMatchObject({ kind: 'accepted', main: next, head: next, published: true });
		await server.flush();
		expect(await receive(server, old, next)).toMatchObject({ kind: 'accepted', main: next, published: true });
		expect(server.history().commits).toBe(made);
		await expectExported(server, store, git, path, [{ old, next }]);
	});
});

describe('the join', () => {
	test('is authored by Epicenter, with every writer it merges in as a co-author and not its pusher', async () => {
		const { server, git, path, old } = await flushedWorld();
		save(server, alice, [{ path: 'notes/a.md', text: note('one, by alice\n') }]);
		save(server, bob, [{ path: 'notes/b.md', text: note('b, by bob\n') }]);
		const next = await commitOn(git, old, { 'agent/log.md': note('step 1\n') });
		expect(await receive(server, old, next)).toMatchObject({ kind: 'accepted', merged: true });
		await server.flush();
		const join = await gitMain(git);
		expect((await git.readCommit(join))?.parents[0]).toBe(next);
		const raw = decoder.decode(Bun.spawnSync(['git', '-C', path, 'cat-file', 'commit', join], { env: ENV }).stdout);
		expect(raw).toMatch(/^author Epicenter <noreply@epicenter\.so> /m);
		expect(raw).toMatch(/^committer Epicenter <noreply@epicenter\.so> /m);
		const coauthors = raw.split('\n').filter((line) => line.startsWith('Co-authored-by: '));
		expect(coauthors).toEqual(['Co-authored-by: alice <alice@users.epicenter.invalid>', 'Co-authored-by: bob <bob@users.epicenter.invalid>']);
	});
});

describe('a join waiting past the window', () => {
	/** A merged push over bob's edit, then more typing after the window passed, so the join's place is dropped. */
	async function aged() {
		const w = await flushedWorld();
		save(w.server, bob, [{ path: 'notes/b.md', text: note('b by bob\n') }]);
		const next = await commitOn(w.git, w.old, { 'agent/log.md': note('step 1\n') });
		expect(await receive(w.server, w.old, next)).toMatchObject({ kind: 'accepted', merged: true });
		const place = (JSON.parse(meta(w.store, 'joins') as string) as { place: number }[])[0]?.place as number;
		save(w.server, bob, [{ path: 'notes/b.md', text: note('b by bob, later\n') }]);
		w.clock.now += LIMITS.window + 60_000;
		save(w.server, alice, [{ path: 'notes/a.md', text: note('one, after a while\n') }]);
		expect(Number(meta(w.store, 'offset'))).toBeGreaterThan(place);
		return { ...w, next };
	}

	test('holds nothing past it: the flush keeps the push on first-parent history and Git ends at the live tree', async () => {
		const { server, git, store, path, old, next } = await aged();
		expect(await server.flush()).toMatchObject({ kind: 'flushed' });
		const head = await gitMain(git);
		expect(await firstParents(git, head)).toContain(next);
		await expectExported(server, store, git, path, [{ old, next }]);
	});

	test('a push on the dropped join flushes first and is refused as main-moved; rebased, it lands', async () => {
		const { server, git, store, path, old, next } = await aged();
		const second = await commitOn(git, next, { 'agent/log.md': note('step 1\nstep 2\n') });
		expect(await receive(server, next, second)).toMatchObject({ kind: 'refused', code: 'main-moved' });
		const exported = await gitMain(git);
		expect(await firstParents(git, exported)).toContain(next);
		const rebased = await commitOn(git, exported, { 'agent/log.md': note('step 1\nstep 2\n') });
		expect(await receive(server, exported, rebased)).toMatchObject({ kind: 'accepted', main: rebased });
		await server.flush();
		await expectExported(server, store, git, path, [
			{ old, next },
			{ old: exported, next: rebased },
		]);
	});
});

describe('a flush', () => {
	test('makes the same few Git requests however many commits it writes, one of them the pack', async () => {
		const requests = async (blocked: number) => {
			const { git, open, old } = await flushedWorld();
			const calls: string[] = [];
			const counted = Object.fromEntries(
				Object.entries(git).map(([name, fn]) => [name, (...args: unknown[]) => (calls.push(name), (fn as (...a: unknown[]) => unknown)(...args))]),
			) as unknown as GitObjects;
			const server = open(undefined, counted);
			// Each merge that writes a conflict block is a Git commit of its own; a merged push adds a side chain and a join.
			for (let i = 0; i < blocked; i++) {
				const base = server.main();
				expect(save(server, alice, [{ path: `notes/n${i}.md`, text: note('a\n') }])).toMatchObject({ kind: 'applied' });
				expect(save(server, bob, [{ path: `notes/n${i}.md`, text: note('b\n') }], { parent: base })).toMatchObject({ kind: 'merged' });
			}
			const next = await commitOn(git, old, { 'agent/log.md': note('step 1\n') });
			expect(await receive(server, old, next)).toMatchObject({ kind: 'accepted', merged: true });
			calls.length = 0;
			const flushed = await server.flush();
			expect(flushed.kind === 'flushed' && flushed.commits.length).toBeGreaterThan(blocked);
			return calls;
		};
		const few = await requests(1);
		const many = await requests(25);
		expect(many.filter((name) => name === 'writePack')).toHaveLength(1);
		// Read Git's main, read the staging ref, the pack with the staging ref, swap main, delete the staging ref.
		expect(many).toEqual(['readRef', 'readRef', 'writePack', 'updateRef', 'deleteRef']);
		expect(many).toEqual(few);
	});
});

describe('a crash', () => {
	for (const step of ['received', ...STEPS.filter((s) => s === 'main-moved' || s === 'completed' || s === 'staging-deleted')] as FlushStep[])
		test(`after the push's '${step}', the retry is answered accepted and nothing is applied twice`, async () => {
			const { git, store, path, old, crashingAt, open } = await flushedWorld();
			const crashing = crashingAt(step);
			save(crashing, bob, [{ path: 'notes/b.md', text: note('b2\n') }]);
			const next = await commitOn(git, old, { 'agent/log.md': note('step 1\n') });
			await expect(receive(crashing, old, next)).rejects.toThrow(`crash after ${step}`);
			const fresh = open();
			const made = fresh.history().commits;
			expect(await receive(fresh, old, next)).toMatchObject({ kind: 'accepted', main: next, head: next, published: true });
			expect(fresh.history().commits).toBe(made);
			expect(await gitMain(git)).toBe(next);
			// Typing goes on, and the pusher pushes again from its own commit.
			save(fresh, alice, [{ path: 'notes/a.md', text: note('one, typed\n') }]);
			const second = await commitOn(git, next, { 'agent/log.md': note('step 1\nstep 2\n') });
			expect(await receive(fresh, next, second)).toMatchObject({ kind: 'accepted', main: second });
			await fresh.flush();
			await expectExported(fresh, store, git, path, [
				{ old, next },
				{ old: next, next: second },
			]);
		});

	for (const step of STEPS)
		test(`after the export's '${step}', a fresh instance finishes it; a push from the pushed commit is refused as main-moved and lands rebased`, async () => {
			const { server, git, store, path, old, crashingAt, open } = await flushedWorld();
			save(server, bob, [{ path: 'notes/b.md', text: note('b2\n') }]);
			const next = await commitOn(git, old, { 'agent/log.md': note('step 1\n') });
			expect(await receive(server, old, next)).toMatchObject({ kind: 'accepted', merged: true });
			save(server, bob, [{ path: 'notes/b.md', text: note('b3\n') }]);
			await expect(crashingAt(step).flush()).rejects.toThrow(`crash after ${step}`);

			const fresh = open();
			save(fresh, alice, [{ path: 'notes/a.md', text: note('one, typed\n') }]);
			const second = await commitOn(git, next, { 'agent/log.md': note('step 1\nstep 2\n') });
			// The export was decided before this push: it finishes first, so Git's main is no longer the push's old value.
			expect(await receive(fresh, next, second)).toMatchObject({ kind: 'refused', code: 'main-moved' });
			const exported = await gitMain(git);
			expect(exported).not.toBe(next);
			expect(await firstParents(git, exported)).toContain(next);
			const rebased = await commitOn(git, exported, { 'agent/log.md': note('step 1\nstep 2\n') });
			expect(await receive(fresh, exported, rebased)).toMatchObject({ kind: 'accepted', main: rebased });
			await fresh.flush();
			await expectExported(fresh, store, git, path, [
				{ old, next },
				{ old: exported, next: rebased },
			]);
			expect(fresh.read('notes/b.md')).toBe(note('b3\n'));
			expect(fresh.read('notes/a.md')).toBe(note('one, typed\n'));
		});
});

describe('randomized', () => {
	function mulberry32(seed: number) {
		let a = seed >>> 0;
		return () => {
			a = (a + 0x6d2b79f5) >>> 0;
			let t = a;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}
	const SEEDS = Number(process.env.PUSH_SEEDS ?? 40);
	const FROM = Number(process.env.PUSH_FROM ?? 1);

	/**
	 * Saves (some on a stale parent), pushes from Git's main or from the
	 * pusher's own last pushed commit, flushes, crashes at a random step of
	 * a flush or a push, and time passing beyond the window. Every push
	 * whose old value is Git's main is accepted (or refused by the live door
	 * with a path, or main-moved when the server moved Git first: a row a
	 * crash left, or live history the window dropped), every other is
	 * main-moved, a retry after a crash is accepted, and at the end Git's
	 * first-parent history runs through every push, its main holds the
	 * live tree, and no commit after a push holds an agent path at its
	 * pre-push value.
	 */
	test(`saves, pushes, flushes and crashes interleaved hold the history invariants over ${SEEDS} seeds`, async () => {
		const { createMemoryGitStore } = await import('./memory-git.js');
		const seen = { merged: 0, chained: 0, pushCrashes: 0, flushCrashes: 0, refusedLive: 0, decidedFirst: 0, droppedFirst: 0, aged: 0 };
		for (let seed = FROM; seed < FROM + SEEDS; seed++) {
			const random = mulberry32(seed);
			const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)] as T;
			const git = createMemoryGitStore();
			const store = openBunSqlite();
			let now = EPOCH;
			/** Whether the window, as of now, no longer keeps the live commit Git's main stands for (the last join's place, or the flushed place). */
			const dropped = () => {
				const newest = store.all<{ place: number | null }>('SELECT MAX(place) AS place FROM commits WHERE place IS NOT NULL AND at < ?', [now - LIMITS.window])[0]?.place ?? -1;
				const keptFrom = Math.max(Number(meta(store, 'offset')), Math.min(Number(meta(store, 'top')), newest + 1));
				const joins = JSON.parse(meta(store, 'joins') ?? '[]') as { place: number }[];
				return (joins.at(-1)?.place ?? Number(meta(store, 'flushed'))) < keptFrom;
			};
			const open = (faults?: (step: FlushStep) => void) => createServer({ store, git, clock: () => now, ...(faults === undefined ? {} : { faults }) });
			let server = open();
			save(server, alice, [{ path: 'notes/p0.md', text: note('start\n') }]);
			await server.flush();
			const mains: string[] = [server.main()];
			const pushes: { old: string; next: string }[] = [];
			let own: string | null = null;
			let log = 'start\n';
			let tmp = 0;
			const where = `seed ${seed} (PUSH_FROM=${seed} PUSH_SEEDS=1)`;
			for (let step = 0; step < 60; step++) {
				const roll = random();
				if (roll < 0.04) {
					now += LIMITS.window + 60_000;
					if (meta(store, 'joins') !== null) seen.aged++;
				} else if (roll < 0.5) {
					const who = pick([alice, bob]);
					const path = `notes/p${Math.floor(random() * 3)}.md`;
					const parent = random() < 0.2 ? pick(mains.slice(-5)) : server.main();
					const now = server.read(path);
					const answer = save(server, who, [{ path, text: note(`${now === null ? '' : 'x '}${who.user} ${step}\n`) }], { parent });
					if (answer.kind === 'applied' || answer.kind === 'merged') mains.push(answer.main);
				} else if (roll < 0.8) {
					const fetched = await gitMain(git);
					const old: string = own !== null && random() < 0.5 ? own : fetched;
					const changes: Record<string, string | null> = {};
					const before = await textsAt(git, old);
					log = `${(before.get('agent/log.md') ?? note('')).replace(/^---\ntitle: A\n---\n/, '')}step ${step}\n`;
					changes['agent/log.md'] = note(log);
					if (random() < 0.3) changes[`agent/tmp${tmp++}.md`] = note(`tmp ${step}\n`);
					const doomed = [...before.keys()].filter((p) => p.startsWith('agent/tmp'));
					if (doomed.length > 0 && random() < 0.3) changes[pick(doomed)] = null;
					if (random() < 0.3) changes[`notes/p${Math.floor(random() * 3)}.md`] = note(`pushed ${step}\n`);
					const next = await commitOn(git, old, changes, `step ${step}\n`);
					// A row a crash left was decided before this push: it finishes first, and may move Git's main past what was fetched.
					const decided = store.all('SELECT 1 FROM journal').length > 0;
					const gone = !decided && dropped();
					const waiting = meta(store, 'joins') !== null;
					const crash = random() < 0.15 ? pick(['received', 'main-moved', 'completed', 'staging-deleted'] as FlushStep[]) : null;
					const pusher =
						crash === null
							? server
							: open((at) => {
									if (at === crash) throw new Error('crash');
								});
					let answer = await receive(pusher, old, next).catch(() => null);
					if (answer === null) {
						seen.pushCrashes++;
						server = open();
						answer = await receive(server, old, next);
					}
					// Git moved before this push was checked: a row a crash left finished, or the window dropped what Git's main stands for and live history was flushed.
					const movedFirst = answer.kind === 'refused' && answer.code === 'main-moved' && (await gitMain(git)) !== fetched;
					if (movedFirst) {
						expect({ where, decidedOrDropped: decided || gone }).toEqual({ where, decidedOrDropped: true });
						if (decided) seen.decidedFirst++;
						else seen.droppedFirst++;
					}
					// The window dropped Git's base: whatever the push's old value, the server flushes first.
					if (gone) expect({ where, movedFirst: (await gitMain(git)) !== fetched }).toEqual({ where, movedFirst: true });
					if (answer.kind === 'accepted' && answer.merged) seen.merged++;
					if (answer.kind === 'accepted' && waiting && old === own) seen.chained++;
					if (answer.kind === 'refused' && answer.code === 'live') seen.refusedLive++;
					if (old === fetched && !movedFirst) {
						if (answer.kind === 'refused') expect({ where, answer }).toMatchObject({ answer: { code: 'live', path: expect.any(String) } });
						else {
							expect({ where, answer }).toMatchObject({ answer: { kind: 'accepted', main: next, published: true } });
							pushes.push({ old, next });
							own = next;
						}
					} else if (old !== fetched) expect({ where, answer }).toMatchObject({ answer: { kind: 'refused', code: 'main-moved' } });
				} else if (random() < 0.6) {
					await server.flush();
				} else {
					const crash = pick(STEPS);
					seen.flushCrashes++;
					await open((at) => {
						if (at === crash) throw new Error('crash');
					})
						.flush()
						.catch(() => {});
					server = open();
				}
			}
			await server.flush();
			const head = await gitMain(git);
			expect({ where, texts: await textsAt(git, head) }).toEqual({ where, texts: new Map([['.gitattributes', ATTRIBUTES], ...server.snapshot()]) });
			const chain = await firstParents(git, head);
			for (const { next } of pushes) expect({ where, onFirstParent: chain.includes(next) }).toEqual({ where, onFirstParent: true });
			expect(store.all('SELECT * FROM journal')).toEqual([]);
			expect(meta(store, 'joins')).toBeNull();
			// No commit after a push, and before the next, holds an agent path at its pre-push value (people never write agent paths).
			const all = await reachable(git, head);
			const ancestry = new Map<string, Set<string>>();
			for (const oid of all.keys()) ancestry.set(oid, new Set((await reachable(git, oid)).keys()));
			for (const [i, { old, next }] of pushes.entries()) {
				const before = await textsAt(git, old);
				const after = await textsAt(git, next);
				const changed = [...new Set([...before.keys(), ...after.keys()])].filter((p) => p.startsWith('agent/') && before.get(p) !== after.get(p));
				const later = pushes.slice(i + 1).map((push) => push.next);
				for (const [oid, ancestors] of ancestry) {
					if (oid === next || !ancestors.has(next) || later.some((l) => ancestors.has(l))) continue;
					const texts = await textsAt(git, oid);
					for (const p of changed) expect({ where, oid, path: p, text: texts.get(p) }).not.toEqual({ where, oid, path: p, text: before.get(p) });
				}
			}
		}
		// The cases this test is for all happened.
		if (SEEDS >= 40) for (const [name, count] of Object.entries(seen)) if (name !== 'refusedLive') expect({ name, count: count > 0 }).toEqual({ name, count: true });
		if (process.env.PUSH_TOTALS === '1') console.log(seen);
	}, 120_000);
});
