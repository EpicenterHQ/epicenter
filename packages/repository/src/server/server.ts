/**
 * The repository's server: live history behind one door, as a state machine over
 * ports. It holds no host imports: the `Store` (SQLite) keeps every live
 * commit, every version a writer may name as its base until Git has it, each
 * writer's last push, and the flush journal; `GitObjects` is where flushed
 * history goes (and where an old base is read); the `Clock` and the host's
 * one `Alarm` schedule flushes.
 *
 * Every write is one file saying what it saw: its base, a version (Git blob
 * hash). `main` only moves forward: each push lands as one live commit on
 * `main`, each write judged against its own base, whoever wrote it: a note
 * merges with `settle` against its base's text, a blob lands by
 * compare-and-swap (`settlePointer`) or beside its file.
 *
 * The door (`admit`, `admitFiles`): the caller passes a verified session
 * (the user and their role in this repository); the push's user must be
 * that user; request bytes, files, path length and pushes per member are
 * bounded; each write is of the kind its path names; every file written,
 * and every merge result, is `admissible` (the predicate the device runs
 * too); and the tree rules hold: paths equal after NFC and case folding are
 * one path, spelled as it was created, a name is a file or a folder, never
 * both (core/tree's `collision`, against what `main` would become), a
 * blob's bytes are present at its size (`uploads`, written only once the
 * bytes are durable), a merge whose note would pass the size limit lands
 * beside it, and a merge may not leave a note past `BLOCK_CAP` conflict
 * blocks (the named exception to "a person is never refused because of
 * someone else").
 *
 * Idempotency is each writer's numbered pushes: one row per (user, device,
 * epoch) keeps the last seq, its hash and its answer, so a resend gets that
 * answer exactly and a device behind itself is told so. Positions are trees
 * kept for the window, so a catch-up is a tree diff, in pages; no write's
 * outcome depends on time.
 *
 * Flushing (flush.ts) turns live history into Git commits; a `git push`
 * comes in through `receive` (receive.ts), on Git's `main`, and lands like
 * any push.
 *
 * Rules the design does not state are marked `RULE:`.
 */
import { defineErrors } from 'wellcrafted/error';
import type { Logger } from 'wellcrafted/logger';
import {
	type Author,
	type CommitFile,
	type Content,
	commitId,
	contentOf,
	type FileWrite,
	kindRefusal,
	type Push,
	pushHash,
	storedText,
} from '../core/commit.js';
import { findConflicts } from '../core/conflict.js';
import {
	admissible,
	fold,
	isNote,
	MAX_BLOB_BYTES,
	MAX_FILE_BYTES,
	PATH_TOO_LONG,
} from '../core/door.js';
import { gitBlobHash } from '../core/hash.js';
import { formatMarkdown, parsePointer } from '../core/markdown.js';
import {
	BLOCK_CAP,
	conflictSibling,
	settle,
	settlePointer,
} from '../core/settle.js';
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

/** A file on `main`: its version (Git blob hash) and what it is, a note's text or a blob's bytes (null: no file). Pointer text never travels. */
export type FileState = {
	path: string;
	hash: string | null;
	content: Content | null;
};

export type PushAnswer =
	/**
	 * The push is in `main`: `applied` when every write landed as sent,
	 * `merged` when one was merged, landed beside its file or did not take.
	 * `files` are `main`'s files for every path changed since the push's
	 * `from` and every path it touched, so the device stands on `main` at
	 * once; `stale` when `from` has left history, so `files` are only what
	 * it touched and the device catches up in full. What became of each
	 * path is in the text itself (conflict blocks).
	 */
	| {
			kind: 'applied' | 'merged';
			main: string;
			/** The commits on `main` after `from`, so the device drops those notifications. */
			commits: string[];
			files: FileState[];
			/** Blob writes that lost and landed beside their file instead: the path written, and where its bytes are (`conflictSibling`). */
			siblings?: { path: string; at: string }[];
			stale?: true;
	  }
	/**
	 * Nothing changed: the door refused one file's write (`path`), so the
	 * device holds it with the reason; the rest may go again without it.
	 */
	| {
			kind: 'refused';
			code: TextCode;
			reason: string;
			path: string;
			main: string;
	  }
	/**
	 * Nothing changed: the request itself was not taken (who sent it, its
	 * size or rate, its form, a condition on `main`, or a base the server is
	 * still reading from Git). No write is at fault: the device keeps its
	 * work and sends it again (waits, splits it) or reports it. For
	 * `file-moved`, `files` are `main`'s files for the paths the push
	 * touched, so a writer can redo its change without asking again.
	 */
	| {
			kind: 'rejected';
			code: RequestCode;
			reason: string;
			main: string;
			files?: FileState[];
	  }
	/**
	 * RULE: this device is behind itself: its epoch already sent a later
	 * push, or this one with other writes (a database restored from a
	 * copy). Nothing changed; the device takes a new epoch, catches up, and
	 * sends what it has not sent as new writes, each whose outcome it
	 * cannot know over an unknown base.
	 */
	| { kind: 'behind'; main: string };

/** What a device behind itself is told, for people. */
export const BEHIND = 'this device is behind itself';

/**
 * Why the door refused a file's text. `inadmissible`'s reason is the door's
 * own (core/door). `is-a-folder` and `under-a-file`: the file would be written where a
 * folder has files, or beneath a file (core/tree's `collision`); like an
 * inadmissible name, only a person renaming one fixes it.
 */
export type TextCode =
	| 'path-too-long'
	| 'inadmissible'
	| 'blob-missing'
	| 'unknown-base'
	| 'too-many-blocks'
	| keyof typeof COLLISIONS;

/** Why a request was not taken. */
export type RequestCode =
	| 'no-session'
	| 'not-member'
	| 'reader'
	| 'not-author'
	| 'rate'
	| 'too-large'
	| 'too-many-files'
	| 'bad-time'
	| 'path-twice'
	| 'file-moved'
	| 'no-precondition'
	| 'reading';

/** What each code says to a person; code branches on the code, never on this. */
export const REASONS: Record<
	Exclude<TextCode, 'inadmissible'> | RequestCode,
	string
> = {
	'path-too-long': PATH_TOO_LONG,
	'blob-missing': "the file's bytes are not on the server",
	'unknown-base': 'the version this write was made on is not in the history',
	'too-many-blocks': 'this note has unresolved conflicts; resolve some first',
	...COLLISIONS,
	'no-session': 'no session',
	'not-member': 'not a member',
	reader: 'a reader may not write',
	'not-author': 'the author is not the session',
	rate: 'rate',
	'too-large': 'request too large',
	'too-many-files': 'too many files',
	'bad-time': 'the time is not an ISO instant',
	'path-twice': 'a path is named twice',
	'file-moved': 'the file moved',
	'no-precondition': 'no precondition',
	reading: "the server is reading this file's history; send again",
};

/** A request rejection, as an answer. */
export const rejection = (
	code: RequestCode,
	main: string,
	files?: FileState[],
): PushAnswer => ({
	kind: 'rejected',
	code,
	reason: REASONS[code],
	main,
	...(files === undefined ? {} : { files }),
});
/** A text refusal, as an answer: the door's own reason for `inadmissible`. */
const refusal = (
	code: TextCode,
	path: string,
	main: string,
	reason = REASONS[code as Exclude<TextCode, 'inadmissible'>],
): PushAnswer => ({ kind: 'refused', code, reason, path, main });
/** `files` as core/tree's changes: each path's segments, and what it becomes (null deletes); a collision asks only whether a file is written, so the text stands in unless `hash` is given. */
const changes = (
	files: CommitFile[],
	hash: (text: string) => string = (text) => text,
): [string[], string | null][] =>
	files.map((f) => [f.path.split('/'), f.text === null ? null : hash(f.text)]);

/**
 * A one-file precondition (HTTP's `If-Match` and `If-None-Match: *`),
 * checked inside the push once the path is in `main`'s spelling: the file
 * is absent, present, or at one of these hashes.
 */
export type Expect = { path: string; is: 'absent' | 'present' | string[] };

/** A notification: the new commit, its parents, and the paths changed since its first parent, with hashes. No texts. */
export type Event = {
	commit: string;
	parents: string[];
	files: { path: string; hash: string | null }[];
};

export type CatchUp = {
	/** The commit this catch-up brings the device to. */
	main: string;
	/** Every file, because the server no longer keeps the position. */
	full: boolean;
	/** One page of paths changed since the position, with hashes. */
	files: { path: string; hash: string | null }[];
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
	/** How long positions are kept, in ms: a catch-up from an older one gets every file. Nothing a write needs is kept by time. */
	window: number;
	/** Commits in one `git push`. */
	pushedCommits: number;
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
	pushedCommits: 1000,
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
	FlushFailed: ({ cause }: { cause: unknown }) => ({
		message: 'A scheduled flush failed; it runs again after the next push',
		cause,
	}),
	Diverged: ({
		main,
		expected,
	}: {
		main: string | null;
		expected: string | null;
	}) => ({ message: DIVERGED, main, expected }),
});

/**
 * Whether live history flows into Git: `live`, or `diverged` when Git's
 * `main` moved outside Epicenter and is not `expected`. Diverged, live
 * edits go on, but no flush or `git push` is taken until an operator puts
 * Git's `main` back at `expected`.
 */
export type ServerState =
	| { kind: 'live' }
	| { kind: 'diverged'; expected: string | null };
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const bytes = (text: string) => encoder.encode(text).length;
/** A UTC instant as `Date.prototype.toISOString` writes it. */
const isInstant = (time: string) =>
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(time) &&
	new Date(Date.parse(time)).toISOString() === time;

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
			id: commitId({
				parent: '',
				author: SERVER,
				time: new Date(at).toISOString(),
				files: [],
			}),
			parents: [],
			author: SERVER,
			time: new Date(at).toISOString(),
			at,
			tree: trees.empty,
			blocks: false,
		});
	}

	const main = () => history.main();
	const state = (path: string): FileState => {
		const hash = trees.read(main().tree, path);
		const text = hash === null ? null : history.blob(hash);
		return { path, hash, content: text === null ? null : contentOf(text) };
	};

	/** RULE: a listing names each file once, by one spelling of its path: the one `tree` holds (it holds at most one), else the first given. */
	function byName(paths: Iterable<string>, tree: string): string[] {
		const named = new Map<string, string>();
		for (const path of paths) {
			const other = named.get(fold(path));
			if (
				other === undefined ||
				(trees.read(tree, other) === null && trees.read(tree, path) !== null)
			)
				named.set(fold(path), path);
		}
		return [...named.values()];
	}

	/** RULE: a name is a file or a folder, never both: the file `files` would put over a folder, or beneath a file, in `tree` is refused. */
	/**
	 * RULE: where a blob write that lost lands: beside its file, at the first
	 * `conflictSibling` name, with more of its bytes' hash each time, that
	 * already holds these bytes (equal bytes are one file: nothing is
	 * written) or is free in the tree the merge makes (no other file there,
	 * in `main` or in this merge, no other spelling of it, no file above it
	 * and nothing under it). Null: no name fits the path bound.
	 */
	function besideIt(
		path: string,
		text: string,
		out: CommitFile[],
		tree: string,
	): { at: string; write: boolean } | null {
		const oid = parsePointer(text)?.oid ?? gitBlobHash(text);
		for (let chars = 7; chars <= oid.length; chars++) {
			const at = conflictSibling(path, oid, chars, limits.path);
			if (bytes(at) > limits.path || admissible(at, text) !== null) return null;
			const written = out.find((f) => fold(f.path) === fold(at));
			const spelling = history.spelling(at);
			const there =
				written !== undefined
					? written.path === at
						? written.text
						: undefined
					: spelling === null || spelling === at
						? history.textIn(tree, at)
						: undefined;
			if (there === text) return { at, write: false };
			if (there !== null) continue;
			if (trees.collision(tree, changes([{ path: at, text }])) !== null)
				continue;
			if (
				out.some(
					(f) => f.path.startsWith(`${at}/`) || at.startsWith(`${f.path}/`),
				)
			)
				continue;
			return { at, write: true };
		}
		return null;
	}

	const collides = (
		tree: string,
		files: CommitFile[],
		head: string,
	): PushAnswer | null => {
		const found = trees.collision(tree, changes(files));
		return found === null ? null : refusal(found.code, found.path, head);
	};

	/**
	 * RULE: drop commits older than the window (never `main` itself): they
	 * are positions a catch-up starts from, and a catch-up from one dropped
	 * gets every file. No write needs them: each names its own base. A
	 * pushed commit waiting to be joined holds nothing past the window
	 * (flush.ts).
	 */
	function prune() {
		const now = clock();
		const cutoff = now - limits.window;
		history.pruneBefore(
			Math.min(history.top(), history.newestBefore(cutoff) + 1),
		);
	}

	/** Put a commit on `main`: its snapshot and its notification. */
	function advance(
		stored: Omit<Stored, 'place' | 'tree' | 'at'>,
		files: CommitFile[],
	) {
		const { tree, changed } = history.advance(
			{ ...stored, at: clock() },
			files,
		);
		onCommit?.({
			id: stored.id,
			parents: stored.parents,
			author: stored.author,
			files: files.map((f) => ({
				path: f.path,
				before: changed.find((c) => c.path === f.path)?.before ?? f.text,
				after: f.text,
			})),
		});
		const event: Event = {
			commit: stored.id,
			parents: stored.parents,
			files: byName(
				changed.map(({ path }) => path),
				tree,
			).map((path) => ({ path, hash: trees.read(tree, path) })),
		};
		pending.push(event);
	}
	/** Notifications wait for their transaction to commit. */
	let pending: Event[] = [];
	const notify = () => {
		const events = pending;
		pending = [];
		for (const event of events)
			for (const listener of listeners) listener(event);
	};

	/** Take `cost` from a member's bucket (`key` names it), refilled at `rate` a second up to `burst`; false when it holds too little. */
	function take(key: string, cost: number, burst: number, rate: number) {
		const now = clock();
		const bucket = first<{ tokens: number; at: number }>(
			store,
			'SELECT tokens, at FROM buckets WHERE user = ?',
			[key],
		) ?? { tokens: burst, at: now };
		const tokens = Math.min(
			burst,
			bucket.tokens + ((now - bucket.at) / 1000) * rate,
		);
		const enough = tokens >= cost;
		store.run(
			'INSERT OR REPLACE INTO buckets (user, tokens, at) VALUES (?, ?, ?)',
			[key, enough ? tokens - cost : tokens, now],
		);
		return enough;
	}

	/** The door: who may push this, and is it something the repository may hold? */
	function admit(
		push: Push,
		session: Session | undefined,
		rate: boolean,
	): PushAnswer | null {
		const head = main().id;
		const reject = (code: RequestCode) => rejection(code, head);
		if (session === undefined) return reject('no-session');
		if (session.role === null) return reject('not-member');
		if (session.role === 'reader') return reject('reader');
		if (rate && !take(session.user, 1, limits.burst, limits.rate))
			return reject('rate');
		if (push.user !== session.user) return reject('not-author');
		// RULE: `time` is the device's claim, any ISO instant: a label people read (in conflict blocks, and Git's author date), never an order. What is time-based (the window, the flush schedule) runs on the server's clock, when a push arrives.
		if (!isInstant(push.time)) return reject('bad-time');
		if (bytes(JSON.stringify(push)) > limits.request)
			return reject('too-large');
		if (push.files.length > limits.files) return reject('too-many-files');
		const paths = new Set<string>();
		for (const file of push.files) {
			if (paths.has(fold(file.path))) return reject('path-twice');
			paths.add(fold(file.path));
		}
		return null;
	}

	/** The door's rules for each file: a portable path of a kind its write agrees with, holding what the repository may hold. */
	function admitFiles(files: FileWrite[], head: string): PushAnswer | null {
		for (const file of files) {
			if (bytes(file.path) > limits.path)
				return refusal('path-too-long', file.path, head);
			// RULE: the kind comes from the path, checked once here; after this, no code asks a write what it is.
			const kind = kindRefusal(file.path, file.next);
			if (kind !== null) return refusal('inadmissible', file.path, head, kind);
			// D4 and the door's content rules: the same predicate the device runs.
			const reason = admissible(file.path, storedText(file.next));
			if (reason !== null)
				return refusal('inadmissible', file.path, head, reason);
			// A blob names bytes the server holds, at their size.
			if ('blob' in file.next && !holdsBlob(store, file.next.blob))
				return refusal('blob-missing', file.path, head);
		}
		return null;
	}

	/** Versions Git does not have that a base names, found absent by a read: a write over one is refused (`unknown-base`). In memory: a restart reads again. */
	const absent = new Set<string>();
	/** The bases these writes merge against that the store does not hold: notes written over a version `main` no longer has. */
	function unread(files: FileWrite[]) {
		const head = main().tree;
		return files.flatMap(({ path, base, next }) =>
			base !== null &&
			'text' in next &&
			base !== trees.read(head, history.spelling(path) ?? path) &&
			history.blob(base) === null
				? [base]
				: [],
		);
	}
	/** Read versions from Git into the store, by hash: what a base names once only Git has it. */
	async function read(hashes: string[]) {
		for (const hash of new Set(hashes)) {
			if (absent.has(hash) || history.blob(hash) !== null) continue;
			const found = await git.readBlob(hash);
			let text: string | null = null;
			try {
				text = found === null ? null : decoder.decode(found);
			} catch {}
			if (text === null || gitBlobHash(text) !== hash) absent.add(hash);
			else store.transaction(() => history.keep(text, true));
		}
	}

	/**
	 * Land `files` on `main` as one commit by `author`: each write is
	 * judged against its own base. A note whose base is `main`'s version
	 * lands as written; any other merges with `settle` against the base's
	 * text (a base of null: two creates). A blob lands by compare-and-swap
	 * of versions (`settlePointer`), and one that lost lands beside it. A
	 * write to any spelling of a file lands at the file, in its spelling.
	 */
	function land(
		files: FileWrite[],
		{
			author,
			time: claimed,
			from,
			expect,
		}: { author: Author; time: string; from: string | null; expect?: Expect },
	): PushAnswer {
		const head = main();
		if (expect !== undefined) {
			const path = history.spelling(expect.path) ?? expect.path;
			const hash = trees.read(head.tree, path);
			const holds =
				expect.is === 'absent'
					? hash === null
					: expect.is === 'present'
						? hash !== null
						: hash !== null && expect.is.includes(hash);
			if (!holds) return rejection('file-moved', head.id, [state(path)]);
		}
		/** RULE: every note lands in house style (core/markdown's `formatMarkdown`); a write not in it is merged, never applied as sent. */
		const styled = (path: string, text: string | null) =>
			text === null || !isNote(path) ? text : formatMarkdown(text);
		const out: CommitFile[] = [];
		const siblings: { path: string; at: string }[] = [];
		let blocks = false;
		let asSent = true;
		for (const write of files) {
			// The file this write names, under the spelling it was created with.
			const path = history.spelling(write.path) ?? write.path;
			const hash = trees.read(head.tree, path);
			const current = hash === null ? null : history.blob(hash);
			const incoming = storedText(write.next);
			if (!isNote(path)) {
				// A blob lands only over the version its writer saw: compare-and-swap, never a merge. One that lost lands beside it.
				const version = incoming === null ? null : gitBlobHash(incoming);
				const swapped = settlePointer(write.base, hash, version);
				if ('lost' in swapped) {
					asSent = false;
					const placed = besideIt(path, incoming as string, out, head.tree);
					if (placed === null) return refusal('path-too-long', path, head.id);
					siblings.push({ path, at: placed.at });
					if (placed.write) out.push({ path: placed.at, text: incoming });
					continue;
				}
				const text = swapped.text === hash ? current : incoming;
				if (text !== incoming || hash !== write.base) asSent = false;
				out.push({ path, text });
				continue;
			}
			let settled: { text: string | null; blocks: boolean } = {
				text: incoming,
				blocks: false,
			};
			if (write.base !== hash) {
				asSent = false;
				const base = write.base === null ? null : history.blob(write.base);
				if (write.base !== null && base === null) {
					if (absent.has(write.base))
						return refusal('unknown-base', path, head.id);
					// Only Git has it: read it, and the writer sends again.
					void read([write.base]);
					return rejection('reading', head.id);
				}
				const who = history.lastAuthor(path) ?? SERVER;
				settled = settle(base, current, incoming, {
					parties: {
						current: { author: `${who.user}/${who.device}`, time: head.time },
						incoming: {
							author: `${author.user}/${author.device}`,
							time: claimed,
						},
					},
				});
			}
			const text = styled(path, settled.text);
			if (text !== incoming) asSent = false;
			// RULE: a merge whose note would pass the size limit does not happen: `main`'s note stays, and the arriving version lands beside it, as a blob write that lost does (equal texts are one file).
			if (text !== null && bytes(text) > MAX_FILE_BYTES) {
				asSent = false;
				const arriving = styled(path, incoming) as string;
				const placed = besideIt(path, arriving, out, head.tree);
				if (placed === null) return refusal('path-too-long', path, head.id);
				siblings.push({ path, at: placed.at });
				if (placed.write) out.push({ path: placed.at, text: arriving });
				continue;
			}
			if (text !== null) {
				// RULE, the named exception: a merge may not leave a note with more than BLOCK_CAP conflict blocks (a stale-base flood). Past it, any writer's merge is refused, even one whose own change adds the block to others' blocks: its writer holds it with the reason until blocks are resolved.
				if (
					findConflicts(text).length >
					Math.max(
						BLOCK_CAP,
						current === null ? 0 : findConflicts(current).length,
					)
				)
					return refusal('too-many-blocks', path, head.id);
			}
			// Every merge result passes the door too.
			const reason = admissible(path, text);
			if (reason !== null)
				return refusal('inadmissible', path, head.id, reason);
			out.push({ path, text });
			if (settled.blocks) blocks = true;
		}
		const clash = collides(head.tree, out, head.id);
		if (clash !== null) return clash;
		const id = commitId({ parent: head.id, author, time: claimed, files: out });
		advance({ id, parents: [head.id], author, time: claimed, blocks }, out);
		const place = from === null ? undefined : history.placeOf(from);
		// Every path written (in the spelling it lands at), and every sibling: what the writer's device stands on next.
		const touched = [
			...new Set([
				...files.map((f) => history.spelling(f.path) ?? f.path),
				...out.map((f) => f.path),
				...siblings.map((s) => s.at),
			]),
		];
		return {
			kind: asSent ? 'applied' : 'merged',
			main: id,
			commits: place === undefined ? [] : history.idsAfter(place),
			files: byName(
				[
					...(place === undefined
						? []
						: trees.diff(history.at(place).tree, main().tree)),
					...touched,
				],
				main().tree,
			)
				.sort()
				.map(state),
			...(siblings.length === 0 ? {} : { siblings }),
			...(place === undefined ? { stale: true as const } : {}),
		};
	}

	/**
	 * A device's push: the door, then its place in its writer's numbered
	 * pushes, then its writes. RULE: one row per writer's epoch keeps its
	 * last push's seq, hash and answer. That push sent again gets that
	 * answer, exactly; an earlier seq, or this seq with other writes, is a
	 * device behind itself. A rejected request is not a push the writer
	 * made: it is not recorded, and goes again under its seq.
	 */
	function pushInside(
		push: Push,
		session: Session | undefined,
		rate: boolean,
		expect?: Expect,
	): PushAnswer {
		prune();
		const turned = admit(push, session, rate);
		if (turned !== null) return turned;
		const hash = pushHash(push);
		const last = first<{ seq: number; hash: string; answer: string }>(
			store,
			'SELECT seq, hash, answer FROM writers WHERE user = ? AND device = ? AND epoch = ?',
			[push.user, push.device, push.epoch],
		);
		if (last !== undefined) {
			if (push.seq === last.seq && hash === last.hash) {
				const recorded = JSON.parse(last.answer) as PushAnswer;
				const missing = unheld(recorded);
				if (missing.length === 0) return rehydrated(recorded);
				// Only Git has a version it names now: read it, and the writer sends again.
				void read(missing);
				return rejection('reading', main().id);
			}
			if (push.seq <= last.seq) return { kind: 'behind', main: main().id };
		}
		const answer =
			admitFiles(push.files, main().id) ??
			land(push.files, {
				author: { user: push.user, device: push.device },
				time: push.time,
				from: push.from,
				...(expect === undefined ? {} : { expect }),
			});
		if (answer.kind !== 'rejected')
			store.run(
				'INSERT OR REPLACE INTO writers (user, device, epoch, seq, hash, answer) VALUES (?, ?, ?, ?, ?, ?)',
				[
					push.user,
					push.device,
					push.epoch,
					push.seq,
					hash,
					JSON.stringify(
						answer.kind === 'applied' || answer.kind === 'merged'
							? {
									...answer,
									files: answer.files.map(({ content: _, ...file }) => file),
								}
							: answer,
					),
				],
			);
		return answer;
	}

	/**
	 * RULE: a writer's last answer is kept without file contents, so its row
	 * stays small whatever the push carried; sent again, each file's content
	 * is read again by its version, which never changes (from Git, once only
	 * Git has it).
	 */
	function rehydrated(answer: PushAnswer): PushAnswer {
		if (answer.kind !== 'applied' && answer.kind !== 'merged') return answer;
		return {
			...answer,
			files: answer.files.map(({ path, hash }) => {
				const text = hash === null ? null : history.blob(hash);
				return {
					path,
					hash,
					content: text === null ? null : contentOf(text),
				};
			}),
		};
	}
	/** The versions a recorded answer names that the store no longer holds. */
	const unheld = (answer: PushAnswer) =>
		answer.kind !== 'applied' && answer.kind !== 'merged'
			? []
			: answer.files.flatMap(({ hash }) =>
					hash !== null && history.blob(hash) === null ? [hash] : [],
				);

	/**
	 * RULE: the sorted paths of one catch-up (from a place, or everything,
	 * to a commit, plus the paths named), computed once and kept for its
	 * later pages: trees are immutable, so a listing never goes stale.
	 */
	const listings = new Map<string, string[]>();
	function listingOf(
		index: number | undefined,
		target: Stored,
		paths: string[],
	) {
		const key = `${index ?? ''}\0${target.id}\0${paths.join('\0')}`;
		const kept = listings.get(key);
		if (kept !== undefined) return kept;
		const all = new Set(
			index === undefined
				? trees.diff(trees.empty, target.tree)
				: trees.diff(history.at(index).tree, target.tree),
		);
		for (const path of paths) all.add(path);
		const listing = byName(all, target.tree).sort();
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
		apply: (files, { author, time, from }, during) =>
			transact(() => {
				// A `git push` lands as one live commit, under the bounds of any push.
				const head = main().id;
				if (files.length > limits.files)
					return rejection('too-many-files', head);
				if (bytes(JSON.stringify(files)) > limits.request)
					return rejection('too-large', head);
				return land(files, { author, time, from });
			}, during),
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
			const roots = [
				meta.get('git_tree') ?? trees.empty,
				...flusher.joins().flatMap((join) => [join.base, join.tree]),
			];
			for (const { plan } of store.all<{ plan: string }>(
				'SELECT plan FROM journal',
			)) {
				const planned = JSON.parse(plan) as {
					commits: { tree: string }[];
					join?: Join;
				};
				for (const commit of planned.commits) roots.push(commit.tree);
				if (planned.join !== undefined)
					roots.push(planned.join.base, planned.join.tree);
			}
			history.sweep(roots);
		});
	}
	const flushAndCollect = async () => {
		const result = await flusher.flush();
		if (result.kind === 'diverged')
			log?.error(
				ServerDiagnostic.Diverged({
					main: result.main,
					expected: result.expected,
				}),
			);
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

	/** Run `take` in one transaction, then tell the listeners what landed; `during` runs in that transaction once it lands (the receiver's journal row). */
	function transact(
		take: () => PushAnswer,
		during?: (answer: PushAnswer & { kind: 'applied' | 'merged' }) => void,
	): PushAnswer {
		pending = [];
		const answer = store.transaction(() => {
			const answer = take();
			if (answer.kind === 'applied' || answer.kind === 'merged')
				during?.(answer);
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
			return stuck === null
				? { kind: 'live' }
				: { kind: 'diverged', expected: stuck.expected };
		},
		/** The server's clock, as the ISO instant a commit made here carries. */
		time,
		/** The bounds on one push a device sizes its commits to. */
		sizing: () => ({
			request: limits.request,
			files: limits.files,
			blob: limits.blob,
		}),
		/**
		 * Whether `session` may read this repository: any member may. The
		 * reads below (`read`, `catchUp`, `fetch`, `subscribe`) do not check;
		 * the host asks this first, as the wire does for every read.
		 */
		mayRead: (session: Session | undefined) =>
			session !== undefined && session.role !== null,
		/**
		 * Take one read from a member's read bucket (`text`: a text by hash,
		 * a small part of one); false when they should slow down. The host
		 * asks this before each catch-up page, file and text, as the wire does.
		 */
		admitRead: (session: Session, kind: 'read' | 'text' = 'read') =>
			store.transaction(() =>
				take(
					`read\0${session.user}`,
					kind === 'text' ? 1 / TEXTS_PER_READ : 1,
					limits.readBurst,
					limits.readRate,
				),
			),
		/** `main`'s version (Git blob hash) of a file, in any spelling of its path, or null for none. */
		version: (path: string) =>
			trees.read(main().tree, history.spelling(path) ?? path),
		/** `main`'s text at a path, in any spelling of it. */
		read: (path: string) =>
			history.textIn(main().tree, history.spelling(path) ?? path),
		/** Every path and text on `main`, sorted. */
		snapshot: () =>
			new Map(
				trees
					.diff(trees.empty, main().tree)
					.sort()
					.map((path) => [path, history.textIn(main().tree, path) as string]),
			),
		/**
		 * Take a push: land each write on `main`, merged against its base, or
		 * refuse it; its resend gets its recorded answer. `expect` is a
		 * one-file precondition, refused as `the file moved` when it does not
		 * hold. A note written over a version only Git has is answered
		 * `reading` while it is read: a host calls `prepare` first.
		 */
		push: (
			push: Push,
			session?: Session,
			{ expect }: { expect?: Expect } = {},
		) => transact(() => pushInside(push, session, true, expect)),
		/** Read from Git what `push` needs that only Git has (the bases it merges against, or the versions its recorded answer names), so `push` then finds them. */
		prepare: (push: Push) => {
			const last = first<{ seq: number; hash: string; answer: string }>(
				store,
				'SELECT seq, hash, answer FROM writers WHERE user = ? AND device = ? AND epoch = ?',
				[push.user, push.device, push.epoch],
			);
			return read([
				...unread(push.files),
				...(last !== undefined &&
				last.seq === push.seq &&
				last.hash === pushHash(push)
					? unheld(JSON.parse(last.answer) as PushAnswer)
					: []),
			]);
		},
		/**
		 * What changed on `main` since `from`, as a tree diff, plus `paths` the
		 * device names, one page at a time: a later page names `to` (the commit
		 * the first page answered) and `after` (the last path it got). A
		 * position outside the window gets every file. RULE: a later page whose
		 * `to` has left the window answers `restart`, never a page of another
		 * commit: pages of two commits joined would stand a device on one with
		 * the other's texts.
		 */
		catchUp({
			from,
			paths = [],
			to,
			after,
		}: {
			from: string | null;
			paths?: string[];
			to?: string;
			after?: string;
		}): CatchUp {
			store.transaction(prune);
			const toPlace = to === undefined ? undefined : history.placeOf(to);
			if (to !== undefined && toPlace === undefined)
				return {
					main: main().id,
					full: true,
					files: [],
					commits: [],
					next: null,
					restart: true,
				};
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
				files: page.map((path) => ({
					path,
					hash: trees.read(target.tree, path),
				})),
				commits:
					last && !full
						? history.idsAfter(index, target.place ?? history.top())
						: [],
				next: last ? null : (page.at(-1) ?? null),
			};
		},
		/** Versions by hash, as content (a note's text, a blob's bytes): a content-addressed read, never stale. */
		fetch: (hashes: string[]): Record<string, Content> =>
			Object.fromEntries(
				hashes.flatMap((hash) => {
					const text = history.blob(hash);
					return text === null ? [] : [[hash, contentOf(text)]];
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
		upload: (oid: string, size: number) =>
			store.run('INSERT OR IGNORE INTO uploads (oid, size) VALUES (?, ?)', [
				oid,
				size,
			]),
		/** The size of the bytes this server holds as `oid`, or null when it holds none. */
		uploaded: (oid: string) =>
			first<{ size: number }>(store, 'SELECT size FROM uploads WHERE oid = ?', [
				oid,
			])?.size ?? null,
		/**
		 * Why bytes `oid` of `size` may not be uploaded, or null when they
		 * may: past the blob limit, or past the repository's quota with
		 * every blob it holds. Bytes already here cost nothing.
		 */
		uploadRefusal(
			oid: string,
			size: number,
		): 'too-large' | 'over-quota' | null {
			if (size > limits.blob) return 'too-large';
			if (
				first(store, 'SELECT 1 FROM uploads WHERE oid = ?', [oid]) !== undefined
			)
				return null;
			const used =
				first<{ used: number | null }>(
					store,
					'SELECT SUM(size) AS used FROM uploads',
				)?.used ?? 0;
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
		receive: (...args: Parameters<typeof receiver.receive>) =>
			receiver.receive(...args),
		/** Live commits made and kept, answers kept, the texts' bytes and tree nodes kept, and flushes, for tests and the benchmark. */
		history: () => ({
			commits: meta.number('made'),
			kept: history.top() - history.offset() + 1,
			writers:
				first<{ n: number }>(store, 'SELECT COUNT(*) AS n FROM writers')?.n ??
				0,
			bytes:
				first<{ n: number }>(
					store,
					'SELECT COALESCE(SUM(LENGTH(text)), 0) AS n FROM blobs',
				)?.n ?? 0,
			nodes:
				first<{ n: number }>(store, 'SELECT COUNT(*) AS n FROM nodes')?.n ?? 0,
			flushes:
				first<{ n: number }>(store, 'SELECT COUNT(*) AS n FROM flushes')?.n ??
				0,
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
				if (bytes === null)
					throw new Error(`Git's main names a missing blob at ${path}`);
				changes.push([
					path.split('/'),
					history.keep(decoder.decode(bytes), true),
				]);
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
