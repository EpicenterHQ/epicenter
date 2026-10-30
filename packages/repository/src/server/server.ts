/**
 * The repository's server: live history behind one door, as a state machine over
 * ports. It holds no host imports: the `Store` (SQLite) keeps every live
 * commit, text, outcome and the flush journal; `GitObjects` is where
 * flushed history goes; the `Clock` and the host's one `Alarm` schedule
 * flushes.
 *
 * Every applied write is a live commit whose id hashes its parent and
 * content (core/commit). `main` only moves forward: a commit on `main`
 * becomes `main`; any other is merged where its history and `main`'s meet,
 * path by path, whoever wrote it: a note with `settle`, a blob by
 * compare-and-swap (`settlePointer`).
 *
 * The door (`admit`): the caller passes a verified session (the user and
 * their role in this repository); the commit's author must be that user and
 * the id must hash the commit; request bytes, files, path length and pushes
 * per member are bounded; every file written, and every merge result, is
 * `admissible` (the predicate the device runs too); and the tree rules hold:
 * paths equal after NFC and case folding are one path, a name is a file or
 * a folder, never both (core/tree's `collision`, against the commit's own
 * parent and against what `main` would become), a pointer's bytes
 * are present at its size (`uploads`, written only once the bytes are
 * durable), a blob write lands only over the blob its writer saw (the
 * commit's parent: `settlePointer`, compare-and-swap, never a merge), and
 * a merge may not grow a note past
 * 1 MB or past `BLOCK_CAP` conflict blocks (the two named exceptions to
 * "a person is never refused because of someone else").
 *
 * Idempotency is the commit id: a resend inside the retention window gets
 * its recorded answer, brought up to now; a resend after its answer left
 * the window, but within `seen`, is answered `flushed`. Positions are trees
 * kept for the window, so a catch-up is a tree diff, in pages.
 *
 * Flushing (flush.ts) turns live history into Git commits; a `git push`
 * comes in through `receive` (receive.ts), on Git's `main`, and merges into
 * live `main` like any commit.
 *
 * Rules the design does not state are marked `RULE:`.
 */
import { defineErrors } from 'wellcrafted/error';
import type { Logger } from 'wellcrafted/logger';
import { type Author, type CommitFile, commitId, type LiveCommit } from '../core/commit.js';
import { findConflicts } from '../core/conflict.js';
import { admissible, fold, isNote, MAX_BLOB_BYTES, MAX_FILE_BYTES } from '../core/door.js';
import { gitBlobHash } from '../core/hash.js';
import { parsePointer } from '../core/markdown.js';
import { BLOCK_CAP, conflictSibling, settle, settlePointer } from '../core/settle.js';
import { COLLISIONS } from '../core/tree.js';
import { first, type SqlDriver } from '../sql.js';
import { createFlusher, type FlushStep, type Join } from './flush.js';
import { type GitObjects, MAIN } from './git-store.js';
import { holdsBlob, openHistory, type Stored } from './history.js';
import { createReceiver, DIVERGED } from './receive.js';

// ============================================================================
// Ports
// ============================================================================

/** The server's durable state: one SQLite database (Bun's, or a Durable Object's). */
export type Store = SqlDriver;
/** Milliseconds since the epoch. */
export type Clock = () => number;
/**
 * The host's one replaceable alarm (a Durable Object's alarm, `setTimeout`,
 * or virtual time), made for the server's `due` entry point: `schedule(at)`
 * replaces any time set before (ms since the epoch, by the server's clock;
 * a time past fires at once), and `cancel` clears it. A host whose alarm
 * fires on its own (a Durable Object's `alarm()` handler) ignores `due` and
 * calls `server.due()` itself.
 */
export type Alarm = { schedule(at: number): void; cancel(): void };

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
	 * The commit is in `main`: applied (`main` is the commit) or merged
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
			/** Blob writes that lost and landed beside their file instead: the path written, and where its bytes are (`conflictSibling`). */
			siblings?: { path: string; at: string }[];
	  }
	/**
	 * The commit landed earlier and its answer has left the retention window
	 * (live history is in Git by then). `files` are `main`'s texts for the
	 * paths it touched; the device catches up for the rest.
	 */
	| { kind: 'flushed'; main: string; files: FileState[] }
	/**
	 * Nothing changed: the door refused one file's text (`path`), so the
	 * device holds that text with the reason; the rest of the commit may go
	 * again without it.
	 */
	| { kind: 'refused'; code: TextCode; reason: string; path: string; main: string }
	/**
	 * Nothing changed: the request itself was not taken (who sent it, its
	 * size or rate, its form, or a condition on `main`). No text is at
	 * fault: the device keeps its work and fixes the request (waits, splits
	 * it, catches up) or reports it. For `file-moved`, `files` are `main`'s
	 * texts for the paths the commit touched, so a writer can redo its
	 * change without asking again.
	 */
	| { kind: 'rejected'; code: RequestCode; reason: string; main: string; files?: FileState[] }
	/** RULE: the commit's parent is older than the retention window, and the server has no record of it: it cannot say what happened. */
	| { kind: 'outcome-unknown'; main: string };

/**
 * Why the door refused a file's text. `inadmissible`'s reason is the door's
 * own (core/door). `is-a-folder` and `under-a-file`: the file would be written where a
 * folder has files, or beneath a file (core/tree's `collision`); like an
 * inadmissible name, only a person renaming one fixes it.
 */
export type TextCode = 'path-too-long' | 'inadmissible' | 'blob-missing' | 'merge-too-large' | 'too-many-blocks' | keyof typeof COLLISIONS;

/** Why a request was not taken. */
export type RequestCode =
	| 'no-session'
	| 'not-member'
	| 'reader'
	| 'not-author'
	| 'rate'
	| 'too-large'
	| 'too-many-files'
	| 'no-parent'
	| 'bad-id'
	| 'bad-time'
	| 'clock-ahead'
	| 'path-twice'
	| 'file-moved'
	| 'no-precondition';

/** What each code says to a person; code branches on the code, never on this. */
export const REASONS: Record<Exclude<TextCode, 'inadmissible'> | RequestCode, string> = {
	'path-too-long': 'the path is too long',
	'blob-missing': "the file's bytes are not on the server",
	'merge-too-large': 'the merge would grow the note past 1 MB',
	'too-many-blocks': 'this note has unresolved conflicts; resolve some first',
	...COLLISIONS,
	'no-session': 'no session',
	'not-member': 'not a member',
	reader: 'a reader may not write',
	'not-author': 'the author is not the session',
	rate: 'rate',
	'too-large': 'request too large',
	'too-many-files': 'too many files',
	'no-parent': 'no parent',
	'bad-id': 'the id is not the hash of the commit',
	'bad-time': 'the time is not an ISO instant',
	'clock-ahead': "the time is ahead of the server's clock",
	'path-twice': 'a path is named twice',
	'file-moved': 'the file moved',
	'no-precondition': 'no precondition',
};

/** A request rejection, as an answer. */
export const rejection = (code: RequestCode, main: string, files?: FileState[]): PushAnswer => ({ kind: 'rejected', code, reason: REASONS[code], main, ...(files === undefined ? {} : { files }) });
/** A text refusal, as an answer: the door's own reason for `inadmissible`. */
const refusal = (code: TextCode, path: string, main: string, reason = REASONS[code as Exclude<TextCode, 'inadmissible'>]): PushAnswer => ({ kind: 'refused', code, reason, path, main });
/** `files` as core/tree's changes: each path's segments, and what it becomes (null deletes); a collision asks only whether a file is written, so the text stands in unless `hash` is given. */
const changes = (files: CommitFile[], hash: (text: string) => string = (text) => text): [string[], string | null][] =>
	files.map((f) => [f.path.split('/'), f.text === null ? null : hash(f.text)]);

/**
 * A one-file precondition (HTTP's `If-Match` and `If-None-Match: *`),
 * checked inside the push once the path is in `main`'s spelling: the file
 * is absent, present, or at one of these hashes.
 */
export type Expect = { path: string; is: 'absent' | 'present' | string[] };

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
	/** The commit a later page named has left the window: the device starts its catch-up again (no files, no next page). */
	restart?: true;
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
	/** Reads per member (a catch-up page, a file): a bucket of `readBurst`, refilled at `readRate` a second; a text by hash costs `1 / TEXTS_PER_READ`. */
	readBurst: number;
	readRate: number;
	/** How long positions, commits and answers are kept, in ms. */
	window: number;
	/** How long a landed commit's id is recognized after its answer left the window, in ms. */
	seen: number;
	/** Commits in one `git push`. */
	pushedCommits: number;
	/** How far ahead of the server's clock a commit's `time` may be, in ms. */
	skew: number;
	/** Bytes of one blob. */
	blob: number;
	/** Bytes of every blob the repository holds, together. */
	quota: number;
};

export const LIMITS: Limits = {
	request: 4 * 1024 * 1024,
	files: 1000,
	path: 512,
	page: 1000,
	burst: 30,
	rate: 10,
	readBurst: 300,
	readRate: 20,
	window: 10 * 60_000,
	seen: 24 * 60 * 60_000,
	pushedCommits: 1000,
	skew: 5 * 60_000,
	blob: MAX_BLOB_BYTES,
	quota: 10 * 1000 ** 3,
};

/** Texts by hash that cost one read: content-addressed and cheap, so a first sync of 50,000 texts fits a burst. */
export const TEXTS_PER_READ = 256;

/** When live history is flushed: after `quiet` ms with no push, and at most `busy` ms after the last flush while pushes go on. */
export type Schedule = { quiet: number; busy: number };
export const SCHEDULE: Schedule = { quiet: 60_000, busy: 5 * 60_000 };

const SERVER: Author = { user: 'epicenter', device: 'server' };

const ServerDiagnostic = defineErrors({
	FlushFailed: ({ cause }: { cause: unknown }) => ({ message: 'A scheduled flush failed; it runs again after the next push', cause }),
	Diverged: ({ main, expected }: { main: string | null; expected: string | null }) => ({ message: DIVERGED, main, expected }),
});

/**
 * Whether live history flows into Git: `live`, or `diverged` when Git's
 * `main` moved outside Epicenter and is not `expected`. Diverged, live
 * edits go on, but no flush or `git push` is taken until an operator puts
 * Git's `main` back at `expected`.
 */
export type ServerState = { kind: 'live' } | { kind: 'diverged'; expected: string | null };
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const bytes = (text: string) => encoder.encode(text).length;
/** A UTC instant as `Date.prototype.toISOString` writes it. */
const isInstant = (time: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(time) && new Date(Date.parse(time)).toISOString() === time;

// ============================================================================
// The server
// ============================================================================

export function createServer({
	store,
	git,
	clock = () => Date.now(),
	alarm: makeAlarm,
	limits: given = {},
	schedule = SCHEDULE,
	onCommit,
	log,
	faults,
}: {
	store: Store;
	git: GitObjects;
	clock?: Clock;
	/** The host's alarm, made for `due`. Without one, flushes run only when asked (`flush`). */
	alarm?: (due: () => void) => Alarm;
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
			id: commitId({ parent: '', author: SERVER, time: new Date(at).toISOString(), files: [] }),
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

	/** RULE: a name is a file or a folder, never both: the file `files` would put over a folder, or beneath a file, in `tree` is refused. */
	/**
	 * RULE: where a blob write that lost lands: beside its file, at the first
	 * `conflictSibling` name, with more of its bytes' hash each time, that
	 * already holds these bytes (equal bytes are one file: nothing is
	 * written) or is free in the tree the merge makes (no other file there,
	 * in `main` or in this merge, no other spelling of it, no file above it
	 * and nothing under it). Null: no name fits the path bound.
	 */
	function besideIt(path: string, text: string, out: CommitFile[], tree: string): { at: string; write: boolean } | null {
		const oid = parsePointer(text)?.oid ?? gitBlobHash(text);
		for (let chars = 7; chars <= oid.length; chars++) {
			const at = conflictSibling(path, oid, chars, limits.path);
			if (bytes(at) > limits.path || admissible(at, text) !== null) return null;
			const written = out.find((f) => fold(f.path) === fold(at));
			const spelling = history.spelling(at);
			const there = written !== undefined ? (written.path === at ? written.text : undefined) : spelling === null || spelling === at ? history.textIn(tree, at) : undefined;
			if (there === text) return { at, write: false };
			if (there !== null) continue;
			if (trees.collision(tree, changes([{ path: at, text }])) !== null) continue;
			if (out.some((f) => f.path.startsWith(`${at}/`) || at.startsWith(`${f.path}/`))) continue;
			return { at, write: true };
		}
		return null;
	}

	const collides = (tree: string, files: CommitFile[], head: string): PushAnswer | null => {
		const found = trees.collision(tree, changes(files));
		return found === null ? null : refusal(found.code, found.path, head);
	};

	/**
	 * RULE: drop commits older than the window (never `main` itself), and
	 * answers older than the window once `main` at their landing is in Git;
	 * ids are recognized for `seen` longer. A pushed commit waiting to be
	 * joined holds nothing past the window (flush.ts).
	 */
	function prune() {
		const now = clock();
		const cutoff = now - limits.window;
		history.pruneBefore(Math.min(history.top(), history.newestBefore(cutoff) + 1));
		store.run('DELETE FROM outcomes WHERE at < ? AND place <= ?', [cutoff, meta.number('flushed')]);
		store.run('DELETE FROM seen WHERE at < ?', [now - limits.seen]);
		store.run('DELETE FROM received WHERE at < ?', [now - limits.seen]);
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

	/** Take `cost` from a member's bucket (`key` names it), refilled at `rate` a second up to `burst`; false when it holds too little. */
	function take(key: string, cost: number, burst: number, rate: number) {
		const now = clock();
		const bucket = first<{ tokens: number; at: number }>(store, 'SELECT tokens, at FROM buckets WHERE user = ?', [key]) ?? { tokens: burst, at: now };
		const tokens = Math.min(burst, bucket.tokens + ((now - bucket.at) / 1000) * rate);
		const enough = tokens >= cost;
		store.run('INSERT OR REPLACE INTO buckets (user, tokens, at) VALUES (?, ?, ?)', [key, enough ? tokens - cost : tokens, now]);
		return enough;
	}

	/** The door: who may push this, and is it something the repository may hold? */
	function admit(commit: LiveCommit, session: Session | undefined, rate: boolean): PushAnswer | null {
		const head = main().id;
		const reject = (code: RequestCode) => rejection(code, head);
		if (session === undefined) return reject('no-session');
		if (session.role === null) return reject('not-member');
		if (session.role === 'reader') return reject('reader');
		const now = clock();
		if (rate && !take(session.user, 1, limits.burst, limits.rate)) return reject('rate');
		if (commit.parent === undefined) return reject('no-parent');
		// The id is checked before any recorded outcome is read, so a replayed id with other files is refused.
		if (commitId(commit) !== commit.id) return reject('bad-id');
		if (commit.author.user !== session.user) return reject('not-author');
		// RULE: `time` is a label people read (in conflict blocks), never an order: an ISO instant, not ahead of the server's clock by more than the skew. An earlier one is a commit sent again after time offline.
		if (!isInstant(commit.time)) return reject('bad-time');
		if (Date.parse(commit.time) > now + limits.skew) return reject('clock-ahead');
		if (bytes(JSON.stringify(commit)) > limits.request) return reject('too-large');
		if (commit.files.length > limits.files) return reject('too-many-files');
		const paths = new Set<string>();
		for (const file of commit.files) {
			if (paths.has(fold(file.path))) return reject('path-twice');
			paths.add(fold(file.path));
		}
		for (const file of commit.files) {
			if (bytes(file.path) > limits.path) return refusal('path-too-long', file.path, head);
			// D4 and the door's content rules: the same predicate the device runs.
			const reason = admissible(file.path, file.text);
			if (reason !== null) return refusal('inadmissible', file.path, head, reason);
			// A pointer names bytes the server holds, at its size.
			const pointer = file.text === null ? null : parsePointer(file.text);
			if (pointer !== null && !holdsBlob(store, pointer)) return refusal('blob-missing', file.path, head);
		}
		return null;
	}

	/** Fill an answer's files (everything changed since the commit's parent, and what it touched) and keep it for a resend. */
	function record(commit: LiveCommit, kind: 'applied' | 'merged', mainId: string, { from, tree }: { from: number; tree: string }, spelled: string[], siblings: { path: string; at: string }[] = []): PushAnswer {
		const touched = [...new Set([...commit.files.map((f) => f.path), ...spelled, ...siblings.map((s) => s.at)])];
		const paths = new Set([...trees.diff(tree, main().tree), ...touched]);
		const answer: PushAnswer = { kind, main: mainId, commits: history.idsAfter(from), files: [...paths].sort().map((path) => state(path, from)), ...(siblings.length === 0 ? {} : { siblings }) };
		const now = clock();
		store.run('INSERT OR REPLACE INTO outcomes (id, at, place, answer, paths) VALUES (?, ?, ?, ?, ?)', [commit.id, now, history.top(), JSON.stringify(answer), JSON.stringify(touched)]);
		store.run('INSERT OR REPLACE INTO seen (id, at, paths) VALUES (?, ?, ?)', [commit.id, now, JSON.stringify(touched)]);
		return answer;
	}

	function pushInside(commit: LiveCommit, session: Session | undefined, rate: boolean, expect?: Expect): PushAnswer {
		prune();
		const turned = admit(commit, session, rate);
		if (turned !== null) return turned;
		const recorded = first<{ answer: string; paths: string }>(store, 'SELECT answer, paths FROM outcomes WHERE id = ?', [commit.id]);
		if (recorded !== undefined) {
			// RULE: a resend gets its verdict brought up to now: `main` and every file changed since its parent, as they are now.
			const answer = JSON.parse(recorded.answer) as PushAnswer;
			const base = history.baseOf(commit.parent);
			if (base === undefined || (answer.kind !== 'applied' && answer.kind !== 'merged')) return answer;
			const paths = new Set([...trees.diff(base.tree, main().tree), ...(JSON.parse(recorded.paths) as string[])]);
			return { ...answer, main: main().id, commits: history.idsAfter(base.from), files: [...paths].sort().map((path) => state(path, base.from)) };
		}
		const seen = first<{ paths: string }>(store, 'SELECT paths FROM seen WHERE id = ?', [commit.id]);
		if (seen !== undefined) return { kind: 'flushed', main: main().id, files: (JSON.parse(seen.paths) as string[]).map((path) => state(path)) };
		// RULE: paths equal after NFC and case folding are one path: a write goes to the spelling `main` has.
		const spelled = commit.files.map((f) => f.path);
		commit = { ...commit, files: commit.files.map((f) => ({ ...f, path: history.spelling(f.path) ?? f.path })) };
		const head = main();
		// A commit's parent is a commit on `main`, or one a merge took in (a `git push` on the commit Git's `main` is, before its export).
		const base = history.baseOf(commit.parent);
		if (base === undefined) return { kind: 'outcome-unknown', main: head.id };
		const from = base.from;
		if (expect !== undefined) {
			const path = history.spelling(expect.path) ?? expect.path;
			const hash = trees.read(head.tree, path);
			const holds = expect.is === 'absent' ? hash === null : expect.is === 'present' ? hash !== null : hash !== null && expect.is.includes(hash);
			if (!holds) return rejection('file-moved', head.id, [state(path)]);
		}
		const author = { user: session?.user ?? commit.author.user, device: commit.author.device };
		// The commit must be one tree over what its writer stood on (on `main`, that is the check), and its merge one tree over `main`, below.
		const clash = collides(base.tree, commit.files, head.id);
		if (clash !== null) return clash;
		/** What a file was written over: a blob's `over` when its writer said, else what the commit's parent holds there. */
		const over = (file: CommitFile) => (file.over !== undefined && !isNote(file.path) ? file.over : history.textIn(base.tree, file.path));
		if (commit.parent === head.id && commit.files.every((file) => over(file) === history.textIn(head.tree, file.path))) {
			advance({ id: commit.id, parents: [commit.parent], author, time: commit.time, blocks: false }, commit.files);
			return record(commit, 'applied', commit.id, base, spelled);
		}

		// Merge where the commit's history and main's meet, path by path.
		const parentTree = base.tree;
		const out: CommitFile[] = [];
		const siblings: { path: string; at: string }[] = [];
		let blocks = false;
		for (const file of commit.files) {
			const ours = history.textIn(head.tree, file.path);
			const base = history.textIn(parentTree, file.path);
			if (!isNote(file.path)) {
				// A blob lands only over the blob its writer saw: compare-and-swap, never a merge. One that lost lands beside it.
				const swapped = settlePointer(over(file), ours, file.text);
				if ('lost' in swapped) {
					const placed = besideIt(file.path, file.text as string, out, head.tree);
					if (placed === null) return refusal('path-too-long', file.path, head.id);
					siblings.push({ path: file.path, at: placed.at });
					if (placed.write) out.push({ path: placed.at, text: file.text });
					continue;
				}
				out.push({ path: file.path, text: swapped.text });
				continue;
			}
			const who = history.lastAuthor(file.path) ?? SERVER;
			const settled = settle(base, ours, file.text, {
				deletedSince: history.deletedSince(from, file.path),
				parties: { current: { author: `${who.user}/${who.device}`, time: head.time }, incoming: { author: `${author.user}/${author.device}`, time: commit.time } },
			});
			if (settled.text !== null) {
				// RULE, the first named exception: a merge that would grow a note past 1 MB is refused, so its writer holds it.
				if (bytes(settled.text) > MAX_FILE_BYTES) return refusal('merge-too-large', file.path, head.id);
				// RULE, the second named exception: a merge may not leave a note with more than BLOCK_CAP conflict blocks (a stale-parent flood). Past it, any writer's merge is refused, even one whose own change adds the block to others' blocks: its writer holds it with the reason until blocks are resolved.
				if (findConflicts(settled.text).length > Math.max(BLOCK_CAP, ours === null ? 0 : findConflicts(ours).length))
					return refusal('too-many-blocks', file.path, head.id);
			}
			// Every merge result passes the door too.
			const reason = admissible(file.path, settled.text);
			if (reason !== null) return refusal('inadmissible', file.path, head.id, reason);
			out.push({ path: file.path, text: settled.text });
			if (settled.blocks) blocks = true;
		}
		const merged = collides(head.tree, out, head.id);
		if (merged !== null) return merged;
		// The device's commit stays a real commit: the merge's second parent.
		const mergeTime = time();
		const id = commitId({ parent: `${head.id} ${commit.id}`, author: SERVER, time: mergeTime, files: out });
		history.keepSide(
			{
				id: commit.id,
				parents: [commit.parent],
				author,
				time: commit.time,
				at: clock(),
				tree: trees.update(parentTree, changes(commit.files, gitBlobHash)),
				blocks: false,
			},
			id,
			commit.files,
		);
		advance({ id, parents: [head.id, commit.id], author, time: mergeTime, blocks }, out);
		return record(commit, 'merged', id, base, spelled, siblings);
	}

	/**
	 * RULE: the sorted paths of one catch-up (from a place, or everything,
	 * to a commit, plus the paths named), computed once and kept for its
	 * later pages: trees are immutable, so a listing never goes stale.
	 */
	const listings = new Map<string, string[]>();
	function listingOf(index: number | undefined, target: Stored, paths: string[]) {
		const key = `${index ?? ''}\0${target.id}\0${paths.join('\0')}`;
		const kept = listings.get(key);
		if (kept !== undefined) return kept;
		const all = new Set(index === undefined ? trees.diff(trees.empty, target.tree) : trees.diff(history.at(index).tree, target.tree));
		for (const path of paths) all.add(path);
		const listing = [...all].sort();
		listings.set(key, listing);
		for (const old of listings.keys()) {
			if (listings.size <= 8) break;
			listings.delete(old);
		}
		return listing;
	}

	// ------------------------------------------------------------------------
	// Flush scheduling
	// ------------------------------------------------------------------------

	const flusher = createFlusher({ history, store, git, faults });
	const receiver = createReceiver({
		history,
		store,
		git,
		clock,
		limits,
		flusher,
		faults,
		apply: (commit, session, during) => push(commit, session, { rate: false, during }),
		prune: () => store.transaction(prune),
	});

	/**
	 * RULE: after a flush, drop what the window no longer keeps, then every
	 * text and tree node that no kept commit, no flush in progress and Git's
	 * last flushed tree names. Answers hold their texts inline.
	 */
	function collect() {
		store.transaction(() => {
			prune();
			// A waiting join's trees stay: its flush diffs against them.
			const roots = [meta.get('git_tree') ?? trees.empty, ...flusher.joins().flatMap((join) => [join.base, join.tree])];
			for (const { plan } of store.all<{ plan: string }>('SELECT plan FROM journal')) {
				const planned = JSON.parse(plan) as { commits: { tree: string }[]; join?: Join };
				for (const commit of planned.commits) roots.push(commit.tree);
				if (planned.join !== undefined) roots.push(planned.join.base, planned.join.tree);
			}
			history.sweep(roots);
		});
	}
	const flushAndCollect = async () => {
		const result = await flusher.flush();
		if (result.kind === 'diverged') log?.error(ServerDiagnostic.Diverged({ main: result.main, expected: result.expected }));
		collect();
		return result;
	};

	/**
	 * RULE: a flush is due `quiet` after the last push with none since, and
	 * at most `busy` after the last flush while pushes go on; nothing is due
	 * once a flush started after the last push. Both times are in `meta`, so
	 * a restarted server schedules what a crash left unflushed.
	 */
	if (meta.get('last_flush') === null) meta.set('last_flush', clock());
	function dueAt(): number | null {
		const push = meta.get('last_push');
		const flush = meta.number('last_flush');
		if (push === null || Number(push) < flush) return null;
		return Math.min(Number(push) + schedule.quiet, flush + schedule.busy);
	}
	function reschedule() {
		const at = dueAt();
		if (at === null) alarm?.cancel();
		else alarm?.schedule(at);
	}
	/** The flush started by the alarm, if one is running. */
	let background: Promise<void> = Promise.resolve();
	function flushInBackground() {
		meta.set('last_flush', clock());
		background = flushAndCollect()
			.then(
				() => {},
				(cause: unknown) => log?.error(ServerDiagnostic.FlushFailed({ cause })),
			)
			.finally(reschedule);
	}
	/** The alarm's entry point: flush if one is due, otherwise set the alarm for when one is. */
	function due() {
		const at = dueAt();
		if (at !== null && clock() >= at) flushInBackground();
		else reschedule();
	}
	const alarm = makeAlarm?.(due);
	function pushed() {
		if (alarm === undefined) return;
		meta.set('last_push', clock());
		reschedule();
	}
	reschedule();

	type PushOptions = { rate?: boolean; expect?: Expect; during?: (answer: PushAnswer & { kind: 'applied' | 'merged' }) => void };
	/** Take a live commit; `during` runs in its transaction once it lands (the receiver's journal row). */
	function push(commit: LiveCommit, session?: Session, { rate = true, expect, during }: PushOptions = {}): PushAnswer {
		pending = [];
		const answer = store.transaction(() => {
			const answer = pushInside(commit, session, rate, expect);
			if (answer.kind === 'applied' || answer.kind === 'merged') during?.(answer);
			return answer;
		});
		if (answer.kind === 'applied' || answer.kind === 'merged') {
			notify();
			pushed();
		} else pending = [];
		return answer;
	}

	return {
		/** The current `main`. */
		main: () => main().id,
		/** Whether live history flows into Git, or a flush is diverged (for the host's alerts). */
		state: (): ServerState => {
			const stuck = flusher.diverged();
			return stuck === null ? { kind: 'live' } : { kind: 'diverged', expected: stuck.expected };
		},
		/** The server's clock, as the ISO instant a commit made here carries. */
		time,
		/** The bounds on one push a device sizes its commits to. */
		sizing: () => ({ request: limits.request, files: limits.files, blob: limits.blob }),
		/**
		 * Whether `session` may read this repository: any member may. The
		 * reads below (`read`, `catchUp`, `fetch`, `subscribe`) do not check;
		 * the host asks this first, as the wire does for every read.
		 */
		mayRead: (session: Session | undefined) => session !== undefined && session.role !== null,
		/**
		 * Take one read from a member's read bucket (`text`: a text by hash,
		 * a small part of one); false when they should slow down. The host
		 * asks this before each catch-up page, file and text, as the wire does.
		 */
		admitRead: (session: Session, kind: 'read' | 'text' = 'read') =>
			store.transaction(() => take(`read\0${session.user}`, kind === 'text' ? 1 / TEXTS_PER_READ : 1, limits.readBurst, limits.readRate)),
		/** `main`'s text at a path, in any spelling of it. */
		read: (path: string) => history.textIn(main().tree, history.spelling(path) ?? path),
		/** Every path and text on `main`, sorted. */
		snapshot: () =>
			new Map(
				trees
					.diff(trees.empty, main().tree)
					.sort()
					.map((path) => [path, history.textIn(main().tree, path) as string]),
			),
		/**
		 * Take a live commit: apply it on `main`, merge it in, or refuse it; a
		 * resend gets its recorded outcome. `expect` is a one-file
		 * precondition, refused as `the file moved` when it does not hold.
		 */
		push: (commit: LiveCommit, session?: Session, { expect }: { expect?: Expect } = {}) => push(commit, session, expect === undefined ? {} : { expect }),
		/**
		 * What changed on `main` since `from`, as a tree diff, plus `paths` the
		 * device names, one page at a time: a later page names `to` (the commit
		 * the first page answered) and `after` (the last path it got). A
		 * position outside the window gets every file. RULE: a later page whose
		 * `to` has left the window answers `restart`, never a page of another
		 * commit: pages of two commits joined would stand a device on one with
		 * the other's texts.
		 */
		catchUp({ from, paths = [], to, after }: { from: string | null; paths?: string[]; to?: string; after?: string }): CatchUp {
			store.transaction(prune);
			const toPlace = to === undefined ? undefined : history.placeOf(to);
			if (to !== undefined && toPlace === undefined) return { main: main().id, full: true, files: [], commits: [], next: null, restart: true };
			const target = toPlace === undefined ? main() : history.at(toPlace);
			const index = from === null ? undefined : history.placeOf(from);
			const full = index === undefined;
			const listing = listingOf(index, target, paths);
			// The first path after `after`, by binary search.
			let low = 0;
			for (let high = listing.length; after !== undefined && low < high; ) {
				const mid = (low + high) >> 1;
				if ((listing[mid] as string) <= after) low = mid + 1;
				else high = mid;
			}
			const page = listing.slice(low, low + limits.page);
			const last = low + page.length === listing.length;
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
		/**
		 * LFS bytes are durable on this server's byte store (the upload
		 * track): pointers naming them at this size may now be written.
		 * Called only after the bytes are stored, never before.
		 */
		upload: (oid: string, size: number) => store.run('INSERT OR IGNORE INTO uploads (oid, size) VALUES (?, ?)', [oid, size]),
		/** The size of the bytes this server holds as `oid`, or null when it holds none. */
		uploaded: (oid: string) => first<{ size: number }>(store, 'SELECT size FROM uploads WHERE oid = ?', [oid])?.size ?? null,
		/**
		 * Why bytes `oid` of `size` may not be uploaded, or null when they
		 * may: past the blob limit, or past the repository's quota with
		 * every blob it holds. Bytes already here cost nothing.
		 */
		uploadRefusal(oid: string, size: number): 'too-large' | 'over-quota' | null {
			if (size > limits.blob) return 'too-large';
			if (first(store, 'SELECT 1 FROM uploads WHERE oid = ?', [oid]) !== undefined) return null;
			const used = first<{ used: number | null }>(store, 'SELECT SUM(size) AS used FROM uploads')?.used ?? 0;
			return used + size > limits.quota ? 'over-quota' : null;
		},
		/**
		 * Flush live history into Git now (`epicenter pull`, `git fetch`), or
		 * finish the flush a crash interrupted: one Git commit at each merge
		 * that wrote a conflict block, and one at `main`.
		 */
		flush: async () => {
			meta.set('last_flush', clock());
			try {
				return await flushAndCollect();
			} finally {
				reschedule();
			}
		},
		/** The alarm's entry point (a Durable Object's `alarm()` calls it): flush if one is due, otherwise set the alarm for when one is. */
		due,
		/** Resolves once no flush or Git push is in progress. */
		idle: async () => {
			await background;
			await flusher.idle();
		},
		/**
		 * Take a `git push` of `refs/heads/main` whose objects are already in
		 * Git: a fast-forward of Git's `main`, merged into live `main` like
		 * any commit (receive.ts).
		 */
		receive: (...args: Parameters<typeof receiver.receive>) => receiver.receive(...args),
		/** Live commits made and kept, answers kept, the texts' bytes and tree nodes kept, and flushes, for tests and the benchmark. */
		history: () => ({
			commits: meta.number('made'),
			kept: history.top() - history.offset() + 1,
			outcomes: first<{ n: number }>(store, 'SELECT COUNT(*) AS n FROM outcomes')?.n ?? 0,
			bytes: first<{ n: number }>(store, 'SELECT COALESCE(SUM(LENGTH(text)), 0) AS n FROM blobs')?.n ?? 0,
			nodes: first<{ n: number }>(store, 'SELECT COUNT(*) AS n FROM nodes')?.n ?? 0,
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
					id: commitId({ parent: head, author: SERVER, time, files: [] }),
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
