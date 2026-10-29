/**
 * Server Tests
 *
 * The server's promises at its door, one at a time, over a SQLite Store and
 * an in-memory Git; the replica-driven scenario, people and property tests
 * in src/sim/ cover how they combine.
 *
 * Key behaviors:
 * - merging: one clash is one block, however many of a person's commits follow it on a stale parent
 * - admission: a session is required, a reader or a stranger may not write, the author is the session's user, and each limit holds; a commit on a stale parent is merged, whoever wrote it, never refused because main moved
 * - idempotency: a resend gets its answer brought up to now; after the window, `flushed`; a parent past the window with no record, `outcome-unknown`
 * - catch-up is a tree diff in pages; the change feed names each commit, its parents and changed paths with hashes
 * - a fresh instance over the same Store answers as the first did
 * - the Git receive path checks every pushed commit and refuses merges, broken notes, other file modes, Epicenter's files and other refs
 * - blobs: a pointer is admitted only once its bytes are here at its size; a blob write lands only over the blob its writer saw (compare-and-swap); the blob limit and the quota refuse uploads; a `git push` may replace, move or delete a binary whose bytes are here
 */
import { describe, expect, test } from 'bun:test';
import { openBunSqlite } from '../bun/sqlite.js';
import { type CommitFile, commitId, type LiveCommit } from '../core/commit.js';
import { findConflicts } from '../core/conflict.js';
import { gitBlobHash } from '../core/hash.js';
import { writePointer } from '../core/markdown.js';
import { POINTER_REFUSALS } from '../core/settle.js';
import { type GitObjects, MAIN } from './git-store.js';
import { createMemoryGitStore } from './memory-git.js';
import { createLogger, memorySink } from 'wellcrafted/logger';
import { createServer, type Event, type Limits, LIMITS, openServer, SCHEDULE, type Server, type Session } from './server.js';

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
	const body = { parent, author: { user, device: 'laptop' }, time, files };
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

	test('a commit on a stale parent is merged, whoever wrote it, never refused because main moved', () => {
		const { server } = setup();
		const base = server.main();
		expect(server.push(make(server, [{ path: 'n/a.md', text: note('one\n') }]), alice).kind).toBe('applied');
		const body = { parent: base, author: { user: 'alice', device: 'agent' }, time: new Date(EPOCH).toISOString(), files: [{ path: 'n/b.md', text: note('two\n') }] };
		expect(server.push({ id: commitId(body), ...body }, alice)).toMatchObject({ kind: 'merged' });
		expect([server.read('n/a.md'), server.read('n/b.md')]).toEqual([note('one\n'), note('two\n')]);
	});
});

describe('merging', () => {
	test("one clash is one block: a person's second commit on a stale parent, after main already holds the block, continues it", () => {
		const { server } = setup();
		const bob: Session = { user: 'bob', role: 'writer' };
		const start = server.main();
		expect(server.push(make(server, [{ path: 'n/a.md', text: note('one\n') }], { parent: start }), alice).kind).toBe('applied');
		const base = server.main();
		expect(server.push(make(server, [{ path: 'n/a.md', text: note('oneA\n') }], { parent: base }), alice).kind).toBe('applied');
		const afterK1 = server.main();
		// Bob, from before Alice's edit, changes the same line: the server merges it into one block.
		const merged = server.push(make(server, [{ path: 'n/a.md', text: note('oneR\n') }], { user: 'bob', parent: base }), bob);
		expect(merged.kind).toBe('merged');
		// Alice has not heard of it: her next commit's parent is her own last one.
		const again = server.push(make(server, [{ path: 'n/a.md', text: note('oneAB\n') }], { parent: afterK1, time: new Date(EPOCH + 1).toISOString() }), alice);
		expect(again.kind).toBe('merged');
		const text = again.kind === 'merged' ? (again.files.find((file) => file.path === 'n/a.md')?.text ?? '') : '';
		expect(findConflicts(text)).toMatchObject([{ current: 'oneAB\n', base: 'one\n', incoming: 'oneR\n' }]);
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

	test("one catch-up's pages share one tree diff, so paging through many paths costs about one diff", () => {
		const { server } = setup({ request: 64 * 1024 * 1024, files: 50_000, page: 100 });
		server.push(make(server, Array.from({ length: 20_000 }, (_, i) => ({ path: `n/${Math.floor(i / 100)}/${i}.md`, text: note(`${i}\n`) }))), alice);
		const start = performance.now();
		let page = server.catchUp({ from: null });
		let pages = 1;
		while (page.next !== null) {
			page = server.catchUp({ from: null, to: page.main, after: page.next });
			pages++;
		}
		expect(pages).toBe(200);
		// A diff of every page took about 3 ms a page here (600 ms in all); one diff and 200 slices take a few.
		expect(performance.now() - start).toBeLessThan(150);
	});

	test('reads are admitted per member: a bucket of `readBurst`, refilled at `readRate` a second', () => {
		const { server, clock } = setup({ readBurst: 2, readRate: 1 });
		expect([server.admitRead(alice), server.admitRead(alice), server.admitRead(alice)]).toEqual([true, true, false]);
		expect(server.admitRead({ user: 'bob', role: 'reader' })).toBe(true);
		clock.now += 1_000;
		expect(server.admitRead(alice)).toBe(true);
		// A text by hash costs a small part of a read, so a large first sync's texts fit the burst.
		clock.now += 2_000;
		for (let i = 0; i < 400; i++) expect(server.admitRead(alice, 'text')).toBe(true);
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

describe('flush scheduling', () => {
	/** An alarm that records what the server asks of it, as a Durable Object's one alarm would hold it. */
	function recordingAlarm() {
		const alarm = { at: null as number | null, fire: () => {} };
		return {
			alarm,
			port: (due: () => void) => {
				alarm.fire = due;
				return {
					schedule: (at: number) => {
						alarm.at = at;
					},
					cancel: () => {
						alarm.at = null;
					},
				};
			},
		};
	}

	test('one alarm, replaced on every push: quiet after the last push, at most busy after the last flush, cancelled once flushed', async () => {
		const clock = { now: EPOCH };
		const store = openBunSqlite();
		const git = createMemoryGitStore();
		const { alarm, port } = recordingAlarm();
		const server = createServer({ store, git, clock: () => clock.now, alarm: port });
		expect(alarm.at).toBeNull();
		server.push(make(server, [{ path: 'n/a.md', text: note('one\n') }]), alice);
		expect(alarm.at).toBe(EPOCH + SCHEDULE.quiet);
		// Typing goes on every 30 s: the alarm moves with it, until the busy bound holds it.
		for (let i = 1; i <= 9; i++) {
			clock.now = EPOCH + i * 30_000;
			server.push(make(server, [{ path: 'n/a.md', text: note(`one ${i}\n`) }]), alice);
			expect(alarm.at).toBe(Math.min(clock.now + SCHEDULE.quiet, EPOCH + SCHEDULE.busy));
		}
		// Fired early (a host may), it flushes nothing and keeps the time.
		alarm.fire();
		await server.idle();
		expect(server.history().flushes).toBe(0);
		expect(alarm.at).toBe(EPOCH + SCHEDULE.busy);
		clock.now = EPOCH + SCHEDULE.busy;
		alarm.fire();
		await server.idle();
		expect(server.history().flushes).toBe(1);
		expect(alarm.at).toBeNull();
	});

	test('a push that a restart left unflushed is scheduled again when the server opens', async () => {
		const clock = { now: EPOCH };
		const store = openBunSqlite();
		const git = createMemoryGitStore();
		const first = createServer({ store, git, clock: () => clock.now, alarm: recordingAlarm().port });
		first.push(make(first, [{ path: 'n/a.md', text: note('one\n') }]), alice);
		clock.now += 10_000;
		const { alarm, port } = recordingAlarm();
		createServer({ store, git, clock: () => clock.now, alarm: port });
		expect(alarm.at).toBe(EPOCH + SCHEDULE.quiet);
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

describe('blobs', () => {
	const a = { oid: 'a'.repeat(64), size: 3 };
	const b = { oid: 'b'.repeat(64), size: 5 };
	const c = { oid: 'c'.repeat(64), size: 7 };
	const path = 'recordings/r1.webm';

	test('a pointer is admitted only once its bytes are on the server, at its size', () => {
		const { server } = setup();
		expect(server.push(make(server, [{ path, text: writePointer(a) }]), alice)).toMatchObject({ kind: 'refused', code: 'blob-missing', path });
		server.upload(a.oid, a.size + 1);
		expect(server.push(make(server, [{ path, text: writePointer(a) }]), alice)).toMatchObject({ kind: 'refused', code: 'blob-missing' });
		const { server: other } = setup();
		other.upload(a.oid, a.size);
		expect(other.uploaded(a.oid)).toBe(a.size);
		expect(other.push(make(other, [{ path, text: writePointer(a) }]), alice)).toMatchObject({ kind: 'applied' });
		expect(other.read(path)).toBe(writePointer(a));
	});

	function landed() {
		const world = setup();
		for (const p of [a, b, c]) world.server.upload(p.oid, p.size);
		return world;
	}

	test('two creates at one path: the first lands, the second is refused with why; the same bytes twice are one file', () => {
		const { server } = landed();
		const parent = server.main();
		expect(server.push(make(server, [{ path, text: writePointer(a) }], { parent }), alice).kind).toBe('applied');
		expect(server.push(make(server, [{ path, text: writePointer(b) }], { parent }), alice)).toMatchObject({ kind: 'refused', code: 'blob-changed', reason: POINTER_REFUSALS.added, path });
		expect(server.push(make(server, [{ path, text: writePointer(a) }], { parent, time: new Date(EPOCH + 1).toISOString() }), alice).kind).toBe('merged');
		expect(server.read(path)).toBe(writePointer(a));
	});

	test('a stale replace is refused; a stale delete leaves the file; a fresh one of each lands', () => {
		const { server } = landed();
		server.push(make(server, [{ path, text: writePointer(a) }]), alice);
		const saw = server.main();
		server.push(make(server, [{ path, text: writePointer(b) }]), alice);
		expect(server.push(make(server, [{ path, text: writePointer(c) }], { parent: saw }), alice)).toMatchObject({ kind: 'refused', code: 'blob-changed', reason: POINTER_REFUSALS.changed });
		expect(server.push(make(server, [{ path, text: null }], { parent: saw }), alice).kind).toBe('merged');
		expect(server.read(path)).toBe(writePointer(b));
		expect(server.push(make(server, [{ path, text: writePointer(c) }]), alice).kind).toBe('applied');
		expect(server.push(make(server, [{ path, text: null }]), alice).kind).toBe('applied');
		expect(server.read(path)).toBeNull();
	});

	test('a delete then a create at one path are two writes that each pass', () => {
		const { server } = landed();
		server.push(make(server, [{ path, text: writePointer(a) }]), alice);
		const saw = server.main();
		server.push(make(server, [{ path, text: null }], { parent: saw }), alice);
		expect(server.push(make(server, [{ path, text: writePointer(b) }]), alice).kind).toBe('applied');
		expect(server.read(path)).toBe(writePointer(b));
	});

	test('the hello announces the blob limit; an upload past it, or past the quota, is refused', () => {
		const { server } = setup({ blob: 10, quota: 12 });
		expect(server.sizing()).toMatchObject({ blob: 10 });
		expect(server.uploadRefusal(a.oid, 11)).toBe('too-large');
		expect(server.uploadRefusal(a.oid, 7)).toBeNull();
		server.upload(a.oid, 7);
		expect(server.uploadRefusal(a.oid, 7)).toBeNull();
		expect(server.uploadRefusal(b.oid, 5)).toBeNull();
		expect(server.uploadRefusal(b.oid, 6)).toBe('over-quota');
		expect(setup().server.sizing()).toMatchObject({ blob: 2 * 1024 ** 3 });
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

	test('a flush that finds Git moved from outside says so: the server state, the log and the receiver; putting main back resumes it', async () => {
		const { server, git, head, commitOn, store } = await flushed();
		const { sink, events } = memorySink();
		const logged = createServer({ store, git, clock: () => EPOCH, log: createLogger('test', sink) });
		const outside = await commitOn(head, { 'n/x.md': note('outside\n') });
		await git.updateRef(MAIN, outside, head);
		logged.push(make(logged, [{ path: 'n/a.md', text: note('two\n') }]), alice);
		expect(await logged.flush()).toMatchObject({ kind: 'diverged', main: outside, expected: head });
		expect(events.map((event) => [event.level, event.message])).toContainEqual(['error', "Git's main moved outside Epicenter; flushes stop until an operator puts it back"]);
		expect(logged.state()).toEqual({ kind: 'diverged', expected: head });
		expect(await logged.receive({ ref: MAIN, old: outside, next: outside }, alice)).toMatchObject({ kind: 'refused', code: 'diverged' });
		// The operator's recovery: Git's main back at the commit Epicenter expects; the next flush finishes.
		await git.updateRef(MAIN, head, outside);
		expect(await logged.flush()).toMatchObject({ kind: 'flushed' });
		expect(logged.state()).toEqual({ kind: 'live' });
		expect(server.read('n/a.md')).toBe(note('two\n'));
	});

	test('a push the live door would refuse is refused before Git moves, so a published main is never rewound', async () => {
		const world = setup({ files: 2 });
		world.server.push(make(world.server, [{ path: 'n/a.md', text: note('a\n') }]), alice);
		await world.server.flush();
		const head = (await world.git.readRef(MAIN)) as string;
		const tree = await world.git.readTree((await world.git.readCommit(head))?.tree ?? '');
		for (const name of ['b', 'c', 'd']) tree.set(`n/${name}.md`, { mode: '100644', oid: await world.git.writeBlob(new TextEncoder().encode(note(`${name}\n`))) });
		const next = await world.git.writeCommit({ tree: await world.git.writeTree(tree), parents: [head], message: 'three\n', author: { name: 'alice', email: 'a@b' }, at: new Date(EPOCH) });
		const moves: string[] = [];
		const watched: GitObjects = {
			...world.git,
			updateRef: async (name, to, expected) => {
				if (name === MAIN) moves.push(to);
				return world.git.updateRef(name, to, expected);
			},
		};
		const server = createServer({ store: world.store, git: watched, clock: () => EPOCH, limits: { files: 2 } });
		expect(await server.receive({ ref: MAIN, old: head, next }, alice)).toMatchObject({ kind: 'refused', code: 'live', reason: 'too many files' });
		expect(moves).toEqual([]);
		expect(await world.git.readRef(MAIN)).toBe(head);
	});

	test('a live commit that lands while a push is checked refuses the push as unflushed (no merge), and Git does not move', async () => {
		const world = setup();
		world.server.push(make(world.server, [{ path: 'n/a.md', text: note('a\n') }]), alice);
		await world.server.flush();
		const head = (await world.git.readRef(MAIN)) as string;
		const tree = await world.git.readTree((await world.git.readCommit(head))?.tree ?? '');
		tree.set('n/b.md', { mode: '100644', oid: await world.git.writeBlob(new TextEncoder().encode(note('b\n'))) });
		const next = await world.git.writeCommit({ tree: await world.git.writeTree(tree), parents: [head], message: 'b\n', author: { name: 'alice', email: 'a@b' }, at: new Date(EPOCH) });
		let server: Server | undefined;
		let landed = false;
		const racing: GitObjects = {
			...world.git,
			readBlob: async (oid) => {
				if (!landed && server !== undefined) {
					landed = true;
					expect(server.push(make(server, [{ path: 'n/c.md', text: note('c\n') }]), alice).kind).toBe('applied');
				}
				return world.git.readBlob(oid);
			},
		};
		server = createServer({ store: world.store, git: racing, clock: () => EPOCH });
		expect(await server.receive({ ref: MAIN, old: head, next }, alice)).toMatchObject({ kind: 'refused', code: 'unflushed' });
		expect(await world.git.readRef(MAIN)).toBe(head);
		expect(server.read('n/b.md')).toBeNull();
		expect(server.read('n/c.md')).toBe(note('c\n'));
	});

	test('a push is journaled like a flush: a crash after Git moved is finished by a fresh instance', async () => {
		const world = setup();
		world.server.push(make(world.server, [{ path: 'n/a.md', text: note('a\n') }]), alice);
		await world.server.flush();
		const head = (await world.git.readRef(MAIN)) as string;
		const tree = await world.git.readTree((await world.git.readCommit(head))?.tree ?? '');
		tree.set('n/b.md', { mode: '100644', oid: await world.git.writeBlob(new TextEncoder().encode(note('b\n'))) });
		const next = await world.git.writeCommit({ tree: await world.git.writeTree(tree), parents: [head], message: 'b\n', author: { name: 'alice', email: 'a@b' }, at: new Date(EPOCH) });
		const crashing = createServer({
			store: world.store,
			git: world.git,
			clock: () => EPOCH,
			faults: (step) => {
				if (step === 'main-moved') throw new Error('crash');
			},
		});
		await expect(crashing.receive({ ref: MAIN, old: head, next }, alice)).rejects.toThrow('crash');
		expect(await world.git.readRef(MAIN)).toBe(next);
		const fresh = await openServer({ store: world.store, git: world.git, clock: () => EPOCH });
		expect(fresh.state()).toEqual({ kind: 'live' });
		expect(fresh.read('n/b.md')).toBe(note('b\n'));
		// Git holds everything live: the next push builds on it.
		const after = await world.git.readTree((await world.git.readCommit(next))?.tree ?? '');
		after.set('n/c.md', { mode: '100644', oid: await world.git.writeBlob(new TextEncoder().encode(note('c\n'))) });
		const third = await world.git.writeCommit({ tree: await world.git.writeTree(after), parents: [next], message: 'c\n', author: { name: 'alice', email: 'a@b' }, at: new Date(EPOCH) });
		expect(await fresh.receive({ ref: MAIN, old: next, next: third }, alice)).toMatchObject({ kind: 'accepted', main: third });
		expect(await fresh.flush()).toEqual({ kind: 'nothing' });
		// The next flush diffs against the tree Git holds: its commit names the one path a live edit changed.
		fresh.push(make(fresh, [{ path: 'n/a.md', text: note('a2\n') }]), alice);
		expect(await fresh.flush()).toMatchObject({ kind: 'flushed', commits: [{ message: expect.stringMatching(/^Edit n\/a\.md\n/) }] });
	});

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

	test('a push may add, replace, move and delete a binary whose bytes are here; one whose bytes are missing is refused', async () => {
		const { head, commitOn, receive, server } = await flushed();
		const a = { oid: 'a'.repeat(64), size: 3 };
		const b = { oid: 'b'.repeat(64), size: 5 };
		server.upload(a.oid, a.size);
		const added = await commitOn(head, { 'audio/r.wav': writePointer(a) });
		const replaced = await commitOn(added, { 'audio/r.wav': writePointer(b) });
		expect(await receive(replaced)).toMatchObject({ kind: 'refused', code: 'file', reason: "the file's bytes are not on the server", commit: replaced, path: 'audio/r.wav' });
		server.upload(b.oid, b.size);
		const moved = await commitOn(replaced, { 'audio/r.wav': null, 'audio/moved.wav': writePointer(b) });
		const deleted = await commitOn(moved, { 'audio/moved.wav': null });
		expect(await receive(deleted)).toMatchObject({ kind: 'accepted', main: deleted });
		expect(server.read('audio/r.wav')).toBeNull();
		expect(server.read('audio/moved.wav')).toBeNull();
		expect(await receive(await commitOn(deleted, { 'audio/plain.txt': 'not a pointer\n' }), { old: deleted })).toMatchObject({ reason: 'a file other than a note goes through Git LFS' });
	});
});
