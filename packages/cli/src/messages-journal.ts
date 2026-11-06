/**
 * Messages' send journal: one SQLite database on this computer
 * (`<data dir>/messages/sends.sqlite`), outside the Messages folder, so no
 * editor, agent or sync touches it. It records each send attempt and its
 * exact text before Beeper is asked (`messages-outbox.ts`).
 *
 * A claim is one `BEGIN IMMEDIATE` transaction: SQLite's write lock, an
 * operating-system file lock, makes the check for a blocking attempt and
 * the insert one step across every process using the file (the local
 * program and any `epicenter messages`). The database runs in WAL mode with
 * `synchronous = FULL` and `fullfsync`, so a claim is on disk, flushed past
 * the drive's cache on macOS, before `claim` returns and before Beeper is
 * asked. A crash after that leaves the claim `claimed`, which only a
 * person's check settles.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Attempt, Journal } from './messages-outbox.js';

type Row = {
	seq: number;
	attempt_id: string;
	reply_id: string;
	reply_version: string;
	chat_id: string;
	chat_title: string | null;
	profile: string;
	text: string | null;
	state: Attempt['state'];
	active_pid: number | null;
	pending_id: string | null;
	routed_chat_id: string | null;
	delivery: string | null;
	note: string | null;
	claimed_at: string;
	updated_at: string;
};

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS sends (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		attempt_id TEXT NOT NULL UNIQUE,
		reply_id TEXT NOT NULL,
		reply_version TEXT NOT NULL,
		chat_id TEXT NOT NULL,
		chat_title TEXT,
		profile TEXT NOT NULL,
		text TEXT,
		state TEXT NOT NULL CHECK (state IN ('claimed', 'accepted', 'sent', 'failed', 'not-sent')),
		active_pid INTEGER,
		pending_id TEXT,
		routed_chat_id TEXT,
		delivery TEXT,
		note TEXT,
		claimed_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	'CREATE INDEX IF NOT EXISTS sends_by_reply ON sends (reply_id)',
	`CREATE INDEX IF NOT EXISTS sends_unsettled ON sends (chat_id) WHERE state IN ('claimed', 'accepted')`,
];

const toAttempt = (row: Row): Attempt => ({
	attemptId: row.attempt_id,
	replyId: row.reply_id,
	replyVersion: row.reply_version,
	chatId: row.chat_id,
	chatTitle: row.chat_title,
	profile: row.profile,
	text: row.text,
	state: row.state,
	activePid: row.active_pid,
	pendingId: row.pending_id,
	routedChatId: row.routed_chat_id,
	delivery: row.delivery,
	note: row.note,
	claimedAt: row.claimed_at,
	updatedAt: row.updated_at,
});

const COLUMNS = {
	state: 'state',
	activePid: 'active_pid',
	text: 'text',
	pendingId: 'pending_id',
	routedChatId: 'routed_chat_id',
	delivery: 'delivery',
	note: 'note',
	updatedAt: 'updated_at',
} as const;

/** The journal at `path`, made with its directory (private to this user) when missing. */
export function openSendJournal(path: string): Journal & { close(): void } {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const db = new Database(path, { create: true, strict: true });
	db.run('PRAGMA busy_timeout = 5000');
	db.run('PRAGMA journal_mode = WAL');
	db.run('PRAGMA synchronous = FULL');
	db.run('PRAGMA fullfsync = ON');
	db.run('PRAGMA checkpoint_fullfsync = ON');
	for (const statement of SCHEMA) db.run(statement);

	const blocking = db.query<Row, [string, string, string]>(
		`SELECT * FROM sends
		 WHERE (reply_id = ?1 AND state IN ('claimed', 'accepted'))
		    OR (chat_id = ?2 AND state = 'claimed')
		    OR (reply_id = ?1 AND reply_version = ?3 AND state = 'sent')
		 ORDER BY seq LIMIT 1`,
	);
	const insert = db.query(
		`INSERT INTO sends (attempt_id, reply_id, reply_version, chat_id, chat_title, profile, text, state, active_pid, pending_id, routed_chat_id, delivery, note, claimed_at, updated_at)
		 VALUES ($attemptId, $replyId, $replyVersion, $chatId, $chatTitle, $profile, $text, $state, $activePid, $pendingId, $routedChatId, $delivery, $note, $claimedAt, $updatedAt)`,
	);
	const byId = db.query<Row, [string]>(
		'SELECT * FROM sends WHERE attempt_id = ?1',
	);
	const unsettled = db.query<Row, []>(
		`SELECT * FROM sends WHERE state IN ('claimed', 'accepted') ORDER BY seq`,
	);
	const latestWithText = db.query<Row, []>(
		`SELECT sends.* FROM sends
		 WHERE seq = (SELECT MAX(previous.seq) FROM sends AS previous WHERE previous.reply_id = sends.reply_id)
		   AND text IS NOT NULL ORDER BY seq`,
	);

	const claim = db.transaction((attempt: Attempt) => {
		const found = blocking.get(
			attempt.replyId,
			attempt.chatId,
			attempt.replyVersion,
		);
		if (found) return toAttempt(found);
		insert.run(attempt);
		return null;
	});

	return {
		claim: (attempt) => claim.immediate(attempt),
		update(attemptId, patch, from) {
			const assignments: string[] = [];
			const values: Record<string, string | number | null> = { attemptId };
			for (const [key, column] of Object.entries(COLUMNS)) {
				const value = patch[key as keyof typeof patch];
				if (value === undefined) continue;
				assignments.push(`${column} = $${key}`);
				values[key] = value;
			}
			const states = from.map((_, index) => `$from${index}`);
			from.forEach((state, index) => {
				values[`from${index}`] = state;
			});
			const changed = db
				.query<Row, [Record<string, string | number | null>]>(
					`UPDATE sends SET ${assignments.join(', ')}
					 WHERE attempt_id = $attemptId AND state IN (${states.join(', ')})
					 RETURNING *`,
				)
				.get(values);
			return changed ? toAttempt(changed) : undefined;
		},
		get(attemptId) {
			const row = byId.get(attemptId);
			return row ? toAttempt(row) : undefined;
		},
		unsettled: () => unsettled.all().map(toAttempt),
		latestWithText: () => latestWithText.all().map(toAttempt),
		ofReplies(replyIds) {
			if (replyIds.length === 0) return [];
			const rows: Row[] = [];
			// Well under SQLite's limit on bound parameters per statement.
			for (let start = 0; start < replyIds.length; start += 500) {
				const chunk = replyIds.slice(start, start + 500);
				rows.push(
					...db
						.query<Row, string[]>(
							`SELECT * FROM sends WHERE reply_id IN (${chunk.map(() => '?').join(', ')})`,
						)
						.all(...chunk),
				);
			}
			return rows.sort((a, b) => a.seq - b.seq).map(toAttempt);
		},
		close: () => db.close(),
	};
}
