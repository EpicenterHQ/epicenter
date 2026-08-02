import { Database } from 'bun:sqlite';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { intentDbPath, openIntentDb } from './intent.ts';
import { bodyHtml, bodyText, headerValue } from './message-fields.ts';
import { accountDirPath, ensureAccountDir, secureDbFiles } from './paths.ts';
import type { GmailLabel, GmailMessage } from './schema.ts';

/**
 * The local mirror: one SQLite file per connected Gmail account. Ports
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
 * Migration is intentionally two-speed, not one blunt `SCHEMA_VERSION` bump
 * for everything: adding an index alone (a query got slow, no row or derived
 * shape change) needs nothing but a new `CREATE INDEX IF NOT EXISTS` line
 * below. Index creation runs unconditionally on every open, with no version
 * bump, no data loss, and no Gmail re-download. A row shape or derivation
 * change needs `SCHEMA_VERSION` bumped, including changes to `bodyText` or
 * header extraction. A version mismatch deletes and rebuilds the whole mirror
 * file because the corpus is disposable and Gmail owns the truth.
 */

export const SCHEMA_VERSION = '4';

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

function unlinkIfExists(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		if (code !== 'ENOENT') throw error;
	}
}

function unlinkDbFiles(path: string): void {
	unlinkIfExists(path);
	unlinkIfExists(`${path}-wal`);
	unlinkIfExists(`${path}-shm`);
}

function openWritableHandle(path: string): Database {
	const db = new Database(path, { create: true });

	db.exec('PRAGMA journal_mode = WAL;');
	db.exec('PRAGMA busy_timeout = 5000;');
	db.exec('PRAGMA synchronous = NORMAL;');
	db.exec('PRAGMA foreign_keys = ON;');
	secureDbFiles(path);
	db.exec(
		`CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);`,
	);
	return db;
}

/**
 * One SQLite file per connected account: `<data-dir>/<accountEmail>/mail.db`.
 * The mirror owns this layout; nothing outside this file assembles mirror
 * paths. `paths.ts` owns the account directory (and the guard that keeps an
 * account email from escaping the data dir).
 */
export function mailDbPath(dataDir: string, accountEmail: string): string {
	return join(accountDirPath(dataDir, accountEmail), 'mail.db');
}

/**
 * The effective-label view: Gmail's mirrored facts with the durable intent
 * overlay applied, one row per `(message, label)`. Every read model below and
 * every ad-hoc SQL query see the same definition, so "what the app shows" has
 * exactly one meaning.
 *
 * The shape matters for more than tidiness. Written as a plain join of
 * `messages` against a per-message effective array, SQLite can push a
 * `message_id = ?` constraint from a correlated use straight into the messages
 * primary key. Written as a top-level `UNION ALL` of two branches it cannot, and
 * a filtered page over a 100k-message mirror goes from sub-millisecond to
 * hundreds of milliseconds. Keep the union inside the scalar subquery.
 *
 * `overlaid` is false only when there is no intent store to attach, which a
 * read-only opener must not create. The overlay arms simply drop out, which is
 * the honest reading of "nothing is asserted": effective labels are the
 * mirrored ones. It is the same definition with an empty overlay, not a second
 * answer to the same question.
 *
 * The view lives in TEMP, not in the mirror file, because it names an attached
 * database: a connection that opened the mirror without `intent` attached must
 * not inherit a view it cannot resolve. TEMP also lets a read-only mirror handle
 * define it, since the temp schema is writable either way.
 */
function effectiveLabelsView(overlaid: boolean): string {
	return `
	CREATE TEMP VIEW IF NOT EXISTS effective_labels AS
		SELECT m.id AS message_id, j.value AS label_id
		  FROM messages m,
		       json_each((
		         SELECT json_group_array(value) FROM (
		           SELECT mirrored.value AS value
		             FROM json_each(m.label_ids) mirrored
		            ${
									overlaid
										? `WHERE NOT EXISTS (
		                  SELECT 1 FROM intent.label_intents i
		                   WHERE i.message_id = m.id AND i.label_id = mirrored.value)
		           UNION ALL
		           SELECT i.label_id
		             FROM intent.label_intents i
		            WHERE i.message_id = m.id AND i.want = 1`
										: ''
								}))) j`;
}

/** The effective label set of the row a query is currently on, as a JSON array
 * string. Correlated, so it is computed only for the rows a page returns. */
const EFFECTIVE_LABEL_IDS = `(
	SELECT json_group_array(e.label_id) FROM effective_labels e
	 WHERE e.message_id = messages.id)`;

/** Whether the row a query is currently on effectively carries `param`'s label.
 * Used for both the label filter and Gmail's trash rule, so the two can never
 * disagree about what "has this label" means. */
function hasEffectiveLabel(param: string): string {
	return `EXISTS (
		SELECT 1 FROM effective_labels e
		 WHERE e.message_id = messages.id AND e.label_id = ${param})`;
}

/**
 * The read-only URI form of a path, for `ATTACH`. SQLite treats an attachment
 * argument beginning with `file:` as a URI, and `?mode=ro` is what keeps a
 * writable mirror connection from becoming a second writer to the durable
 * store. Percent-escaping is not cosmetic here: an unescaped `?` or `#` in a
 * data-dir path would be read as the URI's query or fragment, and SQLite would
 * silently attach a DIFFERENT, empty database rather than fail.
 */
function readOnlyAttachUri(path: string): string {
	const escaped = encodeURI(path).replaceAll('?', '%3f').replaceAll('#', '%23');
	return `file:${escaped}?mode=ro`;
}

/**
 * Attach one account's durable intent store to a mirror connection and define
 * the effective-label view over it.
 *
 * `create` says whether this opener may bring the store into existence. A
 * writable mirror is opened by a path that is about to need it, so it prepares
 * both files. A read-only opener (`query`, `status`) must not: a question about
 * an account should not leave a durable file behind, so when there is no store
 * it attaches nothing and the view degenerates to the mirrored labels.
 *
 * Attaching read-only is the ownership statement, and it also decouples the two
 * files' locks: a writable attachment would be pulled into every
 * `BEGIN IMMEDIATE` on the mirror, so a full-pull page commit would block a
 * triage act mid-flight. `intent.ts` holds the only handle that may write here.
 */
function attachIntent(
	db: Database,
	{ dataDir, accountEmail }: MailDbLocation,
	{ create }: { create: boolean },
): void {
	const path = intentDbPath(dataDir, accountEmail);
	if (create) {
		// Opened and closed by its own owner first: attaching a missing file under
		// `mode=ro` fails outright, and an empty one has no table for the view.
		openIntentDb({ dataDir, accountEmail }).close();
	} else if (!existsSync(path)) {
		db.exec(effectiveLabelsView(false));
		return;
	}
	db.run('ATTACH DATABASE ? AS intent', [readOnlyAttachUri(path)]);
	db.exec(effectiveLabelsView(true));
}

type MailDbLocation = { dataDir: string; accountEmail: string };

export function openMailDb({ dataDir, accountEmail }: MailDbLocation) {
	const path = mailDbPath(dataDir, accountEmail);
	ensureAccountDir(dataDir, accountEmail);
	let db = openWritableHandle(path);

	const storedVersion =
		db
			.query<{ value: string | null }, [string]>(
				`SELECT value FROM _meta WHERE key = ?`,
			)
			.get('schema_version')?.value ?? null;
	if (storedVersion !== null && storedVersion !== SCHEMA_VERSION) {
		db.close();
		unlinkDbFiles(path);
		db = openWritableHandle(path);
	}

	const setMetaStmt = db.query(
		`INSERT INTO _meta (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	);
	const getMetaStmt = db.query<{ value: string | null }, [string]>(
		`SELECT value FROM _meta WHERE key = ?`,
	);

	db.exec(`
		CREATE TABLE IF NOT EXISTS messages (
			id            TEXT PRIMARY KEY,
			raw           TEXT NOT NULL,
			thread_id     TEXT GENERATED ALWAYS AS (json_extract(raw, '$.threadId')) VIRTUAL,
			snippet       TEXT GENERATED ALWAYS AS (json_extract(raw, '$.snippet')) STORED,
			label_ids     TEXT GENERATED ALWAYS AS (json_extract(raw, '$.labelIds')) VIRTUAL,
			internal_date INTEGER GENERATED ALWAYS AS (CAST(json_extract(raw, '$.internalDate') AS INTEGER)) STORED,
			subject       TEXT,
			sender        TEXT,
			body_text     TEXT,
			synced_at     TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, internal_date);
		CREATE INDEX IF NOT EXISTS idx_messages_internal_date ON messages(internal_date);

		CREATE TABLE IF NOT EXISTS labels (
			id         TEXT PRIMARY KEY,
			raw        TEXT NOT NULL,
			name       TEXT GENERATED ALWAYS AS (json_extract(raw, '$.name')) VIRTUAL,
			type       TEXT GENERATED ALWAYS AS (json_extract(raw, '$.type')) VIRTUAL,
			synced_at  TEXT NOT NULL
		);
	`);
	setMetaStmt.run('schema_version', SCHEMA_VERSION);
	// After the version check, so a rebuilt mirror still gets the overlay, and
	// after the mirror schema, so the view's reference to `messages` resolves.
	attachIntent(db, { dataDir, accountEmail }, { create: true });

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
	 * `found` (the reconciler's fold cares only about this) and whether the label
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
		 * to messages carrying that label EFFECTIVELY (Gmail's facts with the
		 * durable intent overlay applied), and an optional `search` matches
		 * subject/sender/body. Both are pushed into SQL so the process never
		 * materializes the whole mirror, and so filtering, ordering, and
		 * `LIMIT`/`OFFSET` are all computed post-overlay: a message the user just
		 * archived leaves the inbox page immediately, and the page still comes
		 * back full. Compiled per call (dynamic WHERE), which is fine at mirror
		 * scale and mirrors the `query` verb's discipline.
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
				where.push(hasEffectiveLabel('$labelId'));
				params.$labelId = labelId;
			}
			// Mirror Gmail's own rule: Trash is hidden from every view (Inbox, All
			// mail, any label) except Trash itself. A trashed row is folded, not
			// deleted, so this read-model filter is what makes it leave the current
			// view; asserting `TRASH` makes it leave before Gmail has even been
			// told, because the assertion is part of the effective label set.
			if (labelId !== 'TRASH') {
				where.push(`NOT ${hasEffectiveLabel(`'TRASH'`)}`);
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
					`SELECT id, thread_id, subject, sender, snippet, internal_date,
					        ${EFFECTIVE_LABEL_IDS} AS label_ids
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
					        ${EFFECTIVE_LABEL_IDS} AS label_ids, body_text, raw
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
		 * a change the reconciler already folded) is applied but not
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
 * The read-only view of a mirror file, for surfaces that must never write and
 * must never assume the on-disk schema is current (`status`, `query`): a
 * pre-current mirror is a valid thing to inspect, so nothing here prepares a
 * statement against today's column set up front; every read compiles at call
 * time against whatever schema the file actually has. The handle rejects
 * writes at the SQLite level, and `busy_timeout` keeps reads from failing
 * against a lock a concurrent reconcile briefly holds.
 *
 * The intent overlay is attached here too, so `local-mail query` and the MCP
 * `query` tool see the same `effective_labels` the app's read models do. SQLite
 * refuses writes through an attachment on a read-only connection, so the ad-hoc
 * SQL surface can read the durable store without becoming a second writer to it.
 */
export function openMailDbReadonly({ dataDir, accountEmail }: MailDbLocation) {
	const db = new Database(mailDbPath(dataDir, accountEmail), {
		readonly: true,
	});
	db.exec('PRAGMA busy_timeout = 5000;');
	attachIntent(db, { dataDir, accountEmail }, { create: false });

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

		schemaVersion(): string | null {
			return meta('schema_version');
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
