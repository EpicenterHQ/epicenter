/**
 * The repository's client: a replica of one repository, a clone with a short
 * local branch, kept in one SQLite database over the `SqlDriver` port. It
 * holds no host imports: the host supplies the database, its timer and
 * clock, and a transport (`socket.ts`) that drives it.
 *
 * Per file, four levels: `base` (the text at the commit this device stands
 * on, its position), `sent` (the text in its commit awaiting an answer),
 * `committed` (the text in its unsent commit), and `mine` (what it shows and
 * types into). A save commits the files saved since they last went out, at
 * once, except held text: a text the door refuses, or one the server
 * refused, which stays held with its reason until its writer saves that
 * file again. What one call saves is one group, sent in one commit or not
 * at all: it waits while any file of it is held or owed its bytes, and a
 * later save of a file in a group joins it. One commit is sent at a time, on top of the position, sized
 * to the server's bounds; while one is in flight, or offline, the unsent
 * commit is amended. A request the server rejects (rate, size, who is
 * asking, its form) holds no text: the work stays committed and goes again
 * once the request is fixed.
 *
 * Saves are conditional: `write(path, next, { over })` names the text the
 * caller started from, and if `mine` moved since, the two are merged here,
 * so a stale editor never reverts someone's synced change. `edit(path, fn)`
 * does the same for a synchronous change.
 *
 * There are no stored notices. A person reads two things: the text, whose
 * conflict blocks say what contested, and each file's state (synced,
 * sending, held with a reason). What is held is always a save of the
 * person's own that cannot go, and it holds its call: a text the door
 * refuses, a text the server refused, work whose outcome is unknown, and a
 * save a front end found that the repository cannot take at all (a folder's
 * note that is not UTF-8, a name that folds to another file's, bytes the
 * device could not store), named by its path as found. A delete or field
 * removal that loses to an edit is not held: it is an intent, not typed
 * text, and the edited file (or field) just stays, visibly.
 *
 * The database, every table named with a `/` so an app's views cannot
 * collide with one:
 *
 *   "epicenter/replica"   key and value: the binding (repository, server,
 *                         account), the device's id, the position, the
 *                         next request id
 *   "epicenter/files"     per path: `text` (mine, what the person sees),
 *                         its `fields` and `body` for the app's views, `base`
 *                         and its `hash`, `saved`, `held` (the reason),
 *                         `unknown`, `fold` (the path after NFC and case
 *                         folding, so one spelling finds the other), and
 *                         `call`: the call whose saved or held text it is
 *   "epicenter/unsent"    the unsent commit: per path, its text (null deletes)
 *                         and the call that made it
 *   "epicenter/inflight"  the commit sent and not yet answered, how many
 *                         times it was sent, and each file's call; its files
 *                         are the `sent` level
 *   "epicenter/refused"   saves a front end found that the repository cannot
 *                         take: per path as found (and folded), why, and
 *                         the call
 *   "epicenter/calls"     one row per call (a `writeAll`): its message
 *                         (`epicenter commit -m`), the call it joined when a
 *                         later save met its work, and what became of it:
 *                         the commit that landed it, the paths where its
 *                         delete did not take (`kept`), and those where a
 *                         merge of its work wrote conflict blocks
 *   "epicenter/passed"    recent positions, so a late notification is old
 *   "epicenter/staged"    the pages of a catch-up being gathered: path, hash
 *   "epicenter/fetched"   texts read by hash for that catch-up
 *   "epicenter/objects"   blob bytes the server holds, by oid, at a size
 *
 * A pointer this device made whose bytes the server does not hold is owed:
 * it stays saved here, out of every commit, `sending` with "its bytes are
 * uploading", and so does its group, until the upload track
 * (client/uploads) calls `present`. A refused upload holds it with why, and
 * its group with it; its writer's next save of the path tries again. Owed
 * is derived from these tables, never stored.
 *
 * Every change runs in one transaction, and a request goes out only once
 * the state naming it is stored. No file's text is kept in memory: each is
 * read from the database when a change needs it, and every question about
 * many files (what is saved, held, unsent) is an indexed query, so a
 * replica's memory follows the work in flight, not the repository. What
 * stays in memory is the commit in flight and what a restart does not
 * need: a process starts by catching up, so notifications not yet placed,
 * a catch-up being gathered (its pages and texts staged in the database,
 * cleared when it starts again) and the request awaiting its reply are
 * asked for again.
 *
 * Rules the design does not state are marked `RULE:`.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { commitId, type LiveCommit } from '../core/commit.js';
import { findConflicts } from '../core/conflict.js';
import { admissible, fold, isNote, MAX_BLOB_BYTES } from '../core/door.js';
import { gitBlobHash } from '../core/hash.js';
import type { Lens } from '../core/lens.js';
import { BODY_SQL, parseMarkdown, parsePointer, writeMarkdown } from '../core/markdown.js';
import { appendBlock, settle, settlePointer } from '../core/settle.js';
import type { CatchUp, Event, PushAnswer, RequestCode, TextCode } from '../server/server.js';
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

/**
/**
 * Which repository a replica holds, on which server (its stable id, which
 * the server's hello names; null: none met yet), for which account: the
 * user every hello must name. Null: a repository kept only on this device,
 * which no server's hello passes.
 */
export type Binding = { repository: string; server: string | null; account: string | null };

/** The server's bounds: one push's bytes as JSON and its files, and one blob's bytes. */
export type Sizing = { request: number; files: number; blob: number };

/** What the first exchange of a connection says: where the transport reached (the server's id), the session's user (the account it is signed in as, whom its commits name), `main` there, and the server's bounds on a push. */
export type Hello = { repository: string; server: string; user: string; main: string; limits?: Sizing };

/**
 * One change to a file, made over the text this device shows when it is
 * applied, so a page that started from an older text never reverts a newer
 * one. Every change ends in the same save (merged where the file moved
 * since what the caller started from) and the same rules for what is held.
 */
export type Change =
	/** A new note. A path that holds a note already keeps it and gets this one as one conflict block, as two creates do. */
	| { kind: 'create'; path: string; text: string }
	/** Set fields on the note as it is now (a field set to undefined is removed): its other keys, their formatting and its body stay. */
	| { kind: 'patch'; path: string; fields: Record<string, unknown> }
	| { kind: 'delete'; path: string }
	/** Exact source: `text`, made from `over`; where the file moved since `over`, the two are merged. Without `over`, the caller asserts it started from what this device shows now. */
	| { kind: 'write'; path: string; text: string | null; over?: string | null };

/** What a change answers: each path's text after it, keyed as the caller spelled the path, the revision that change made (or the one already there, if it changed nothing), and its call, whose outcome the replica reports. */
export type Changed = { texts: Record<string, string | null>; revision: number; call: number };

export const ChangeError = defineErrors({
	/** A patch named a path this device shows no file at. */
	NotFound: ({ path }: { path: string }) => ({ message: `There is no note at ${path}`, path }),
	/** A patch named a note whose frontmatter does not parse, so it has no fields to set. */
	Unparseable: ({ path, reason }: { path: string; reason: string }) => ({ message: `The frontmatter of ${path} does not parse: ${reason}`, path, reason }),
});
export type ChangeError = InferErrors<typeof ChangeError>;

export const ReplicaError = defineErrors({
	BoundElsewhere: ({ field, bound, given }: { field: keyof Binding; bound: string | null; given: string | null }) => ({
		message: `This replica holds ${field} ${JSON.stringify(bound)}, not ${JSON.stringify(given)}`,
		field,
		bound,
		given,
	}),
});
export type ReplicaError = InferErrors<typeof ReplicaError>;

/** One file's state, as a person sees it: `reason` says why it is held, or why it is not sending (the server rejected the request). */
export type FileStatus = { status: 'synced' | 'sending' | 'held'; reason?: string };

/**
 * What became of one call (a `writeAll`): `landed` in `commit` (its own
 * commit, or `main` as it found it when nothing of it needed sending), with
 * the paths where a merge of its work wrote conflict blocks and those where
 * its delete did not take (`kept`: an edit beat it, so the file stays);
 * `held`, with its files that hold it and why; or `pending`, in the commit
 * in flight once sent. A call a later save joined is that call's.
 */
export type CallOutcome =
	| { kind: 'landed'; commit: string; conflicts: string[]; kept: string[] }
	| { kind: 'held'; held: { path: string; reason: string }[] }
	| { kind: 'pending'; commit: string | null };

/** The last refusal or rejection of this device's commit, until one lands. */
export type Verdict = { code: TextCode | RequestCode; reason: string };

// ============================================================================
// The database
// ============================================================================

/** Columns added since a table was first made: a database made before them gets them (`addColumns`). */
const COLUMNS = {
	files: 'call INTEGER',
	unsent: 'call INTEGER NOT NULL DEFAULT 0',
	inflight: "calls TEXT NOT NULL DEFAULT '{}'",
} as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS "epicenter/replica" (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS "epicenter/files" (
	path TEXT PRIMARY KEY,
	fold TEXT NOT NULL,
	text TEXT,
	fields TEXT,
	body TEXT GENERATED ALWAYS AS (${BODY_SQL}) VIRTUAL,
	base TEXT,
	hash TEXT,
	saved INTEGER NOT NULL DEFAULT 0,
	held TEXT,
	unknown INTEGER NOT NULL DEFAULT 0,
	${COLUMNS.files}
) STRICT;
CREATE TABLE IF NOT EXISTS "epicenter/unsent" (path TEXT PRIMARY KEY, text TEXT, ${COLUMNS.unsent}) STRICT;
CREATE TABLE IF NOT EXISTS "epicenter/inflight" (id TEXT PRIMARY KEY, commit_json TEXT NOT NULL, attempts INTEGER NOT NULL, ${COLUMNS.inflight}) STRICT;
CREATE TABLE IF NOT EXISTS "epicenter/refused" (path TEXT PRIMARY KEY, fold TEXT NOT NULL, reason TEXT NOT NULL, call INTEGER NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS "epicenter/refused/call" ON "epicenter/refused" (call);
CREATE INDEX IF NOT EXISTS "epicenter/refused/fold" ON "epicenter/refused" (fold);
CREATE TABLE IF NOT EXISTS "epicenter/calls" (id INTEGER PRIMARY KEY, message TEXT, joined INTEGER, landed TEXT, kept TEXT NOT NULL DEFAULT '[]', conflicts TEXT NOT NULL DEFAULT '[]') STRICT;
DROP TABLE IF EXISTS "epicenter/groups";
DROP TABLE IF EXISTS "epicenter/messages";
CREATE TABLE IF NOT EXISTS "epicenter/passed" (id TEXT PRIMARY KEY, n INTEGER NOT NULL UNIQUE) STRICT;
CREATE TABLE IF NOT EXISTS "epicenter/staged" (n INTEGER PRIMARY KEY, path TEXT NOT NULL, hash TEXT, deleted INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS "epicenter/fetched" (hash TEXT PRIMARY KEY, text TEXT NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS "epicenter/files/fold" ON "epicenter/files" (fold);
CREATE INDEX IF NOT EXISTS "epicenter/files/saved" ON "epicenter/files" (path) WHERE saved = 1;
CREATE INDEX IF NOT EXISTS "epicenter/files/held" ON "epicenter/files" (path) WHERE held IS NOT NULL;
CREATE INDEX IF NOT EXISTS "epicenter/files/unknown" ON "epicenter/files" (path) WHERE unknown = 1;
CREATE INDEX IF NOT EXISTS "epicenter/files/unsent" ON "epicenter/files" (path) WHERE text IS NOT base;
CREATE INDEX IF NOT EXISTS "epicenter/files/call" ON "epicenter/files" (call) WHERE call IS NOT NULL;
CREATE INDEX IF NOT EXISTS "epicenter/unsent/call" ON "epicenter/unsent" (call);
CREATE INDEX IF NOT EXISTS "epicenter/staged/path" ON "epicenter/staged" (path);
CREATE TABLE IF NOT EXISTS "epicenter/objects" (oid TEXT PRIMARY KEY, size INTEGER NOT NULL) STRICT;
`;

/**
 * Files whose text is a pointer this device made (not yet `main`'s), not
 * held, whose bytes the server does not hold: owed. Only files with
 * work are read (`"epicenter/files/unsent"`, a partial index), and a note,
 * whose fields may name an `oid`, is never one.
 */
const OWED_WHERE = `f.text IS NOT f.base AND f.held IS NULL AND f.path NOT LIKE '%.md' AND json_extract(f.fields, '$.oid') IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM "epicenter/objects" o WHERE o.oid = json_extract(f.fields, '$.oid'))`;
const OWED_SQL = `FROM "epicenter/files" f WHERE ${OWED_WHERE}`;
/**
 * What keeps call `?1` from going, held first: a save refused where it was
 * found, a held file, or one owed its bytes. A file's text is its saved
 * call's while saved or held, else its unsent commit's.
 */
/** Every held save, with its call: held files, and saves refused where they were found. */
const HELD = `(SELECT path, held AS reason, call FROM "epicenter/files" WHERE held IS NOT NULL UNION ALL SELECT path, reason, call FROM "epicenter/refused")`;
const BLOCKER_SQL = `SELECT path, held FROM (
	SELECT r.path, r.reason AS held, -1 AS n FROM "epicenter/refused" r WHERE r.call = ?1
	UNION ALL
	SELECT f.path, f.held, f.rowid AS n FROM "epicenter/files" f WHERE f.call = ?1 AND (f.held IS NOT NULL OR (${OWED_WHERE}))
	UNION ALL
	SELECT f.path, f.held, f.rowid AS n FROM "epicenter/unsent" u JOIN "epicenter/files" f ON f.path = u.path WHERE u.call = ?1 AND f.call IS NULL AND (${OWED_WHERE})
) ORDER BY held IS NULL, n LIMIT 1`;

/** What a file waiting on its bytes says. */
export const UPLOADING = 'its bytes are uploading';

/** A database made before a column gets it, before the schema indexes it: `fold` (phase 5) filled from each path, and the calls (work from before them is call 0). */
function addColumns(driver: SqlDriver) {
	const columnsOf = (table: string) => driver.all<{ name: string }>(`PRAGMA table_info("${table}")`).map((column) => column.name);
	driver.transaction(() => {
		const files = columnsOf('epicenter/files');
		if (files.length > 0 && !files.includes('fold')) {
			driver.run(`ALTER TABLE "epicenter/files" ADD COLUMN fold TEXT NOT NULL DEFAULT ''`);
			for (const { path } of driver.all<{ path: string }>('SELECT path FROM "epicenter/files"')) driver.run('UPDATE "epicenter/files" SET fold = ? WHERE path = ?', [fold(path), path]);
		}
		for (const [table, column] of Object.entries(COLUMNS)) {
			const have = columnsOf(`epicenter/${table}`);
			if (have.length > 0 && !have.includes(column.split(' ')[0] ?? '')) driver.run(`ALTER TABLE "epicenter/${table}" ADD COLUMN ${column}`);
		}
	});
}

/** A level of a file: its text, null for no file. */
type Level = { text: string | null };
/** Work at a level: its text, and the call that made it. */
type Work = Level & { call: number };

type FileRecord = {
	base: string | null;
	mine: string | null;
	/** In the unsent commit, made by its call. */
	committed?: Work;
	/** Saved since it last went out: the next commit takes it, unless it is held or waits for a held partner. */
	saved?: true;
	/** RULE: held, with why: the person's own text that cannot go. Only a save of this path clears it. */
	held?: { reason: string };
	/** RULE: this work's commit got `outcome-unknown`: the next catch-up puts it beside what is there, never merged blindly. */
	unknown?: true;
	/** RULE: the call whose saved or held text `mine` is: what one call saves commits together (a rename's two halves, a note and its blob), and one file of it held or owed holds them all. */
	call?: number;
};

/** A file as the logic reads it: the stored record and, while its commit is in flight, the text it sent and that commit's call for it. */
type FileView = FileRecord & { sent?: Work };

/** A file as stored, with its base's hash. */
type Stored = FileRecord & { hash: string | null };

/** One file's row and its unsent work, in one read. */
const FILE_SQL = `SELECT f.text, f.base, f.hash, f.saved, f.held, f.unknown, f.call, u.path IS NOT NULL AS committed, u.text AS committed_text, u.call AS committed_call
	FROM "epicenter/files" f LEFT JOIN "epicenter/unsent" u ON u.path = f.path WHERE f.path = ?`;
type FileRow = {
	text: string | null;
	base: string | null;
	hash: string | null;
	saved: number;
	held: string | null;
	unknown: number;
	call: number | null;
	committed: number;
	committed_text: string | null;
	committed_call: number | null;
};

/** Texts a catch-up's pages name that this device lacks: not its base at that path, nor read already. RULE: only the paths a catch-up names, so its cost follows what it names, not the repository; a text held at another path is read. */
const LACKING_SQL = `FROM "epicenter/staged" s LEFT JOIN "epicenter/files" f ON f.path = s.path
	WHERE s.hash IS NOT NULL AND f.hash IS NOT s.hash AND NOT EXISTS (SELECT 1 FROM "epicenter/fetched" x WHERE x.hash = s.hash)`;

/** Recent positions kept, so a late notification is recognized as old. */
const PASSED = 4096;
/** Texts read in one request: a large catch-up reads in several, each with its own timeout. */
const READ_BATCH = 256;
/** Staged files a catch-up applies at a time, so its memory is one page, not the listing. */
const APPLY_PAGE = 512;
/** Texts whose hash is remembered, so a level is hashed once, not at every notification. */
const HASHED = 4_096;

/** What a view reads of a text: a note's frontmatter, or a pointer's oid and size, as JSON. */
function fieldsOf(text: string | null): string | null {
	if (text === null) return null;
	const pointer = parsePointer(text);
	if (pointer !== null) return JSON.stringify(pointer);
	const parsed = parseMarkdown(text);
	return parsed.error === null ? JSON.stringify(parsed.data.fields) : null;
}

const encoder = new TextEncoder();
/** Calls kept after their work is done, so a writer asks about its own call long after it went. */
const CALLS_KEPT = 4_096;

/**
 * Open the replica kept in `driver` for `binding`. A database that holds
 * another repository, account or server is refused; a new one records the
 * binding, and `device` as its device's id. A database keeps the device id
 * it was first given, so a host may pass a fresh one at every open.
 *
 * A replica learns its server once: a binding's server is what is known of
 * it (null: not yet), so a host that does not know it passes null and the
 * database's wins, and the first server known is recorded for good.
 */
export function openReplica(options: Parameters<typeof createReplica>[0]): Result<Replica, ReplicaError> {
	const { driver } = options;
	addColumns(driver);
	driver.exec(SCHEMA);
	const stored = new Map(driver.all<{ key: string; value: string }>(`SELECT key, value FROM "epicenter/replica" WHERE key IN ('repository', 'server', 'account', 'device')`).map(({ key, value }) => [key, value]));
	const binding = { ...options.binding };
	const fresh = stored.size === 0;
	if (!fresh)
		for (const field of ['repository', 'server', 'account'] as const) {
			const bound = JSON.parse(stored.get(field) ?? 'null') as string | null;
			if (field === 'server' && (binding.server === null || bound === null)) binding.server ??= bound;
			else if (bound !== binding[field]) return ReplicaError.BoundElsewhere({ field, bound, given: binding[field] });
		}
	const device = stored.get('device') ?? options.device;
	driver.transaction(() => {
		// A catch-up staged by an earlier process starts again.
		driver.run('DELETE FROM "epicenter/staged"');
		driver.run('DELETE FROM "epicenter/fetched"');
		for (const field of ['repository', 'server', 'account'] as const) driver.run('INSERT OR REPLACE INTO "epicenter/replica" (key, value) VALUES (?, ?)', [field, JSON.stringify(binding[field])]);
		// A database without a device id records this one.
		driver.run('INSERT OR REPLACE INTO "epicenter/replica" (key, value) VALUES (?, ?)', ['device', device]);
	});
	return Ok(createReplica({ ...options, binding, device }));
}

/** How long a replica waits for an answer before it takes a request as lost, by default. */
export const REQUEST_TIMEOUT = 2_000;

function createReplica({
	driver,
	binding,
	device,
	app,
	after,
	now,
	timeout = REQUEST_TIMEOUT,
	gap = 500,
}: {
	driver: SqlDriver;
	binding: Binding;
	device: string;
	/** The app whose views (one per name) read the files this device shows. */
	app?: { lenses: Pick<Lens, 'name' | 'view'>[] };
	/** Run `run` after `ms` (the host's timer). */
	after: (ms: number, run: () => void) => void;
	/** The host's clock, in milliseconds. */
	now: () => number;
	/** A request unanswered this long is taken as lost. */
	timeout?: number;
	/** A notification that cannot be placed this long sends a catch-up. */
	gap?: number;
}) {
	/** Whom this device's commits name: the session's user from the connection's hello; before one, the account. */
	let user = binding.account ?? device;
	for (const lens of app?.lenses ?? []) {
		driver.exec(`DROP VIEW IF EXISTS temp."${lens.name}"`);
		driver.exec(lens.view);
	}

	// --------------------------------------------------------------------------
	// What the database holds: files read where a change needs them
	// --------------------------------------------------------------------------

	const meta = {
		get: (key: string) => first<{ value: string }>(driver, 'SELECT value FROM "epicenter/replica" WHERE key = ?', [key])?.value ?? null,
		set: (key: string, value: string | null) => {
			if (value === null) driver.run('DELETE FROM "epicenter/replica" WHERE key = ?', [key]);
			else driver.run('INSERT OR REPLACE INTO "epicenter/replica" (key, value) VALUES (?, ?)', [key, value]);
		},
	};
	let position: string | null = null;
	let next = 1;
	/** The last refusal or rejection, for a writer awaiting its verdict; cleared when a commit lands. */
	let lastRefusal: Verdict | null = null;
	/** The server's bounds on a push, from the connection's first exchange. */
	let sizing: Sizing | null = null;
	/** RULE: after a commit was rejected as too large, at most this many files go in one. */
	let cap: number | null = null;
	/** A rejection only the person or the account can fix: no commit goes until the next connection. */
	let stalled: Verdict | null = null;
	/** The commit sent and not yet answered: sent again, unchanged, until it is. */
	let inflight: LiveCommit | null = null;
	/** How many times the commit in flight has been sent: once means an `outcome-unknown` answer was a refusal, not a lost landing. */
	let attempts = 0;
	/** The work of the commit in flight, by path: each file's `sent` level, and its call. */
	let sentWork = new Map<string, Work>();
	let passedN = 0;
	/** Counts changes stored: each transaction that changes a file's text or state makes the next one. */
	let revision = 0;

	/** Read what a restart keeps beside the files: the commit in flight, the position, the counters. */
	function load() {
		const flight = first<{ commit_json: string; attempts: number; calls: string }>(driver, 'SELECT commit_json, attempts, calls FROM "epicenter/inflight"');
		inflight = flight === undefined ? null : (JSON.parse(flight.commit_json) as LiveCommit);
		attempts = flight?.attempts ?? 0;
		const calls = JSON.parse(flight?.calls ?? '{}') as Record<string, number>;
		sentWork = new Map(inflight?.files.map((f) => [f.path, { text: f.text, call: calls[f.path] ?? 0 }]));
		position = meta.get('position');
		next = Number(meta.get('next') ?? 1);
		passedN = first<{ n: number | null }>(driver, 'SELECT MAX(n) AS n FROM "epicenter/passed"')?.n ?? 0;
		revision = Number(meta.get('revision') ?? 0);
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
	/** The commit in flight is `commit` now, each file of it made by `calls[path]`; or none. */
	const setInflight = (commit: LiveCommit | null, calls: Record<string, number> = {}) => {
		const before = [...sentWork.keys()];
		for (const path of [...before, ...(commit?.files.map((f) => f.path) ?? [])]) changed.add(path);
		inflight = commit;
		attempts = commit === null ? 0 : 1;
		sentWork = new Map(commit?.files.map((f) => [f.path, { text: f.text, call: calls[f.path] ?? 0 }]));
		driver.run('DELETE FROM "epicenter/inflight"');
		if (commit !== null) driver.run('INSERT INTO "epicenter/inflight" (id, commit_json, attempts, calls) VALUES (?, ?, ?, ?)', [commit.id, JSON.stringify(commit), attempts, JSON.stringify(calls)]);
		// A file whose only level was the text it sent goes with it.
		for (const path of before) {
			const f = stored(path);
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

	/** One file as stored, or undefined when the database has no row for it. */
	function stored(path: string): Stored | undefined {
		const row = first<FileRow>(driver, FILE_SQL, [path]);
		if (row === undefined) return undefined;
		const f: Stored = { base: row.base, mine: row.text, hash: row.hash };
		if (row.saved === 1) f.saved = true;
		if (row.held !== null) f.held = { reason: row.held };
		if (row.unknown === 1) f.unknown = true;
		if (row.committed === 1) f.committed = { text: row.committed_text, call: row.committed_call ?? 0 };
		// Saved or held work from before calls had ids is call 0.
		if (f.saved !== undefined || f.held !== undefined) f.call = row.call ?? 0;
		return f;
	}
	const sentOf = (path: string): Work | undefined => sentWork.get(path);
	const record = (path: string): FileView => {
		const { hash: _, ...f } = stored(path) ?? { base: null, mine: null, hash: null };
		const sent = sentOf(path);
		return sent === undefined ? f : { ...f, sent };
	};
	/** The paths a query names, in its order. */
	const pathsOf = (sql: string, params: SqlValue[] = []) => driver.all<{ path: string }>(sql, params).map((row) => row.path);
	/**
	 * The paths where `where` holds, in order of their first store. Read
	 * unordered and put in order here: asked to order by rowid, SQLite scans
	 * every file in rowid order rather than use a partial index and sort.
	 */
	const pathsWhere = (where: string) =>
		driver
			.all<{ path: string; n: number }>(`SELECT path, rowid AS n FROM "epicenter/files" WHERE ${where}`)
			.sort((a, b) => a.n - b.n)
			.map((row) => row.path);
	/** Files in order of their first store, as the logic reads them, where `where` holds. */
	const filesWhere = (where: string): [string, FileView][] => pathsWhere(where).map((path) => [path, record(path)]);
	/** Files with an unsent commit, in order of their first store. */
	const committedFiles = (): [string, FileView][] =>
		pathsOf('SELECT u.path FROM "epicenter/unsent" u JOIN "epicenter/files" f ON f.path = u.path ORDER BY f.rowid').map((path) => [path, record(path)]);

	/**
	 * Store a file's record (its `sent` level lives in the commit in flight).
	 * RULE: a file is in a call only while it has work there: `call` names
	 * the call of saved or held text, so once the file has neither, it
	 * leaves. Calls are stored as the call each joined, if it joined one.
	 */
	function set(path: string, { sent: _, call: given, ...rest }: FileView) {
		const before = stored(path);
		const next: FileRecord = { ...rest };
		if (next.committed !== undefined) next.committed = { text: next.committed.text, call: callOf(next.committed.call) };
		if ((next.saved !== undefined || next.held !== undefined) && given !== undefined) next.call = callOf(given);
		const empty = next.base === null && next.mine === null && next.committed === undefined && next.held === undefined && next.saved === undefined && !sentWork.has(path);
		if (empty) {
			if (before === undefined) return;
			changed.add(path);
			driver.run('DELETE FROM "epicenter/files" WHERE path = ?', [path]);
			driver.run('DELETE FROM "epicenter/unsent" WHERE path = ?', [path]);
			return;
		}
		const row =
			before === undefined ||
			before.base !== next.base ||
			before.mine !== next.mine ||
			before.saved !== next.saved ||
			before.held?.reason !== next.held?.reason ||
			before.unknown !== next.unknown ||
			before.call !== next.call;
		if (row) {
			changed.add(path);
			const hash = before !== undefined && before.base === next.base ? before.hash : next.base === null ? null : gitBlobHash(next.base);
			const fields = before !== undefined && before.mine === next.mine ? undefined : fieldsOf(next.mine);
			const values: SqlValue[] = [path, fold(path), next.mine, next.base, hash, next.saved ? 1 : 0, next.held?.reason ?? null, next.unknown ? 1 : 0, next.call ?? null];
			if (fields === undefined)
				driver.run(
					'INSERT INTO "epicenter/files" (path, fold, text, base, hash, saved, held, unknown, call) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (path) DO UPDATE SET text = excluded.text, base = excluded.base, hash = excluded.hash, saved = excluded.saved, held = excluded.held, unknown = excluded.unknown, call = excluded.call',
					values,
				);
			else
				driver.run(
					'INSERT INTO "epicenter/files" (path, fold, text, base, hash, saved, held, unknown, call, fields) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (path) DO UPDATE SET text = excluded.text, base = excluded.base, hash = excluded.hash, saved = excluded.saved, held = excluded.held, unknown = excluded.unknown, call = excluded.call, fields = excluded.fields',
					[...values, fields],
				);
		}
		if (before?.committed?.text !== next.committed?.text || before?.committed?.call !== next.committed?.call || (before?.committed === undefined) !== (next.committed === undefined)) {
			changed.add(path);
			if (next.committed === undefined) driver.run('DELETE FROM "epicenter/unsent" WHERE path = ?', [path]);
			else driver.run('INSERT OR REPLACE INTO "epicenter/unsent" (path, text, call) VALUES (?, ?, ?)', [path, next.committed.text, next.committed.call]);
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
	const listeners = new Set<(paths: string[], revision: number) => void>();

	function atomically<T>(fn: () => T): T {
		if (depth > 0) return fn();
		depth++;
		let result: T;
		try {
			result = driver.transaction(() => {
				const value = fn();
				if (changed.size > 0) {
					revision++;
					meta.set('revision', String(revision));
				}
				return value;
			});
		} catch (cause) {
			// Rolled back: what is in memory is read again from what the database kept.
			outgoing.length = 0;
			changed.clear();
			load();
			// A catch-up whose staged pages or texts were rolled back starts again; its reply, when it comes, is late.
			if (gathering !== null || (reading !== null && 'catchUp' in reading)) {
				gathering = null;
				reading = null;
				pending = null;
				needCatchUp = true;
				after(0, () => {
					if (alive) atomically(pump);
				});
			}
			throw cause;
		} finally {
			depth--;
		}
		for (const { to, request } of outgoing.splice(0)) if (to === send) to(request);
		if (changed.size > 0) {
			const paths = [...changed].sort();
			changed.clear();
			for (const listener of listeners) listener(paths, revision);
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
	/** A catch-up being gathered page by page, its files staged in `"epicenter/staged"`: the commit its pages describe. */
	let gathering: Pick<CatchUp, 'main' | 'full'> | null = null;
	/** A catch-up whose texts are being read into `"epicenter/fetched"` (the hashes last asked for), or a notification whose texts are. */
	let reading: { catchUp: Pick<CatchUp, 'main' | 'full' | 'commits'>; asked: string[] } | { event: Event } | null = null;
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

	/** Paths whose text this device made names bytes `oid`. */
	const pointing = (oid: string) => pathsOf(`SELECT path FROM "epicenter/files" WHERE text IS NOT base AND path NOT LIKE '%.md' AND json_extract(fields, '$.oid') = ?`, [oid]);
	/** A pointer whose bytes the server does not hold yet waits here, saved, and its group waits with it. */
	function owes(path: string, f: FileRecord) {
		if (f.held !== undefined || isNote(path) || f.mine === null || f.mine === f.base) return false;
		const pointer = parsePointer(f.mine);
		return pointer !== null && first(driver, 'SELECT 1 FROM "epicenter/objects" WHERE oid = ?', [pointer.oid]) === undefined;
	}

	// --------------------------------------------------------------------------
	// Calls: what one `writeAll` saved, one group
	// --------------------------------------------------------------------------

	/** A new call, saying `message` (or none); calls long done are forgotten as new ones are made. */
	function newCall(message: string | null) {
		driver.run('INSERT INTO "epicenter/calls" (message) VALUES (?)', [message]);
		const call = first<{ id: number }>(driver, 'SELECT last_insert_rowid() AS id')?.id ?? 0;
		if (call % 256 === 0)
			driver.run(
				`DELETE FROM "epicenter/calls" WHERE id <= ? AND id NOT IN (SELECT call FROM "epicenter/files" WHERE call IS NOT NULL) AND id NOT IN (SELECT call FROM "epicenter/unsent") AND id NOT IN (SELECT call FROM "epicenter/refused") AND id NOT IN (SELECT value FROM "epicenter/inflight", json_each("epicenter/inflight".calls))`,
				[call - CALLS_KEPT],
			);
		return call;
	}
	/** The call `call` is now: itself, or the call it joined. */
	function callOf(call: number) {
		for (let at = call; ; ) {
			const joined = first<{ joined: number | null }>(driver, 'SELECT joined FROM "epicenter/calls" WHERE id = ?', [at])?.joined ?? null;
			if (joined === null) return at;
			at = joined;
		}
	}
	/** What a call says: its message (`epicenter commit -m`), or null. */
	const messageOf = (call: number) => first<{ message: string | null }>(driver, 'SELECT message FROM "epicenter/calls" WHERE id = ?', [callOf(call)])?.message ?? null;
	/**
	 * RULE: two calls whose work meets at a file are one group from then on:
	 * `from`'s saved, held and unsent work becomes `into`'s, and the group
	 * says the newer call's message (or the older's, when the newer has
	 * none). A call it had joined before follows it.
	 */
	function join(from: number, into: number) {
		const [older, newer] = [callOf(from), callOf(into)].sort((a, b) => a - b) as [number, number];
		if (older === newer) return;
		const target = callOf(into);
		const source = target === older ? newer : older;
		const message = messageOf(newer) ?? messageOf(older);
		const said = (call: number) => first<{ kept: string; conflicts: string }>(driver, 'SELECT kept, conflicts FROM "epicenter/calls" WHERE id = ?', [call]) ?? { kept: '[]', conflicts: '[]' };
		const union = (a: string, b: string) => JSON.stringify([...new Set([...(JSON.parse(a) as string[]), ...(JSON.parse(b) as string[])])]);
		const [kept, conflicts] = [said(source), said(target)];
		driver.run('UPDATE "epicenter/calls" SET kept = ?, conflicts = ? WHERE id = ?', [union(kept.kept, conflicts.kept), union(kept.conflicts, conflicts.conflicts), target]);
		for (const path of pathsOf('SELECT path FROM "epicenter/files" WHERE call = ? UNION SELECT path FROM "epicenter/unsent" WHERE call = ? UNION SELECT path FROM "epicenter/refused" WHERE call = ?', [source, source, source])) changed.add(path);
		driver.run('UPDATE "epicenter/files" SET call = ? WHERE call = ?', [target, source]);
		driver.run('UPDATE "epicenter/unsent" SET call = ? WHERE call = ?', [target, source]);
		driver.run('UPDATE "epicenter/refused" SET call = ? WHERE call = ?', [target, source]);
		driver.run('UPDATE "epicenter/calls" SET message = ? WHERE id = ?', [message, target]);
		driver.run('UPDATE "epicenter/calls" SET joined = ? WHERE id = ? OR joined = ?', [target, source, source]);
	}

	/** Note of `call` that its work at `path` was a delete that did not take (`kept`), or met a merge that wrote conflict blocks (`conflicts`). */
	function note(call: number, column: 'kept' | 'conflicts', path: string) {
		const id = callOf(call);
		const now = JSON.parse(first<{ list: string }>(driver, `SELECT ${column} AS list FROM "epicenter/calls" WHERE id = ?`, [id])?.list ?? '[]') as string[];
		if (!now.includes(path)) driver.run(`UPDATE "epicenter/calls" SET ${column} = ? WHERE id = ?`, [JSON.stringify([...now, path]), id]);
	}
	const blocksIn = (text: string | null) => (text === null ? 0 : findConflicts(text).length);

	/** What keeps `call` from going: a file of it held, else one owed its bytes; null when nothing does. */
	function blocker(call: number): { path: string; held: boolean } | null {
		const found = first<{ path: string; held: string | null }>(driver, BLOCKER_SQL, [call]);
		return found === undefined ? null : { path: found.path, held: found.held !== null };
	}
	/** Whether a call waits on a file of it, for one pass over many files: each call is asked once. */
	function blockedCalls() {
		const known = new Map<number, boolean>();
		return (call: number) => {
			let blocked = known.get(call);
			if (blocked === undefined) {
				blocked = blocker(call) !== null;
				known.set(call, blocked);
			}
			return blocked;
		};
	}

	/** Whether a file saved and not yet committed can go now. */
	const savedReady = () => {
		const blocked = blockedCalls();
		return driver.all<{ call: number }>('SELECT DISTINCT call FROM "epicenter/files" WHERE saved = 1').some(({ call }) => !blocked(call));
	};

	/** RULE: committed files that can go now: a commit waits while a file of its call is held or owed (a rename's halves, a note and its blob, go together), or while the server asked this member to slow down. */
	const ready = () => {
		if (now() < backoffUntil) return [];
		const blocked = blockedCalls();
		return committedFiles().filter(([, f]) => !blocked(f.committed?.call ?? 0));
	};

	/**
	 * RULE: a commit fits the server's bounds (its bytes as JSON and its
	 * files, and the cap a too-large rejection set): whole calls, in order,
	 * as many as fit, and at least the first. The rest stays committed and
	 * goes in the next commit. The commit says the message of its call, if
	 * that call has one.
	 */
	function sized(going: [string, FileView][]): { files: [string, FileView][]; message: string | null } {
		const files = Math.min(sizing?.files ?? Number.POSITIVE_INFINITY, cap ?? Number.POSITIVE_INFINITY);
		// Room for the commit's id, parent, author and time.
		const request = (sizing?.request ?? Number.POSITIVE_INFINITY) - 1_024;
		const calls = new Map<number, [string, FileView][]>();
		for (const entry of going) {
			const call = entry[1].committed?.call ?? 0;
			const unit = calls.get(call);
			if (unit === undefined) calls.set(call, [entry]);
			else unit.push(entry);
		}
		const taken = new Set<string>();
		let count = 0;
		let size = 0;
		/** RULE: a call with a message is a commit alone, so the message describes exactly what it saved. */
		let said: string | null = null;
		for (const [call, unit] of calls) {
			const message = messageOf(call);
			if (taken.size > 0 && (message !== null || said !== null)) continue;
			const bytes = unit.reduce((sum, [p, f]) => sum + encoder.encode(JSON.stringify({ path: p, text: f.committed?.text ?? null })).length + 1, 0) + (message === null ? 0 : encoder.encode(JSON.stringify(message)).length);
			if (taken.size > 0 && (count + unit.length > files || size + bytes > request)) continue;
			for (const [p] of unit) taken.add(p);
			count += unit.length;
			size += bytes;
			said = message;
		}
		return { files: going.filter(([path]) => taken.has(path)), message: said };
	}

	/**
	 * Cut: take the files saved since they last went out into the unsent commit
	 * (amended while one is in flight or offline). One the door refuses is
	 * held instead, so held text goes only with its own next save.
	 */
	function cut() {
		for (const [path, f] of filesWhere('saved = 1')) {
			const refusal = f.mine === tip(f) ? null : admissible(path, f.mine);
			if (refusal !== null) {
				const { saved: _, ...rest } = f;
				set(path, { ...rest, held: { reason: refusal } });
			}
		}
		const blocked = blockedCalls();
		/** RULE: a commit with a message is never amended: a call that saved over a file whose unsent commit is another call's with a message waits whole until that commit is sent. */
		const waiting = new Set(
			driver
				.all<{ call: number }>(
					'SELECT DISTINCT f.call AS call FROM "epicenter/files" f JOIN "epicenter/unsent" u ON u.path = f.path JOIN "epicenter/calls" c ON c.id = u.call WHERE f.saved = 1 AND u.call IS NOT f.call AND c.message IS NOT NULL',
				)
				.map((row) => row.call),
		);
		for (const [path, f] of filesWhere('saved = 1')) {
			const call = f.call ?? 0;
			if (blocked(call) || waiting.has(call)) continue;
			// RULE: an unsent commit without a message is amended as ever: its call joins the one whose save goes over it, which it then says.
			if (f.committed !== undefined) join(f.committed.call, call);
			const { saved: _, ...rest } = f;
			const under = (f.sent ?? { text: f.base }).text;
			if (f.mine === under) {
				const { committed: __, ...clean } = rest;
				set(path, clean);
			} else set(path, { ...rest, committed: { text: f.mine, call } });
		}
		stats.commits++;
		pump();
	}

	/** Paths equal after NFC and case folding are one path: a save goes to the spelling this device has. */
	function spelled(path: string) {
		const nfc = path.normalize('NFC');
		return first<{ path: string }>(driver, 'SELECT path FROM "epicenter/files" WHERE fold = ? ORDER BY rowid LIMIT 1', [fold(nfc)])?.path ?? nfc;
	}

	/** Saves in a `batch` running now, and whether one of them left a cut to make when it ends. */
	let batching = 0;
	let cutDue = false;
	/**
	 * RULE: saves made together are cut into the unsent commit once, when the
	 * last ends: each call keeps its own group, and the cut is the same as one
	 * after each (an unsent commit without a message is amended as ever), but
	 * its cost is paid once, not per save over every file still waiting.
	 */
	function batch<T>(run: () => T): T {
		return atomically(() => {
			batching++;
			let value: T;
			try {
				value = run();
			} finally {
				batching--;
			}
			if (batching === 0 && cutDue) {
				cutDue = false;
				cut();
			}
			return value;
		});
	}

	/**
	 * Save texts as one call, which says `message` if given: each merged here
	 * with `mine` if `mine` moved since the text the caller started from.
	 * `refused` names saves the caller found at a path (as found) that the
	 * repository cannot take, with why, which hold this call; null: the path
	 * holds one it can take again (or none).
	 */
	function writeAll(
		changes: Record<string, string | null>,
		{ over, message, refused = {} }: { over?: Record<string, string | null>; message?: string; refused?: Record<string, string | null> } = {},
	): Changed {
		return atomically(() => {
			const call = newCall(message ?? null);
			// RULE: a save joins the call of the saved or held text it replaces at its path: a new text over a held file of a group, or over a rename's half not yet committed, still goes with the rest. An unsent commit below it is met when this save is cut (`cut`).
			for (const given of Object.keys(changes)) {
				const f = record(spelled(given));
				if (f.call !== undefined) join(f.call, call);
			}
			// RULE: a save refused where it was found is held in its call like a held file: a later word on its path (a save there, or that it is gone or can be taken) joins that call and ends the refusal.
			for (const path of new Set([...Object.keys(changes), ...Object.keys(refused)])) {
				const was = first<{ call: number }>(driver, 'SELECT call FROM "epicenter/refused" WHERE path = ?', [path]);
				if (was !== undefined) join(was.call, call);
				const reason = refused[path] ?? null;
				if (was === undefined && reason === null) continue;
				changed.add(path);
				if (reason === null) driver.run('DELETE FROM "epicenter/refused" WHERE path = ?', [path]);
				else driver.run('INSERT OR REPLACE INTO "epicenter/refused" (path, fold, reason, call) VALUES (?, ?, ?, ?)', [path, fold(path.normalize('NFC')), reason, call]);
			}
			for (const [given, text] of Object.entries(changes)) {
				const path = spelled(given);
				const { held: _, ...f } = record(path);
				const from = over === undefined || !(given in over) ? f.mine : (over[given] ?? null);
				if (!isNote(path)) {
					// A blob never merges: a write over a blob that moved since `over` is held with why, and its call with it.
					const swapped = from === f.mine ? { text } : settlePointer(from, f.mine, text);
					set(path, 'refused' in swapped ? { ...f, call, mine: text, held: { reason: swapped.refused } } : { ...f, call, mine: swapped.text, saved: true });
					continue;
				}
				const next = from === f.mine ? text : settle(from, f.mine, text, { parties: parties() }).text;
				set(path, { ...f, call, mine: next, saved: true });
			}
			if (batching > 0) cutDue = true;
			else cut();
			// Each text under the path as the caller spelled it; the revision this transaction makes once it commits, if it changed anything.
			return { texts: Object.fromEntries(Object.keys(changes).map((given) => [given, record(spelled(given)).mine])), revision: revision + (changed.size > 0 ? 1 : 0), call };
		});
	}

	/** Apply changes over what this device shows now, in one transaction and one save. */
	function change(changes: Change[]): Result<Changed, ChangeError> {
		return atomically(() => {
			const texts: Record<string, string | null> = {};
			const over: Record<string, string | null> = {};
			/** Each path as the caller spelled it, and as this device stores it. */
			const spellings = new Map<string, string>();
			for (const c of changes) {
				const path = spelled(c.path);
				spellings.set(c.path, path);
				const current = path in texts ? (texts[path] ?? null) : record(path).mine;
				switch (c.kind) {
					case 'create':
						texts[path] = c.text;
						if (!(path in over)) over[path] = null;
						break;
					case 'patch': {
						if (current === null) return ChangeError.NotFound({ path });
						const patched = writeMarkdown(current, { fields: c.fields });
						if (patched.error !== null) return ChangeError.Unparseable({ path, reason: patched.error.reason });
						texts[path] = patched.data;
						if (!(path in over)) over[path] = current;
						break;
					}
					case 'delete':
						texts[path] = null;
						if (!(path in over)) over[path] = current;
						break;
					case 'write':
						texts[path] = c.text;
						if (!(path in over)) over[path] = c.over === undefined ? current : c.over;
						break;
					default:
						c satisfies never;
				}
			}
			const written = writeAll(texts, { over });
			return Ok({ ...written, texts: Object.fromEntries([...spellings].map(([given, path]) => [given, written.texts[path] ?? null])) });
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
			// RULE: a lost read of a catch-up's texts is asked again, keeping the pages and texts gathered.
			if (message.type === 'fetch' && reading !== null && 'catchUp' in reading) return readBatch();
			reading = null;
			gathering = null;
			unstage();
			// A lost push is sent again as it is; a lost catch-up or read is asked again.
			if (message.type !== 'push') needCatchUp = true;
			pump();
		});
	}

	function catchUp() {
		stats.catchUps++;
		needCatchUp = false;
		gathering = null;
		unstage();
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
		const { files: going, message } = stalled === null ? sized(ready()) : { files: [], message: null };
		// RULE: a ready commit goes before reading notifications: its answer brings everything since its parent, and on a busy note there is always another notification.
		if (going.length === 0) {
			if (waiting.has(parent)) place();
			return;
		}
		const body = {
			parent,
			author: { user, device },
			time: new Date(now()).toISOString(),
			files: going.map(([path, f]) => ({ path, text: f.committed?.text ?? null })),
			...(message === null ? {} : { message }),
		};
		const sent: LiveCommit = { id: commitId(body), ...body };
		setInflight(sent, Object.fromEntries(going.map(([path, f]) => [path, f.committed?.call ?? 0])));
		for (const [path, f] of going) {
			const { committed: _, ...rest } = f;
			set(path, rest);
		}
		stats.pushes++;
		request({ type: 'push', rid: takeRid(), commit: sent });
		// A save that waited for this commit to go (it is never amended) is free to commit now.
		if (message !== null && first(driver, 'SELECT 1 FROM "epicenter/files" WHERE saved = 1') !== undefined) cut();
	}

	// ==========================================================================
	// Taking what the server says
	// ==========================================================================

	/**
	 * RULE: paths equal after NFC and case folding are one row, spelled as
	 * `main` spells it. Where `main` has `path` and this device keeps a row of
	 * another spelling for it (its own create, crossing one there), that row
	 * and its work move to `path`, so the work is rebased onto `main`'s text
	 * and never sent over it unseen. A row in the commit awaiting its answer
	 * moves with its sent text, so what was saved over the sent text is
	 * rebased as this device's own: only an answer that lands that commit
	 * reaches such a row, since nothing else is applied while one is in flight.
	 */
	function respell(path: string) {
		if (stored(path) !== undefined) return;
		const other = first<{ path: string }>(driver, 'SELECT path FROM "epicenter/files" WHERE fold = ? AND path != ? ORDER BY rowid LIMIT 1', [fold(path), path])?.path;
		if (other === undefined) return;
		const f = record(other);
		sentWork.delete(other);
		set(other, { base: null, mine: null });
		if (f.sent !== undefined) sentWork.set(path, f.sent);
		set(path, f);
	}

	/** RULE: where a file's unsent and saved work become one held text, their calls join: what holds it holds them both. */
	function oneCall(f: FileView) {
		const call = f.call ?? f.committed?.call ?? 0;
		if (f.committed !== undefined) join(f.committed.call, call);
		return callOf(call);
	}

	/**
	 * A path's text on `main` is now `text`. `landed` when that holds this
	 * device's sent commit, whose text the local work above it was made on.
	 * `deleted` when the path was deleted at some point since this device's base.
	 */
	function integrate(path: string, text: string | null, landed: boolean, deleted = false) {
		if (text !== null) respell(path);
		const f = record(path);
		const own = landed && f.sent !== undefined;
		// A path in the commit awaiting its answer waits for that answer, which brings it.
		if (f.sent !== undefined && !own) return;
		if (f.unknown) {
			// RULE: work whose outcome is unknown is put beside what is there, held for its person, never merged blindly. `mine` is the newest of it: held text typed over the commit is in it too.
			const work = f.mine;
			// A delete is an intent, not typed text: where the path is as this device last had it, nothing landed there and the delete goes again; where it changed, the text stays, as a delete that lost to an edit does.
			if (work === null && text !== null && text === f.base) {
				set(path, { base: text, mine: null, committed: { text: null, call: oneCall(f) } });
				return;
			}
			// RULE: a delete that did not take is named to its call (`kept`): the file stays.
			if (work === null && text !== null) note(oneCall(f), 'kept', path);
			const mine =
				work === text || work === null
					? text
					: text === null
						? work
						: isNote(path)
							? appendBlock(text, work, { current: { author: 'main', time: '-' }, incoming: { author: `${user}/${device}/outcome-unknown`, time: new Date(now()).toISOString() } })
							: work;
			// Held work keeps its call: it goes again with the rest of what was saved with it, or not at all.
			set(path, { base: text, mine, ...(mine === text ? {} : { held: { reason: 'outcome unknown' }, call: oneCall(f) }) });
			return;
		}
		const below = own ? (f.sent?.text ?? null) : f.base;
		// RULE: this device's delete, landed, did not take where `main` still has the file and never deleted it since: an edit, or other bytes, beat it, and the file stays.
		if (own && f.sent?.text === null && text !== null && !deleted) note(f.sent.call, 'kept', path);
		if (!isNote(path)) return integratePointer(path, f, text, below);
		const gone = deleted && !own;
		// Committed work is rebased onto the new text; a delete or removal that loses to an edit leaves the edit.
		let committed: string | null | undefined;
		if (f.committed !== undefined) {
			const rebased = settle(below, text, f.committed.text, { deletedSince: gone, parties: parties() });
			committed = rebased.text;
			if (rebased.blocks) note(f.committed.call, 'conflicts', path);
			if (f.committed.text === null && committed !== null) note(f.committed.call, 'kept', path);
		}
		// Held or waiting text in `mine` is rebased too, and stays held: it goes only with its own save.
		const mineBelow = f.committed !== undefined ? f.committed.text : below;
		const rebased = settle(mineBelow, committed !== undefined ? committed : text, f.mine, { deletedSince: gone && f.committed === undefined, parties: parties() });
		const mine = rebased.text;
		if (f.call !== undefined && rebased.blocks) note(f.call, 'conflicts', path);
		if (f.call !== undefined && f.mine === null && mine !== null) note(f.call, 'kept', path);
		// This device's commit, landed: a merge on the server wrote blocks into it.
		if (own && f.sent !== undefined && blocksIn(text) > blocksIn(f.sent.text)) note(f.sent.call, 'conflicts', path);
		const next: FileRecord = { base: text, mine };
		// `mine` is the newest save: once it is `main`'s text, an older commit below it has nothing left to say.
		if (f.committed !== undefined && committed !== undefined && committed !== text && mine !== text) next.committed = { text: committed, call: f.committed.call };
		if (mine !== text) {
			if (f.held !== undefined) next.held = f.held;
			if (f.saved !== undefined) next.saved = true;
		}
		// The saved or held text keeps its call (set).
		if (f.call !== undefined) next.call = f.call;
		set(path, next);
	}

	/**
	 * A blob path's text on `main` is now `text`, and this device's work on it
	 * was made over `below`. A blob never merges: work lands only where it is
	 * still over what it was made on, as the server's compare-and-swap
	 * answers it (core/settle). A create or replace over a blob that moved is
	 * held with why; a delete over one that moved is dropped, and the file
	 * stays.
	 */
	function integratePointer(path: string, f: FileView, text: string | null, below: string | null) {
		let held = f.held;
		let committed: string | null | undefined;
		/** What `mine` now sits on: the committed work if it still lands, else `main`. */
		let under = text;
		if (f.committed !== undefined) {
			const swapped = settlePointer(below, text, f.committed.text);
			if ('refused' in swapped) held = { reason: swapped.refused };
			else {
				under = swapped.text;
				if (swapped.text !== text) committed = swapped.text;
				if (f.committed.text === null && swapped.text !== null) note(f.committed.call, 'kept', path);
			}
		}
		let mine: string | null;
		// `mine` is the committed work itself: it shares that work's outcome.
		if (f.committed !== undefined && f.mine === f.committed.text) mine = held === undefined ? under : f.mine;
		else {
			// Saved over what it was made on (the committed work, or `below`): settled by the same rule.
			const typed = settlePointer(f.committed !== undefined ? f.committed.text : below, under, f.mine);
			if ('refused' in typed) held = { reason: typed.refused };
			mine = 'refused' in typed ? f.mine : typed.text;
			if (f.call !== undefined && f.mine === null && mine !== null) note(f.call, 'kept', path);
		}
		const next: FileRecord = { base: text, mine };
		if (mine !== text) {
			if (f.committed !== undefined && committed !== undefined) next.committed = { text: committed, call: f.committed.call };
			if (held !== undefined) next.held = held;
			else if (f.saved !== undefined) next.saved = true;
		}
		// Held work holds the call it came from, and its saved text's with it (set).
		if (held !== undefined) next.call = oneCall(f);
		else if (f.call !== undefined) next.call = f.call;
		set(path, next);
	}

	/**
	 * This device's commit is in `main`, which holds `files` at the paths it
	 * touched (`applied`, `merged`, and `flushed` long after). A file sent
	 * under another spelling of a path `main` has is that path's, sent text
	 * and all, before any is taken; then each path takes its own sent text as
	 * landed, so the commit in flight is cleared after.
	 */
	function landed(files: { path: string; text: string | null; deleted?: boolean }[]) {
		if (inflight !== null) for (const call of new Set([...sentWork.values()].map((work) => callOf(work.call)))) driver.run('UPDATE "epicenter/calls" SET landed = ? WHERE id = ?', [inflight.id, call]);
		for (const file of files) if (file.text !== null) respell(file.path);
		for (const file of files) integrate(file.path, file.text, true, file.deleted === true);
		setInflight(null);
	}

	function onLanded(answer: Extract<PushAnswer, { kind: 'applied' | 'merged' }>) {
		if (answer.kind === 'applied') stats.applied++;
		else stats.merged++;
		lastRefusal = null;
		cap = null;
		for (const id of answer.commits) pass(id);
		prune();
		landed(answer.files);
		setPosition(answer.main);
		pass(answer.main);
	}

	/**
	 * The door refused one file's text: that file is held with the reason,
	 * and the rest goes again; what was saved with it stays committed and
	 * waits for it, so its group lands whole or not at all.
	 */
	function onRefused(answer: Extract<PushAnswer, { kind: 'refused' }>) {
		stats.refused++;
		lastRefusal = { code: answer.code, reason: answer.reason };
		// RULE: a writer's refused text is never dropped: what the door refused is held with the reason. Saved again since it was sent (more typing), the refusal judged a text its writer replaced, so the newer save goes, and is judged itself.
		for (const file of inflight?.files ?? []) takeBack(file, file.path === answer.path ? { reason: answer.reason } : null);
		setInflight(null);
	}

	/**
	 * The commit in flight came back unsent (refused, rejected, its outcome
	 * unknown): `file`'s sent work is unsent again, in its call, or held with
	 * `hold`'s reason where nothing newer was committed over it. Newer work
	 * at the file meets it as a later save does: an unsent commit made over
	 * it takes it in, held text joins it, and saved text meets it when cut.
	 */
	function takeBack(file: { path: string; text: string | null }, hold: { reason: string } | null, extra: { unknown?: true } = {}) {
		const { sent: work = { text: file.text, call: 0 }, ...rest } = record(file.path);
		if (hold !== null && rest.committed === undefined) {
			if (rest.call !== undefined) join(work.call, rest.call);
			set(file.path, { ...rest, ...extra, call: rest.call ?? work.call, held: hold });
		} else if (rest.committed !== undefined) {
			join(work.call, rest.committed.call);
			set(file.path, { ...rest, ...extra });
		} else set(file.path, { ...rest, ...extra, committed: work });
	}

	/**
	 * The request was not taken, and no text is at fault: the work stays
	 * committed. RULE: rate waits a second; too large splits the next commit
	 * between groups, never within one (one group too large alone is held
	 * whole: every file of it, still together, so it goes at once or not at
	 * all); anything else only the writer or the account can fix, so
	 * nothing more is sent until the next connection, and the files say why.
	 */
	function onRejected(answer: Extract<PushAnswer, { kind: 'rejected' }>) {
		stats.refused++;
		lastRefusal = { code: answer.code, reason: answer.reason };
		const sent = inflight?.files ?? [];
		/** The commit is one call's work. */
		const alone = sent.length > 0 && new Set([...sentWork.values()].map((work) => callOf(work.call))).size === 1;
		const tooLarge = answer.code === 'too-large' || answer.code === 'too-many-files';
		// The call is too large to go together: it is held whole, so none of it lands without the rest.
		for (const file of sent) takeBack(file, tooLarge && alone ? { reason: `${answer.reason}: what was saved together goes together; save less at once` } : null);
		setInflight(null);
		switch (answer.code) {
			case 'rate':
				backoffUntil = now() + 1_000;
				later(1_000, pump);
				return;
			case 'too-large':
			case 'too-many-files':
				if (!alone) cap = Math.max(1, Math.floor(sent.length / 2));
				return;
			default:
				stalled = { code: answer.code, reason: answer.reason };
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
		for (const file of sent?.files ?? []) takeBack(file, null, once ? {} : { unknown: true });
		setInflight(null);
		if (!once) for (const [path, f] of committedFiles()) set(path, { ...f, unknown: true });
		setPosition(null);
		needCatchUp = true;
	}

	/**
	 * The commit landed long ago and its answer is gone: the texts it touched
	 * are `main`'s now, built on it, and a full catch-up brings the rest.
	 */
	function onFlushed(answer: Extract<PushAnswer, { kind: 'flushed' }>) {
		stats.flushed++;
		landed(answer.files);
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
			case 'rejected':
				onRejected(answer);
				return;
			case 'outcome-unknown':
				onUnknown();
				return;
			default:
				answer satisfies never;
		}
	}

	/** Hashes of texts this device hashed lately, so a level is hashed once, not at every notification. */
	const hashed = new Map<string, string>();
	const hashOf = (text: string) => {
		let hash = hashed.get(text);
		if (hash === undefined) {
			// Bounded: what is held changes, and an old text only costs one more hash.
			if (hashed.size >= HASHED) hashed.clear();
			hash = gitBlobHash(text);
			hashed.set(text, hash);
		}
		return hash;
	};

	/**
	 * Texts this device already holds at `paths`, by hash: each path's base
	 * (whose hash is stored) and its other levels. RULE: only the paths a
	 * notification or catch-up names, so its cost follows what it names, not
	 * the repository; a text held at another path is fetched.
	 */
	function known(paths: Iterable<string>) {
		const texts = new Map<string, string>();
		for (const path of paths) {
			const f = record(path);
			const hash = stored(path)?.hash ?? null;
			if (f.base !== null && hash !== null) texts.set(hash, f.base);
			for (const level of [f.mine, f.sent?.text ?? null, f.committed?.text ?? null]) if (level !== null && level !== f.base) texts.set(hashOf(level), level);
		}
		return texts;
	}
	const named = (listed: { files: { path: string }[] }) => listed.files.map((f) => f.path);
	const missing = (wanted: (string | null)[], have: Map<string, string>) => [...new Set(wanted.filter((h): h is string => h !== null && !have.has(h)))];

	/** Stage one page of a catch-up. */
	function stage(page: CatchUp) {
		for (const file of page.files) driver.run('INSERT INTO "epicenter/staged" (path, hash, deleted) VALUES (?, ?, ?)', [file.path, file.hash, file.deleted === true ? 1 : 0]);
	}
	/** Forget a staged catch-up and the texts read for it. */
	/** Every staged row up to this one needs no text read: the next read of a catch-up's texts looks after it. */
	let lackingAfter = 0;
	function unstage() {
		driver.run('DELETE FROM "epicenter/staged"');
		driver.run('DELETE FROM "epicenter/fetched"');
		lackingAfter = 0;
	}
	/**
	 * The hashes a staged catch-up still lacks, the first `limit` of them.
	 * Texts this device holds at a staged path other than its base (what it
	 * shows, sent or committed: only paths with work, so few) count as read.
	 */
	function lacking(limit: number) {
		const working = new Set([
			...pathsOf('SELECT path FROM "epicenter/staged" WHERE path IN (SELECT path FROM "epicenter/unsent") OR path IN (SELECT path FROM "epicenter/files" WHERE text IS NOT base)'),
			...[...sentWork.keys()].filter((path) => first(driver, 'SELECT 1 FROM "epicenter/staged" WHERE path = ?', [path]) !== undefined),
		]);
		for (const [hash, text] of known(working)) driver.run('INSERT OR IGNORE INTO "epicenter/fetched" (hash, text) VALUES (?, ?)', [hash, text]);
		// From the first row still lacking, not from the first row: each batch reads past the rows before it once, so a catch-up's reads stay linear. A row that lacked a text stays at or after it until read, so a lost read is asked again.
		const rows = driver.all<{ n: number; hash: string }>(`SELECT s.n AS n, s.hash AS hash ${LACKING_SQL} AND s.n > ? ORDER BY s.n LIMIT ?`, [lackingAfter, limit]);
		lackingAfter = (rows[0]?.n ?? lackingAfter + 1) - 1;
		return [...new Set(rows.map((row) => row.hash))];
	}
	/** A staged path's text by hash: its base when that is it, else a text read. */
	function stagedText(path: string, hash: string | null) {
		if (hash === null) return null;
		const base = first<{ base: string | null }>(driver, 'SELECT base FROM "epicenter/files" WHERE path = ? AND hash = ?', [path, hash])?.base;
		return base ?? first<{ text: string }>(driver, 'SELECT text FROM "epicenter/fetched" WHERE hash = ?', [hash])?.text ?? null;
	}

	/** Apply the staged catch-up, a page of files at a time. */
	function applyCatchUp(reply: Pick<CatchUp, 'main' | 'full' | 'commits'>) {
		// RULE (kept by reasoning, no seed reaches it): a text that cannot be found is never taken as a delete, or a later save would write over a text this device never saw.
		if (first(driver, `SELECT 1 ${LACKING_SQL} LIMIT 1`) !== undefined) {
			unstage();
			needCatchUp = true;
			return;
		}
		for (let after = 0; ; ) {
			const page = driver.all<{ n: number; path: string; hash: string | null; deleted: number }>('SELECT n, path, hash, deleted FROM "epicenter/staged" WHERE n > ? ORDER BY n LIMIT ?', [after, APPLY_PAGE]);
			for (const file of page) integrate(file.path, stagedText(file.path, file.hash), false, file.deleted === 1);
			const last = page.at(-1);
			if (last === undefined) break;
			after = last.n;
		}
		// In a full listing, every local file not named is absent.
		if (reply.full)
			// Paths only: each record, its texts with it, is read inside `integrate`, one file at a time.
			for (const path of pathsWhere('(base IS NOT NULL OR unknown = 1) AND path NOT IN (SELECT path FROM "epicenter/staged")')) integrate(path, null, false);
		for (const [path, f] of filesWhere('unknown = 1')) {
			const { unknown: _, ...rest } = f;
			set(path, rest);
		}
		unstage();
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

	/** Read the next batch of a catch-up's texts. */
	function readBatch() {
		if (reading === null || !('catchUp' in reading)) return;
		stats.fetches++;
		reading.asked = lacking(READ_BATCH);
		request({ type: 'fetch', rid: takeRid(), hashes: reading.asked });
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
			const have = known(named(event));
			const absent = missing(
				event.files.map((f) => f.hash),
				have,
			);
			if (absent.length > 0) {
				// A ready commit goes first (see `pump`); one waiting on a held partner is not ready, and must not stop this.
				if (pending !== null || send === null || ready().length > 0) break;
				reading = { event };
				stats.fetches++;
				request({ type: 'fetch', rid: takeRid(), hashes: absent });
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
				// RULE: every page of one catch-up describes one commit: a page of another (the first page's commit left the window between pages) starts it again.
				if (page.restart === true || (gathering !== null && (page.main !== gathering.main || page.full !== gathering.full))) {
					catchUp();
					break;
				}
				stage(page);
				if (page.next !== null) {
					// RULE: a catch-up comes in pages up to the server's limit; the device gathers them, then applies them at once.
					gathering = { main: page.main, full: page.full };
					request({ type: 'catch-up', rid: takeRid(), from: position, paths: [], to: page.main, after: page.next });
					break;
				}
				gathering = null;
				const caught = { main: page.main, full: page.full, commits: page.commits };
				if (lacking(1).length === 0) applyCatchUp(caught);
				else {
					reading = { catchUp: caught, asked: [] };
					readBatch();
				}
				break;
			}
			case 'fetched': {
				const was = reading;
				if (was !== null && 'catchUp' in was) {
					for (const [hash, text] of Object.entries(message.texts)) driver.run('INSERT OR IGNORE INTO "epicenter/fetched" (hash, text) VALUES (?, ?)', [hash, text]);
					// A text the server no longer keeps, or the last batch: apply (which catches up again for a text missing).
					if (was.asked.every((hash) => hash in message.texts) && lacking(1).length > 0) {
						readBatch();
						break;
					}
					reading = null;
					applyCatchUp(was.catchUp);
					place();
					break;
				}
				reading = null;
				const texts = new Map([...(was === null ? [] : known(named(was.event))), ...Object.entries(message.texts)]);
				if (was !== null && was.event.files.some((f) => f.hash !== null && !texts.has(f.hash))) {
					// The server no longer keeps a text the notification names (its commit left the window): catch up instead.
					waiting.delete(was.event.parents[0] ?? '');
					needCatchUp = true;
				} else if (was !== null && position === was.event.parents[0]) applyEvent(was.event, texts);
				place();
				break;
			}
			default:
				message satisfies never;
		}
		pump();
	}

	// Work saved before a restart and not yet committed is committed now.
	if (first(driver, 'SELECT 1 FROM "epicenter/files" WHERE saved = 1') !== undefined) atomically(cut);

	/** One file's state: synced, sending, or held with why. */
	function stateOf(path: string): FileStatus {
		const refused = first<{ reason: string }>(driver, 'SELECT reason FROM "epicenter/refused" WHERE path = ?', [path]);
		if (refused !== undefined) return { status: 'held', reason: refused.reason };
		const f = record(path);
		const reason = heldReason(f);
		if (reason !== null) return { status: 'held', reason };
		if (owes(path, f)) return { status: 'sending', reason: UPLOADING };
		// A path saved with a held or owed one waits for it: say which, and why.
		const waits = (f.call === undefined ? null : blocker(f.call)) ?? (f.committed === undefined ? null : blocker(f.committed.call));
		if (waits !== null) return waits.held ? { status: 'held', reason: `saved with ${waits.path}, which is held` } : { status: 'sending', reason: `saved with ${waits.path}, whose bytes are uploading` };
		if (f.sent === undefined && f.committed === undefined && f.saved === undefined) return { status: 'synced' };
		return stalled === null ? { status: 'sending' } : { status: 'sending', reason: stalled.reason };
	}

	/** Whether `call` has work here: saved or held text, an unsent commit, or the commit in flight. */
	function working(call: number) {
		return (
			first(driver, 'SELECT 1 FROM "epicenter/files" WHERE call = ?1 UNION ALL SELECT 1 FROM "epicenter/unsent" WHERE call = ?1 UNION ALL SELECT 1 FROM "epicenter/refused" WHERE call = ?1 LIMIT 1', [call]) !== undefined ||
			[...sentWork.values()].some((work) => callOf(work.call) === call)
		);
	}

	/** What became of call `id`. A call long done and forgotten landed, as `main` now holds it. */
	function outcomeOf(id: number): CallOutcome {
		const call = callOf(id);
		const row = first<{ landed: string | null; kept: string; conflicts: string }>(driver, 'SELECT landed, kept, conflicts FROM "epicenter/calls" WHERE id = ?', [call]);
		const lists = { conflicts: JSON.parse(row?.conflicts ?? '[]') as string[], kept: JSON.parse(row?.kept ?? '[]') as string[] };
		if (row?.landed != null) return { kind: 'landed', commit: row.landed, ...lists };
		if (!working(call)) return position === null ? { kind: 'pending', commit: null } : { kind: 'landed', commit: position, ...lists };
		if (blocker(call)?.held === true)
			return {
				kind: 'held',
				held: driver.all<{ path: string; reason: string }>(`SELECT path, reason FROM ${HELD} WHERE call = ? ORDER BY path`, [call]),
			};
		const sending = [...sentWork.values()].some((work) => callOf(work.call) === call);
		return { kind: 'pending', commit: sending ? (inflight?.id ?? null) : null };
	}

	return {
		device,
		/** The repository, server and account this replica holds. */
		binding: (): Binding => ({ ...binding }),

		// ------------------------------------------------------------------------
		// The read side: what the person sees
		// ------------------------------------------------------------------------

		/** What this device shows for a path, or null for no file. */
		read: (path: string) => first<{ text: string | null }>(driver, 'SELECT text FROM "epicenter/files" WHERE path = ?', [path])?.text ?? null,
		/** Every path this device shows. */
		paths: () => pathsOf('SELECT path FROM "epicenter/files" WHERE text IS NOT NULL').sort(),
		/** One file's state: synced, sending, or held with why. */
		state: stateOf,
		/** Saves held back, with why: held files, and saves refused where they were found (by their path as found), by path. */
		held: () => driver.all<{ path: string; reason: string }>(`SELECT path, reason FROM ${HELD} ORDER BY path`),
		/** Paths whose text has not reached the server: unsent, in flight, or held. */
		unsent: () =>
			[...new Set([...pathsOf('SELECT path FROM "epicenter/files" WHERE text IS NOT base'), ...pathsOf('SELECT path FROM "epicenter/unsent"'), ...sentWork.keys()])].sort(),
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
		watch(listener: (paths: string[], revision: number) => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		/** Every file's base and mine, and whether it has nothing unsent, for checks: it reads every text, so only tests call it. */
		files: () => new Map(filesWhere('1').map(([path, f]) => [path, { base: f.base, mine: f.mine, tip: tip(f), settled: f.sent === undefined && f.committed === undefined }])),

		// ------------------------------------------------------------------------
		// Writing
		// ------------------------------------------------------------------------

		/**
		 * Save one path: `over` is the text the caller started from (the editor's
		 * loaded text); if `mine` moved since, the two are merged here. Without
		 * `over`, the caller asserts it started from what `read` shows now.
		 */
		write(path: string, next: string | null, { over }: { over?: string | null } = {}) {
			writeAll({ [path]: next }, over === undefined ? {} : { over: { [path]: over } });
		},
		/** Save several paths in one commit (a rename is a delete of the old path and a write of the new one). */
		writeAll,
		/** Make several saves as one transaction, each call its own group, cut into the unsent commit once at the end (a folder's scan hands hundreds). */
		batch,
		/** Apply changes (create, patch, delete, exact source, a body edit) over what this device shows now, in one transaction and one save; each path's resulting text and the revision come back. */
		change,
		/** The revision of the last change stored. */
		revision: () => revision,
		/** Change a path from what it shows now. */
		edit(path: string, change: (text: string | null) => string | null) {
			const text = record(path).mine;
			writeAll({ [path]: change(text) }, { over: { [path]: text } });
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
			first(driver, 'SELECT 1 FROM "epicenter/unsent"') !== undefined ||
			first(driver, `SELECT 1 ${OWED_SQL} LIMIT 1`) !== undefined ||
			savedReady(),
		/** Why this device's last commit was refused or rejected (a writer's verdict), until one lands; or null. */
		lastRefusal: () => lastRefusal,
		/** Why nothing is being sent: a rejection only the person or the account can fix, until the next connection; or null. */
		rejection: () => stalled,
		position: () => position,
		/** The commit sent and not yet answered (its id, message and files), or null. */
		sent: (): LiveCommit | null => inflight,
		/** What became of a call: landed (in which commit), held (by which of its files, and why), or pending. */
		outcome: outcomeOf,
		/** Calls with work here, oldest first, with their messages. */
		calls() {
			const ids = new Set([
				...driver.all<{ call: number }>('SELECT call FROM "epicenter/files" WHERE call IS NOT NULL UNION SELECT call FROM "epicenter/unsent" UNION SELECT call FROM "epicenter/refused"').map((row) => row.call),
				...[...sentWork.values()].map((work) => callOf(work.call)),
			]);
			return [...ids].sort((a, b) => a - b).map((call) => ({ call, message: messageOf(call) }));
		},
		stats: () => ({ ...stats }),

		// ------------------------------------------------------------------------
		// The upload track's side
		// ------------------------------------------------------------------------

		/** The most bytes one blob may hold: the server's limit from its hello, or the default before one. */
		blobLimit: () => sizing?.blob ?? MAX_BLOB_BYTES,
		/** Bytes this device owes the server, each once, oldest first: what the upload track sends. */
		owed: (limit = 64) =>
			driver.all<{ oid: string; size: number }>(
				`SELECT oid, size FROM (SELECT json_extract(f.fields, '$.oid') AS oid, json_extract(f.fields, '$.size') AS size, MIN(f.rowid) AS n ${OWED_SQL} GROUP BY 1) ORDER BY n LIMIT ?`,
				[limit],
			).map(({ oid, size }) => ({ oid, size })),
		/** The server holds bytes `oid` at `size`: every pointer owed them goes in the next commit. */
		present(oid: string, size: number) {
			atomically(() => {
				for (const path of pointing(oid)) changed.add(path);
				driver.run('INSERT OR REPLACE INTO "epicenter/objects" (oid, size) VALUES (?, ?)', [oid, size]);
				cut();
			});
		},
		/**
		 * The server will not take bytes `oid` (too large, over the quota, or
		 * on neither this device nor the server): every pointer owed them is
		 * held with `reason`. Its person's save of the path clears it: a
		 * delete, other bytes, or the same bytes again, which the upload
		 * track then tries again.
		 */
		refused(oid: string, reason: string) {
			atomically(() => {
				for (const path of pointing(oid).filter((owing) => owes(owing, record(owing)))) {
					const { saved: _, ...rest } = record(path);
					set(path, { ...rest, held: { reason } });
				}
			});
		},

		// ------------------------------------------------------------------------
		// The transport's side
		// ------------------------------------------------------------------------

		/**
		 * A connection's first exchange: refused when it reached another
		 * repository, server or account than this replica holds (a replica
		 * that has met no server yet records this one); otherwise a
		 * `main` other than this device's position means it may have missed
		 * something, so it catches up.
		 */
		hello(hello: Hello): Result<undefined, ReplicaError> {
			if (hello.repository !== binding.repository) return ReplicaError.BoundElsewhere({ field: 'repository', bound: binding.repository, given: hello.repository });
			if (hello.user !== binding.account) return ReplicaError.BoundElsewhere({ field: 'account', bound: binding.account, given: hello.user });
			if (binding.server !== null && hello.server !== binding.server) return ReplicaError.BoundElsewhere({ field: 'server', bound: binding.server, given: hello.server });
			if (binding.server === null) {
				// The first server this replica meets is its server for good.
				binding = { ...binding, server: hello.server };
				driver.run('INSERT OR REPLACE INTO "epicenter/replica" (key, value) VALUES (?, ?)', ['server', JSON.stringify(hello.server)]);
			}
			sizing = hello.limits ?? null;
			user = hello.user;
			if (alive && (hello.main !== position || stalled !== null))
				atomically(() => {
					// A new connection may carry a session that fixes a rejection: try again.
					stalled = null;
					if (hello.main !== position) needCatchUp = true;
					pump();
				});
			return Ok(undefined);
		},
		/** Requests can be sent (online), or not (null). */
		attach(sender: ((request: Request) => void) | null) {
			if (!alive) return;
			atomically(() => {
				send = sender;
				// A new connection may carry a session that fixes a rejection: try again.
				if (sender !== null) stalled = null;
				if (sender === null) {
					pending = null;
					reading = null;
					gathering = null;
					unstage();
				}
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
