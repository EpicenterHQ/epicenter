/**
 * Design B's server: live history behind one door, as a state machine over
 * ports. It holds no host imports: the `Store` (SQLite) keeps every live
 * commit, text, outcome and the flush journal; `GitObjects` is where
 * flushed history goes; the `Clock` and the `Timer` schedule flushes.
 *
 * Every applied write is a live commit whose id hashes its parent and
 * content (core/commit). `main` only moves forward: a commit on `main`
 * fast-forwards it; otherwise a `merge`-mode commit is merged path by path
 * with `settle`, and a `fast-forward`-mode commit is refused.
 *
 * The door (`admit`): the caller passes a verified session (the user and
 * their role in this repository); the commit's author must be that user and
 * the id must hash the commit; request bytes, files, path length and pushes
 * per member are bounded; every file written, and every merge result, is
 * `admissible` (the predicate the device runs too); and the tree rules hold:
 * paths equal after NFC and case folding are one path, a blob's path is
 * immutable and its bytes present, and a merge may not grow a note past
 * 1 MB or past `BLOCK_CAP` conflict blocks.
 *
 * Idempotency is the commit id: a resend inside the retention window gets
 * its recorded answer, brought up to now; a resend after its answer left
 * the window, but within `seen`, is answered `flushed`. Positions are trees
 * kept for the window, so a catch-up is a tree diff, in pages.
 *
 * Flushing (flush.ts) turns live history into Git commits; a `git push`
 * comes in through `receive` (receive.ts), fast-forward only.
 *
 * Rules the design does not state are marked `RULE:`.
 */
import { defineErrors } from 'wellcrafted/error';
import type { Logger } from 'wellcrafted/logger';
import { type Author, type CommitFile, commitId, type LiveCommit } from '../core/commit.js';
import { findConflicts } from '../core/conflict.js';
import { admissible, fold, isNote, MAX_FILE_BYTES } from '../core/door.js';
import { gitBlobHash } from '../core/hash.js';
import { parsePointer } from '../core/markdown.js';
import { BLOCK_CAP, settle } from '../core/settle.js';
import { first, type SqlDriver } from '../sql.js';
import { createFlusher, type FlushStep } from './flush.js';
import { type GitObjects, MAIN } from './git-store.js';
import { openHistory, type Stored } from './history.js';
import { createReceiver } from './receive.js';

// ============================================================================
// Ports
// ============================================================================

/** The server's durable state: one SQLite database (Bun's, or a Durable Object's). */
export type Store = SqlDriver;
/** Milliseconds since the epoch. */
export type Clock = () => number;
/** Run `run` after `ms` (the host's timer: `setTimeout`, an alarm, or virtual time). */
export type Timer = (ms: number, run: () => void) => void;

// ============================================================================
// Protocol
// ============================================================================

/** A member's role in a repository. */
export type Role = 'owner' | 'writer' | 'reader';

/** Who is asking, as the host verified: the user and their role here, or null when they are not a member. */
export type Session = { user: string; role: Role | null };

/** A path's text on `main`; `deleted` when the path was deleted at some point since the commit or position asked from. */
export type FileState = { path: string; text: string | null; hash: string | null; deleted?: true };

export type PushAnswer =
	/**
	 * The commit is in `main`: fast-forwarded (`main` is the commit) or merged
	 * (`main` is the merge commit). `files` are `main`'s texts for every path
	 * changed since the commit's parent and every path it touched, so the
	 * device can stand on `main` at once. What became of each path is in the
	 * text itself (conflict blocks); the device compares what it sent.
	 */
	| {
			kind: 'applied' | 'merged';
			main: string;
			/** The commits on `main` after the commit's parent, so the device drops those notifications. */
			commits: string[];
			files: FileState[];
	  }
	/**
	 * The commit landed earlier and its answer has left the retention window
	 * (live history is in Git by then). `files` are `main`'s texts for the
	 * paths it touched; the device catches up for the rest.
	 */
	| { kind: 'flushed'; main: string; files: FileState[] }
	/**
	 * Nothing changed: `main` moved and the commit asked to fast-forward, or
	 * the door refused it (`path` names the file at fault). For `main moved`,
	 * `files` are `main`'s texts for the paths the commit touched, so a writer
	 * can redo its change without asking again.
	 */
	| { kind: 'refused'; reason: string; path?: string; main: string; files?: FileState[] }
	/** RULE: the commit's parent is older than the retention window, and the server has no record of it: it cannot say what happened. */
	| { kind: 'outcome-unknown'; main: string };

/** A notification: the new commit, its parents, and the paths changed since its first parent, with hashes. No texts. */
export type Event = { commit: string; parents: string[]; files: { path: string; hash: string | null }[] };

export type CatchUp = {
	/** The commit this catch-up brings the device to. */
	main: string;
	/** Every file, because the server no longer keeps the position. */
	full: boolean;
	/** One page of paths changed since the position, with hashes. */
	files: { path: string; hash: string | null; deleted?: true }[];
	/** The commits walked (on the last page), so the device drops those notifications. */
	commits: string[];
	/** Ask again with `after` for the next page, or null on the last. */
	next: string | null;
};

/** One commit on `main`, for audits: what each path was and became. */
export type Committed = {
	id: string;
	parents: string[];
	author: Author;
	files: { path: string; before: string | null; after: string | null }[];
};

export type Limits = {
	/** Bytes of one push, as JSON. */
	request: number;
	files: number;
	/** Bytes of one path. */
	path: number;
	/** Paths in one catch-up page. */
	page: number;
	/** Pushes per member: a bucket of `burst`, refilled at `rate` a second. */
	burst: number;
	rate: number;
	/** How long positions, commits and answers are kept, in ms. */
	window: number;
	/** How long a landed commit's id is recognized after its answer left the window, in ms. */
	seen: number;
	/** Commits in one `git push`. */
	pushedCommits: number;
};

export const LIMITS: Limits = {
	request: 4 * 1024 * 1024,
	files: 1000,
	path: 512,
	page: 1000,
	burst: 30,
	rate: 10,
	window: 10 * 60_000,
	seen: 24 * 60 * 60_000,
	pushedCommits: 1000,
};

/** When live history is flushed: after `quiet` ms with no push, and at most `busy` ms after the last flush while pushes go on. */
export type Schedule = { quiet: number; busy: number };
export const SCHEDULE: Schedule = { quiet: 60_000, busy: 5 * 60_000 };

const SERVER: Author = { user: 'epicenter', device: 'server' };

const ServerDiagnostic = defineErrors({
	FlushFailed: ({ cause }: { cause: unknown }) => ({ message: 'A scheduled flush failed; it runs again after the next push', cause }),
});
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const bytes = (text: string) => encoder.encode(text).length;

// ============================================================================
// The server
// ============================================================================

export function createServer({
	store,
	git,
	clock = () => Date.now(),
	timer,
	limits: given = {},
	schedule = SCHEDULE,
	onCommit,
	log,
	faults,
}: {
	store: Store;
	git: GitObjects;
	clock?: Clock;
	/** Without a timer, flushes run only when asked (`flush`). */
	timer?: Timer;
	limits?: Partial<Limits>;
	schedule?: Schedule;
	/** Called with every commit that lands on `main`, for audits and tests. */
	onCommit?: (committed: Committed) => void;
	/** Where a scheduled flush that failed is reported. */
	log?: Logger;
	/** Test support: called at each flush step boundary; a throw there is a crash. */
	faults?: (step: FlushStep) => void;
}) {
	const limits = { ...LIMITS, ...given };
	const history = openHistory(store);
	const { trees, meta } = history;
	const listeners = new Set<(event: Event) => void>();
	const time = () => new Date(clock()).toISOString();

	if (meta.get('top') === null) {
		const at = clock();
		history.root({
			id: commitId({ parent: '', mode: 'merge', author: SERVER, time: new Date(at).toISOString(), files: [] }),
			parents: [],
			author: SERVER,
			time: new Date(at).toISOString(),
			at,
			tree: trees.empty,
			blocks: false,
		});
	}

	const main = () => history.main();
	const state = (path: string, from?: number): FileState => {
		const hash = trees.read(main().tree, path);
		const text = hash === null ? null : history.blob(hash);
		return { path, text, hash, ...(from !== undefined && history.deletedSince(from, path) ? { deleted: true as const } : {}) };
	};

	/**
	 * RULE: drop commits older than the window (never `main` itself), and
	 * answers older than the window once `main` at their landing is in Git;
	 * ids are recognized for `seen` longer.
	 */
	function prune() {
		const now = clock();
		const cutoff = now - limits.window;
		history.pruneBefore(Math.min(history.top(), history.newestBefore(cutoff) + 1));
		store.run('DELETE FROM outcomes WHERE at < ? AND place <= ?', [cutoff, meta.number('flushed')]);
		store.run('DELETE FROM seen WHERE at < ?', [now - limits.seen]);
	}

	/** Put a commit on `main`: its snapshot and its notification. */
	function advance(stored: Omit<Stored, 'place' | 'tree' | 'at'>, files: CommitFile[]) {
		const { tree, changed } = history.advance({ ...stored, at: clock() }, files);
		onCommit?.({
			id: stored.id,
			parents: stored.parents,
			author: stored.author,
			files: files.map((f) => ({ path: f.path, before: changed.find((c) => c.path === f.path)?.before ?? f.text, after: f.text })),
		});
		const event: Event = { commit: stored.id, parents: stored.parents, files: changed.map(({ path }) => ({ path, hash: trees.read(tree, path) })) };
		pending.push(event);
	}
	/** Notifications wait for their transaction to commit. */
	let pending: Event[] = [];
	const notify = () => {
		const events = pending;
		pending = [];
		for (const event of events) for (const listener of listeners) listener(event);
	};

	/** The door: who may push this, and is it something the repository may hold? */
	function admit(commit: LiveCommit, session: Session | undefined, rate: boolean): PushAnswer | null {
		const head = main().id;
		const refuse = (reason: string, path?: string): PushAnswer => ({ kind: 'refused', reason, main: head, ...(path === undefined ? {} : { path }) });
		if (session === undefined) return refuse('no session');
		if (session.role === null) return refuse('not a member');
		if (session.role === 'reader') return refuse('a reader may not write');
		const now = clock();
		const bucket = first<{ tokens: number; at: number }>(store, 'SELECT tokens, at FROM buckets WHERE user = ?', [session.user]) ?? { tokens: limits.burst, at: now };
		const tokens = Math.min(limits.burst, bucket.tokens + ((now - bucket.at) / 1000) * limits.rate);
		if (rate && tokens < 1) {
			store.run('INSERT OR REPLACE INTO buckets (user, tokens, at) VALUES (?, ?, ?)', [session.user, tokens, now]);
			return refuse('rate');
		}
		store.run('INSERT OR REPLACE INTO buckets (user, tokens, at) VALUES (?, ?, ?)', [session.user, rate ? tokens - 1 : tokens, now]);
		if (commit.parent === undefined) return refuse('no parent');
		// The id is checked before any recorded outcome is read, so a replayed id with other files is refused.
		if (commitId(commit) !== commit.id) return refuse('the id is not the hash of the commit');
		if (commit.author.user !== session.user) return refuse('the author is not the session');
		if (bytes(JSON.stringify(commit)) > limits.request) return refuse('request too large');
		if (commit.files.length > limits.files) return refuse('too many files');
		const paths = new Set<string>();
		const tree = main().tree;
		for (const file of commit.files) {
			if (bytes(file.path) > limits.path) return refuse('bad path', file.path);
			if (paths.has(fold(file.path))) return refuse('a path is named twice', file.path);
			paths.add(fold(file.path));
			// D4 and the door's content rules: the same predicate the device runs.
			const reason = admissible(file.path, file.text);
			if (reason !== null) return refuse(reason, file.path);
			const pointer = file.text === null ? null : parsePointer(file.text);
			if (pointer === null) continue;
			if (first(store, 'SELECT 1 FROM uploads WHERE oid = ?', [pointer.oid]) === undefined) return refuse("the blob's bytes are missing", file.path);
			const there = history.textIn(tree, history.spelling(file.path) ?? file.path);
			if (there !== null && there !== file.text) return refuse("a blob's path is immutable", file.path);
		}
		return null;
	}

	/** Fill an answer's files (everything changed since the commit's parent, and what it touched) and keep it for a resend. */
	function record(commit: LiveCommit, kind: 'applied' | 'merged', mainId: string, from: number, spelled: string[]): PushAnswer {
		const touched = [...new Set([...commit.files.map((f) => f.path), ...spelled])];
		const paths = new Set([...trees.diff(history.at(from).tree, main().tree), ...touched]);
		const answer: PushAnswer = { kind, main: mainId, commits: history.idsAfter(from), files: [...paths].sort().map((path) => state(path, from)) };
		const now = clock();
		store.run('INSERT OR REPLACE INTO outcomes (id, at, place, answer, paths) VALUES (?, ?, ?, ?, ?)', [commit.id, now, history.top(), JSON.stringify(answer), JSON.stringify(touched)]);
		store.run('INSERT OR REPLACE INTO seen (id, at, paths) VALUES (?, ?, ?)', [commit.id, now, JSON.stringify(touched)]);
		return answer;
	}

	function pushInside(commit: LiveCommit, session: Session | undefined, rate: boolean): PushAnswer {
		prune();
		const refusal = admit(commit, session, rate);
		if (refusal !== null) return refusal;
		const recorded = first<{ answer: string; paths: string }>(store, 'SELECT answer, paths FROM outcomes WHERE id = ?', [commit.id]);
		if (recorded !== undefined) {
			// RULE: a resend gets its verdict brought up to now: `main` and every file changed since its parent, as they are now.
			const answer = JSON.parse(recorded.answer) as PushAnswer;
			const from = history.placeOf(commit.parent);
			if (from === undefined || (answer.kind !== 'applied' && answer.kind !== 'merged')) return answer;
			const paths = new Set([...trees.diff(history.at(from).tree, main().tree), ...(JSON.parse(recorded.paths) as string[])]);
			return { ...answer, main: main().id, commits: history.idsAfter(from), files: [...paths].sort().map((path) => state(path, from)) };
		}
		const seen = first<{ paths: string }>(store, 'SELECT paths FROM seen WHERE id = ?', [commit.id]);
		if (seen !== undefined) return { kind: 'flushed', main: main().id, files: (JSON.parse(seen.paths) as string[]).map((path) => state(path)) };
		// RULE: paths equal after NFC and case folding are one path: a write goes to the spelling `main` has.
		const spelled = commit.files.map((f) => f.path);
		commit = { ...commit, files: commit.files.map((f) => ({ ...f, path: history.spelling(f.path) ?? f.path })) };
		const head = main();
		const from = history.placeOf(commit.parent);
		if (from === undefined) return { kind: 'outcome-unknown', main: head.id };
		const forward = commit.parent === head.id;
		const refuse = (reason: string, path?: string): PushAnswer => ({ kind: 'refused', reason, main: head.id, ...(path === undefined ? {} : { path }) });
		if (commit.mode === 'fast-forward' && !forward) return { kind: 'refused', reason: 'main moved', main: head.id, files: commit.files.map((f) => state(f.path, from)) };
		const author = { user: session?.user ?? commit.author.user, device: commit.author.device };
		if (forward) {
			advance({ id: commit.id, parents: [commit.parent], author, time: commit.time, blocks: false }, commit.files);
			return record(commit, 'applied', commit.id, from, spelled);
		}

		// Merge where the commit's history and main's meet, path by path.
		const parentTree = history.at(from).tree;
		const out: CommitFile[] = [];
		let blocks = false;
		for (const file of commit.files) {
			const ours = history.textIn(head.tree, file.path);
			const who = history.lastAuthor(file.path) ?? SERVER;
			const settled = settle(history.textIn(parentTree, file.path), ours, file.text, {
				deletedSince: history.deletedSince(from, file.path),
				parties: { current: { author: `${who.user}/${who.device}`, time: head.time }, incoming: { author: `${author.user}/${author.device}`, time: commit.time } },
			});
			if (settled.text !== null && isNote(file.path)) {
				// RULE, the one named exception: a merge that would grow a note past 1 MB is refused, so its writer holds it.
				if (bytes(settled.text) > MAX_FILE_BYTES) return refuse('the merge would grow the note past 1 MB', file.path);
				// RULE: a merge may not leave a note with more than BLOCK_CAP conflict blocks (a stale-parent flood); its writer holds it, or an agent redoes it.
				if (findConflicts(settled.text).length > Math.max(BLOCK_CAP, ours === null ? 0 : findConflicts(ours).length))
					return refuse('the note has too many conflict blocks', file.path);
			}
			// Every merge result passes the door too.
			const reason = admissible(file.path, settled.text);
			if (reason !== null) return refuse(reason, file.path);
			out.push({ path: file.path, text: settled.text });
			if (settled.disposition === 'conflict' || settled.disposition === 'different-note') blocks = true;
		}
		// The device's commit stays a real commit: the merge's second parent.
		const mergeTime = time();
		const id = commitId({ parent: `${head.id} ${commit.id}`, mode: 'merge', author: SERVER, time: mergeTime, files: out });
		history.keepSide(
			{
				id: commit.id,
				parents: [commit.parent],
				author,
				time: commit.time,
				at: clock(),
				tree: trees.update(parentTree, commit.files.map((f) => [f.path.split('/'), f.text === null ? null : gitBlobHash(f.text)])),
				blocks: false,
			},
			id,
			commit.files,
		);
		advance({ id, parents: [head.id, commit.id], author, time: mergeTime, blocks }, out);
		return record(commit, 'merged', id, from, spelled);
	}

	// ------------------------------------------------------------------------
	// Flush scheduling
	// ------------------------------------------------------------------------

	let lastPush = 0;
	let lastFlush = clock();
	const flusher = createFlusher({ history, store, git, faults });
	const receiver = createReceiver({ history, store, git, clock, limits, flusher, apply: (commit, session) => push(commit, session, { rate: false }) });

	function flushInBackground() {
		lastFlush = clock();
		flusher.flush().catch((cause: unknown) => log?.error(ServerDiagnostic.FlushFailed({ cause })));
	}
	/** The quiet-time trigger: `quiet` after the last push with none since, or `busy` after the last flush. */
	function pushed() {
		if (timer === undefined) return;
		lastPush = clock();
		if (lastPush - lastFlush >= schedule.busy) flushInBackground();
		const at = lastPush;
		timer(schedule.quiet, () => {
			if (lastPush === at) flushInBackground();
		});
	}

	/** Take a live commit: fast-forward `main`, merge it in, or refuse it; a resend gets its recorded outcome. */
	function push(commit: LiveCommit, session?: Session, { rate = true } = {}): PushAnswer {
		pending = [];
		const answer = store.transaction(() => pushInside(commit, session, rate));
		if (answer.kind === 'applied' || answer.kind === 'merged') {
			notify();
			pushed();
		} else pending = [];
		return answer;
	}

	return {
		/** The current `main`. */
		main: () => main().id,
		read: (path: string) => history.textIn(main().tree, path),
		/** Every path and text on `main`, sorted. */
		snapshot: () =>
			new Map(
				trees
					.diff(trees.empty, main().tree)
					.sort()
					.map((path) => [path, history.textIn(main().tree, path) as string]),
			),
		/** Take a live commit: fast-forward `main`, merge it in, or refuse it; a resend gets its recorded outcome. */
		push: (commit: LiveCommit, session?: Session) => push(commit, session),
		/**
		 * What changed on `main` since `from`, as a tree diff, plus `paths` the
		 * device names, one page at a time: a later page names `to` (the commit
		 * the first page answered) and `after` (the last path it got). A
		 * position outside the window gets every file.
		 */
		catchUp({ from, paths = [], to, after }: { from: string | null; paths?: string[]; to?: string; after?: string }): CatchUp {
			store.transaction(prune);
			const toPlace = to === undefined ? undefined : history.placeOf(to);
			const target = toPlace === undefined ? main() : history.at(toPlace);
			const index = from === null ? undefined : history.placeOf(from);
			const full = index === undefined;
			const all = new Set(full ? trees.diff(trees.empty, target.tree) : trees.diff(history.at(index).tree, target.tree));
			for (const path of paths) all.add(path);
			const sorted = [...all].sort().filter((path) => after === undefined || path > after);
			const page = sorted.slice(0, limits.page);
			const last = page.length === sorted.length;
			return {
				main: target.id,
				full,
				files: page.map((path) => {
					const hash = trees.read(target.tree, path);
					return { path, hash, ...(!full && history.deletedSince(index, path) ? { deleted: true as const } : {}) };
				}),
				commits: last && !full ? history.idsAfter(index, target.place ?? history.top()) : [],
				next: last ? null : (page.at(-1) ?? null),
			};
		},
		/** Texts by hash: a content-addressed read, never stale. */
		fetch: (hashes: string[]) =>
			Object.fromEntries(
				hashes.flatMap((hash) => {
					const text = history.blob(hash);
					return text === null ? [] : [[hash, text]];
				}),
			),
		/** Follow the change feed: one event per commit on `main`. */
		subscribe(listener: (event: Event) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** LFS bytes arrive (the upload track): pointers to them may now be written. */
		upload: (oid: string) => store.run('INSERT OR IGNORE INTO uploads (oid) VALUES (?)', [oid]),
		/**
		 * Flush live history into Git now (`epicenter pull`, `git fetch`), or
		 * finish the flush a crash interrupted: one Git commit at each merge
		 * that wrote a conflict block, and one at `main`.
		 */
		flush: () => {
			lastFlush = clock();
			return flusher.flush();
		},
		/** Resolves once no flush or Git push is in progress. */
		idle: () => flusher.idle(),
		/**
		 * Take a `git push` of `refs/heads/main` whose objects are already in
		 * Git: fast-forward only (D1). Refused because live edits are not in
		 * Git yet, it starts a flush, so the client can fetch and retry.
		 */
		async receive(...args: Parameters<typeof receiver.receive>) {
			const answer = await receiver.receive(...args);
			if (answer.kind === 'refused' && answer.reason.startsWith('live edits')) flushInBackground();
			return answer;
		},
		/** Live commits made and kept, answers kept, and flushes, for tests and the benchmark. */
		history: () => ({
			commits: meta.number('made'),
			kept: history.top() - history.offset() + 1,
			outcomes: first<{ n: number }>(store, 'SELECT COUNT(*) AS n FROM outcomes')?.n ?? 0,
			bytes: first<{ n: number }>(store, 'SELECT COALESCE(SUM(LENGTH(text)), 0) AS n FROM blobs')?.n ?? 0,
			flushes: first<{ n: number }>(store, 'SELECT COUNT(*) AS n FROM flushes')?.n ?? 0,
		}),
	};
}
export type Server = ReturnType<typeof createServer>;

/**
 * Open a repository's server over its Store and Git: a Store that holds no
 * history yet starts from Git's `main` (its texts become the first live
 * tree), and a flush a crash interrupted is finished before it answers.
 */
export async function openServer(options: Parameters<typeof createServer>[0]) {
	const { store, git, clock = () => Date.now() } = options;
	const history = openHistory(store);
	if (history.meta.get('top') === null) {
		const head = await git.readRef(MAIN);
		const commit = head === null ? null : await git.readCommit(head);
		if (head !== null && commit !== null) {
			const changes: [string[], string][] = [];
			for (const [path, entry] of await git.readTree(commit.tree)) {
				if (path === '.gitattributes') continue;
				const bytes = await git.readBlob(entry.oid);
				if (bytes === null) throw new Error(`Git's main names a missing blob at ${path}`);
				changes.push([path.split('/'), history.keep(decoder.decode(bytes))]);
			}
			const at = clock();
			const time = new Date(at).toISOString();
			store.transaction(() => {
				history.root({
					id: commitId({ parent: head, mode: 'merge', author: SERVER, time, files: [] }),
					parents: [],
					author: SERVER,
					time,
					at,
					tree: history.trees.update(history.trees.empty, changes),
					blocks: false,
				});
				history.meta.set('git_head', head);
				history.meta.set('git_tree', commit.tree);
			});
		}
	}
	const server = createServer(options);
	await server.flush();
	return server;
}
