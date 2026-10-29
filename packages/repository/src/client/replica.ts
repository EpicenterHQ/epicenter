/**
 * Design B's client: a replica of one repository, a clone with a short
 * local branch, kept in one SQLite database over the `SqlDriver` port. It
 * holds no host imports: the host supplies the database, its timer and
 * clock, and a transport (`socket.ts`) that drives it.
 *
 * Per file, four levels: `base` (the text at the commit this device stands
 * on, its position), `sent` (the text in its commit awaiting an answer),
 * `committed` (the text in its unsent commit), and `mine` (what it shows and
 * types into). A save commits the files saved since they last went out, at
 * once, except held text: a text the door refuses, or one the server
 * refused, which stays held with its reason until its person saves that
 * file again. One commit is sent at a time, on top of the position; while
 * one is in flight, or offline, the unsent commit is amended.
 *
 * Saves are conditional: `write(path, next, { over })` names the text the
 * caller started from, and if `mine` moved since, the two are merged here,
 * so a stale editor never reverts someone's synced change. `edit(path, fn)`
 * does the same for a synchronous change.
 *
 * There are no stored notices. A person reads two things: the text, whose
 * conflict blocks say what contested, and each file's state (synced,
 * sending, held with a reason). What is held is always the person's own
 * text: a text the door refuses, a text the server refused, work whose
 * outcome is unknown. A delete or field removal that loses to an edit is not
 * held: it is an intent, not typed text, and the edited file (or field) just
 * stays, visibly.
 *
 * The database, every table named with a `/` so an app's views cannot
 * collide with one:
 *
 *   "epicenter/replica"   key and value: the binding (repository, server,
 *                         account), the position, the next request id, the
 *                         mode of the next commit, the last refusal
 *   "epicenter/files"     per path: `text` (mine, what the person sees),
 *                         its `fields` and `body` for the app's views, `base`
 *                         and its `hash`, `saved`, `held` (the reason), and
 *                         `unknown`
 *   "epicenter/unsent"    the unsent commit: per path, its text (null deletes)
 *   "epicenter/inflight"  the commit sent and not yet answered, and how many
 *                         times it was sent; its files are the `sent` level
 *   "epicenter/groups"    paths saved together (a rename's two halves)
 *   "epicenter/passed"    recent positions, so a late notification is old
 *
 * Every change runs in one transaction, and a request goes out only once
 * the state naming it is stored. What stays in memory is what a restart
 * does not need: a process starts by catching up, so notifications not yet
 * placed, a catch-up being gathered and the request awaiting its reply are
 * asked for again.
 *
 * Rules the design does not state are marked `RULE:`.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { commitId, type LiveCommit } from '../core/commit.js';
import { admissible, fold } from '../core/door.js';
import { gitBlobHash } from '../core/hash.js';
import type { Lens } from '../core/lens.js';
import { BODY_SQL, parseMarkdown, parsePointer } from '../core/markdown.js';
import { appendBlock, settle } from '../core/settle.js';
import type { CatchUp, Event, PushAnswer } from '../server/server.js';
import { first, type SqlDriver, type SqlValue } from '../sql.js';

// ============================================================================
// Protocol
// ============================================================================

/** What a replica asks of the server: a commit, a catch-up page, texts by hash. */
export type Request =
	| { type: 'push'; rid: number; commit: LiveCommit }
	| { type: 'catch-up'; rid: number; from: string | null; paths: string[]; to?: string; after?: string }
	| { type: 'fetch'; rid: number; hashes: string[] };
export type Reply =
	| { type: 'answer'; rid: number; answer: PushAnswer }
	| { type: 'caught-up'; rid: number; catchUp: CatchUp }
	| { type: 'fetched'; rid: number; texts: Record<string, string> };

/** Which repository a replica holds, on which server, for which account (null: a guest's). */
export type Binding = { repository: string; server: string; account: string | null };

/** What the first exchange of a connection says: where the transport reached, as whom, and `main` there. */
export type Hello = Binding & { main: string };

export const ReplicaError = defineErrors({
	BoundElsewhere: ({ field, bound, given }: { field: keyof Binding; bound: string | null; given: string | null }) => ({
		message: `This replica holds ${field} ${JSON.stringify(bound)}, not ${JSON.stringify(given)}`,
		field,
		bound,
		given,
	}),
});
export type ReplicaError = InferErrors<typeof ReplicaError>;

/** One file's state, as a person sees it. */
export type FileStatus = { status: 'synced' | 'sending' | 'held'; reason?: string };

// ============================================================================
// The database
// ============================================================================

const SCHEMA = `
CREATE TABLE IF NOT EXISTS "epicenter/replica" (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS "epicenter/files" (
	path TEXT PRIMARY KEY,
	text TEXT,
	fields TEXT,
	body TEXT GENERATED ALWAYS AS (${BODY_SQL}) VIRTUAL,
	base TEXT,
	hash TEXT,
	saved INTEGER NOT NULL DEFAULT 0,
	held TEXT,
	unknown INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE IF NOT EXISTS "epicenter/unsent" (path TEXT PRIMARY KEY, text TEXT) STRICT;
CREATE TABLE IF NOT EXISTS "epicenter/inflight" (id TEXT PRIMARY KEY, commit_json TEXT NOT NULL, attempts INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS "epicenter/groups" (path TEXT NOT NULL, other TEXT NOT NULL, PRIMARY KEY (path, other)) STRICT;
CREATE TABLE IF NOT EXISTS "epicenter/passed" (id TEXT PRIMARY KEY, n INTEGER NOT NULL UNIQUE) STRICT;
`;

/** A level of a file: its text, null for no file. */
type Level = { text: string | null };

type FileRecord = {
	base: string | null;
	mine: string | null;
	/** In the unsent commit. */
	committed?: Level;
	/** Saved since it last went out: the next commit takes it, unless it is held or waits for a held partner. */
	saved?: true;
	/** RULE: held, with why: the person's own text that cannot go. Only a save of this path clears it. */
	held?: { reason: string };
	/** RULE: this work's commit got `outcome-unknown`: the next catch-up puts it beside what is there, never merged blindly. */
	unknown?: true;
	/** RULE: paths saved with this one (a rename's two halves): they commit together, and one held holds them all. */
	together?: string[];
};

/** A file as the logic reads it: the stored record and, while its commit is in flight, the text it sent. */
type FileView = FileRecord & { sent?: Level };

type FileRow = { path: string; text: string | null; base: string | null; hash: string | null; saved: number; held: string | null; unknown: number };

/** Recent positions kept, so a late notification is recognized as old. */
const PASSED = 4096;

/** What a view reads of a text: a note's frontmatter, or a pointer's oid and size, as JSON. */
function fieldsOf(text: string | null): string | null {
	if (text === null) return null;
	const pointer = parsePointer(text);
	if (pointer !== null) return JSON.stringify(pointer);
	const parsed = parseMarkdown(text);
	return parsed.error === null ? JSON.stringify(parsed.data.fields) : null;
}

const sameGroup = (a: string[] | undefined, b: string[] | undefined) => (a ?? []).join('\0') === (b ?? []).join('\0');

/**
 * Open the replica kept in `driver` for `binding`. A database that holds
 * another repository, server or account is refused; a new one records the
 * binding.
 */
export function openReplica(options: Parameters<typeof createReplica>[0]): Result<Replica, ReplicaError> {
	const { driver, binding } = options;
	driver.exec(SCHEMA);
	const stored = driver.all<{ key: string; value: string }>(`SELECT key, value FROM "epicenter/replica" WHERE key IN ('repository', 'server', 'account')`);
	if (stored.length === 0)
		driver.transaction(() => {
			for (const field of ['repository', 'server', 'account'] as const)
				driver.run('INSERT INTO "epicenter/replica" (key, value) VALUES (?, ?)', [field, JSON.stringify(binding[field])]);
		});
	else
		for (const { key, value } of stored) {
			const field = key as keyof Binding;
			const bound = JSON.parse(value) as string | null;
			if (bound !== binding[field]) return ReplicaError.BoundElsewhere({ field, bound, given: binding[field] });
		}
	return Ok(createReplica(options));
}

function createReplica({
	driver,
	binding,
	device,
	mode = 'merge',
	app,
	after,
	now,
	timeout = 2_000,
	gap = 500,
}: {
	driver: SqlDriver;
	binding: Binding;
	device: string;
	/** How this device's commits meet a `main` that moved: a person's always merge. */
	mode?: 'merge' | 'fast-forward';
	/** The app whose views (one per name) read the files this device shows. */
	app?: { lenses: Lens[] };
	/** Run `run` after `ms` (the host's timer). */
	after: (ms: number, run: () => void) => void;
	/** The host's clock, in milliseconds. */
	now: () => number;
	/** A request unanswered this long is taken as lost. */
	timeout?: number;
	/** A notification that cannot be placed this long sends a catch-up. */
	gap?: number;
}) {
	const user = binding.account ?? device;
	for (const lens of app?.lenses ?? []) {
		driver.exec(`DROP VIEW IF EXISTS temp."${lens.name}"`);
		driver.exec(lens.view);
	}

	// --------------------------------------------------------------------------
	// What the database holds, read once and written through
	// --------------------------------------------------------------------------

	const meta = {
		get: (key: string) => first<{ value: string }>(driver, 'SELECT value FROM "epicenter/replica" WHERE key = ?', [key])?.value ?? null,
		set: (key: string, value: string | null) => {
			if (value === null) driver.run('DELETE FROM "epicenter/replica" WHERE key = ?', [key]);
			else driver.run('INSERT OR REPLACE INTO "epicenter/replica" (key, value) VALUES (?, ?)', [key, value]);
		},
	};
	const files = new Map<string, FileRecord>();
	const hashes = new Map<string, string | null>();
	let position: string | null = null;
	let next = 1;
	let nextMode = mode;
	/** The reason of the last refusal, for an agent awaiting its verdict. */
	let lastRefusal: string | null = null;
	/** The commit sent and not yet answered: sent again, unchanged, until it is. */
	let inflight: LiveCommit | null = null;
	/** How many times the commit in flight has been sent: once means an `outcome-unknown` answer was a refusal, not a lost landing. */
	let attempts = 0;
	/** The texts of the commit in flight, by path: each file's `sent` level. */
	let sentTexts = new Map<string, string | null>();
	let passedN = 0;

	function load() {
		files.clear();
		hashes.clear();
		for (const row of driver.all<FileRow>('SELECT path, text, base, hash, saved, held, unknown FROM "epicenter/files"')) {
			const f: FileRecord = { base: row.base, mine: row.text };
			if (row.saved === 1) f.saved = true;
			if (row.held !== null) f.held = { reason: row.held };
			if (row.unknown === 1) f.unknown = true;
			files.set(row.path, f);
			hashes.set(row.path, row.hash);
		}
		for (const row of driver.all<{ path: string; text: string | null }>('SELECT path, text FROM "epicenter/unsent"')) {
			const f = files.get(row.path);
			if (f !== undefined) f.committed = { text: row.text };
		}
		for (const row of driver.all<{ path: string; other: string }>('SELECT path, other FROM "epicenter/groups" ORDER BY rowid')) {
			const f = files.get(row.path);
			if (f !== undefined) f.together = [...(f.together ?? []), row.other];
		}
		const flight = first<{ commit_json: string; attempts: number }>(driver, 'SELECT commit_json, attempts FROM "epicenter/inflight"');
		inflight = flight === undefined ? null : (JSON.parse(flight.commit_json) as LiveCommit);
		attempts = flight?.attempts ?? 0;
		sentTexts = new Map(inflight?.files.map((f) => [f.path, f.text]));
		position = meta.get('position');
		next = Number(meta.get('next') ?? 1);
		nextMode = (meta.get('mode') as typeof mode | null) ?? mode;
		lastRefusal = meta.get('refusal');
		passedN = first<{ n: number | null }>(driver, 'SELECT MAX(n) AS n FROM "epicenter/passed"')?.n ?? 0;
	}
	load();

	const setPosition = (id: string | null) => {
		position = id;
		meta.set('position', id);
	};
	const takeRid = () => {
		const rid = next++;
		meta.set('next', String(next));
		return rid;
	};
	const setMode = (next: typeof mode) => {
		if (next === nextMode) return;
		nextMode = next;
		meta.set('mode', next === mode ? null : next);
	};
	const setInflight = (commit: LiveCommit | null) => {
		const before = [...sentTexts.keys()];
		for (const path of [...before, ...(commit?.files.map((f) => f.path) ?? [])]) changed.add(path);
		inflight = commit;
		attempts = commit === null ? 0 : 1;
		sentTexts = new Map(commit?.files.map((f) => [f.path, f.text]));
		driver.run('DELETE FROM "epicenter/inflight"');
		if (commit !== null) driver.run('INSERT INTO "epicenter/inflight" (id, commit_json, attempts) VALUES (?, ?, ?)', [commit.id, JSON.stringify(commit), attempts]);
		// A file whose only level was the text it sent goes with it.
		for (const path of before) {
			const f = files.get(path);
			if (f !== undefined) set(path, f);
		}
	};
	const sentAgain = () => {
		attempts++;
		driver.run('UPDATE "epicenter/inflight" SET attempts = ?', [attempts]);
	};

	const pass = (id: string) => {
		passedN++;
		driver.run('INSERT OR REPLACE INTO "epicenter/passed" (id, n) VALUES (?, ?)', [id, passedN]);
		driver.run('DELETE FROM "epicenter/passed" WHERE n <= ?', [passedN - PASSED]);
	};
	const passed = (id: string) => first(driver, 'SELECT 1 FROM "epicenter/passed" WHERE id = ?', [id]) !== undefined;

	const sentOf = (path: string): Level | undefined => (sentTexts.has(path) ? { text: sentTexts.get(path) ?? null } : undefined);
	const record = (path: string): FileView => {
		const f = files.get(path) ?? { base: null, mine: null };
		const sent = sentOf(path);
		return sent === undefined ? f : { ...f, sent };
	};
	/** Every file, as the logic reads it. */
	const all = (): [string, FileView][] => [...files.keys()].map((path) => [path, record(path)]);

	/** Store a file's record (its `sent` level lives in the commit in flight). */
	function set(path: string, { sent: _, ...next }: FileView) {
		const before = files.get(path);
		const empty =
			next.base === null &&
			next.mine === null &&
			next.committed === undefined &&
			next.held === undefined &&
			next.together === undefined &&
			next.saved === undefined &&
			!sentTexts.has(path);
		if (empty) {
			if (before === undefined) return;
			files.delete(path);
			hashes.delete(path);
			changed.add(path);
			driver.run('DELETE FROM "epicenter/files" WHERE path = ?', [path]);
			driver.run('DELETE FROM "epicenter/unsent" WHERE path = ?', [path]);
			driver.run('DELETE FROM "epicenter/groups" WHERE path = ?', [path]);
			return;
		}
		files.set(path, next);
		const row =
			before === undefined ||
			before.base !== next.base ||
			before.mine !== next.mine ||
			before.saved !== next.saved ||
			before.held?.reason !== next.held?.reason ||
			before.unknown !== next.unknown;
		if (row) {
			changed.add(path);
			const hash = before !== undefined && before.base === next.base ? (hashes.get(path) ?? null) : next.base === null ? null : gitBlobHash(next.base);
			hashes.set(path, hash);
			const fields = before !== undefined && before.mine === next.mine ? undefined : fieldsOf(next.mine);
			const values: SqlValue[] = [path, next.mine, next.base, hash, next.saved ? 1 : 0, next.held?.reason ?? null, next.unknown ? 1 : 0];
			if (fields === undefined)
				driver.run(
					'INSERT INTO "epicenter/files" (path, text, base, hash, saved, held, unknown) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (path) DO UPDATE SET text = excluded.text, base = excluded.base, hash = excluded.hash, saved = excluded.saved, held = excluded.held, unknown = excluded.unknown',
					values,
				);
			else
				driver.run(
					'INSERT INTO "epicenter/files" (path, text, base, hash, saved, held, unknown, fields) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (path) DO UPDATE SET text = excluded.text, base = excluded.base, hash = excluded.hash, saved = excluded.saved, held = excluded.held, unknown = excluded.unknown, fields = excluded.fields',
					[...values, fields],
				);
		}
		if (before?.committed?.text !== next.committed?.text || (before?.committed === undefined) !== (next.committed === undefined)) {
			changed.add(path);
			if (next.committed === undefined) driver.run('DELETE FROM "epicenter/unsent" WHERE path = ?', [path]);
			else driver.run('INSERT OR REPLACE INTO "epicenter/unsent" (path, text) VALUES (?, ?)', [path, next.committed.text]);
		}
		if (!sameGroup(before?.together, next.together)) {
			changed.add(path);
			driver.run('DELETE FROM "epicenter/groups" WHERE path = ?', [path]);
			for (const other of next.together ?? []) driver.run('INSERT INTO "epicenter/groups" (path, other) VALUES (?, ?)', [path, other]);
		}
	}

	// --------------------------------------------------------------------------
	// One transaction per change; requests and notices after it commits
	// --------------------------------------------------------------------------

	let send: ((request: Request) => void) | null = null;
	let depth = 0;
	/** Requests made in the transaction running, with the sender they were made for. */
	const outgoing: { to: (request: Request) => void; request: Request }[] = [];
	/** Paths whose text or state changed in the transaction running. */
	const changed = new Set<string>();
	const listeners = new Set<(paths: string[]) => void>();

	function atomically<T>(fn: () => T): T {
		if (depth > 0) return fn();
		depth++;
		let result: T;
		try {
			result = driver.transaction(fn);
		} catch (cause) {
			// Rolled back: what is in memory is read again from what the database kept.
			outgoing.length = 0;
			changed.clear();
			load();
			throw cause;
		} finally {
			depth--;
		}
		for (const { to, request } of outgoing.splice(0)) if (to === send) to(request);
		if (changed.size > 0) {
			const paths = [...changed].sort();
			changed.clear();
			for (const listener of listeners) listener(paths);
		}
		return result;
	}
	/** The host's timer, for this instance only, in a transaction. */
	const later = (ms: number, run: () => void) =>
		after(ms, () => {
			if (alive) atomically(run);
		});

	// --------------------------------------------------------------------------
	// In memory: what a restart asks for again
	// --------------------------------------------------------------------------

	/** Notifications not yet placed, by the commit they follow. */
	const waiting = new Map<string, Event>();
	let pending: { rid: number; kind: Request['type'] } | null = null;
	/** A catch-up being gathered page by page, then its texts read. */
	let gathering: CatchUp | null = null;
	/** A catch-up or notification whose texts are being read. */
	let reading: { catchUp: CatchUp } | { event: Event } | null = null;
	// A process starts by catching up.
	let needCatchUp = true;
	let gapArmed = false;
	let alive = true;
	/** No push before this time: the server asked this member to slow down. */
	let backoffUntil = 0;
	/** Who each side of a block this device writes is: `main` as it arrived, and this device's person, now. */
	const parties = () => ({ current: { author: 'main', time: '-' }, incoming: { author: `${user}/${device}`, time: new Date(now()).toISOString() } });
	const stats = { pushes: 0, applied: 0, merged: 0, refused: 0, catchUps: 0, fetches: 0, timeouts: 0, late: 0, notifications: 0, placed: 0, commits: 0, unknown: 0, flushed: 0 };

	/** What the server will have once this device's commits land. */
	const tip = (f: FileView) => (f.committed ?? f.sent ?? { text: f.base }).text;
	/** Why `mine` is held back, or null when it can go. */
	const heldReason = (f: FileRecord) => f.held?.reason ?? null;

	// ==========================================================================
	// Saving, committing and sending
	// ==========================================================================

	/** Held, or saved together with a path that is held. */
	function blocked(path: string, seen = new Set<string>()): boolean {
		if (seen.has(path)) return false;
		seen.add(path);
		const f = record(path);
		return heldReason(f) !== null || (f.together ?? []).some((other) => blocked(other, seen));
	}

	/** RULE: committed files that can go now: a commit waits while a path saved with it is held (a rename's halves go together), or while the server asked this member to slow down. */
	const ready = () => (now() < backoffUntil ? [] : all().filter(([path, f]) => f.committed !== undefined && !blocked(path)));

	/**
	 * Take the files saved since they last went out into the unsent commit
	 * (amended while one is in flight or offline). One the door refuses is
	 * held instead, so held text goes only with its own next save.
	 */
	function commit() {
		for (const [path, f] of all()) {
			if (f.saved === undefined) continue;
			const refusal = f.mine === tip(f) ? null : admissible(path, f.mine);
			if (refusal !== null) {
				const { saved: _, ...rest } = f;
				set(path, { ...rest, held: { reason: refusal } });
			}
		}
		for (const [path, f] of all()) {
			if (f.saved === undefined || blocked(path)) continue;
			const { saved: _, ...rest } = f;
			const under = (f.sent ?? { text: f.base }).text;
			if (f.mine === under) {
				const { committed: __, ...clean } = rest;
				set(path, clean);
			} else set(path, { ...rest, committed: { text: f.mine } });
		}
		stats.commits++;
		pump();
	}

	/** Save texts: each merged here with `mine` if `mine` moved since the text the caller started from. */
	function writeAll(changes: Record<string, string | null>, { over, commitMode }: { over?: Record<string, string | null>; commitMode?: 'merge' | 'fast-forward' } = {}) {
		atomically(() => {
			// Paths equal after NFC and case folding are one path: a save goes to the spelling this device has.
			const spelled = (path: string) => {
				const nfc = path.normalize('NFC');
				return [...files.keys()].find((known) => fold(known) === fold(nfc)) ?? nfc;
			};
			const paths = Object.keys(changes).map(spelled);
			for (const [given, text] of Object.entries(changes)) {
				const path = spelled(given);
				const { held: _, ...f } = record(path);
				const from = over === undefined || !(given in over) ? f.mine : (over[given] ?? null);
				const next = from === f.mine ? text : settle(from, f.mine, text, { parties: parties() }).text;
				// RULE: a save joins any group the path is already in: a new text over a rename's unsent half must still go with the other half.
				const together = [...new Set([...(f.together ?? []), ...paths.filter((other) => other !== path)])];
				set(path, { ...f, mine: next, saved: true, ...(together.length === 0 ? {} : { together }) });
			}
			if (commitMode !== undefined) setMode(commitMode);
			commit();
		});
	}

	function request(message: Request) {
		if (send === null) return;
		const { rid } = message;
		pending = { rid, kind: message.type };
		outgoing.push({ to: send, request: message });
		later(timeout, () => {
			if (pending?.rid !== rid) return;
			stats.timeouts++;
			pending = null;
			reading = null;
			gathering = null;
			// A lost push is sent again as it is; a lost catch-up or read is asked again.
			if (message.type !== 'push') needCatchUp = true;
			pump();
		});
	}

	function catchUp() {
		stats.catchUps++;
		needCatchUp = false;
		gathering = null;
		request({ type: 'catch-up', rid: takeRid(), from: position, paths: [] });
	}

	function pump() {
		if (!alive || send === null || pending !== null) return;
		if (inflight !== null) {
			stats.pushes++;
			sentAgain();
			request({ type: 'push', rid: takeRid(), commit: inflight });
			return;
		}
		const parent = position;
		if (needCatchUp || parent === null) return catchUp();
		if (reading !== null || gathering !== null) return;
		const going = ready();
		// RULE: a ready commit goes before reading notifications: its answer brings everything since its parent, and on a busy note there is always another notification.
		if (going.length === 0) {
			if (waiting.has(parent)) place();
			return;
		}
		const body = {
			parent,
			mode: nextMode,
			author: { user, device },
			time: new Date(now()).toISOString(),
			files: going.map(([path, f]) => ({ path, text: f.committed?.text ?? null })),
		};
		const sent: LiveCommit = { id: commitId(body), ...body };
		setInflight(sent);
		for (const [path, f] of going) {
			const { committed: _, ...rest } = f;
			set(path, rest);
		}
		setMode(mode);
		stats.pushes++;
		request({ type: 'push', rid: takeRid(), commit: sent });
	}

	// ==========================================================================
	// Taking what the server says
	// ==========================================================================

	/**
	 * A path's text on `main` is now `text`. `landed` when that holds this
	 * device's sent commit, whose text the local work above it was made on.
	 * `deleted` when the path was deleted at some point since this device's base.
	 */
	function integrate(path: string, text: string | null, landed: boolean, deleted = false) {
		const f = record(path);
		const own = landed && f.sent !== undefined;
		// A path in the commit awaiting its answer waits for that answer, which brings it.
		if (f.sent !== undefined && !own) return;
		if (f.unknown) {
			// RULE: work whose outcome is unknown is put beside what is there, held for its person, never merged blindly.
			const work = f.committed !== undefined ? f.committed.text : f.mine;
			const mine =
				work === text
					? text
					: work === null || text === null
						? work
						: appendBlock(text, work, { current: { author: 'main', time: '-' }, incoming: { author: `${user}/${device}/outcome-unknown`, time: new Date(now()).toISOString() } });
			set(path, { base: text, mine, ...(mine === text ? {} : { held: { reason: 'outcome unknown' } }) });
			return;
		}
		const below = own ? (f.sent?.text ?? null) : f.base;
		const gone = deleted && !own;
		// Committed work is rebased onto the new text; a delete or removal that loses to an edit leaves the edit.
		let committed: string | null | undefined;
		if (f.committed !== undefined) committed = settle(below, text, f.committed.text, { deletedSince: gone, parties: parties() }).text;
		// Held or waiting text in `mine` is rebased too, and stays held: it goes only with its own save.
		const mineBelow = f.committed !== undefined ? f.committed.text : below;
		const mine = settle(mineBelow, committed !== undefined ? committed : text, f.mine, { deletedSince: gone && f.committed === undefined, parties: parties() }).text;
		const next: FileRecord = { base: text, mine };
		// `mine` is the newest save: once it is `main`'s text, an older commit below it has nothing left to say.
		if (committed !== undefined && committed !== text && mine !== text) next.committed = { text: committed };
		if (mine !== text) {
			if (f.held !== undefined) next.held = f.held;
			if (f.saved !== undefined) next.saved = true;
		}
		// A group lasts until its own commit lands: while anything of it is unsent here.
		if (f.together !== undefined && (!own || next.committed !== undefined || next.mine !== next.base)) next.together = f.together;
		set(path, next);
	}

	function onLanded(answer: Extract<PushAnswer, { kind: 'applied' | 'merged' }>) {
		if (answer.kind === 'applied') stats.applied++;
		else stats.merged++;
		for (const id of answer.commits) pass(id);
		prune();
		// Each path of the commit takes its own sent text as landed, so the commit in flight is cleared after.
		for (const file of answer.files) integrate(file.path, file.text, true, file.deleted === true);
		setInflight(null);
		setPosition(answer.main);
		pass(answer.main);
	}

	function onRefused(answer: Extract<PushAnswer, { kind: 'refused' }>) {
		stats.refused++;
		const sent = inflight;
		lastRefusal = answer.reason;
		meta.set('refusal', answer.reason);
		for (const file of sent?.files ?? []) {
			const { sent: level, ...rest } = record(file.path);
			if (mode === 'fast-forward') {
				// An agent's change is dropped: it reads again and redoes its task.
				const { committed: _, ...clean } = rest;
				set(file.path, { ...clean, mine: rest.base });
				continue;
			}
			// RULE: a person's refused text is never dropped: what the door refused is held with the reason; the rest goes again.
			const atFault = answer.path === undefined || answer.path === file.path;
			const partner = answer.path !== undefined && (rest.together ?? []).includes(answer.path);
			if (answer.reason !== 'rate' && !atFault && partner) {
				// Saved with the path at fault (a rename's other half): it waits with it, uncommitted.
				const { committed: _, ...clean } = rest;
				set(file.path, { ...clean, saved: true });
			} else if (answer.reason === 'rate' || !atFault) set(file.path, { ...rest, committed: rest.committed ?? level ?? { text: file.text } });
			// RULE: saved again since it was sent (a rename's delete, more typing): the refusal judged a text the person replaced, so the newer save goes, and is judged itself.
			else if (rest.committed !== undefined) set(file.path, rest);
			else {
				const { committed: _, ...clean } = rest;
				set(file.path, { ...clean, held: { reason: answer.reason } });
			}
		}
		setInflight(null);
		if (mode === 'fast-forward') needCatchUp = true;
		if (answer.reason === 'rate') {
			backoffUntil = now() + 1_000;
			later(1_000, pump);
		}
	}

	/**
	 * The server cannot say what became of this commit (its parent or its
	 * outcome left the window). RULE: sent once, it was refused, never landed,
	 * so its work goes back as unsent and merges normally after a full
	 * catch-up; sent more than once, an earlier send may have landed, so its
	 * work is put beside what is there, held.
	 */
	function onUnknown() {
		stats.unknown++;
		const sent = inflight;
		const once = attempts <= 1;
		for (const file of sent?.files ?? []) {
			const { sent: level, ...rest } = record(file.path);
			set(file.path, { ...rest, committed: rest.committed ?? level ?? { text: file.text }, ...(once ? {} : { unknown: true as const }) });
		}
		setInflight(null);
		if (!once) for (const [path, f] of all()) if (f.committed !== undefined) set(path, { ...f, unknown: true });
		setPosition(null);
		needCatchUp = true;
	}

	/**
	 * The commit landed long ago and its answer is gone: the texts it touched
	 * are `main`'s now, built on it, and a full catch-up brings the rest.
	 */
	function onFlushed(answer: Extract<PushAnswer, { kind: 'flushed' }>) {
		stats.flushed++;
		for (const file of answer.files) integrate(file.path, file.text, true);
		setInflight(null);
		setPosition(null);
		needCatchUp = true;
	}

	function onAnswer(answer: PushAnswer) {
		switch (answer.kind) {
			case 'applied':
			case 'merged':
				onLanded(answer);
				place();
				return;
			case 'flushed':
				onFlushed(answer);
				return;
			case 'refused':
				onRefused(answer);
				return;
			case 'outcome-unknown':
				onUnknown();
				return;
			default:
				answer satisfies never;
		}
	}

	/** Texts this device already holds, by hash. */
	function known() {
		const texts = new Map<string, string>();
		for (const [path, f] of all()) {
			const hash = hashes.get(path) ?? null;
			if (f.base !== null && hash !== null) texts.set(hash, f.base);
			for (const level of [f.mine, f.sent?.text ?? null, f.committed?.text ?? null]) if (level !== null) texts.set(gitBlobHash(level), level);
		}
		return texts;
	}
	const missing = (wanted: (string | null)[], have: Map<string, string>) => [...new Set(wanted.filter((h): h is string => h !== null && !have.has(h)))];

	function applyCatchUp(reply: CatchUp, texts: Map<string, string>) {
		// RULE (kept by reasoning, no seed reaches it): a text that cannot be found is never taken as a delete, or a later save would write over a text this device never saw.
		if (reply.files.some((f) => f.hash !== null && !texts.has(f.hash))) {
			needCatchUp = true;
			return;
		}
		const named = new Set(reply.files.map((f) => f.path));
		for (const file of reply.files) integrate(file.path, file.hash === null ? null : (texts.get(file.hash) ?? null), false, file.deleted === true);
		// In a full listing, every local file not named is absent.
		if (reply.full) for (const [path, f] of all()) if (!named.has(path) && (f.base !== null || f.unknown)) integrate(path, null, false);
		for (const [path, f] of all())
			if (f.unknown) {
				const { unknown: _, ...rest } = f;
				set(path, rest);
			}
		for (const id of reply.commits) pass(id);
		setPosition(reply.main);
		pass(reply.main);
		prune();
	}

	function applyEvent(event: Event, texts: Map<string, string>) {
		if (event.files.some((f) => f.hash !== null && !texts.has(f.hash))) return;
		waiting.delete(event.parents[0] ?? '');
		for (const file of event.files) integrate(file.path, file.hash === null ? null : (texts.get(file.hash) ?? null), false);
		setPosition(event.commit);
		pass(event.commit);
		stats.placed++;
	}

	/** Drop waiting notifications for commits already passed: an answer or a catch-up covered them. */
	function prune() {
		for (const [parent, event] of [...waiting]) if (passed(event.commit)) waiting.delete(parent);
	}

	/** Apply waiting notifications that follow the position, reading their texts first. */
	function place() {
		const following = () => (position === null ? undefined : waiting.get(position));
		// RULE: nothing is applied while a commit is in flight (a delete needs no read, so this is not implied); its answer brings everything since its parent.
		// The socket needs this too: notifications of commits before this one arrive before its answer, and would move the position past paths in it, whose changes wait for the answer.
		// RULE: nor while a catch-up is out: its answer names the position it brings, and a notification applied first would have it move the position back.
		// The socket needs this too, between a catch-up's pages, which name the commit the first page answered.
		const catchingUp = () => pending?.kind === 'catch-up' || gathering !== null || (reading !== null && 'catchUp' in reading);
		for (let event = following(); event !== undefined && inflight === null && !catchingUp(); event = following()) {
			const have = known();
			const lacking = missing(
				event.files.map((f) => f.hash),
				have,
			);
			if (lacking.length > 0) {
				// A ready commit goes first (see `pump`); one waiting on a held partner is not ready, and must not stop this.
				if (pending !== null || send === null || ready().length > 0) break;
				reading = { event };
				stats.fetches++;
				request({ type: 'fetch', rid: takeRid(), hashes: lacking });
				return;
			}
			applyEvent(event, have);
		}
		if (waiting.size > 0 && !gapArmed) {
			gapArmed = true;
			later(gap, () => {
				gapArmed = false;
				if (waiting.size === 0 || (position !== null && waiting.has(position))) return;
				needCatchUp = true;
				pump();
			});
		}
	}

	function takeReply(message: Reply) {
		// A reply to a request that timed out is ignored: the request is made again.
		if (pending?.rid !== message.rid) {
			stats.late++;
			return;
		}
		pending = null;
		switch (message.type) {
			case 'answer':
				onAnswer(message.answer);
				break;
			case 'caught-up': {
				const page = message.catchUp;
				const whole: CatchUp = gathering === null ? page : { ...page, files: [...gathering.files, ...page.files] };
				if (page.next !== null) {
					// RULE: a catch-up comes in pages up to the server's limit; the device gathers them, then applies them at once.
					gathering = whole;
					request({ type: 'catch-up', rid: takeRid(), from: position, paths: [], to: page.main, after: page.next });
					break;
				}
				gathering = null;
				const have = known();
				const lacking = missing(
					whole.files.map((f) => f.hash),
					have,
				);
				if (lacking.length === 0) applyCatchUp(whole, have);
				else {
					reading = { catchUp: whole };
					stats.fetches++;
					request({ type: 'fetch', rid: takeRid(), hashes: lacking });
				}
				break;
			}
			case 'fetched': {
				const was = reading;
				reading = null;
				const texts = new Map([...known(), ...Object.entries(message.texts)]);
				if (was !== null && 'catchUp' in was) applyCatchUp(was.catchUp, texts);
				else if (was !== null && position === was.event.parents[0]) applyEvent(was.event, texts);
				place();
				break;
			}
			default:
				message satisfies never;
		}
		pump();
	}

	// Work saved before a restart and not yet committed is committed now.
	if ([...files.values()].some((f) => f.saved !== undefined)) atomically(commit);

	/** One file's state: synced, sending, or held with why. */
	function stateOf(path: string): FileStatus {
		const f = record(path);
		const reason = heldReason(f);
		if (reason !== null) return { status: 'held', reason };
		// A path saved with a held one waits for it: say so, not "sending".
		const partner = f.saved === undefined && f.committed === undefined ? undefined : (f.together ?? []).find((other) => blocked(other));
		if (partner !== undefined) return { status: 'held', reason: `saved with ${partner}, which is held` };
		return f.sent !== undefined || f.committed !== undefined || f.saved !== undefined ? { status: 'sending' } : { status: 'synced' };
	}

	return {
		device,
		/** The repository, server and account this replica holds. */
		binding: (): Binding => ({ ...binding }),

		// ------------------------------------------------------------------------
		// The read side: what the person sees
		// ------------------------------------------------------------------------

		/** What this device shows for a path, or null for no file. */
		read: (path: string) => files.get(path)?.mine ?? null,
		/** Every path this device shows. */
		paths: () =>
			[...files]
				.filter(([, f]) => f.mine !== null)
				.map(([path]) => path)
				.sort(),
		/** One file's state: synced, sending, or held with why. */
		state: stateOf,
		/** Files whose text is held back, with why. */
		held: () =>
			[...files].flatMap(([path, f]) => {
				const reason = heldReason(f);
				return reason === null ? [] : [{ path, reason }];
			}),
		/**
		 * One read-only SQL statement over what this device shows: the
		 * app's views (one per name), or `"epicenter/files"` itself, whose
		 * `text` is what the person sees.
		 */
		query: <TRow = Record<string, SqlValue>>(sql: string, params?: SqlValue[]) => driver.read<TRow>(sql, params),
		/**
		 * Be told, after each change is stored, which paths' text or state
		 * changed; returns the function that stops it.
		 */
		watch(listener: (paths: string[]) => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		/** Every file's base and mine, and whether it has nothing unsent, for checks. */
		files: () => new Map(all().map(([path, f]) => [path, { base: f.base, mine: f.mine, tip: tip(f), settled: f.sent === undefined && f.committed === undefined }])),

		// ------------------------------------------------------------------------
		// Writing
		// ------------------------------------------------------------------------

		/**
		 * Save one path: `over` is the text the caller started from (the editor's
		 * loaded text); if `mine` moved since, the two are merged here. Without
		 * `over`, the caller asserts it started from what `read` shows now.
		 */
		write(path: string, next: string | null, { over, commitMode }: { over?: string | null; commitMode?: 'merge' | 'fast-forward' } = {}) {
			writeAll({ [path]: next }, { ...(over === undefined ? {} : { over: { [path]: over } }), ...(commitMode === undefined ? {} : { commitMode }) });
		},
		/** Save several paths in one commit (a rename is a delete of the old path and a write of the new one). */
		writeAll,
		/** Change a path from what it shows now. */
		edit(path: string, change: (text: string | null) => string | null, options: { commitMode?: 'merge' | 'fast-forward' } = {}) {
			const text = files.get(path)?.mine ?? null;
			writeAll({ [path]: change(text) }, { over: { [path]: text }, ...options });
		},

		// ------------------------------------------------------------------------
		// Sync state
		// ------------------------------------------------------------------------

		/** Whether anything is waiting to send, for an answer, or to be caught up. */
		busy: () =>
			pending !== null ||
			needCatchUp ||
			gathering !== null ||
			inflight !== null ||
			all().some(([path, f]) => f.committed !== undefined || (f.saved !== undefined && !blocked(path))),
		/** Why the last commit was refused (an agent's verdict), or null. */
		lastRefusal: () => lastRefusal,
		position: () => position,
		stats: () => ({ ...stats }),

		// ------------------------------------------------------------------------
		// The transport's side
		// ------------------------------------------------------------------------

		/**
		 * A connection's first exchange: refused when it reached another
		 * repository, server or account than this replica holds; otherwise a
		 * `main` other than this device's position means it may have missed
		 * something, so it catches up.
		 */
		hello(hello: Hello): Result<undefined, ReplicaError> {
			for (const field of ['repository', 'server', 'account'] as const)
				if (hello[field] !== binding[field]) return ReplicaError.BoundElsewhere({ field, bound: binding[field], given: hello[field] });
			if (alive && hello.main !== position) atomically(() => {
				needCatchUp = true;
				pump();
			});
			return Ok(undefined);
		},
		/** Requests can be sent (online), or not (null). */
		attach(sender: ((request: Request) => void) | null) {
			if (!alive) return;
			atomically(() => {
				send = sender;
				if (sender === null) {
					pending = null;
					reading = null;
					gathering = null;
				}
				pump();
			});
		},
		/** The notification stream opened: anything may have been missed, so catch up. */
		streamOpened() {
			if (!alive) return;
			atomically(() => {
				needCatchUp = true;
				pump();
			});
		},
		notify(event: Event) {
			if (!alive) return;
			stats.notifications++;
			const [parent = ''] = event.parents;
			atomically(() => {
				// Old: already passed, or after a position passed that is not this one (history is a line).
				if (passed(event.commit) || (passed(parent) && parent !== position)) return;
				// This device's own commit (or the merge that takes it in) waits like any other: nothing is applied while it is in flight, and its answer passes it.
				waiting.set(parent, event);
				place();
				pump();
			});
		},
		reply(message: Reply) {
			if (!alive) return;
			atomically(() => takeReply(message));
		},
		/** Stop: timers and late messages for this instance do nothing. The database stays open for its owner. */
		close() {
			alive = false;
			listeners.clear();
		},
	};
}

export type Replica = ReturnType<typeof createReplica>;
