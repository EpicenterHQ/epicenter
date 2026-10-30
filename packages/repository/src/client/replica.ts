/**
 * The repository's client: a replica of one repository, a clone with a short
 * local branch, kept in one SQLite database over the `SqlDriver` port. It
 * holds no host imports: the host supplies the database, its timer and
 * clock, and a transport (`socket.ts`) that drives it.
 *
 * Per file, four levels: `base` (the text at the commit this device stands
 * on, its position), `sent` (the text in its commit awaiting an answer),
 * `committed` (the text in its unsent commit), and `mine` (what it shows and
 * types into). The unit is the file. A device has one unsent commit, and
 * a save puts each file it saved there at once (amending what that file had
 * there), except held text: a text the door refuses, or one the server
 * refused, which stays held with its reason until its writer saves that
 * file again. When a commit goes, every file that can go goes: a held file
 * waits alone, with its reason, and a pointer whose bytes the server does
 * not hold yet waits alone for them. Nothing waits for another file. One
 * commit is sent at a time, on top of the position, sized to the server's
 * bounds; while one is in flight, or offline, the unsent commit is amended.
 * A request the server rejects (rate, size, who is asking, its form) holds
 * no text: the work stays committed and goes again once the request is
 * fixed; one file too large to go alone is held with why.
 *
 * Saves are conditional: `write(path, next, { over })` names the text the
 * caller started from, and if `mine` moved since, the two are merged here,
 * so a stale editor never reverts someone's synced change. `edit(path, fn)`
 * does the same for a synchronous change.
 *
 * There are no stored notices. A person reads two things: the text, whose
 * conflict blocks say what contested, and each file's state (synced,
 * sending, held with a reason). What is held is always a save of the
 * person's own that cannot go, and it holds only itself: a text the door
 * refuses, a text the server refused, and a save a front end found that the repository cannot take at all (a folder's
 * note that is not UTF-8, a name that folds to another file's, bytes the
 * device could not store), named by its path as found. A delete or field
 * removal that loses to an edit is not held: it is an intent, not typed
 * text, and the edited file (or field) just stays, visibly. Nor is work
 * whose outcome is unknown: it goes as a labelled conflict block after what
 * is there (a blob, saying what it was made over), and a blob write that
 * lost lands beside its file, at a sibling the server names.
 *
 * The database, every table named with a `/` so an app's views cannot
 * collide with one:
 *
 *   "epicenter/replica"   key and value: the binding (repository, server,
 *                         account), the device's id, the position, the
 *                         next request id
 *   "epicenter/files"     per file, one row: `path` (as written, the one
 *                         fact of its name) and `fold`, an index derived
 *                         from it (the path after NFC and case folding:
 *                         paths equal after them are one file), `text` (mine, what the person sees), its `fields`
 *                         and `body` for the app's views, `base` and its
 *                         `hash`, `saved`, `held` (the reason) and `unknown`
 *   "epicenter/unsent"    the unsent commit: per file (by `fold`), its text
 *                         (null deletes)
 *   "epicenter/inflight"  the commit sent and not yet answered, and how many
 *                         times it was sent; its files are the `sent` level
 *   "epicenter/refused"   saves a front end found that the repository cannot
 *                         take: per path as found (and folded), and why
 *   "epicenter/passed"    recent positions, so a late notification is old
 *   "epicenter/staged"    the pages of a catch-up being gathered: path (and
 *                         fold), hash
 *   "epicenter/fetched"   texts read by hash for that catch-up
 *   "epicenter/objects"   blob bytes the server holds, by oid, at a size
 *   "epicenter/landed"    how each file this device sent last landed
 *
 * A file's spelling is fixed when it is created: it has the spelling `main`
 * has for it, or the one it was made under when `main` has none. A save
 * through any spelling of its path is a save of it, and leaves its
 * spelling, a delete and a create before the delete lands included. Only a
 * file created after its delete landed takes a new spelling.
 *
 * A pointer this device made whose bytes the server does not hold is owed:
 * it stays in the unsent commit, out of every commit sent, `sending` with
 * "its bytes are uploading", until the upload track (client/uploads) calls
 * `present`. A refused upload holds it with why; its writer's next save of
 * the path tries again. Owed is derived from these tables, never stored.
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
import {
	type Content,
	contentOf,
	type Next,
	type Push,
	pushHash,
	storedText,
	textOf,
} from '../core/commit.js';
import { findConflicts } from '../core/conflict.js';
import {
	admissible,
	fold,
	isNote,
	MAX_BLOB_BYTES,
	onlyAPersonFixes,
} from '../core/door.js';
import { gitBlobHash } from '../core/hash.js';
import type { Lens } from '../core/lens.js';
import {
	BODY_SQL,
	parseMarkdown,
	parsePointer,
	writeMarkdown,
} from '../core/markdown.js';
import { appendBlock, settle, settlePointer } from '../core/settle.js';
import type {
	CatchUp,
	Event,
	FileState,
	PushAnswer,
	RequestCode,
	TextCode,
} from '../server/server.js';
import { first, type SqlDriver, type SqlValue } from '../sql.js';

// ============================================================================
// Protocol
// ============================================================================

/** What a replica asks of the server: a push, a catch-up page, versions by hash. */
export type Request =
	| { type: 'push'; rid: number; push: Push }
	| {
			type: 'catch-up';
			rid: number;
			from: string | null;
			paths: string[];
			to?: string;
			after?: string;
	  }
	| { type: 'fetch'; rid: number; hashes: string[] };
export type Reply =
	| { type: 'answer'; rid: number; answer: PushAnswer }
	| { type: 'caught-up'; rid: number; catchUp: CatchUp }
	/** Versions by hash, as content: a blob's bytes, never its pointer's text. */
	| { type: 'fetched'; rid: number; versions: Record<string, Content> };

/**
/**
 * Which repository a replica holds, on which server (its stable id, which
 * the server's hello names; null: none met yet), for which account: the
 * user every hello must name. Null: a repository kept only on this device,
 * which no server's hello passes.
 */
export type Binding = {
	repository: string;
	server: string | null;
	account: string | null;
};

/** The server's bounds: one push's bytes as JSON and its files, and one blob's bytes. */
export type Sizing = { request: number; files: number; blob: number };

/** What the first exchange of a connection says: where the transport reached (the server's id), the session's user (the account it is signed in as, whom its commits name), `main` there, and the server's bounds on a push. */
export type Hello = {
	repository: string;
	server: string;
	user: string;
	main: string;
	limits?: Sizing;
};

/**
 * One change to a file, made over the text this device shows when it is
 * applied, so a page that started from an older text never reverts a newer
 * one. Every change ends in the same save (merged where the file moved
 * since what the caller started from) and the same rules for what is held.
 */
export type Change =
	/** A new note. A path that holds a note already keeps it and gets this one as one conflict block, as two creates do. */
	| { kind: 'create'; path: string; text: string }
	/** Set fields on the note as it is now (a field set to undefined is removed): its other keys, their formatting and its body stay; a note with no parseable frontmatter gains a header before its whole text. */
	| { kind: 'patch'; path: string; fields: Record<string, unknown> }
	| { kind: 'delete'; path: string }
	/** Exact source: `text`, made from `over`; where the file moved since `over`, the two are merged. Without `over`, the caller asserts it started from what this device shows now. */
	| { kind: 'write'; path: string; text: string | null; over?: string | null };

/** What a change answers: each path's text after it, keyed as the caller spelled the path, and the revision that change made (or the one already there, if it changed nothing). */
export type Changed = {
	texts: Record<string, string | null>;
	revision: number;
};

export const ChangeError = defineErrors({
	/** A patch named a path this device shows no file at. */
	NotFound: ({ path }: { path: string }) => ({
		message: `There is no note at ${path}`,
		path,
	}),
});
export type ChangeError = InferErrors<typeof ChangeError>;

export const ReplicaError = defineErrors({
	BoundElsewhere: ({
		field,
		bound,
		given,
	}: {
		field: keyof Binding;
		bound: string | null;
		given: string | null;
	}) => ({
		message: `This replica holds ${field} ${JSON.stringify(bound)}, not ${JSON.stringify(given)}`,
		field,
		bound,
		given,
	}),
});
export type ReplicaError = InferErrors<typeof ReplicaError>;

/** One file's state, as a person sees it: `reason` says why it is held, or why it is not sending (the server rejected the request). */
/**
 * One file's state on this device: synced; sending; waiting, with why (the
 * system clears it: bytes to upload, a size or bound); or refused, with why
 * (only a person can fix it: core/door's `onlyAPersonFixes`).
 */
export type FileStatus =
	| { status: 'synced' }
	| { status: 'sending'; reason?: string }
	| { status: 'waiting' | 'refused'; reason: string };

/**
 * How a file this device sent landed: as sent (`landed`), with conflict
 * blocks, beside it at a sibling the server named, or a delete that did not
 * take (the file was changed elsewhere, and stays).
 */
export type Outcome =
	| { kind: 'landed' }
	| { kind: 'blocks' }
	| { kind: 'sibling'; at: string }
	| { kind: 'delete-did-not-take' };

/** The last refusal or rejection of this device's commit, until one lands. */
export type Verdict = { code: TextCode | RequestCode; reason: string };

// ============================================================================
// The database
// ============================================================================

/** `fold` columns are indexes over a path, written only as `fold(path)` (`putFile`, `putUnsent`, `putLanded`, `stage`). */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS "epicenter/replica" (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS "epicenter/files" (
	fold TEXT PRIMARY KEY,
	path TEXT NOT NULL,
	text TEXT,
	fields TEXT,
	body TEXT GENERATED ALWAYS AS (${BODY_SQL}) VIRTUAL,
	base TEXT,
	hash TEXT,
	made TEXT,
	saved INTEGER NOT NULL DEFAULT 0,
	held TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS "epicenter/files/path" ON "epicenter/files" (path);
CREATE TABLE IF NOT EXISTS "epicenter/unsent" (fold TEXT PRIMARY KEY, text TEXT, base TEXT) STRICT;
CREATE TABLE IF NOT EXISTS "epicenter/inflight" (hash TEXT PRIMARY KEY, push_json TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS "epicenter/refused" (path TEXT PRIMARY KEY, fold TEXT NOT NULL, reason TEXT NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS "epicenter/refused/fold" ON "epicenter/refused" (fold);
CREATE TABLE IF NOT EXISTS "epicenter/passed" (id TEXT PRIMARY KEY, n INTEGER NOT NULL UNIQUE) STRICT;
CREATE TABLE IF NOT EXISTS "epicenter/staged" (n INTEGER PRIMARY KEY, path TEXT NOT NULL, fold TEXT NOT NULL, hash TEXT) STRICT;
CREATE TABLE IF NOT EXISTS "epicenter/fetched" (hash TEXT PRIMARY KEY, text TEXT NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS "epicenter/files/saved" ON "epicenter/files" (path) WHERE saved = 1;
CREATE INDEX IF NOT EXISTS "epicenter/files/held" ON "epicenter/files" (path) WHERE held IS NOT NULL;
CREATE INDEX IF NOT EXISTS "epicenter/files/unsent" ON "epicenter/files" (path) WHERE text IS NOT base;
CREATE INDEX IF NOT EXISTS "epicenter/staged/fold" ON "epicenter/staged" (fold);
CREATE TABLE IF NOT EXISTS "epicenter/objects" (oid TEXT PRIMARY KEY, size INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS "epicenter/landed" (fold TEXT PRIMARY KEY, path TEXT NOT NULL, outcome TEXT NOT NULL) STRICT;
`;

/**
 * Files whose text is a pointer this device made (not yet `main`'s), not
 * held, whose bytes the server does not hold: owed. Only files with
 * work are read (`"epicenter/files/unsent"`, a partial index), and a note,
 * whose fields may name an `oid`, is never one. `main`'s own pointer is
 * owed again once a change of this device's lands over it: `ready` checks
 * each committed pointer against the base when it goes, and nothing goes
 * while a commit is in flight.
 */
const OWED_WHERE = `f.text IS NOT f.base AND f.held IS NULL AND f.path NOT LIKE '%.md' AND json_extract(f.fields, '$.oid') IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM "epicenter/objects" o WHERE o.oid = json_extract(f.fields, '$.oid'))`;
const OWED_SQL = `FROM "epicenter/files" f WHERE ${OWED_WHERE}`;
/** Every held save: held files, and saves refused where they were found. */
const HELD = `(SELECT path, held AS reason FROM "epicenter/files" WHERE held IS NOT NULL UNION ALL SELECT path, reason FROM "epicenter/refused")`;

/** What a file waiting on its bytes says. */
export const UPLOADING = 'its bytes are uploading';

/** A text's version: its Git blob hash, or null for no file. */
const versionOf = (text: string | null) =>
	text === null ? null : gitBlobHash(text);

/**
 * A database made before the schema it opens with gets it, before the
 * schema indexes it: the call columns and tables (phase 9c) dropped, since
 * a file is no call's; files kept per spelling kept by name (`byName`); the
 * levels made before each write carried its base given one (`withBases`); a
 * catch-up's scratch made again; the body a view reads made again where its
 * rule changed.
 */
function migrate(driver: SqlDriver) {
	const columnsOf = (table: string) =>
		driver
			.all<{ name: string }>(`PRAGMA table_info("${table}")`)
			.map((column) => column.name);
	driver.transaction(() => {
		driver.run('DROP INDEX IF EXISTS "epicenter/refused/call"');
		for (const [table, column] of [
			['refused', 'call'],
			['inflight', 'calls'],
		] as const)
			if (columnsOf(`epicenter/${table}`).includes(column))
				driver.run(`ALTER TABLE "epicenter/${table}" DROP COLUMN ${column}`);
		for (const table of ['calls', 'groups', 'messages'])
			driver.run(`DROP TABLE IF EXISTS "epicenter/${table}"`);
		// A catch-up staged before is gathered again at open: its table is made again with the fold, and without the deletes a base no longer needs.
		const staged = columnsOf('epicenter/staged');
		if (!staged.includes('fold') || staged.includes('deleted'))
			driver.run('DROP TABLE IF EXISTS "epicenter/staged"');
		// Files kept one row per spelling (before one row per name) were not keyed by their fold.
		const keyed = driver
			.all<{ name: string; pk: number }>('PRAGMA table_info("epicenter/files")')
			.find((column) => column.name === 'fold');
		if (
			keyed !== undefined
				? keyed.pk === 0
				: columnsOf('epicenter/files').length > 0
		)
			byName(driver);
		else if (columnsOf('epicenter/files').includes('over')) withBases(driver);
		// The body a view reads is what follows the header, by position, whether or not it parses (phase 9g, then merge by kind): the generated column is made again.
		const made = first<{ sql: string }>(
			driver,
			`SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'epicenter/files'`,
		)?.sql;
		if (made !== undefined && !made.includes(BODY_SQL)) {
			driver.run('ALTER TABLE "epicenter/files" DROP COLUMN body');
			driver.run(
				`ALTER TABLE "epicenter/files" ADD COLUMN body TEXT GENERATED ALWAYS AS (${BODY_SQL}) VIRTUAL`,
			);
		}
	});
}

/**
 * A file as it was kept before each write carried its base: `over` (a
 * blob's write known to have lost: JSON, absent meaning the base), the
 * `unknown` mark of work whose outcome the server could not say, and a
 * `renamed` mark (piece 1), with the commit in flight by id.
 */
type OldRow = {
	path: string;
	text: string | null;
	fields: string | null;
	base: string | null;
	hash: string | null;
	saved: number;
	held: string | null;
	unknown?: number;
	over?: string | null;
};
/** RULE: what an old level was made over: its `over` where it said, else the file's base; work whose outcome was unknown, over a base it cannot know (none). */
const madeOf = (row: OldRow, over: string | null | undefined) =>
	row.unknown === 1
		? null
		: over !== null && over !== undefined
			? versionOf(JSON.parse(over) as string | null)
			: (row.hash ?? versionOf(row.base));

/** Old rows, their unsent level and the commit in flight, as kept now: one row per name, every level with its base. */
function rebuild(
	driver: SqlDriver,
	rows: OldRow[],
	unsent: Map<string, { text: string | null; over?: string | null }>,
	landed: { path: string; outcome: string }[],
) {
	const inflight =
		first(driver, 'SELECT 1 FROM sqlite_schema WHERE name = ?', [
			'epicenter/inflight',
		]) === undefined
			? []
			: driver.all<{ commit_json?: string }>(
					'SELECT * FROM "epicenter/inflight"',
				);
	for (const table of ['files', 'unsent', 'landed', 'inflight'])
		driver.run(`DROP TABLE IF EXISTS "epicenter/${table}"`);
	driver.exec(SCHEMA);
	const byFold = new Map(rows.map((row) => [fold(row.path), row]));
	for (const row of rows) {
		// Work whose outcome was unknown goes over no base: the device cannot know whether it landed.
		const base = row.unknown === 1 ? null : row.base;
		putFile(driver, row.path, {
			text: row.text,
			fields: row.fields,
			base,
			hash: row.unknown === 1 ? null : row.hash,
			made: madeOf(row, row.over),
			saved: row.saved,
			held: row.held,
		});
	}
	for (const [key, level] of unsent) {
		const row = byFold.get(key);
		if (row !== undefined)
			putUnsent(driver, row.path, {
				text: level.text,
				base: madeOf(row, level.over),
			});
	}
	// RULE: the commit in flight when the device was upgraded goes again as unsent work, over the base it was made on; work committed since stays, continuing it.
	for (const { commit_json } of inflight) {
		if (commit_json === undefined) continue;
		const sent = JSON.parse(commit_json) as {
			files: { path: string; text: string | null; over?: string | null }[];
		};
		for (const file of sent.files) {
			const row = byFold.get(fold(file.path));
			if (row === undefined || unsent.has(fold(file.path))) continue;
			putUnsent(driver, row.path, {
				text: file.text,
				base: madeOf(row, file.over),
			});
		}
	}
	for (const { path, outcome } of landed) putLanded(driver, path, outcome);
}

/** The tables of one database, as their rows, or none where it has no such table. */
const rowsOf = <T>(driver: SqlDriver, table: string) =>
	first(driver, 'SELECT 1 FROM sqlite_schema WHERE name = ?', [
		`epicenter/${table}`,
	]) === undefined
		? []
		: driver.all<T>(`SELECT * FROM "epicenter/${table}"`);

/** One row per name already: every level given the base it was made over. */
function withBases(driver: SqlDriver) {
	const rows = driver.all<OldRow>(
		'SELECT * FROM "epicenter/files" ORDER BY rowid',
	);
	const unsent = new Map(
		rowsOf<{ fold: string; text: string | null; over?: string | null }>(
			driver,
			'unsent',
		).map((u) => [u.fold, u]),
	);
	driver.run('DROP INDEX IF EXISTS "epicenter/files/unknown"');
	rebuild(
		driver,
		rows,
		unsent,
		rowsOf<{ path: string; outcome: string }>(driver, 'landed'),
	);
}

/** A file's row but its path and the index over it. `fields` undefined: as stored. */
type FileColumns = {
	text: string | null;
	fields?: string | null;
	base: string | null;
	hash: string | null;
	made: string | null;
	saved: number;
	held: string | null;
};
const FILE_COLUMNS = ['text', 'base', 'hash', 'made', 'saved', 'held'] as const;

/**
 * Store one file's row. RULE: a file's one stored fact is its path, as
 * written; `fold` is an index over it (paths equal after NFC and case
 * folding are one file), written only by these three functions and always
 * as `fold(path)`, so no path and key can disagree. A column, not an
 * expression index: NFC is no SQLite function, and an app-defined one
 * would make the schema unreadable on a host without it.
 */
function putFile(driver: SqlDriver, path: string, row: FileColumns) {
	const columns = [
		...FILE_COLUMNS,
		...(row.fields === undefined ? [] : (['fields'] as const)),
	];
	driver.run(
		`INSERT INTO "epicenter/files" (fold, path, ${columns.join(', ')}) VALUES (?, ?, ${columns.map(() => '?').join(', ')}) ON CONFLICT (fold) DO UPDATE SET path = excluded.path, ${columns.map((c) => `${c} = excluded.${c}`).join(', ')}`,
		[fold(path), path, ...columns.map((c) => row[c] ?? null)],
	);
}
/** Store a file's unsent level, or none, under the index over its path. */
function putUnsent(driver: SqlDriver, path: string, level: Level | undefined) {
	if (level === undefined)
		driver.run('DELETE FROM "epicenter/unsent" WHERE fold = ?', [fold(path)]);
	else
		driver.run(
			'INSERT OR REPLACE INTO "epicenter/unsent" (fold, text, base) VALUES (?, ?, ?)',
			[fold(path), level.text, level.base],
		);
}
/** Store how a file this device sent landed, under the index over its path. */
function putLanded(driver: SqlDriver, path: string, outcome: string) {
	driver.run(
		'INSERT OR REPLACE INTO "epicenter/landed" (fold, path, outcome) VALUES (?, ?, ?)',
		[fold(path), path, outcome],
	);
}

/**
 * Files kept one row per spelling (before one row per name) become one row
 * per name: the files, their unsent level and how each landed, in the order
 * first stored. RULE: of several rows of one name, the first stored stays
 * (every save went to it); another's work (a note's text that is not its
 * base) goes after its text as one labelled conflict block, saved, so it is
 * sent, never merged blindly.
 */
function byName(driver: SqlDriver) {
	const kept = new Map<string, OldRow & { blocked?: true }>();
	for (const row of driver.all<OldRow>(
		'SELECT * FROM "epicenter/files" ORDER BY rowid',
	)) {
		const key = fold(row.path);
		const one = kept.get(key);
		if (one === undefined) kept.set(key, row);
		else if (
			row.text !== null &&
			row.text !== row.base &&
			row.text !== one.text &&
			isNote(one.path)
		) {
			one.text =
				one.text === null
					? row.text
					: appendBlock(one.text, row.text, {
							current: { author: 'main', time: '-' },
							incoming: { author: `${row.path} as kept`, time: '-' },
						});
			one.saved = 1;
			one.blocked = true;
		}
	}
	const unsent = new Map<
		string,
		{ text: string | null; over?: string | null }
	>();
	for (const u of rowsOf<{
		path: string;
		text: string | null;
		over?: string | null;
	}>(driver, 'unsent'))
		if (kept.get(fold(u.path))?.path === u.path) unsent.set(fold(u.path), u);
	rebuild(
		driver,
		[...kept.values()].map(({ blocked, ...row }) =>
			blocked ? { ...row, fields: fieldsOf(row.text) } : row,
		),
		unsent,
		rowsOf<{ path: string; outcome: string }>(driver, 'landed'),
	);
}

/** A level of a file: its text (null for no file) and the version it was made over (its base, a Git blob hash; null for none). */
type Level = { text: string | null; base: string | null };

/** Each file's `sent` level in a push, by fold, as stored (a blob's pointer). */
const levelsOf = (push: Push | null) =>
	new Map<string, Level>(
		push?.files.map((f) => [
			fold(f.path),
			{ text: storedText(f.next), base: f.base },
		]),
	);

type FileRecord = {
	/** The spelling of its path the file has (absent: no row yet, so the one it is given). */
	spelling?: string;
	base: string | null;
	mine: string | null;
	/**
	 * The version `mine` was made over: the base's for a note (its work is
	 * rebased as `main` moves), and for a blob the version its writer saw,
	 * which a blob keeps until the server judges it (undefined: the base's).
	 */
	made?: string | null;
	/** In the unsent commit. */
	committed?: Level;
	/** Saved since it last went out: the next cut takes it into the unsent commit, or holds it. */
	saved?: true;
	/** RULE: held, with why: the person's own text that cannot go. Only a save of this path clears it. */
	held?: { reason: string };
};

/** A file as the logic reads it: the stored record and, while its push is in flight, the level it sent. */
type FileView = FileRecord & { sent?: Level };

/** A file as stored, with its spelling and its base's hash. */
type Stored = FileRecord & { spelling: string; hash: string | null };

/** One file's row and its unsent work, in one read. */
const FILE_SQL = `SELECT f.path, f.text, f.base, f.hash, f.made, f.saved, f.held, u.fold IS NOT NULL AS committed, u.text AS committed_text, u.base AS committed_base
	FROM "epicenter/files" f LEFT JOIN "epicenter/unsent" u ON u.fold = f.fold WHERE f.fold = ?`;
type FileRow = {
	path: string;
	text: string | null;
	base: string | null;
	hash: string | null;
	made: string | null;
	saved: number;
	held: string | null;
	committed: number;
	committed_text: string | null;
	committed_base: string | null;
};

/** Texts a catch-up's pages name that this device lacks: not its base at that path, nor read already. RULE: only the paths a catch-up names, so its cost follows what it names, not the repository; a text held at another path is read. */
const LACKING_SQL = `FROM "epicenter/staged" s LEFT JOIN "epicenter/files" f ON f.fold = s.fold
	WHERE s.hash IS NOT NULL AND f.hash IS NOT s.hash AND NOT EXISTS (SELECT 1 FROM "epicenter/fetched" x WHERE x.hash = s.hash)`;

/** Recent positions kept, so a late notification is recognized as old. */
const PASSED = 4096;
/** Texts read in one request: a large catch-up reads in several, each with its own timeout. */
const READ_BATCH = 256;
/** Staged files a catch-up applies at a time, so its memory is one page, not the listing. */
const APPLY_PAGE = 512;
/** Texts whose hash is remembered, so a level is hashed once, not at every notification. */
const HASHED = 4_096;

/** What a view reads of a text: a note's fields (null where its header is missing or does not parse), or a pointer's oid and size, as JSON. */
function fieldsOf(text: string | null): string | null {
	if (text === null) return null;
	const pointer = parsePointer(text);
	if (pointer !== null) return JSON.stringify(pointer);
	const parsed = parseMarkdown(text);
	return parsed.hasFrontmatter ? JSON.stringify(parsed.fields) : null;
}

const encoder = new TextEncoder();

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
export function openReplica(
	options: Parameters<typeof createReplica>[0],
): Result<Replica, ReplicaError> {
	const { driver } = options;
	migrate(driver);
	driver.exec(SCHEMA);
	const stored = new Map(
		driver
			.all<{ key: string; value: string }>(
				`SELECT key, value FROM "epicenter/replica" WHERE key IN ('repository', 'server', 'account', 'device')`,
			)
			.map(({ key, value }) => [key, value]),
	);
	const binding = { ...options.binding };
	const fresh = stored.size === 0;
	if (!fresh)
		for (const field of ['repository', 'server', 'account'] as const) {
			const bound = JSON.parse(stored.get(field) ?? 'null') as string | null;
			if (field === 'server' && (binding.server === null || bound === null))
				binding.server ??= bound;
			else if (bound !== binding[field])
				return ReplicaError.BoundElsewhere({
					field,
					bound,
					given: binding[field],
				});
		}
	const device = stored.get('device') ?? options.device;
	driver.transaction(() => {
		// A catch-up staged by an earlier process starts again.
		driver.run('DELETE FROM "epicenter/staged"');
		driver.run('DELETE FROM "epicenter/fetched"');
		for (const field of ['repository', 'server', 'account'] as const)
			driver.run(
				'INSERT OR REPLACE INTO "epicenter/replica" (key, value) VALUES (?, ?)',
				[field, JSON.stringify(binding[field])],
			);
		// A database without a device id records this one.
		driver.run(
			'INSERT OR REPLACE INTO "epicenter/replica" (key, value) VALUES (?, ?)',
			['device', device],
		);
	});
	return Ok(createReplica({ ...options, binding, device }));
}

/** How long a replica waits for an answer before it takes a request as lost, by default. */
export const REQUEST_TIMEOUT = 2_000;
/**
 * How long a file's text must be quiet before it is sent: a burst of
 * keystrokes, each saved here at once, lands as one text. A pause, never a
 * hold: a file always goes once quiet, and a restart forgets the pause.
 */
export const SEND_QUIET = 1_500;

function createReplica({
	driver,
	binding,
	device,
	app,
	after,
	now,
	timeout = REQUEST_TIMEOUT,
	gap = 500,
	quiet = SEND_QUIET,
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
	/** How long a file's text must be quiet before it is sent (`SEND_QUIET`); 0 for a host whose clock does not move. */
	quiet?: number;
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
		get: (key: string) =>
			first<{ value: string }>(
				driver,
				'SELECT value FROM "epicenter/replica" WHERE key = ?',
				[key],
			)?.value ?? null,
		set: (key: string, value: string | null) => {
			if (value === null)
				driver.run('DELETE FROM "epicenter/replica" WHERE key = ?', [key]);
			else
				driver.run(
					'INSERT OR REPLACE INTO "epicenter/replica" (key, value) VALUES (?, ?)',
					[key, value],
				);
		},
	};
	let position: string | null = null;
	let next = 1;
	/** The last refusal or rejection, for a writer awaiting its verdict; cleared when a push lands. */
	let lastRefusal: Verdict | null = null;
	/** The server's bounds on a push, from the connection's first exchange. */
	let sizing: Sizing | null = null;
	/** RULE: after a push was rejected as too large, at most this many files go in one. */
	let cap: number | null = null;
	/** A rejection only the person or the account can fix: no push goes until the next connection. */
	let stalled: Verdict | null = null;
	/** The push sent and not yet answered: sent again, unchanged, until it is. */
	let inflight: Push | null = null;
	/** The work of the push in flight, by fold: each file's `sent` level. */
	let sentWork = new Map<string, Level>();
	let passedN = 0;
	/** Counts changes stored: each transaction that changes a file's text or state makes the next one. */
	let revision = 0;

	/** Read what a restart keeps beside the files: the push in flight, the position, the counters. */
	function load() {
		const flight = first<{ push_json: string }>(
			driver,
			'SELECT push_json FROM "epicenter/inflight"',
		);
		inflight =
			flight === undefined ? null : (JSON.parse(flight.push_json) as Push);
		sentWork = levelsOf(inflight);
		position = meta.get('position');
		next = Number(meta.get('next') ?? 1);
		passedN =
			first<{ n: number | null }>(
				driver,
				'SELECT MAX(n) AS n FROM "epicenter/passed"',
			)?.n ?? 0;
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
	/**
	 * RULE: this database's pushes are numbered within an epoch it chose:
	 * `seq` is stored with the push it numbers, before that push is sent, so
	 * the server recognizes a resend exactly and a database restored from a
	 * copy (whose seq went back) is told it is behind itself.
	 */
	const epoch = () => {
		let chosen = meta.get('epoch');
		if (chosen === null) {
			chosen = crypto.randomUUID();
			meta.set('epoch', chosen);
			meta.set('seq', '0');
		}
		return chosen;
	};
	const takeSeq = () => {
		const seq = Number(meta.get('seq') ?? 0) + 1;
		meta.set('seq', String(seq));
		return seq;
	};
	/** The push in flight is `push` now, or none. */
	const setInflight = (push: Push | null) => {
		const before = inflight?.files.map((f) => f.path) ?? [];
		for (const path of [...before, ...(push?.files.map((f) => f.path) ?? [])])
			changed.add(stored(path)?.spelling ?? path);
		inflight = push;
		sentWork = levelsOf(push);
		driver.run('DELETE FROM "epicenter/inflight"');
		if (push !== null)
			driver.run(
				'INSERT INTO "epicenter/inflight" (hash, push_json) VALUES (?, ?)',
				[pushHash(push), JSON.stringify(push)],
			);
		// A file whose only level was the text it sent goes with it.
		for (const path of before) {
			const f = stored(path);
			if (f !== undefined) set(path, f);
		}
	};

	const pass = (id: string) => {
		passedN++;
		driver.run(
			'INSERT OR REPLACE INTO "epicenter/passed" (id, n) VALUES (?, ?)',
			[id, passedN],
		);
		driver.run('DELETE FROM "epicenter/passed" WHERE n <= ?', [
			passedN - PASSED,
		]);
	};
	const passed = (id: string) =>
		first(driver, 'SELECT 1 FROM "epicenter/passed" WHERE id = ?', [id]) !==
		undefined;

	/** One file as stored, or undefined when the database has no row for it. */
	function stored(path: string): Stored | undefined {
		const row = first<FileRow>(driver, FILE_SQL, [fold(path)]);
		if (row === undefined) return undefined;
		const f: Stored = {
			spelling: row.path,
			base: row.base,
			mine: row.text,
			hash: row.hash,
			made: row.made,
		};
		if (row.saved === 1) f.saved = true;
		if (row.held !== null) f.held = { reason: row.held };
		if (row.committed === 1)
			f.committed = { text: row.committed_text, base: row.committed_base };
		return f;
	}
	const sentOf = (path: string): Level | undefined => sentWork.get(fold(path));
	const record = (path: string): FileView => {
		const { hash: _, ...f } = stored(path) ?? {
			base: null,
			mine: null,
			hash: null,
		};
		const sent = sentOf(path);
		return sent === undefined ? f : { ...f, sent };
	};
	/** The paths a query names, in its order. */
	const pathsOf = (sql: string, params: SqlValue[] = []) =>
		driver.all<{ path: string }>(sql, params).map((row) => row.path);
	/**
	 * The paths where `where` holds, in order of their first store. Read
	 * unordered and put in order here: asked to order by rowid, SQLite scans
	 * every file in rowid order rather than use a partial index and sort.
	 */
	const pathsWhere = (where: string) =>
		driver
			.all<{ path: string; n: number }>(
				`SELECT path, rowid AS n FROM "epicenter/files" WHERE ${where}`,
			)
			.sort((a, b) => a.n - b.n)
			.map((row) => row.path);
	/** Files in order of their first store, as the logic reads them, where `where` holds. */
	const filesWhere = (where: string): [string, FileView][] =>
		pathsWhere(where).map((path) => [path, record(path)]);
	/** Files with an unsent commit, in order of their first store. */
	const committedFiles = (): [string, FileView][] =>
		pathsOf(
			'SELECT f.path FROM "epicenter/unsent" u JOIN "epicenter/files" f ON f.fold = u.fold ORDER BY f.rowid',
		).map((path) => [path, record(path)]);

	/**
	 * Store a file's record (its `sent` level lives in the push in flight),
	 * keyed by its fold. It keeps the spelling it has unless `next` names one.
	 */
	function set(path: string, { sent: _, ...next }: FileView) {
		const key = fold(path);
		const before = stored(path);
		const spelling = next.spelling ?? before?.spelling ?? path.normalize('NFC');
		const empty =
			next.base === null &&
			next.mine === null &&
			next.committed === undefined &&
			next.held === undefined &&
			next.saved === undefined &&
			!sentWork.has(key);
		if (empty) {
			if (before === undefined) return;
			changed.add(before.spelling);
			driver.run('DELETE FROM "epicenter/files" WHERE fold = ?', [key]);
			putUnsent(driver, before.spelling, undefined);
			return;
		}
		if (before !== undefined && before.spelling !== spelling)
			changed.add(before.spelling);
		const hash =
			before !== undefined && before.base === next.base
				? before.hash
				: versionOf(next.base);
		const made = next.made === undefined ? hash : next.made;
		const row =
			before === undefined ||
			before.spelling !== spelling ||
			before.base !== next.base ||
			before.mine !== next.mine ||
			before.saved !== next.saved ||
			before.held?.reason !== next.held?.reason ||
			before.made !== made;
		if (row) {
			changed.add(spelling);
			const fields =
				before !== undefined && before.mine === next.mine
					? undefined
					: fieldsOf(next.mine);
			putFile(driver, spelling, {
				text: next.mine,
				...(fields === undefined ? {} : { fields }),
				base: next.base,
				hash,
				made,
				saved: next.saved ? 1 : 0,
				held: next.held?.reason ?? null,
			});
		}
		if (
			before?.committed?.text !== next.committed?.text ||
			(before?.committed === undefined) !== (next.committed === undefined) ||
			before?.committed?.base !== next.committed?.base
		) {
			changed.add(spelling);
			putUnsent(driver, spelling, next.committed);
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
		for (const { to, request } of outgoing.splice(0))
			if (to === send) to(request);
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
	let reading:
		| { catchUp: Pick<CatchUp, 'main' | 'full' | 'commits'>; asked: string[] }
		| { event: Event }
		| null = null;
	// A process starts by catching up.
	let needCatchUp = true;
	let gapArmed = false;
	let alive = true;
	/** No push before this time: the server asked this member to slow down. */
	let backoffUntil = 0;
	/** Who each side of a block this device writes is: `main` as it arrived, and this device's person, now. */
	const parties = () => ({
		current: { author: 'main', time: '-' },
		incoming: {
			author: `${user}/${device}`,
			time: new Date(now()).toISOString(),
		},
	});
	const stats = {
		pushes: 0,
		applied: 0,
		merged: 0,
		refused: 0,
		catchUps: 0,
		fetches: 0,
		timeouts: 0,
		late: 0,
		notifications: 0,
		placed: 0,
		commits: 0,
		behind: 0,
	};

	/** What the server will have once this device's commits land. */
	const tip = (f: FileView) => (f.committed ?? f.sent ?? { text: f.base }).text;
	/** Why `mine` is held back, or null when it can go. */
	const heldReason = (f: FileRecord) => f.held?.reason ?? null;

	// ==========================================================================
	// Saving, committing and sending
	// ==========================================================================

	/** Paths whose text this device made names bytes `oid`. */
	const pointing = (oid: string) =>
		pathsOf(
			`SELECT path FROM "epicenter/files" WHERE text IS NOT base AND path NOT LIKE '%.md' AND json_extract(fields, '$.oid') = ?`,
			[oid],
		);
	/** RULE: a pointer this device made (not its base) whose bytes the server does not hold waits alone for them: no push carries it before. */
	function owedText(path: string, text: string | null, base: string | null) {
		if (isNote(path) || text === null || text === base) return false;
		const pointer = parsePointer(text);
		return (
			pointer !== null &&
			first(driver, 'SELECT 1 FROM "epicenter/objects" WHERE oid = ?', [
				pointer.oid,
			]) === undefined
		);
	}
	/** What this device shows at a path is a pointer owed its bytes, and not held. */
	const owes = (path: string, f: FileRecord) =>
		f.held === undefined && owedText(path, f.mine, f.base);

	/** When this device last saved each file (by fold), in this process: a file goes once its text has been quiet for `SEND_QUIET`. */
	const savedAt = new Map<string, number>();
	/** When the pump runs again for a file still within its pause, if it is armed. */
	let quietUntil: number | null = null;
	/**
	 * RULE: committed files that can go now: each on its own, once quiet for
	 * `SEND_QUIET`, every one but a pointer owed its bytes; none while the
	 * server asked this member to slow down. A file still within its pause
	 * arms the pump for when it ends.
	 */
	const ready = () => {
		if (now() < backoffUntil) return [];
		const at = now();
		let next: number | null = null;
		const going = committedFiles().filter(([path, f]) => {
			const due = (savedAt.get(fold(path)) ?? Number.NEGATIVE_INFINITY) + quiet;
			if (due > at) {
				next = Math.min(next ?? due, due);
				return false;
			}
			savedAt.delete(fold(path));
			return !owedText(path, f.committed?.text ?? null, f.base);
		});
		if (next !== null && (quietUntil === null || next < quietUntil)) {
			const wake: number = next;
			quietUntil = wake;
			later(wake - at, () => {
				if (quietUntil === wake) quietUntil = null;
				pump();
			});
		}
		return going;
	};

	/**
	 * RULE: a commit fits the server's bounds (its bytes as JSON and its
	 * files, and the cap a too-large rejection set): files in order, as many
	 * as fit, and at least the first. The rest stays committed and goes in
	 * the next commit.
	 */
	function sized(going: [string, FileView][]): [string, FileView][] {
		const files = Math.min(
			sizing?.files ?? Number.POSITIVE_INFINITY,
			cap ?? Number.POSITIVE_INFINITY,
		);
		// Room for the commit's id, parent, author and time.
		const request = (sizing?.request ?? Number.POSITIVE_INFINITY) - 1_024;
		const taken: [string, FileView][] = [];
		let size = 0;
		for (const entry of going) {
			const bytes =
				encoder.encode(
					JSON.stringify({
						path: entry[0],
						text: entry[1].committed?.text ?? null,
					}),
				).length + 1;
			if (
				taken.length > 0 &&
				(taken.length + 1 > files || size + bytes > request)
			)
				continue;
			taken.push(entry);
			size += bytes;
		}
		return taken;
	}

	/**
	 * Cut: take the files saved since they last went out into the unsent commit
	 * (amended while one is in flight or offline), each over the version it
	 * was made on. One the door refuses is held instead, so held text goes
	 * only with its own next save; the text the file had in the unsent
	 * commit, if any, still goes. A pointer owed its bytes stays saved, out
	 * of the unsent commit, until `present` says the server holds them, and
	 * nothing else waits for it.
	 */
	function cut() {
		for (const [path, f] of filesWhere('saved = 1')) {
			// A save replaces what was held at its path.
			const { saved: _, held: __, ...rest } = f;
			const refusal = f.mine === tip(f) ? null : admissible(path, f.mine);
			if (refusal !== null) {
				set(path, { ...rest, held: { reason: refusal } });
				continue;
			}
			if (owedText(path, f.mine, f.base)) {
				if (f.held !== undefined) set(path, { ...rest, saved: true });
				continue;
			}
			const under = (f.sent ?? { text: f.base }).text;
			if (f.mine === under) {
				const { committed: ___, ...clean } = rest;
				set(path, clean);
			} else
				set(path, {
					...rest,
					committed: { text: f.mine, base: madeOver(f) },
				});
		}
		stats.commits++;
		pump();
	}

	/** The version `mine` was made over: its writer's, kept for a blob; a note's is its base's, as its work is rebased. */
	const madeOver = (f: FileRecord) =>
		f.made === undefined ? versionOf(f.base) : f.made;

	/**
	 * Save one text, merged with `mine` where `mine` moved since `from`, the
	 * text the caller started from (undefined: what this device shows).
	 * RULE: a file is one name, spelled as it was created: a save through any
	 * spelling of its path is a save of it, and leaves its spelling, even
	 * after a delete this device has not had answered. Only a file this
	 * device has no row for (none, or its delete landed) takes the spelling
	 * it is saved under.
	 */
	function save(given: string, text: string | null, from?: string | null) {
		const { held: _, ...f } = record(given);
		const as = { spelling: f.spelling ?? given.normalize('NFC') };
		if (quiet > 0) savedAt.set(fold(given), now());
		// A new save of a path forgets how its last one landed.
		driver.run('DELETE FROM "epicenter/landed" WHERE fold = ?', [fold(given)]);
		const over = from === undefined ? f.mine : from;
		if (!isNote(as.spelling)) {
			// RULE: a blob never merges, and keeps the version it was made over until the server judges it: a save over what this device shows continues that work's version; one over an older text that moved since was made over that text, and lands beside the other.
			if (over === f.mine) {
				set(given, { ...f, ...as, mine: text, made: madeOver(f), saved: true });
				return;
			}
			const swapped = settlePointer(over, f.mine, text);
			set(
				given,
				'lost' in swapped
					? { ...f, ...as, mine: text, made: versionOf(over), saved: true }
					: { ...f, ...as, mine: swapped.text, saved: true },
			);
			return;
		}
		const next =
			over === f.mine
				? text
				: settle(over, f.mine, text, { parties: parties() }).text;
		set(given, { ...f, ...as, mine: next, made: undefined, saved: true });
	}

	/** Each path's text as the caller spelled it, and the revision the transaction running makes once it commits, if it changed anything. */
	const answered = (given: string[]): Changed => ({
		texts: Object.fromEntries(given.map((path) => [path, record(path).mine])),
		revision: revision + (changed.size > 0 ? 1 : 0),
	});

	/**
	 * Save texts, in one transaction and in order (a rename is a delete of
	 * the old path, then a write of the new one): each merged here with
	 * `mine` if `mine` moved since the text the caller started from. Each
	 * file goes on its own. `refused` names saves the caller found at a path
	 * (as found) that the repository cannot take, with why, held there
	 * alone; null: the path holds one it can take again (or none).
	 */
	function writeAll(
		changes: Record<string, string | null>,
		{
			over,
			refused = {},
		}: {
			over?: Record<string, string | null>;
			refused?: Record<string, string | null>;
		} = {},
	): Changed {
		return atomically(() => {
			// RULE: a save refused where it was found is held at its path like a held file: a later word on its path (a save there, or that it is gone or can be taken) ends the refusal.
			for (const path of new Set([
				...Object.keys(changes),
				...Object.keys(refused),
			])) {
				const was =
					first(driver, 'SELECT 1 FROM "epicenter/refused" WHERE path = ?', [
						path,
					]) !== undefined;
				const reason = refused[path] ?? null;
				if (!was && reason === null) continue;
				changed.add(path);
				if (reason === null)
					driver.run('DELETE FROM "epicenter/refused" WHERE path = ?', [path]);
				else
					driver.run(
						'INSERT OR REPLACE INTO "epicenter/refused" (path, fold, reason) VALUES (?, ?, ?)',
						[path, fold(path.normalize('NFC')), reason],
					);
			}
			for (const [given, text] of Object.entries(changes))
				save(
					given,
					text,
					over === undefined || !(given in over)
						? undefined
						: (over[given] ?? null),
				);
			cut();
			return answered(Object.keys(changes));
		});
	}

	/** Apply changes over what this device shows now, in order, in one transaction and one save. */
	function change(changes: Change[]): Result<Changed, ChangeError> {
		return atomically(() => {
			// A patch names a file this device shows, or one an earlier change here makes.
			const shown = new Map<string, boolean>();
			for (const c of changes) {
				const key = fold(c.path);
				const showing = shown.get(key) ?? record(c.path).mine !== null;
				if (c.kind === 'patch' && !showing)
					return ChangeError.NotFound({ path: c.path });
				shown.set(
					key,
					c.kind === 'patch' ||
						(c.kind === 'create'
							? true
							: c.kind === 'delete'
								? false
								: c.text !== null),
				);
			}
			for (const c of changes) {
				const current = record(c.path).mine;
				switch (c.kind) {
					case 'create':
						save(c.path, c.text, null);
						break;
					case 'patch':
						save(
							c.path,
							writeMarkdown(current as string, { fields: c.fields }),
							current,
						);
						break;
					case 'delete':
						save(c.path, null, current);
						break;
					case 'write':
						save(c.path, c.text, c.over === undefined ? current : c.over);
						break;
					default:
						c satisfies never;
				}
			}
			cut();
			return Ok(answered(changes.map((c) => c.path)));
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
			if (message.type === 'fetch' && reading !== null && 'catchUp' in reading)
				return readBatch();
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
			request({ type: 'push', rid: takeRid(), push: inflight });
			return;
		}
		const parent = position;
		if (needCatchUp || parent === null) return catchUp();
		if (reading !== null || gathering !== null) return;
		const going = stalled === null ? sized(ready()) : [];
		// RULE: a ready push goes before reading notifications: its answer brings everything since its position, and on a busy note there is always another notification.
		if (going.length === 0) {
			if (waiting.has(parent)) place();
			return;
		}
		const sent: Push = {
			user,
			device,
			epoch: epoch(),
			seq: takeSeq(),
			time: new Date(now()).toISOString(),
			from: parent,
			files: going.map(([path, f]) => ({
				path,
				base: f.committed?.base ?? null,
				next: nextOf(f.committed?.text ?? null),
			})),
		};
		setInflight(sent);
		for (const [path, f] of going) {
			const { committed: _, ...rest } = f;
			set(path, rest);
		}
		stats.pushes++;
		request({ type: 'push', rid: takeRid(), push: sent });
	}

	/** What a level's text makes its file on the wire: a note's text, a blob's bytes (never its pointer's text), or a delete. */
	const nextOf = (text: string | null): Next =>
		text === null ? { deleted: true } : contentOf(text);

	// ==========================================================================
	// Taking what the server says
	// ==========================================================================

	/**
	 * A path's text on `main` is now `text`. `landed` when that holds this
	 * device's sent push, whose text the local work above it was made on.
	 */
	function integrate(path: string, text: string | null, landed: boolean) {
		const f = record(path);
		const own = landed && f.sent !== undefined;
		// A path in the push awaiting its answer waits for that answer, which brings it.
		if (f.sent !== undefined && !own) return;
		/** RULE: the file takes the spelling `main` has for it (`path`): `main` holds a file only under the spelling it was created with. */
		const as: Pick<FileRecord, 'spelling'> = {
			spelling: text === null ? (f.spelling ?? path) : path,
		};
		const below = own ? (f.sent?.text ?? null) : f.base;
		if (!isNote(path)) return integratePointer(path, f, text, own, as);
		// Committed work is rebased onto the new text; a delete or removal that loses to an edit leaves the edit. RULE: a note deleted and created again since its base merges by its content, as on the server.
		let committed: string | null | undefined;
		if (f.committed !== undefined)
			committed = settle(below, text, f.committed.text, {
				parties: parties(),
			}).text;
		// Held or waiting text in `mine` is rebased too, and stays held: it goes only with its own save.
		const mineBelow = f.committed !== undefined ? f.committed.text : below;
		const mine = settle(
			mineBelow,
			committed !== undefined ? committed : text,
			f.mine,
			{ parties: parties() },
		).text;
		const next: FileRecord = { ...as, base: text, mine };
		// `mine` is the newest save: once it is `main`'s text, an older commit below it has nothing left to say.
		if (
			f.committed !== undefined &&
			committed !== undefined &&
			committed !== text &&
			mine !== text
		)
			next.committed = { text: committed, base: versionOf(text) };
		if (mine !== text) {
			if (f.held !== undefined) next.held = f.held;
			if (f.saved !== undefined) next.saved = true;
		}
		set(path, next);
	}

	/**
	 * A blob path's text on `main` is now `text`. A blob never merges, and
	 * this device never judges its own blob work: each level keeps the
	 * version it was made over, and the server lands it there or beside
	 * (compare-and-swap). Only this device's own write, landed as sent,
	 * moves the version the work saved over it was made on. Work `main`
	 * now holds is done; where it shows nothing of its own, the device
	 * shows `main`'s.
	 */
	function integratePointer(
		path: string,
		f: FileView,
		text: string | null,
		own: boolean,
		as: Pick<FileRecord, 'spelling'>,
	) {
		const version = versionOf(text);
		const sent = own ? f.sent : undefined;
		/** Work saved over this device's own write continues it: where that write landed as sent, it was made over what landed. */
		const over = (made: string | null) =>
			sent !== undefined && sent.text === text && made === sent.base
				? version
				: made;
		const shown = sent !== undefined ? sent.text : f.base;
		const working =
			f.committed !== undefined ||
			f.saved !== undefined ||
			f.held !== undefined ||
			f.mine !== shown;
		const mine = working ? f.mine : text;
		const next: FileRecord = { ...as, base: text, mine };
		if (mine !== text) {
			next.made = over(madeOver(f));
			if (f.committed !== undefined && f.committed.text !== text)
				next.committed = {
					text: f.committed.text,
					base: over(f.committed.base),
				};
			if (f.held !== undefined) next.held = f.held;
			else if (f.saved !== undefined) next.saved = true;
		}
		set(path, next);
	}

	/**
	 * This device's push is in `main`, which holds `files` at the paths it
	 * touched (one entry per file, in `main`'s spelling): each takes its own
	 * sent text as landed, so the push in flight is cleared after.
	 */
	function landed(files: { path: string; text: string | null }[]) {
		for (const file of files) integrate(file.path, file.text, true);
		setInflight(null);
	}

	/** Record how each file of the push in flight landed, from `main`'s texts at its paths and the siblings the server named. */
	function recordOutcomes(
		files: { path: string; text: string | null }[],
		siblings: { path: string; at: string }[] = [],
	) {
		for (const sent of inflight?.files ?? []) {
			const text = storedText(sent.next);
			const there = files.find((file) => fold(file.path) === fold(sent.path));
			const sibling = siblings.find((s) => fold(s.path) === fold(sent.path));
			const outcome: Outcome =
				sibling !== undefined
					? { kind: 'sibling', at: sibling.at }
					: text === null && there !== undefined && there.text !== null
						? { kind: 'delete-did-not-take' }
						: isNote(sent.path) &&
								there?.text != null &&
								findConflicts(there.text).length >
									findConflicts(text ?? '').length
							? { kind: 'blocks' }
							: { kind: 'landed' };
			putLanded(driver, there?.path ?? sent.path, JSON.stringify(outcome));
		}
	}

	/** An answer's files as this device keeps them: a blob's content as its pointer, at the Git edge. */
	const texts = (files: FileState[]) =>
		files.map((f) => ({
			path: f.path,
			text: f.content === null ? null : textOf(f.content),
		}));

	function onLanded(
		answer: Extract<PushAnswer, { kind: 'applied' | 'merged' }>,
	) {
		if (answer.kind === 'applied') stats.applied++;
		else stats.merged++;
		lastRefusal = null;
		cap = null;
		for (const id of answer.commits) pass(id);
		prune();
		const files = texts(answer.files);
		recordOutcomes(files, answer.siblings);
		landed(files);
		// RULE: an answer whose `from` left history names only what the push touched: the device catches up in full.
		if (answer.stale === true) {
			setPosition(null);
			needCatchUp = true;
			return;
		}
		setPosition(answer.main);
		pass(answer.main);
	}

	/**
	 * The door refused one file's write: that file is held with the reason,
	 * alone, and the rest goes again in the next push.
	 */
	function onRefused(answer: Extract<PushAnswer, { kind: 'refused' }>) {
		stats.refused++;
		lastRefusal = { code: answer.code, reason: answer.reason };
		// RULE: a writer's refused text is never dropped: what the door refused is held with the reason. Saved again since it was sent (more typing), the refusal judged a text its writer replaced, so the newer save goes, and is judged itself.
		for (const file of inflight?.files ?? [])
			takeBack(
				file.path,
				fold(file.path) === fold(answer.path)
					? { reason: answer.reason }
					: null,
			);
		setInflight(null);
	}

	/**
	 * The push in flight came back unsent (refused, rejected, or its device
	 * behind itself): the file's sent work is unsent again, or held with
	 * `hold`'s reason where nothing newer was committed over it. An unsent
	 * commit made over it takes it in, as a later save does, and continues
	 * the version it was made over.
	 */
	function takeBack(path: string, hold: { reason: string } | null) {
		const { sent, ...rest } = record(path);
		if (sent === undefined) return;
		if (hold !== null && rest.committed === undefined)
			set(path, { ...rest, held: hold });
		else if (rest.committed === undefined)
			set(path, { ...rest, committed: sent });
	}

	/**
	 * The request was not taken, and no text is at fault: the work stays
	 * committed. RULE: rate, and a base the server is reading from Git, wait
	 * a second; too large halves the next push, and one file too large to go
	 * alone is held with why; anything else only the writer or the account
	 * can fix, so nothing more is sent until the next connection, and the
	 * files say why.
	 */
	function onRejected(answer: Extract<PushAnswer, { kind: 'rejected' }>) {
		stats.refused++;
		lastRefusal = { code: answer.code, reason: answer.reason };
		const sent = inflight?.files ?? [];
		const alone = sent.length === 1;
		const tooLarge =
			answer.code === 'too-large' || answer.code === 'too-many-files';
		for (const file of sent)
			takeBack(file.path, tooLarge && alone ? { reason: answer.reason } : null);
		setInflight(null);
		switch (answer.code) {
			case 'rate':
			case 'reading':
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
	 * RULE: this device is behind itself: its database went back in time (a
	 * restore from a copy), so pushes it no longer knows of may have landed.
	 * It takes a new epoch, and every file with work it has not had answered
	 * (in flight, unsent, saved or held) forgets its base: it cannot know what
	 * its last write left. Each then merges as a write over no file: a note's
	 * work goes after what is there as one block (nothing where it is already
	 * there), a blob's lands beside a different one, and a delete does not
	 * take. It catches up, and sends that work as new writes.
	 */
	function onBehind() {
		stats.behind++;
		for (const file of inflight?.files ?? []) takeBack(file.path, null);
		setInflight(null);
		meta.set('epoch', crypto.randomUUID());
		meta.set('seq', '0');
		for (const [path, f] of filesWhere(
			'text IS NOT base OR saved = 1 OR held IS NOT NULL OR fold IN (SELECT fold FROM "epicenter/unsent")',
		))
			set(path, {
				...f,
				base: null,
				made: null,
				...(f.committed === undefined
					? {}
					: { committed: { text: f.committed.text, base: null } }),
			});
		needCatchUp = true;
	}

	function onAnswer(answer: PushAnswer) {
		switch (answer.kind) {
			case 'applied':
			case 'merged':
				onLanded(answer);
				place();
				return;
			case 'refused':
				onRefused(answer);
				return;
			case 'rejected':
				onRejected(answer);
				return;
			case 'behind':
				onBehind();
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
			for (const level of [
				f.mine,
				f.sent?.text ?? null,
				f.committed?.text ?? null,
			])
				if (level !== null && level !== f.base) texts.set(hashOf(level), level);
		}
		return texts;
	}
	const named = (listed: { files: { path: string }[] }) =>
		listed.files.map((f) => f.path);
	const missing = (wanted: (string | null)[], have: Map<string, string>) => [
		...new Set(wanted.filter((h): h is string => h !== null && !have.has(h))),
	];

	/** Stage one page of a catch-up. */
	function stage(page: CatchUp) {
		for (const file of page.files)
			driver.run(
				'INSERT INTO "epicenter/staged" (path, fold, hash) VALUES (?, ?, ?)',
				[file.path, fold(file.path), file.hash],
			);
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
			...pathsOf(
				'SELECT path FROM "epicenter/staged" WHERE fold IN (SELECT fold FROM "epicenter/unsent") OR fold IN (SELECT fold FROM "epicenter/files" WHERE text IS NOT base)',
			),
			...(inflight?.files ?? [])
				.map((sent) => sent.path)
				.filter(
					(path) =>
						first(driver, 'SELECT 1 FROM "epicenter/staged" WHERE fold = ?', [
							fold(path),
						]) !== undefined,
				),
		]);
		for (const [hash, text] of known(working))
			driver.run(
				'INSERT OR IGNORE INTO "epicenter/fetched" (hash, text) VALUES (?, ?)',
				[hash, text],
			);
		// From the first row still lacking, not from the first row: each batch reads past the rows before it once, so a catch-up's reads stay linear. A row that lacked a text stays at or after it until read, so a lost read is asked again.
		const rows = driver.all<{ n: number; hash: string }>(
			`SELECT s.n AS n, s.hash AS hash ${LACKING_SQL} AND s.n > ? ORDER BY s.n LIMIT ?`,
			[lackingAfter, limit],
		);
		lackingAfter = (rows[0]?.n ?? lackingAfter + 1) - 1;
		return [...new Set(rows.map((row) => row.hash))];
	}
	/** A staged path's text by hash: its base when that is it, else a text read. */
	function stagedText(path: string, hash: string | null) {
		if (hash === null) return null;
		const base = first<{ base: string | null }>(
			driver,
			'SELECT base FROM "epicenter/files" WHERE fold = ? AND hash = ?',
			[fold(path), hash],
		)?.base;
		return (
			base ??
			first<{ text: string }>(
				driver,
				'SELECT text FROM "epicenter/fetched" WHERE hash = ?',
				[hash],
			)?.text ??
			null
		);
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
			const page = driver.all<{ n: number; path: string; hash: string | null }>(
				'SELECT n, path, hash FROM "epicenter/staged" WHERE n > ? ORDER BY n LIMIT ?',
				[after, APPLY_PAGE],
			);
			for (const file of page)
				integrate(file.path, stagedText(file.path, file.hash), false);
			const last = page.at(-1);
			if (last === undefined) break;
			after = last.n;
		}
		// In a full listing, every local file not named is absent.
		if (reply.full)
			// Paths only: each record, its texts with it, is read inside `integrate`, one file at a time.
			for (const path of pathsWhere(
				'base IS NOT NULL AND fold NOT IN (SELECT fold FROM "epicenter/staged")',
			))
				integrate(path, null, false);
		unstage();
		for (const id of reply.commits) pass(id);
		setPosition(reply.main);
		pass(reply.main);
		prune();
	}

	function applyEvent(event: Event, texts: Map<string, string>) {
		if (event.files.some((f) => f.hash !== null && !texts.has(f.hash))) return;
		waiting.delete(event.parents[0] ?? '');
		for (const file of event.files)
			integrate(
				file.path,
				file.hash === null ? null : (texts.get(file.hash) ?? null),
				false,
			);
		setPosition(event.commit);
		pass(event.commit);
		stats.placed++;
	}

	/** Drop waiting notifications for commits already passed: an answer or a catch-up covered them. */
	function prune() {
		for (const [parent, event] of [...waiting])
			if (passed(event.commit)) waiting.delete(parent);
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
		const following = () =>
			position === null ? undefined : waiting.get(position);
		// RULE: nothing is applied while a commit is in flight (a delete needs no read, so this is not implied); its answer brings everything since its parent.
		// The socket needs this too: notifications of commits before this one arrive before its answer, and would move the position past paths in it, whose changes wait for the answer.
		// RULE: nor while a catch-up is out: its answer names the position it brings, and a notification applied first would have it move the position back.
		// The socket needs this too, between a catch-up's pages, which name the commit the first page answered.
		const catchingUp = () =>
			pending?.kind === 'catch-up' ||
			gathering !== null ||
			(reading !== null && 'catchUp' in reading);
		for (
			let event = following();
			event !== undefined && inflight === null && !catchingUp();
			event = following()
		) {
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
				if (waiting.size === 0 || (position !== null && waiting.has(position)))
					return;
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
				if (
					page.restart === true ||
					(gathering !== null &&
						(page.main !== gathering.main || page.full !== gathering.full))
				) {
					catchUp();
					break;
				}
				stage(page);
				if (page.next !== null) {
					// RULE: a catch-up comes in pages up to the server's limit; the device gathers them, then applies them at once.
					gathering = { main: page.main, full: page.full };
					request({
						type: 'catch-up',
						rid: takeRid(),
						from: position,
						paths: [],
						to: page.main,
						after: page.next,
					});
					break;
				}
				gathering = null;
				const caught = {
					main: page.main,
					full: page.full,
					commits: page.commits,
				};
				if (lacking(1).length === 0) applyCatchUp(caught);
				else {
					reading = { catchUp: caught, asked: [] };
					readBatch();
				}
				break;
			}
			case 'fetched': {
				const was = reading;
				// Versions come as content (a blob's bytes, never its pointer's text); this device keeps the pointer, at the Git edge.
				const read = Object.fromEntries(
					Object.entries(message.versions).map(([hash, content]) => [
						hash,
						textOf(content),
					]),
				);
				if (was !== null && 'catchUp' in was) {
					for (const [hash, text] of Object.entries(read))
						driver.run(
							'INSERT OR IGNORE INTO "epicenter/fetched" (hash, text) VALUES (?, ?)',
							[hash, text],
						);
					// A text the server no longer keeps, or the last batch: apply (which catches up again for a text missing).
					if (
						was.asked.every((hash) => hash in read) &&
						lacking(1).length > 0
					) {
						readBatch();
						break;
					}
					reading = null;
					applyCatchUp(was.catchUp);
					place();
					break;
				}
				reading = null;
				const texts = new Map([
					...(was === null ? [] : known(named(was.event))),
					...Object.entries(read),
				]);
				if (
					was !== null &&
					was.event.files.some((f) => f.hash !== null && !texts.has(f.hash))
				) {
					// The server no longer keeps a text the notification names (its commit left the window): catch up instead.
					waiting.delete(was.event.parents[0] ?? '');
					needCatchUp = true;
				} else if (was !== null && position === was.event.parents[0])
					applyEvent(was.event, texts);
				place();
				break;
			}
			default:
				message satisfies never;
		}
		pump();
	}

	// Work saved before a restart and not yet committed is committed now.
	if (
		first(driver, 'SELECT 1 FROM "epicenter/files" WHERE saved = 1') !==
		undefined
	)
		atomically(cut);

	/** One file's state: synced, sending, or held with why. */
	/** Paths whose text has not reached the server: unsent, in flight, waiting or refused. */
	const unsentPaths = () =>
		[
			...new Set([
				...pathsOf('SELECT path FROM "epicenter/files" WHERE text IS NOT base'),
				...pathsOf(
					'SELECT f.path FROM "epicenter/unsent" u JOIN "epicenter/files" f ON f.fold = u.fold',
				),
				...(inflight?.files ?? []).map(
					(sent) => stored(sent.path)?.spelling ?? sent.path,
				),
			]),
		].sort();

	function stateOf(path: string): FileStatus {
		const refused = first<{ reason: string }>(
			driver,
			'SELECT reason FROM "epicenter/refused" WHERE path = ?',
			[path],
		);
		const f = record(path);
		const reason = refused?.reason ?? heldReason(f);
		if (reason !== null)
			return {
				status: onlyAPersonFixes(path, reason) ? 'refused' : 'waiting',
				reason,
			};
		// The text this device shows, or the one in its unsent commit, waits for its bytes.
		if (
			owes(path, f) ||
			(f.committed !== undefined && owedText(path, f.committed.text, f.base))
		)
			return { status: 'waiting', reason: UPLOADING };
		if (
			f.sent === undefined &&
			f.committed === undefined &&
			f.saved === undefined
		)
			return { status: 'synced' };
		return stalled === null
			? { status: 'sending' }
			: { status: 'sending', reason: stalled.reason };
	}

	return {
		device,
		/** The repository, server and account this replica holds. */
		binding: (): Binding => ({ ...binding }),

		// ------------------------------------------------------------------------
		// The read side: what the person sees
		// ------------------------------------------------------------------------

		/** What this device shows for a path, in any spelling of it, or null for no file. */
		read: (path: string) =>
			first<{ text: string | null }>(
				driver,
				'SELECT text FROM "epicenter/files" WHERE fold = ?',
				[fold(path)],
			)?.text ?? null,
		/** Every path this device shows. */
		paths: () =>
			pathsOf(
				'SELECT path FROM "epicenter/files" WHERE text IS NOT NULL',
			).sort(),
		/** One file's state: synced, sending, waiting with why, or refused with why. */
		state: stateOf,
		/** Files not sent, each waiting or refused, with why: held files, owed pointers, and saves refused where they were found (by their path as found), by path. */
		notSent: (): {
			path: string;
			status: 'waiting' | 'refused';
			reason: string;
		}[] =>
			[...new Set([...pathsOf(`SELECT path FROM ${HELD}`), ...unsentPaths()])]
				.sort()
				.flatMap((path) => {
					const state = stateOf(path);
					return state.status === 'waiting' || state.status === 'refused'
						? [{ path, status: state.status, reason: state.reason }]
						: [];
				}),
		/** How each file this device sent last landed, until it is saved again. */
		outcomes: (): { path: string; outcome: Outcome }[] =>
			driver
				.all<{ path: string; outcome: string }>(
					'SELECT path, outcome FROM "epicenter/landed" ORDER BY path',
				)
				.map(({ path, outcome }) => ({
					path,
					outcome: JSON.parse(outcome) as Outcome,
				})),
		/** Paths whose text has not reached the server: unsent, in flight, or held. */
		unsent: unsentPaths,
		/**
		 * One read-only SQL statement over what this device shows: the
		 * app's views (one per name), or `"epicenter/files"` itself, whose
		 * `text` is what the person sees.
		 */
		query: <TRow = Record<string, SqlValue>>(
			sql: string,
			params?: SqlValue[],
		) => driver.read<TRow>(sql, params),
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
		files: () =>
			new Map(
				filesWhere('1').map(([path, f]) => [
					path,
					{
						base: f.base,
						mine: f.mine,
						tip: tip(f),
						settled: f.sent === undefined && f.committed === undefined,
					},
				]),
			),

		// ------------------------------------------------------------------------
		// Writing
		// ------------------------------------------------------------------------

		/**
		 * Save one path: `over` is the text the caller started from (the editor's
		 * loaded text); if `mine` moved since, the two are merged here. Without
		 * `over`, the caller asserts it started from what `read` shows now.
		 */
		write(
			path: string,
			next: string | null,
			{ over }: { over?: string | null } = {},
		) {
			writeAll(
				{ [path]: next },
				over === undefined ? {} : { over: { [path]: over } },
			);
		},
		/** Save several paths in one transaction (a rename is a delete of the old path and a write of the new one); each goes on its own. */
		writeAll,
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
			first(driver, 'SELECT 1 FROM "epicenter/files" WHERE saved = 1') !==
				undefined,
		/** Why this device's last commit was refused or rejected (a writer's verdict), until one lands; or null. */
		lastRefusal: () => lastRefusal,
		/** Why nothing is being sent: a rejection only the person or the account can fix, until the next connection; or null. */
		rejection: () => stalled,
		position: () => position,
		/** The push sent and not yet answered (its seq and files), or null. */
		sent: (): Push | null => inflight,
		stats: () => ({ ...stats }),

		// ------------------------------------------------------------------------
		// The upload track's side
		// ------------------------------------------------------------------------

		/** The most bytes one blob may hold: the server's limit from its hello, or the default before one. */
		blobLimit: () => sizing?.blob ?? MAX_BLOB_BYTES,
		/** Bytes this device owes the server, each once, oldest first: what the upload track sends. */
		owed: (limit = 64) =>
			driver
				.all<{ oid: string; size: number }>(
					`SELECT oid, size FROM (SELECT json_extract(f.fields, '$.oid') AS oid, json_extract(f.fields, '$.size') AS size, MIN(f.rowid) AS n ${OWED_SQL} GROUP BY 1) ORDER BY n LIMIT ?`,
					[limit],
				)
				.map(({ oid, size }) => ({ oid, size })),
		/** The server holds bytes `oid` at `size`: every pointer owed them goes in the next commit. */
		present(oid: string, size: number) {
			atomically(() => {
				for (const path of pointing(oid)) changed.add(path);
				driver.run(
					'INSERT OR REPLACE INTO "epicenter/objects" (oid, size) VALUES (?, ?)',
					[oid, size],
				);
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
				for (const path of pointing(oid).filter((owing) =>
					owes(owing, record(owing)),
				)) {
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
			if (hello.repository !== binding.repository)
				return ReplicaError.BoundElsewhere({
					field: 'repository',
					bound: binding.repository,
					given: hello.repository,
				});
			if (hello.user !== binding.account)
				return ReplicaError.BoundElsewhere({
					field: 'account',
					bound: binding.account,
					given: hello.user,
				});
			if (binding.server !== null && hello.server !== binding.server)
				return ReplicaError.BoundElsewhere({
					field: 'server',
					bound: binding.server,
					given: hello.server,
				});
			if (binding.server === null) {
				// The first server this replica meets is its server for good.
				binding = { ...binding, server: hello.server };
				driver.run(
					'INSERT OR REPLACE INTO "epicenter/replica" (key, value) VALUES (?, ?)',
					['server', JSON.stringify(hello.server)],
				);
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
				if (passed(event.commit) || (passed(parent) && parent !== position))
					return;
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
