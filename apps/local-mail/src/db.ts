import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import {
	bodyHtml,
	bodyText,
	hasExternalizedBody,
	headerValue,
} from './message-fields.ts';
import { accountDir, mailDbPath } from './paths.ts';
import type { GmailLabel, GmailMessage } from './schema.ts';

/**
 * The mailbox database: one stable SQLite file per connected Gmail account, at
 * `<dataDir>/<accountEmail>/mail.db` (ADR-0198). Ports `apps/local-books`'
 * CDC-cursor and transaction discipline (see that file's top comment) onto
 * Gmail's `history.list` shape, which differs from QuickBooks' `/cdc` in ways
 * that shaped the design below:
 *
 * - Gmail's cursor is an opaque, increasing `historyId`, not a timestamp, so
 *   staleness is judged from our own `last_synced_at` wall-clock record, not
 *   from parsing the cursor itself (see `sync.ts`'s `decideMode`).
 * - `history.list`'s `labelsAdded`/`labelsRemoved` records carry a full
 *   current `labelIds` snapshot for a message that may already be stored,
 *   not a full object replacement. `patchMessageLabels` handles this as a
 *   targeted field patch, distinct from the generic upsert.
 * - Full backfill is paginated (`messages.list` + per-id `messages.get`), so
 *   it commits per page (`ingestFullPullPage`) rather than accumulating the
 *   whole mailbox in memory before one transaction; the cursor only advances
 *   once, in `finishFullPull`, after every page has committed.
 *
 * The account owns its identity through the directory (`<dataDir>/<email>/`),
 * not a stored column, and the file inside it is always called `mail.db`. This
 * file is NOT a mirror: it is on its way to holding durable local state that
 * Gmail cannot supply again, so nothing here may be named by a version,
 * replaced by an empty successor, or reclaimed (ADR-0198). What that costs is
 * one mechanism this file owns: the fact tier's shape is stamped in `_meta`, and
 * a build whose contract moved on rebuilds that tier in place. See
 * `FACT_CORPUS_VERSION`.
 */

export type RealmState = {
	historyId: string | null;
	lastFullPullAt: string | null;
	lastSyncedAt: string | null;
};

/**
 * One row of the triage list, projected for the HTTP read surface. `labelIds`
 * is the parsed array (the `label_ids` column stores Gmail's JSON string); the
 * UI derives unread/inbox/label chips from it, so no state is invented here.
 */
export type MessageSummary = {
	id: string;
	threadId: string | null;
	subject: string | null;
	sender: string | null;
	snippet: string | null;
	internalDate: number | null;
	labelIds: string[];
};

/** A single message opened in the detail pane: a summary, its `To`/`Date`
 * headers, and both body projections. `bodyText` is the stored searchable
 * plain text; `unsafeBodyHtml` is the `text/html` part derived from the stored
 * resource at read time (never stored, so no shape change), unsanitized on
 * purpose. The name carries the warning across the wire: the only caller that
 * may render it is the sanitizer boundary in the SPA, which runs DOMPurify
 * first. */
export type MessageDetail = MessageSummary & {
	to: string | null;
	date: string | null;
	bodyText: string | null;
	unsafeBodyHtml: string | null;
	/**
	 * True when this message has no offline body because Gmail externalized the
	 * body part: `format=full` returned an `attachmentId` where the bytes would
	 * be, and one `messages.get` is the entire per-message budget (ADR-0196), so
	 * they are never fetched. The row is fully synchronized; only the body is
	 * elsewhere. Derived at read time, so it costs no stored column.
	 */
	bodyExternalized: boolean;
};

/** A mirrored Gmail label, for the label-filter rail and the add/remove menu. */
export type LabelSummary = {
	id: string;
	name: string | null;
	type: string | null;
};

/** Label sets are unordered: Gmail may echo the same labels in a different
 * order, so a material change is a set difference, not an array inequality. */
function sameLabelSet(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	const present = new Set(a);
	return b.every((id) => present.has(id));
}

function parseLabelIds(json: string | null): string[] {
	if (!json) return [];
	try {
		const parsed = JSON.parse(json);
		return Array.isArray(parsed)
			? parsed.filter((v) => typeof v === 'string')
			: [];
	} catch {
		return [];
	}
}

export type MailDb = ReturnType<typeof openMailDb>;

/**
 * One column of a declared table: its SQLite name and affinity, an optional
 * trailing constraint, and, when SQLite computes the value itself, the
 * expression it computes it from. A generated column cannot disagree with the
 * stored resource, which is why every column that can be one is one.
 */
type ColumnDeclaration = {
	name: string;
	type: 'TEXT' | 'INTEGER';
	constraint: string | null;
	generated: { expression: string; storage: 'VIRTUAL' | 'STORED' } | null;
};

type TableDeclaration = { table: string; columns: ColumnDeclaration[] };

/** A column this app writes at ingest: an id, the resource, a timestamp, or one
 * of the three values SQL cannot reach (see `FACT_TABLES`). */
function stored(
	name: string,
	type: ColumnDeclaration['type'],
	constraint: string | null = null,
): ColumnDeclaration {
	return { name, type, constraint, generated: null };
}

/** A column SQLite projects from the stored resource. */
function projected(
	name: string,
	type: ColumnDeclaration['type'],
	expression: string,
	storage: 'VIRTUAL' | 'STORED',
): ColumnDeclaration {
	return { name, type, constraint: null, generated: { expression, storage } };
}

/**
 * `_meta`: the key/value shelf that outlives every rebuild, because it is where
 * the version that decides a rebuild is stored. It is not a fact table and is
 * never dropped.
 */
const META_TABLE: TableDeclaration = {
	table: '_meta',
	columns: [stored('key', 'TEXT', 'PRIMARY KEY'), stored('value', 'TEXT')],
};

/**
 * The fact tier's declared stored shape, as plain data, and the single source
 * the DDL below is generated from. Gmail owns every value here and nothing in it
 * is authored locally, which is exactly what makes these the tables a corpus
 * change may drop and rebuild (ADR-0198).
 *
 * Three tiers of column, per ADR-0196, and no fourth:
 *
 * 1. `resource`: the parsed `messages.get(format=full)` payload, verbatim. Not
 *    `raw`: `format=raw` is Gmail's own name for the base64url RFC 5322 blob
 *    this app never fetches, so a column named `raw` holding a parsed resource
 *    was a false statement in the schema. `labels.resource` follows the same
 *    word for the same reason (`labels.list` returns a Label resource); one
 *    file should not have two names for "verbatim provider JSON".
 * 2. Every column SQLite can project from it, as a generated column.
 * 3. Exactly the columns SQL cannot project that pushed-down search and sort
 *    need: `subject`, `sender`, `body_text`, and nothing else. `To`, `Date`, and
 *    the HTML body are derived at read time instead.
 *
 * The test for a proposed column is not "is it useful" but "can SQLite project
 * it, and if not, does a pushed-down filter or sort require it?" A column that
 * fails both belongs in a read-time derivation, and adding one is not free
 * either way: it is a `FACT_CORPUS_VERSION` bump, so it costs a full re-pull of
 * the mailbox at 20 quota units per message (ADR-0196).
 *
 * Indexes are deliberately absent: an index holds no Gmail facts.
 */
const FACT_TABLES: TableDeclaration[] = [
	{
		table: 'labels',
		columns: [
			stored('id', 'TEXT', 'PRIMARY KEY'),
			stored('resource', 'TEXT', 'NOT NULL'),
			projected('name', 'TEXT', `json_extract(resource, '$.name')`, 'VIRTUAL'),
			projected('type', 'TEXT', `json_extract(resource, '$.type')`, 'VIRTUAL'),
			stored('synced_at', 'TEXT', 'NOT NULL'),
		],
	},
	{
		table: 'messages',
		columns: [
			stored('id', 'TEXT', 'PRIMARY KEY'),
			stored('resource', 'TEXT', 'NOT NULL'),
			projected(
				'thread_id',
				'TEXT',
				`json_extract(resource, '$.threadId')`,
				'VIRTUAL',
			),
			projected(
				'snippet',
				'TEXT',
				`json_extract(resource, '$.snippet')`,
				'STORED',
			),
			projected(
				'label_ids',
				'TEXT',
				`json_extract(resource, '$.labelIds')`,
				'VIRTUAL',
			),
			projected(
				'internal_date',
				'INTEGER',
				`CAST(json_extract(resource, '$.internalDate') AS INTEGER)`,
				'STORED',
			),
			// The three columns SQL cannot project, written by this app at ingest.
			// What each one means is part of the corpus contract, so changing any of
			// these promises is a `FACT_CORPUS_VERSION` bump: `subject` is the `Subject`
			// header, `sender` is the `From` header, and `body_text` is the decoded
			// `text/plain` part, else tags stripped from `text/html`. Changing
			// `headerValue` or `bodyText` without bumping the version is the mistake
			// to look for in review.
			stored('subject', 'TEXT'),
			stored('sender', 'TEXT'),
			stored('body_text', 'TEXT'),
			stored('synced_at', 'TEXT', 'NOT NULL'),
		],
	},
];

/**
 * The version of the corpus contract this build stores for the FACT tier, and
 * the only thing a rebuild is decided by. It is stored in `_meta` rather than in
 * the filename, because the file also holds local state Gmail cannot supply
 * again and so can never be replaced by an empty successor (ADR-0198). It is not
 * the app's release version and it is not a migration target: nothing reads a
 * lower version and nothing rewrites one.
 *
 * The reader rewrite that renamed `raw` to `resource` is version `5`, and the
 * count continues from there: the corpus contract did not change when the file
 * stopped being named after it.
 *
 * Bump it when this build would store something a previous build did not: an
 * added, removed, or retyped fact column; a changed promise for what `subject`,
 * `sender`, or `body_text` holds; or a change to which messages a full pull
 * covers. Do not bump it for an index, a read-time derivation such as the HTML
 * body, a comment, or an app release. A bump drops and re-creates the fact
 * tables in place and costs a full re-pull of the mailbox at 20 quota units per
 * message, so it is not a free edit.
 */
const FACT_CORPUS_VERSION = 5;

/** Where `FACT_CORPUS_VERSION` is stamped inside the file. */
const FACT_CORPUS_VERSION_KEY = 'fact_corpus_version';

/**
 * The `_meta` keys that describe how far the fact tier has been pulled. They
 * belong to the corpus a rebuild throws away, so a rebuild clears them and the
 * next pass starts from a full pull. Every other key survives, including keys
 * this build has never heard of.
 */
const CURSOR_KEYS = [
	'history_id',
	'last_full_pull_at',
	'last_synced_at',
] as const;

/** `CREATE TABLE IF NOT EXISTS` for one declared table. Every identifier and
 * expression here is authored in this file and the set is closed, so the
 * declaration interpolates into DDL without further checking. */
function createTableSql({ table, columns }: TableDeclaration): string {
	const defs = columns.map((column) => {
		const constraint = column.constraint ? ` ${column.constraint}` : '';
		const generated = column.generated
			? ` GENERATED ALWAYS AS (${column.generated.expression}) ${column.generated.storage}`
			: '';
		return `${column.name} ${column.type}${constraint}${generated}`;
	});
	return `CREATE TABLE IF NOT EXISTS ${table} (${defs.join(', ')});`;
}

const CREATE_META_TABLE = createTableSql(META_TABLE);
const CREATE_FACT_TABLES = FACT_TABLES.map(createTableSql).join('\n');

/**
 * Indexes over the fact tier, outside the corpus contract: they hold no Gmail
 * facts, so adding one is a query optimization applied on every open, not a
 * shape change that costs a re-pull. That is why this runs unconditionally while
 * the tables above run only under a rebuild.
 */
const CREATE_FACT_INDEXES = `
	CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, internal_date);
	CREATE INDEX IF NOT EXISTS idx_messages_internal_date ON messages(internal_date);
`;

const BUSY_TIMEOUT_MS = 5000;

/**
 * Apply a connection's pragmas, closing the handle if one of them fails.
 *
 * `new Database(...)` opens lazily, so a pragma is the first statement that
 * actually reaches the file and therefore the first that can fail on a missing
 * permission or a path that is not a database. Without the close, every such
 * failure would leak the descriptor it had already opened, which a long-running
 * daemon retrying a broken mailbox would accumulate.
 */
function applyPragmas(db: Database, pragmas: readonly string[]): Database {
	try {
		for (const pragma of pragmas) db.run(pragma);
	} catch (cause) {
		db.close();
		throw cause;
	}
	return db;
}

function secureDir(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
}

function chmodIfExists(path: string, mode: number): void {
	try {
		chmodSync(path, mode);
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		if (code !== 'ENOENT') throw error;
	}
}

/**
 * The mailbox holds someone's mail, so the file and both SQLite sidecars are
 * `0600` and the directories are `0700`.
 */
function secureDbFiles(path: string): void {
	chmodIfExists(path, 0o600);
	chmodIfExists(`${path}-wal`, 0o600);
	chmodIfExists(`${path}-shm`, 0o600);
}

type MailDbLocation = { dataDir: string; accountEmail: string };

/**
 * Open the mailbox for writing, creating it if absent.
 *
 * The one thing an open decides is whether this build's fact-tier contract
 * matches the one stamped in the file. When it does not, the fact tier is
 * rebuilt in place; everything else in the file is left exactly as it was. A
 * first open is that same rebuild against an empty file, so there is one path,
 * not two.
 */
export function openMailDb({ dataDir, accountEmail }: MailDbLocation) {
	// Resolve the path first: an account email that cannot name one path segment
	// must be refused before anything is created on disk.
	const path = mailDbPath(dataDir, accountEmail);
	secureDir(dataDir);
	secureDir(accountDir(dataDir, accountEmail));
	// WAL so readers never block the writer; a busy_timeout so a second writer
	// waits for the lock instead of failing instantly with SQLITE_BUSY;
	// synchronous NORMAL because the fact tier is re-pullable, so a lost last
	// commit on power loss costs a re-pull and nothing more.
	const db = applyPragmas(new Database(path, { create: true }), [
		`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`,
		'PRAGMA journal_mode = WAL;',
		'PRAGMA synchronous = NORMAL;',
		'PRAGMA foreign_keys = ON;',
	]);
	secureDbFiles(path);

	// `_meta` before anything else: it is what the rebuild decision is read from.
	db.run(CREATE_META_TABLE);

	const setMetaStmt = db.query(
		`INSERT INTO _meta (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	);
	const getMetaStmt = db.query<{ value: string | null }, [string]>(
		`SELECT value FROM _meta WHERE key = ?`,
	);
	const deleteMetaStmt = db.query(`DELETE FROM _meta WHERE key = ?`);

	/**
	 * Bring the fact tier to this build's contract by rebuilding it where it
	 * stands: drop the declared fact tables, recreate them, clear the cursor so
	 * the next pass is a full pull, and stamp the version. One transaction, so a
	 * crash leaves either the previous corpus or an empty current one, never a
	 * half-shaped file.
	 *
	 * The scope is exactly the names declared above, and that is the point.
	 * Anything else in this file survives a rebuild: the durable local overlays
	 * ADR-0198 puts here are not re-pullable, so a sweep of tables this build does
	 * not recognize would delete the only copy of a user's pending work. Dropping
	 * a table takes its indexes with it, which is why `CREATE_FACT_INDEXES` below
	 * is a create list and there is no drop list beside it.
	 */
	function rebuildFactTier(): void {
		const tx = db.transaction(() => {
			for (const { table } of FACT_TABLES) {
				db.run(`DROP TABLE IF EXISTS ${table};`);
			}
			db.run(CREATE_FACT_TABLES);
			for (const key of CURSOR_KEYS) deleteMetaStmt.run(key);
			setMetaStmt.run(FACT_CORPUS_VERSION_KEY, String(FACT_CORPUS_VERSION));
		});
		tx.immediate();
	}

	const storedVersion = getMetaStmt.get(FACT_CORPUS_VERSION_KEY)?.value ?? null;
	if (storedVersion !== String(FACT_CORPUS_VERSION)) rebuildFactTier();
	db.run(CREATE_FACT_INDEXES);

	const upsertMessageStmt = db.query(
		`INSERT INTO messages (id, resource, subject, sender, body_text, synced_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   resource = excluded.resource,
		   subject = excluded.subject,
		   sender = excluded.sender,
		   body_text = excluded.body_text,
		   synced_at = excluded.synced_at`,
	);
	const deleteMessageStmt = db.query(`DELETE FROM messages WHERE id = ?`);
	const sweepMessagesStmt = db.query(
		`DELETE FROM messages WHERE synced_at < ?`,
	);
	const getMessageResourceStmt = db.query<{ resource: string }, [string]>(
		`SELECT resource FROM messages WHERE id = ?`,
	);
	const hasMessageStmt = db.query<{ 1: number }, [string]>(
		`SELECT 1 FROM messages WHERE id = ?`,
	);
	const patchMessageLabelsStmt = db.query(
		`UPDATE messages SET resource = ?, synced_at = ? WHERE id = ?`,
	);
	const findLabelByIdOrExactNameStmt = db.query<
		{ id: string; name: string | null },
		[string, string, string]
	>(
		`SELECT id, name FROM labels
		 WHERE id = ? OR name = ?
		 ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, id
		 LIMIT 1`,
	);
	const upsertLabelStmt = db.query(
		`INSERT INTO labels (id, resource, synced_at)
		 VALUES (?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET resource = excluded.resource, synced_at = excluded.synced_at`,
	);
	const deleteLabelsStmt = db.query(`DELETE FROM labels`);
	const liveMessageCountStmt = db.query<{ n: number }, []>(
		`SELECT count(*) AS n FROM messages`,
	);
	const labelCountStmt = db.query<{ n: number }, []>(
		`SELECT count(*) AS n FROM labels`,
	);
	const recentMessagesStmt = db.query<
		{ subject: string | null; sender: string | null },
		[number]
	>(`SELECT subject, sender FROM messages ORDER BY internal_date DESC LIMIT ?`);

	function readRealmState(): RealmState {
		return {
			historyId: getMetaStmt.get('history_id')?.value ?? null,
			lastFullPullAt: getMetaStmt.get('last_full_pull_at')?.value ?? null,
			lastSyncedAt: getMetaStmt.get('last_synced_at')?.value ?? null,
		};
	}

	function upsertMessage(message: GmailMessage, syncedAt: string): void {
		upsertMessageStmt.run(
			message.id,
			JSON.stringify(message),
			headerValue(message, 'Subject'),
			headerValue(message, 'From'),
			bodyText(message),
			syncedAt,
		);
	}

	/**
	 * Fold `labelIds` into one row's stored resource, reporting both whether the row was
	 * `found` (a write-through fold cares only about this) and whether the label
	 * set `changed` materially (the sync metric counts only these, so an
	 * idempotent history echo of labels already current does not read as drift).
	 * The write is unconditional either way: a no-op patch still refreshes
	 * `synced_at`, matching the prior behaviour.
	 */
	function patchMessageLabelsRow(
		messageId: string,
		labelIds: string[],
		syncedAt: string,
	): { found: boolean; changed: boolean } {
		const row = getMessageResourceStmt.get(messageId);
		if (!row) return { found: false, changed: false };
		const parsed = JSON.parse(row.resource);
		const prevLabelIds: string[] = Array.isArray(parsed.labelIds)
			? parsed.labelIds
			: [];
		const patched = { ...parsed, labelIds };
		patchMessageLabelsStmt.run(JSON.stringify(patched), syncedAt, messageId);
		return { found: true, changed: !sameLabelSet(prevLabelIds, labelIds) };
	}

	return {
		/**
		 * Escape hatch for tests and diagnostics only. Production reads go
		 * through the read models below or the readonly opener; the ad-hoc SQL
		 * product surface is the `query` verb, not this handle.
		 */
		raw: db,

		readRealmState,

		/** Whether a message row is mirrored; sync uses this to detect label patches aimed at unmirrored rows. */
		hasMessage(id: string): boolean {
			return hasMessageStmt.get(id) !== null;
		},

		/**
		 * Fold Gmail's authoritative post-mutation labels into one mirrored row.
		 * Returns false when the row is absent and does not touch `_meta`: a fold
		 * is not a sync pass and must not move staleness or history cursors.
		 */
		patchMessageLabels(
			messageId: string,
			labelIds: string[],
			syncedAt: string,
		) {
			const tx = db.transaction(
				() => patchMessageLabelsRow(messageId, labelIds, syncedAt).found,
			);
			return tx.immediate();
		},

		counts(): { messages: number; labels: number } {
			return {
				messages: liveMessageCountStmt.get()?.n ?? 0,
				labels: labelCountStmt.get()?.n ?? 0,
			};
		},

		findLabelByIdOrExactName(
			label: string,
		): { id: string; name: string | null } | null {
			return findLabelByIdOrExactNameStmt.get(label, label, label) ?? null;
		},

		/** Live messages, newest first, for post-pass reporting. */
		recentMessages(
			limit: number,
		): { subject: string | null; sender: string | null }[] {
			return recentMessagesStmt.all(limit);
		},

		/**
		 * The triage list read model. Newest first; an optional `labelId` filters
		 * to messages carrying that Gmail label, and an optional `search` matches
		 * subject/sender/body. Both are pushed into SQL so the process never
		 * materializes the whole mirror. Compiled per call (dynamic WHERE), which
		 * is fine at mirror scale and mirrors the `query` verb's discipline.
		 */
		listMessages({
			labelId,
			search,
			limit,
			offset,
		}: {
			labelId?: string;
			search?: string;
			limit: number;
			offset: number;
		}): MessageSummary[] {
			const where: string[] = [];
			const params: Record<string, string | number> = {
				$limit: limit,
				$offset: offset,
			};
			if (labelId) {
				where.push(
					`EXISTS (SELECT 1 FROM json_each(messages.label_ids) WHERE value = $labelId)`,
				);
				params.$labelId = labelId;
			}
			// Mirror Gmail's own rule: Trash is hidden from every view (Inbox, All
			// mail, any label) except Trash itself. A trashed row is folded, not
			// deleted, so this read-model filter is what makes it leave the current
			// view the instant `messages.trash` returns, before sync sweeps it.
			if (labelId !== 'TRASH') {
				where.push(
					`NOT EXISTS (SELECT 1 FROM json_each(messages.label_ids) WHERE value = 'TRASH')`,
				);
			}
			if (search) {
				where.push(`(subject LIKE $q OR sender LIKE $q OR body_text LIKE $q)`);
				params.$q = `%${search}%`;
			}
			const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
			const rows = db
				.query<
					{
						id: string;
						thread_id: string | null;
						subject: string | null;
						sender: string | null;
						snippet: string | null;
						internal_date: number | null;
						label_ids: string | null;
					},
					Record<string, string | number>
				>(
					`SELECT id, thread_id, subject, sender, snippet, internal_date, label_ids
					 FROM messages ${clause}
					 ORDER BY internal_date DESC
					 LIMIT $limit OFFSET $offset`,
				)
				.all(params);
			return rows.map((row) => ({
				id: row.id,
				threadId: row.thread_id,
				subject: row.subject,
				sender: row.sender,
				snippet: row.snippet,
				internalDate: row.internal_date,
				labelIds: parseLabelIds(row.label_ids),
			}));
		},

		/** One message with its extracted body, for the detail pane. */
		getMessageDetail(id: string): MessageDetail | null {
			const row = db
				.query<
					{
						id: string;
						thread_id: string | null;
						subject: string | null;
						sender: string | null;
						snippet: string | null;
						internal_date: number | null;
						label_ids: string | null;
						body_text: string | null;
						resource: string;
					},
					[string]
				>(
					`SELECT id, thread_id, subject, sender, snippet, internal_date,
					        label_ids, body_text, resource
					 FROM messages WHERE id = ?`,
				)
				.get(id);
			if (!row) return null;
			let to: string | null = null;
			let date: string | null = null;
			// Derived at read time from the stored resource, never stored: an HTML
			// body column would only mirror `body_text` for symmetry's sake and
			// cost a corpus bump. `bodyHtml` is defensive on its own, but the parse
			// shares this try so a corrupt resource yields nulls rather than throwing.
			let unsafeBodyHtml: string | null = null;
			// Likewise read-time: whether Gmail put the body behind an `attachmentId`
			// instead of inline `data`. The reader says so rather than spending a
			// second call per message to fetch it (ADR-0196).
			let bodyExternalized = false;
			try {
				const message = JSON.parse(row.resource) as GmailMessage;
				to = headerValue(message, 'To');
				date = headerValue(message, 'Date');
				unsafeBodyHtml = bodyHtml(message);
				bodyExternalized = hasExternalizedBody(message);
			} catch {
				// Fall back to nulls; the summary fields already carry the essentials.
			}
			return {
				id: row.id,
				threadId: row.thread_id,
				subject: row.subject,
				sender: row.sender,
				snippet: row.snippet,
				internalDate: row.internal_date,
				labelIds: parseLabelIds(row.label_ids),
				to,
				date,
				bodyText: row.body_text,
				unsafeBodyHtml,
				bodyExternalized,
			};
		},

		/** Every mirrored label, for the filter rail and the add/remove menu. */
		listLabels(): LabelSummary[] {
			return db
				.query<{ id: string; name: string | null; type: string | null }, []>(
					`SELECT id, name, type FROM labels ORDER BY type, name`,
				)
				.all();
		},

		/**
		 * One page of a full backfill: upsert every message, no cursor advance.
		 * Called once per `messages.list` page so a
		 * crash mid-backfill loses only the in-flight page, not the whole pull.
		 */
		ingestFullPullPage(messages: GmailMessage[], syncedAt: string): void {
			const tx = db.transaction(() => {
				for (const message of messages) upsertMessage(message, syncedAt);
			});
			tx.immediate();
		},

		/** Replace the label set (small, returned complete by `labels.list` every call). */
		ingestLabels(labels: GmailLabel[], syncedAt: string): void {
			const tx = db.transaction(() => {
				deleteLabelsStmt.run();
				for (const label of labels) {
					upsertLabelStmt.run(label.id, JSON.stringify(label), syncedAt);
				}
			});
			tx.immediate();
		},

		/**
		 * Closes out a FULL pull: records the `historyId` baseline read before
		 * page 1, so changes during the pull replay idempotently instead of
		 * disappearing behind a post-pull cursor.
		 */
		finishFullPull(historyId: string, syncedAt: string): number {
			const tx = db.transaction(() => {
				const swept = sweepMessagesStmt.run(syncedAt).changes;
				setMetaStmt.run('history_id', historyId);
				setMetaStmt.run('last_full_pull_at', syncedAt);
				setMetaStmt.run('last_synced_at', syncedAt);
				return swept;
			});
			return tx.immediate();
		},

		/**
		 * Applies one `history.list` batch and advances the cursor, all in one
		 * transaction (whole-batch atomic, same as local-books' `ingest`): a
		 * crash rolls back to the prior `historyId` and the next pass re-pulls
		 * the window, which is idempotent (upserts and physical deletes both are).
		 *
		 * `labelPatches` carries each affected message's CURRENT full `labelIds`
		 * snapshot (that's what `labelsAdded`/`labelsRemoved` records give us),
		 * so it patches the existing row's stored `labelIds` in place rather than
		 * replacing the row; a patch for a message not yet mirrored is silently
		 * skipped, but only as a residual guard: sync pre-resolves patches
		 * aimed at unmirrored rows into full refetches (`hasMessage`), so a
		 * miss here means the message changed mid-pass and the next pass
		 * converges.
		 *
		 * Returns `labelsChanged`: how many label patches materially changed a
		 * row's label set. A patch whose labels already match (a history echo of
		 * a change the write-through fold already applied) is applied but not
		 * counted, so the sync metric reports convergence, not phantom drift.
		 */
		applyHistoryBatch({
			messagesToUpsert,
			messagesToDelete,
			labelPatches,
			newHistoryId,
			syncedAt,
		}: {
			messagesToUpsert: GmailMessage[];
			messagesToDelete: string[];
			labelPatches: { messageId: string; labelIds: string[] }[];
			newHistoryId: string;
			syncedAt: string;
		}): { labelsChanged: number } {
			const tx = db.transaction(() => {
				let labelsChanged = 0;
				for (const message of messagesToUpsert)
					upsertMessage(message, syncedAt);
				for (const id of messagesToDelete) deleteMessageStmt.run(id);
				for (const { messageId, labelIds } of labelPatches) {
					if (patchMessageLabelsRow(messageId, labelIds, syncedAt).changed) {
						labelsChanged += 1;
					}
				}
				setMetaStmt.run('history_id', newHistoryId);
				setMetaStmt.run('last_synced_at', syncedAt);
				return { labelsChanged };
			});
			return tx.immediate();
		},

		close(): void {
			db.close();
		},
	};
}

/**
 * The read-only view of the mailbox, for surfaces that must never write and must
 * never conjure a file (`status`, `query`). Returns `null` when `mail.db` does
 * not exist, which is the honest answer to "is there a mailbox to read": the
 * caller reports it rather than creating one.
 *
 * A reader sets no persistent pragma and never rebuilds, so it does not check
 * the stored corpus version: a rebuild is a writer's job, and a reader that
 * triggered one would be a write. Reads compile at call time and tolerate absent
 * tables, because a writable open that died between creating the file and its
 * first transaction leaves a file with nothing in it; that reports as empty, not
 * as a crash. The handle rejects writes at the SQLite level, and `busy_timeout`
 * keeps reads from failing against a lock a concurrent sync briefly holds.
 */
export function openMailDbReadonly({ dataDir, accountEmail }: MailDbLocation) {
	const path = mailDbPath(dataDir, accountEmail);
	if (!existsSync(path)) return null;
	const db = applyPragmas(new Database(path, { readonly: true }), [
		`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`,
	]);

	const hasTable = (name: string): boolean =>
		db
			.query<{ 1: number }, [string]>(
				`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
			)
			.get(name) !== null;

	const meta = (key: string): string | null =>
		hasTable('_meta')
			? (db
					.query<{ value: string | null }, [string]>(
						`SELECT value FROM _meta WHERE key = ?`,
					)
					.get(key)?.value ?? null)
			: null;

	const countRows = (table: 'messages' | 'labels'): number =>
		hasTable(table)
			? (db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()
					?.n ?? 0)
			: 0;

	return {
		/** The ad-hoc SQL surface (the `query` verb and tests). */
		raw: db,

		realmState(): RealmState {
			return {
				historyId: meta('history_id'),
				lastFullPullAt: meta('last_full_pull_at'),
				lastSyncedAt: meta('last_synced_at'),
			};
		},

		counts(): { messages: number; labels: number } {
			return { messages: countRows('messages'), labels: countRows('labels') };
		},

		close(): void {
			db.close();
		},
	};
}
