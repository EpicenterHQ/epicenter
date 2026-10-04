import { chmodSync, mkdirSync } from 'node:fs';
import { bodyHtml, bodyText, headerValue } from './message-fields.ts';
import { defineMirror, type MirrorSite } from './mirror.ts';
import { accountDir } from './paths.ts';
import type { GmailLabel, GmailMessage } from './schema.ts';

/**
 * The local mirror: one SQLite artifact per connected Gmail account. Ports
 * `apps/local-books`' CDC-cursor and transaction discipline (see that file's
 * top comment) onto Gmail's `history.list` shape, which differs from
 * QuickBooks' `/cdc` in ways that shaped the design below:
 *
 * - Gmail's cursor is an opaque, increasing `historyId`, not a timestamp, so
 *   staleness is judged from our own `last_synced_at` wall-clock record, not
 *   from parsing the cursor itself (see `sync.ts`'s `decideMode`).
 * - `history.list`'s `labelsAdded`/`labelsRemoved` records carry a full
 *   current `labelIds` snapshot for a message that may already be mirrored,
 *   not a full object replacement. `patchMessageLabels` handles this as a
 *   targeted field patch, distinct from the generic upsert.
 * - Full backfill is paginated (`messages.list` + per-id `messages.get`), so
 *   it commits per page (`ingestFullPullPage`) rather than accumulating the
 *   whole mailbox in memory before one transaction; the cursor only advances
 *   once, in `finishFullPull`, after every page has committed.
 *
 * The account owns its identity through the directory (`<dataDir>/<account>/`),
 * not a stored column. Inside that directory the artifact is named by the
 * fingerprint of `MIRROR_DECLARATION` (ADR-0194): nothing about the stored shape
 * is stamped inside the file, and opening never drops, unlinks, or migrates
 * anything. That matters more here than in Books because Mail's rebuild is an
 * hours-long paginated backfill, so the predecessor stays readable on disk while
 * its successor fills; see `finishFullPull` for when the app decides a
 * replacement is complete.
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
 * plain text; `unsafeBodyHtml` is the raw `text/html` derived from `raw` at
 * read time (never stored, so no schema change), unsanitized on purpose. The
 * name carries the warning across the wire: the only caller that may render it
 * is the sanitizer boundary in the SPA, which runs DOMPurify first. */
export type MessageDetail = MessageSummary & {
	to: string | null;
	date: string | null;
	bodyText: string | null;
	unsafeBodyHtml: string | null;
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

function secureDbFiles(path: string): void {
	chmodIfExists(path, 0o600);
	chmodIfExists(`${path}-wal`, 0o600);
	chmodIfExists(`${path}-shm`, 0o600);
}

type ColumnType = 'TEXT' | 'INTEGER';

/** A column SQLite computes from `raw` on its own, as a GENERATED column. */
type Projection = {
	/** The `json_extract` path, e.g. `$.threadId`. */
	path: string;
	/** `STORED` when a read or an index needs the value materialized. */
	storage: 'VIRTUAL' | 'STORED';
	/** Wrap in `CAST(... AS <type>)` when SQLite must be told the affinity. */
	cast: ColumnType | null;
};

/**
 * One declared column. Exactly one of `projected` and `derivation` is set, or
 * neither for a plain column the app writes verbatim.
 */
type ColumnDeclaration = {
	name: string;
	type: ColumnType;
	constraint: string | null;
	projected: Projection | null;
	derivation: string | null;
};

type TableDeclaration = { table: string; columns: ColumnDeclaration[] };

/** A column the app writes verbatim: an id, the raw blob, a bookkeeping stamp. */
function stored(
	name: string,
	type: ColumnType,
	constraint: string | null = null,
): ColumnDeclaration {
	return { name, type, constraint, projected: null, derivation: null };
}

/** A column SQLite projects out of `raw`; the declaration carries the expression. */
function projected(
	name: string,
	type: ColumnType,
	projection: Projection,
): ColumnDeclaration {
	return {
		name,
		type,
		constraint: null,
		projected: projection,
		derivation: null,
	};
}

/**
 * A column whose value the app computes in TypeScript at ingest, named by what
 * it holds. Gmail nests headers as an array and MIME bodies as a base64url part
 * tree, so neither is reachable from a `json_extract` path: `message-fields.ts`
 * decodes them once at ingest and the column stores the result.
 *
 * The string is therefore the one hand-maintained fingerprint input in this
 * file, and it is irreducible rather than a `SCHEMA_VERSION` in disguise. The
 * fingerprint has to answer "is the stored shape the same shape as before", and
 * for these three columns the stored shape is a TypeScript function's output.
 * ADR-0194 rejects hashing function source (formatting and bundling changes are
 * not shape changes), so what is declared is the contract: change what
 * `bodyText` selects and this string no longer describes the column, which
 * renames the artifact and re-pulls. The check a reviewer runs is local ("does
 * this string still describe what the function does?"), not a global constant
 * disconnected from the change that invalidated it.
 */
function derived(
	name: string,
	type: ColumnType,
	derivation: string,
): ColumnDeclaration {
	return { name, type, constraint: null, projected: null, derivation };
}

/**
 * The mirror's declared stored shape, as plain data. It is BOTH the source the
 * DDL below is generated from AND the fingerprint input that names the artifact
 * on disk, so a shape change cannot be made without renaming the artifact.
 *
 * Column order is meaningful (it is the table's column order), so it is
 * preserved rather than sorted. Table order is not, but this is a closed
 * three-table literal rather than a registry, so there is nothing to reorder by
 * accident and sorting would only hide the DDL's real shape.
 *
 * Indexes are deliberately absent: an index holds no mirror facts and is applied
 * idempotently on every open, so a query optimization must not force a re-pull.
 * That is what makes migration two-speed. Adding a `CREATE INDEX IF NOT EXISTS`
 * line in `openMailDb` costs nothing; touching this literal costs one full
 * paginated re-pull of the mailbox, with the predecessor retained until
 * something calls `reclaim`.
 */
const MIRROR_DECLARATION = {
	tables: [
		{
			table: '_meta',
			columns: [stored('key', 'TEXT', 'PRIMARY KEY'), stored('value', 'TEXT')],
		},
		{
			table: 'messages',
			columns: [
				stored('id', 'TEXT', 'PRIMARY KEY'),
				stored('raw', 'TEXT', 'NOT NULL'),
				projected('thread_id', 'TEXT', {
					path: '$.threadId',
					storage: 'VIRTUAL',
					cast: null,
				}),
				projected('snippet', 'TEXT', {
					path: '$.snippet',
					storage: 'STORED',
					cast: null,
				}),
				projected('label_ids', 'TEXT', {
					path: '$.labelIds',
					storage: 'VIRTUAL',
					cast: null,
				}),
				projected('internal_date', 'INTEGER', {
					path: '$.internalDate',
					storage: 'STORED',
					cast: 'INTEGER',
				}),
				derived('subject', 'TEXT', 'header:Subject'),
				derived('sender', 'TEXT', 'header:From'),
				derived('body_text', 'TEXT', 'body:text-plain-else-stripped-html'),
				stored('synced_at', 'TEXT', 'NOT NULL'),
			],
		},
		{
			table: 'labels',
			columns: [
				stored('id', 'TEXT', 'PRIMARY KEY'),
				stored('raw', 'TEXT', 'NOT NULL'),
				projected('name', 'TEXT', {
					path: '$.name',
					storage: 'VIRTUAL',
					cast: null,
				}),
				projected('type', 'TEXT', {
					path: '$.type',
					storage: 'VIRTUAL',
					cast: null,
				}),
				stored('synced_at', 'TEXT', 'NOT NULL'),
			],
		},
	],
} satisfies { tables: TableDeclaration[] };

const MIRROR = defineMirror({ name: 'mail', declaration: MIRROR_DECLARATION });

/**
 * The mirror as materialized for one account: `<dataDir>/<accountEmail>/`. The
 * site answers what the current artifact's path is, what else is on disk, and
 * how to open or reclaim it; nothing outside this file assembles a mirror path.
 */
export function mailMirror(dataDir: string, accountEmail: string): MirrorSite {
	return MIRROR.at(accountDir(dataDir, accountEmail));
}

/** `CREATE TABLE IF NOT EXISTS` for one declared table. */
function createTableSql({ table, columns }: TableDeclaration): string {
	const defs = columns.map((c) => {
		const constraint = c.constraint ? ` ${c.constraint}` : '';
		if (!c.projected) return `${c.name} ${c.type}${constraint}`;
		const { path, storage, cast } = c.projected;
		const extract = `json_extract(raw, '${path}')`;
		const expression = cast ? `CAST(${extract} AS ${cast})` : extract;
		return `${c.name} ${c.type} GENERATED ALWAYS AS (${expression}) ${storage}`;
	});
	return `CREATE TABLE IF NOT EXISTS ${table} (\n\t${defs.join(',\n\t')}\n);`;
}

const CREATE_TABLES = MIRROR_DECLARATION.tables.map(createTableSql);

/**
 * Applied on every open and deliberately outside the declaration, so adding one
 * costs a query plan and not a mailbox re-download.
 */
const CREATE_INDEXES = [
	`CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, internal_date);`,
	`CREATE INDEX IF NOT EXISTS idx_messages_internal_date ON messages(internal_date);`,
];

type MailDbLocation = { dataDir: string; accountEmail: string };

/**
 * Open the account's current mirror artifact for writing, creating it if absent.
 * Nothing here inspects, migrates, or drops what it finds: a different
 * declaration is a different filename, so an artifact this opens is always one
 * this build wrote (ADR-0194).
 *
 * Permissions stay with the app, and their ordering is the reason this does not
 * simply call `site.open()`. Both directories are secured to 0700 BEFORE the
 * artifact exists, so the file and its `-wal`/`-shm` sidecars are born inside a
 * directory no other user can traverse. The 0600 chmod cannot come first: the
 * sidecars do not exist until `journal_mode = WAL` creates them, which is inside
 * `open()`. The directory mode is what closes the window; the file mode is the
 * second layer, applied the moment there is a file to apply it to.
 */
export function openMailDb({ dataDir, accountEmail }: MailDbLocation) {
	const site = mailMirror(dataDir, accountEmail);
	secureDir(dataDir);
	secureDir(accountDir(dataDir, accountEmail));
	const db = site.open();
	secureDbFiles(site.path);
	for (const sql of CREATE_TABLES) db.run(sql);
	for (const sql of CREATE_INDEXES) db.run(sql);

	const setMetaStmt = db.query(
		`INSERT INTO _meta (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	);
	const getMetaStmt = db.query<{ value: string | null }, [string]>(
		`SELECT value FROM _meta WHERE key = ?`,
	);

	const upsertMessageStmt = db.query(
		`INSERT INTO messages (id, raw, subject, sender, body_text, synced_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   raw = excluded.raw,
		   subject = excluded.subject,
		   sender = excluded.sender,
		   body_text = excluded.body_text,
		   synced_at = excluded.synced_at`,
	);
	const deleteMessageStmt = db.query(`DELETE FROM messages WHERE id = ?`);
	const sweepMessagesStmt = db.query(
		`DELETE FROM messages WHERE synced_at < ?`,
	);
	const getMessageRawStmt = db.query<{ raw: string }, [string]>(
		`SELECT raw FROM messages WHERE id = ?`,
	);
	const hasMessageStmt = db.query<{ 1: number }, [string]>(
		`SELECT 1 FROM messages WHERE id = ?`,
	);
	const patchMessageLabelsStmt = db.query(
		`UPDATE messages SET raw = ?, synced_at = ? WHERE id = ?`,
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
		`INSERT INTO labels (id, raw, synced_at)
		 VALUES (?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET raw = excluded.raw, synced_at = excluded.synced_at`,
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
	 * Fold `labelIds` into one row's `raw`, reporting both whether the row was
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
		const row = getMessageRawStmt.get(messageId);
		if (!row) return { found: false, changed: false };
		const parsed = JSON.parse(row.raw);
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
						raw: string;
					},
					[string]
				>(
					`SELECT id, thread_id, subject, sender, snippet, internal_date,
					        label_ids, body_text, raw
					 FROM messages WHERE id = ?`,
				)
				.get(id);
			if (!row) return null;
			let to: string | null = null;
			let date: string | null = null;
			// Derived at read time from `raw`, never stored: an HTML body column
			// would only mirror `body_text` for symmetry's sake and force a schema
			// bump. `bodyHtml` is defensive on its own, but the parse shares this
			// try so a corrupt `raw` yields nulls rather than throwing.
			let unsafeBodyHtml: string | null = null;
			try {
				const message = JSON.parse(row.raw) as GmailMessage;
				to = headerValue(message, 'To');
				date = headerValue(message, 'Date');
				unsafeBodyHtml = bodyHtml(message);
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
		 * so it patches the existing row's `raw.labelIds` in place rather than
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
 * The read-only view of the current mirror artifact, for surfaces that must
 * never write (`status`, `query`), or `null` when the account has no current
 * materialization yet. "Not built" is a state a caller reports, not an error,
 * and never a file this conjures: an absent artifact used to be an `existsSync`
 * check followed by an open, which left a window between the two.
 *
 * A predecessor is never opened here. The moment the declaration changes it
 * stops being authoritative, so it is retained but not consulted; a caller that
 * wants to inspect one takes its path from `mailMirror(...).artifacts()` and
 * opens it deliberately.
 *
 * The handle rejects writes at the SQLite level, and `busy_timeout` keeps reads
 * from failing against a lock a concurrent sync briefly holds.
 */
export function openMailDbReadonly({ dataDir, accountEmail }: MailDbLocation) {
	const db = mailMirror(dataDir, accountEmail).openReadonly();
	if (db === null) return null;

	const meta = (key: string): string | null =>
		db
			.query<{ value: string | null }, [string]>(
				`SELECT value FROM _meta WHERE key = ?`,
			)
			.get(key)?.value ?? null;

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
			return {
				messages:
					db
						.query<{ n: number }, []>(`SELECT count(*) AS n FROM messages`)
						.get()?.n ?? 0,
				labels:
					db.query<{ n: number }, []>(`SELECT count(*) AS n FROM labels`).get()
						?.n ?? 0,
			};
		},

		close(): void {
			db.close();
		},
	};
}
