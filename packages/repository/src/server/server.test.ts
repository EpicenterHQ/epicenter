/**
 * Server Tests
 *
 * The server's promises at its door, one at a time, over a SQLite Store and
 * an in-memory Git; the replica-driven scenario, people and property tests
 * in src/b/ cover how they combine.
 *
 * Key behaviors:
 * - admission: a session is required, a reader or a stranger may not write, the author is the session's user, and each limit holds; a stale fast-forward commit is refused with main's texts
 * - idempotency: a resend gets its answer brought up to now; after the window, `flushed`; a parent past the window with no record, `outcome-unknown`
 * - catch-up is a tree diff in pages; the change feed names each commit, its parents and changed paths with hashes
 * - a fresh instance over the same Store answers as the first did
 * - the Git receive path checks every pushed commit and refuses merges, broken notes, other modes, Epicenter's files and other refs
 */
import { describe, expect, test } from 'bun:test';
import { openBunSqlite } from '../bun/sqlite.js';
import { type CommitFile, commitId, type LiveCommit } from '../core/commit.js';
import { gitBlobHash } from '../core/hash.js';
import { MAIN } from './git-store.js';
import { createMemoryGitStore } from './memory-git.js';
import { createServer, type Event, type Limits, LIMITS, type Server, type Session } from './server.js';

const EPOCH = Date.UTC(2026, 9, 28, 12);
const alice: Session = { user: 'alice', role: 'writer' };
const note = (body: string) => `---\ntitle: A\n---\n${body}`;

function setup(limits: Partial<Limits> = {}) {
	const clock = { now: EPOCH };
	const store = openBunSqlite();
	const git = createMemoryGitStore();
	const server = createServer({ store, git, clock: () => clock.now, limits });
	return { clock, store, git, server };
}

function make(server: Server, files: CommitFile[], { user = 'alice', parent = server.main(), time = new Date(EPOCH).toISOString() } = {}): LiveCommit {
	const body = { parent, mode: 'merge' as const, author: { user, device: 'laptop' }, time, files };
	return { id: commitId(body), ...body };
}

describe('admission', () => {
	test('a session is required, and only a writer of this repository may write as themselves', () => {
		const { server } = setup();
		const commit = make(server, [{ path: 'notes/a.md', text: note('a\n') }]);
		expect(server.push(commit)).toMatchObject({ kind: 'rejected', code: 'no-session', reason: 'no session' });
		expect(server.push(commit, { user: 'alice', role: null })).toMatchObject({ kind: 'rejected', code: 'not-member', reason: 'not a member' });
		expect(server.push(commit, { user: 'alice', role: 'reader' })).toMatchObject({ kind: 'rejected', code: 'reader', reason: 'a reader may not write' });
		expect(server.push(commit, { user: 'mallory', role: 'writer' })).toMatchObject({ kind: 'rejected', code: 'not-author', reason: 'the author is not the session' });
		expect(server.push(commit, { user: 'alice', role: 'owner' })).toMatchObject({ kind: 'applied' });
	});

	test('each limit holds', () => {
		const { server, clock } = setup({ files: 2, path: 20, request: 2_000, burst: 3, rate: 1 });
		const text = note('x\n');
		expect(server.push(make(server, [1, 2, 3].map((i) => ({ path: `n/${i}.md`, text }))), alice)).toMatchObject({ kind: 'rejected', code: 'too-many-files' });
		expect(server.push(make(server, [{ path: `notes/${'é'.repeat(10)}.md`, text }]), alice)).toMatchObject({ kind: 'refused', code: 'path-too-long', path: `notes/${'é'.repeat(10)}.md` });
		expect(server.push(make(server, [{ path: 'n/a.md', text: note('x'.repeat(3_000)) }]), alice)).toMatchObject({ kind: 'rejected', code: 'too-large' });
		// The three refusals above used the burst; the bucket refills at one push a second.
		expect(server.push(make(server, [{ path: 'n/a.md', text }]), alice)).toMatchObject({ kind: 'rejected', code: 'rate', reason: 'rate' });
		clock.now += 1_000;
		expect(server.push(make(server, [{ path: 'n/a.md', text }]), alice)).toMatchObject({ kind: 'applied' });
	});

	test("a commit's time is an ISO instant no later than the server's clock allows; an earlier one is a resend's", () => {
		const { server } = setup();
		const files = [{ path: 'n/a.md', text: note('a\n') }];
		expect(server.push(make(server, files, { time: 'yesterday' }), alice)).toMatchObject({ kind: 'rejected', code: 'bad-time', reason: 'the time is not an ISO instant' });
		expect(server.push(make(server, files, { time: new Date(EPOCH + LIMITS.skew + 1).toISOString() }), alice)).toMatchObject({
			kind: 'rejected',
			code: 'clock-ahead',
		});
		expect(server.push(make(server, files, { time: new Date(EPOCH - 3 * 24 * 3_600_000).toISOString() }), alice)).toMatchObject({ kind: 'applied' });
	});

	test('a merge result passes the door too', () => {
		const { server } = setup();
		const base = server.main();
		expect(server.push(make(server, [{ path: 'n/a.md', text: note('one\n') }]), alice).kind).toBe('applied');
		// A stale create of the same note is another note at the path (D3); a block that would pass 1 MB is refused.
		const big = note(`${'b'.repeat(600_000)}\n`);
		expect(server.push(make(server, [{ path: 'n/a.md', text: big }], { parent: base }), alice).kind).toBe('merged');
		expect(server.push(make(server, [{ path: 'n/a.md', text: note(`${'c'.repeat(600_000)}\n`) }], { parent: base }), alice)).toMatchObject({
			kind: 'refused',
			code: 'merge-too-large',
			reason: 'the merge would grow the note past 1 MB',
			path: 'n/a.md',
		});
	});

	test("a stale fast-forward commit is refused with main's texts for the paths it touched", () => {
		const { server } = setup();
		const base = server.main();
		expect(server.push(make(server, [{ path: 'n/a.md', text: note('one\n') }]), alice).kind).toBe('applied');
		const body = { parent: base, mode: 'fast-forward' as const, author: { user: 'alice', device: 'laptop' }, time: new Date(EPOCH).toISOString(), files: [{ path: 'n/a.md', text: note('two\n') }] };
		expect(server.push({ id: commitId(body), ...body }, alice)).toEqual({
			kind: 'rejected',
			code: 'main-moved',
			reason: 'main moved',
			main: server.main(),
			files: [{ path: 'n/a.md', text: note('one\n'), hash: gitBlobHash(note('one\n')) }],
		});
	});
});

describe('idempotency', () => {
	test('a resend gets its answer brought up to now, then `flushed` once the window passed, from a fresh instance too', async () => {
		const { server, clock, store, git } = setup();
		const first = make(server, [{ path: 'n/a.md', text: note('a\n') }]);
		expect(server.push(first, alice)).toMatchObject({ kind: 'applied', main: first.id });
		const second = make(server, [{ path: 'n/b.md', text: note('b\n') }]);
		server.push(second, alice);
		const resent = server.push(first, alice);
		expect(resent).toMatchObject({ kind: 'applied', main: second.id, commits: [first.id, second.id] });
		// An id with other files is a forgery, not a resend.
		expect(server.push({ ...make(server, [{ path: 'n/a.md', text: note('other\n') }]), id: first.id }, alice)).toMatchObject({ kind: 'rejected', code: 'bad-id' });
		await server.flush();
		clock.now += LIMITS.window + 1;
		const fresh = createServer({ store, git, clock: () => clock.now });
		expect(fresh.push(first, alice)).toEqual({ kind: 'flushed', main: second.id, files: [{ path: 'n/a.md', text: note('a\n'), hash: gitBlobHash(note('a\n')) }] });
		expect(fresh.history().commits).toBe(2);
	});

	test('a commit on a parent past the window, with no record, is outcome-unknown', () => {
		const { server, clock } = setup();
		const root = server.main();
		server.push(make(server, [{ path: 'n/a.md', text: note('a\n') }]), alice);
		clock.now += LIMITS.window + 1;
		server.push(make(server, [{ path: 'n/a.md', text: note('b\n') }]), alice);
		expect(server.push(make(server, [{ path: 'n/c.md', text: note('c\n') }], { parent: root }), alice)).toMatchObject({ kind: 'outcome-unknown' });
	});
});

describe('catch-up and the change feed', () => {
	test('a catch-up is a tree diff in pages, and a position past the window gets every file', () => {
		const { server, clock } = setup({ page: 2 });
		const from = server.main();
		const commit = make(server, ['a', 'b', 'c'].map((name) => ({ path: `n/${name}.md`, text: note(`${name}\n`) })));
		server.push(commit, alice);
		const one = server.catchUp({ from });
		expect(one).toMatchObject({ main: commit.id, full: false, next: 'n/b.md', commits: [] });
		expect(one.files.map((f) => f.path)).toEqual(['n/a.md', 'n/b.md']);
		const two = server.catchUp({ from, to: one.main, after: one.next ?? '' });
		expect(two).toMatchObject({ next: null, commits: [commit.id], files: [{ path: 'n/c.md', hash: gitBlobHash(note('c\n')) }] });
		clock.now += LIMITS.window + 1;
		server.push(make(server, [{ path: 'n/a.md', text: null }]), alice);
		expect(server.catchUp({ from })).toMatchObject({ full: true, files: [{ path: 'n/b.md' }, { path: 'n/c.md' }] });
	});

	test('a later page whose commit has left the window answers restart, never a page of another commit', () => {
		const { server, clock } = setup({ page: 1 });
		server.push(make(server, ['a', 'b'].map((name) => ({ path: `n/${name}.md`, text: note(`${name}\n`) }))), alice);
		clock.now += LIMITS.window + 1;
		const one = server.catchUp({ from: null });
		expect(one).toMatchObject({ full: true, next: 'n/a.md' });
		// A push between the pages prunes the commit the first page answered.
		server.push(make(server, [{ path: 'n/a.md', text: note('a2\n') }]), alice);
		expect(server.catchUp({ from: null, to: one.main, after: one.next ?? '' })).toEqual({ main: server.main(), full: true, restart: true, files: [], commits: [], next: null });
	});

	test('each commit on main is one event: its id, parents and changed paths with hashes, after it is stored', () => {
		const { server } = setup();
		const events: Event[] = [];
		server.subscribe((event) => events.push(event));
		const base = server.main();
		const first = make(server, [{ path: 'n/a.md', text: note('a\n') }, { path: 'n/same.md', text: null }]);
		server.push(first, alice);
		server.push(make(server, [{ path: 'n/b.md', text: note('b\n') }], { parent: base }), alice);
		expect(events[0]).toEqual({ commit: first.id, parents: [base], files: [{ path: 'n/a.md', hash: gitBlobHash(note('a\n')) }] });
		expect(events[1]?.parents[0]).toBe(first.id);
		expect(events[1]?.files).toEqual([{ path: 'n/b.md', hash: gitBlobHash(note('b\n')) }]);
		expect(events.map((event) => event.commit)).toEqual([first.id, server.main()]);
	});
});

describe('storage', () => {
	test('texts and tree nodes no kept commit names are collected after a flush, so 200 saves of a 10 KB note leave a bounded store', async () => {
		const { server, clock } = setup();
		const text = (i: number) => note(`${'x'.repeat(10_000)} ${i}\n`);
		for (let i = 0; i < 200; i++) {
			expect(server.push(make(server, [{ path: 'n/a.md', text: text(i) }, { path: `n/deep/${i % 3}/b.md`, text: note(`${i}\n`) }]), alice).kind).toBe('applied');
			clock.now += 1_000;
		}
		await server.flush();
		expect(server.history().bytes).toBeGreaterThan(200 * 10_000);
		clock.now += LIMITS.window + 1;
		await server.flush();
		const { bytes, nodes } = server.history();
		expect(bytes).toBeLessThan(3 * 10_100);
		expect(nodes).toBeLessThan(12);
		// What main holds is still there, for reads and the next catch-up.
		expect(server.read('n/a.md')).toBe(text(199));
		expect(server.catchUp({ from: null }).files).toHaveLength(4);
		expect(server.fetch([gitBlobHash(text(199))])).toEqual({ [gitBlobHash(text(199))]: text(199) });
	});
});

describe('the Git receive path', () => {
	async function flushed() {
		const world = setup();
		world.server.push(make(world.server, [{ path: 'n/a.md', text: note('a\n') }]), alice);
		await world.server.flush();
		const head = (await world.git.readRef(MAIN)) as string;
		const { git } = world;
		/** A commit on `parent` with `changes` to its tree. */
		const commitOn = async (parent: string, changes: Record<string, string | null>, { mode = '100644', parents = [parent] } = {}) => {
			const tree = await git.readTree((await git.readCommit(parent))?.tree ?? '');
			for (const [path, text] of Object.entries(changes)) {
				if (text === null) tree.delete(path);
				else tree.set(path, { mode, oid: await git.writeBlob(new TextEncoder().encode(text)) });
			}
			return git.writeCommit({ tree: await git.writeTree(tree), parents, message: 'pushed\n', author: { name: 'alice', email: 'a@b' }, at: new Date(EPOCH) });
		};
		const receive = (next: string, { old = head, ref = MAIN, session = alice }: { old?: string; ref?: string; session?: Session } = {}) =>
			world.server.receive({ ref, old, next }, session);
		return { ...world, head, commitOn, receive };
	}

	test('every pushed commit is checked, not only the tip', async () => {
		const { head, commitOn, receive, git, server } = await flushed();
		const broken = await commitOn(head, { 'n/a.md': '---\ntitle: [\n---\n' });
		const repaired = await commitOn(broken, { 'n/a.md': note('fixed\n') });
		expect(await receive(repaired)).toMatchObject({ kind: 'refused', code: 'file', reason: 'does not parse', commit: broken, path: 'n/a.md' });
		expect(await git.readRef(MAIN)).toBe(head);
		expect(server.read('n/a.md')).toBe(note('a\n'));
	});

	test('merges, other modes, Epicenter files, other refs and readers are refused', async () => {
		const { head, commitOn, receive } = await flushed();
		const side = await commitOn(head, { 'n/b.md': note('b\n') });
		const merge = await commitOn(side, { 'n/c.md': note('c\n') }, { parents: [side, head] });
		expect(await receive(merge)).toMatchObject({ reason: 'a pushed commit may have only one parent; rebase instead of merging' });
		expect(await receive(await commitOn(head, { 'run.sh': 'echo\n' }, { mode: '100755' }))).toMatchObject({ reason: 'only regular files may be pushed' });
		expect(await receive(await commitOn(head, { '.gitattributes': '* binary\n' }))).toMatchObject({ reason: 'Epicenter owns this file' });
		expect(await receive(await commitOn(head, { 'n/A.md': note('twin\n') }))).toMatchObject({ reason: "'n/a.md' and 'n/A.md' are one path" });
		expect(await receive(side, { ref: 'refs/heads/other' })).toMatchObject({ reason: 'only a fast-forward of refs/heads/main is accepted' });
		expect(await receive(side, { session: { user: 'alice', role: 'reader' } })).toMatchObject({ kind: 'refused', code: 'reader' });
		expect(await receive(side)).toMatchObject({ kind: 'accepted', main: side });
	});
});
