import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { bodyHtml, bodyText, headerValue } from './message-fields.ts';
import {
	CREATE_INDEXES_SQL,
	CREATE_TABLES_SQL,
	MIRROR_FINGERPRINT,
} from './mirror-schema.ts';
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
 * Migration is intentionally two-speed, and neither speed is a hand-stamped
 * version any more. Adding an index alone (a query got slow, no row or derived
 * shape change) needs nothing but a new line in `CREATE_INDEXES_SQL`: index
 * creation runs unconditionally on every open, with no fingerprint change, no
 * data loss, and no Gmail re-download. A row shape or derivation change moves
 * `MIRROR_FINGERPRINT` instead, either on its own (the tables are generated
 * from the same declaration that is fingerprinted) or through a
 * `STORED_PROJECTIONS` token for the columns imperative code fills. A
 * fingerprint mismatch deletes and rebuilds the whole mirror file, because the
 * corpus is disposable and Gmail owns the truth.
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
 * paths. The account email names a directory, so it must be exactly one path
 * segment: emails reach here from Google's profile endpoint or a
 * store-validated override, and this guard keeps any other string from
 * escaping the data dir.
 */
export function mailDbPath(dataDir: string, accountEmail: string): string {
	if (
		accountEmail.length === 0 ||
		accountEmail === '.' ||
		accountEmail === '..' ||
		accountEmail.includes('/') ||
		accountEmail.includes('\\')
	) {
		throw new Error(
			`Account email ${JSON.stringify(accountEmail)} cannot name a mirror directory.`,
		);
	}
	return join(dataDir, accountEmail, 'mail.db');
}

type MailDbLocation = { dataDir: string; accountEmail: string };

export function openMailDb({ dataDir, accountEmail }: MailDbLocation) {
	const path = mailDbPath(dataDir, accountEmail);
	secureDir(dataDir);
	secureDir(join(dataDir, accountEmail));
	let db = openWritableHandle(path);

	// The rebuild gate, writers only. Anything but an exact fingerprint match is
	// a rebuild, including a missing one: a file this code did not stamp (a
	// pre-fingerprint mirror carrying the retired `schema_version`, or a
	// hand-made one) holds columns today's reads would misinterpret. A brand-new
	// file takes this branch too, discarding the empty `_meta` the open above
	// created, so after this point the on-disk fingerprint is always current.
	const storedFingerprint =
		db
			.query<{ value: string | null }, [string]>(
				`SELECT value FROM _meta WHERE key = ?`,
			)
			.get('mirror_fingerprint')?.value ?? null;
	if (storedFingerprint !== MIRROR_FINGERPRINT) {
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

	db.exec(CREATE_TABLES_SQL);
	// Outside the fingerprint on purpose: re-applied every open, never a rebuild.
	db.exec(CREATE_INDEXES_SQL);
	setMetaStmt.run('mirror_fingerprint', MIRROR_FINGERPRINT);

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

	/**
	 * The only site that writes the imperatively projected columns. `subject`,
	 * `sender`, and `body_text` each carry a `STORED_PROJECTIONS` token: change
	 * what these three calls produce for the same message (including which
	 * header feeds which column) and bump the matching token, or mirrors written
	 * by older code keep values this code would never have produced.
	 */
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
 * The read-only view of a mirror file, for surfaces that must never write and
 * must never assume the on-disk schema is current (`status`, `query`): a
 * pre-current mirror is a valid thing to inspect, so nothing here prepares a
 * statement against today's column set up front; every read compiles at call
 * time against whatever schema the file actually has. The handle rejects
 * writes at the SQLite level, and `busy_timeout` keeps reads from failing
 * against a lock a concurrent sync briefly holds.
 */
export function openMailDbReadonly({ dataDir, accountEmail }: MailDbLocation) {
	const db = new Database(mailDbPath(dataDir, accountEmail), {
		readonly: true,
	});
	db.exec('PRAGMA busy_timeout = 5000;');

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

		/**
		 * The shape fingerprint the last writer stamped, reported verbatim. A
		 * reader never compares, rebuilds, or stamps: judging staleness against
		 * `MIRROR_FINGERPRINT` is the caller's job (`status.ts`), and acting on it
		 * is the next writer's.
		 */
		mirrorFingerprint(): string | null {
			return meta('mirror_fingerprint');
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
