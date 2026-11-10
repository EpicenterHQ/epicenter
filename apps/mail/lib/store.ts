/** Two files, two lifetimes: .cache/mirror.sqlite is rebuildable;
 * intent.local.sqlite holds the durable ADR-0198 partial map.
 * Message reads use effective_labels so pending intent shows immediately. */
import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type Message, systemLabels } from './fixture.js';
import { parseQuery } from './query.js';

export const MIRROR_VERSION = 1;
export type Intent = {
	message_id: string;
	label_id: string;
	want: number;
	seq: number;
	asserted_at: string;
};
export type Snapshot = {
	messages: Message[];
	labels: { id: string; name: string; type: string }[];
	cursor: string;
};
type MessageRecord = {
	id: string;
	thread_id: string;
	from_name: string;
	from_address: string;
	to_text: string;
	subject: string;
	snippet: string;
	body: string;
	internal_date: number;
};

export function openStore(dir: string) {
	mkdirSync(join(dir, '.cache'), { recursive: true });
	const path = join(dir, '.cache/mirror.sqlite');
	let db = new Database(path);
	const version = (
		db.query('PRAGMA user_version').get() as { user_version: number }
	).user_version;
	if (version !== 0 && version !== MIRROR_VERSION) {
		db.close();
		for (const suffix of ['', '-wal', '-shm'])
			rmSync(path + suffix, { force: true });
		db = new Database(path);
	}
	db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
		CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, thread_id TEXT, from_name TEXT, from_address TEXT, to_text TEXT, subject TEXT, snippet TEXT, body TEXT, internal_date INTEGER);
		CREATE TABLE IF NOT EXISTS message_labels(message_id TEXT, label_id TEXT, PRIMARY KEY(message_id,label_id));
		CREATE TABLE IF NOT EXISTS labels(id TEXT PRIMARY KEY, name TEXT, type TEXT);
		CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
		PRAGMA user_version=${MIRROR_VERSION}`);
	db.run('ATTACH DATABASE ? AS intent', [join(dir, 'intent.local.sqlite')]);
	db.exec(`PRAGMA intent.journal_mode=WAL;
		CREATE TABLE IF NOT EXISTS intent.label_intents(message_id TEXT, label_id TEXT, want INTEGER CHECK(want IN (0,1)), seq INTEGER, asserted_at TEXT, PRIMARY KEY(message_id,label_id));
		CREATE TABLE IF NOT EXISTS intent.meta(key TEXT PRIMARY KEY, value INTEGER);
		INSERT OR IGNORE INTO intent.meta VALUES ('seq',0);
		CREATE TEMP VIEW effective_labels AS
		SELECT message_id,label_id FROM message_labels ml WHERE NOT EXISTS (SELECT 1 FROM intent.label_intents i WHERE i.message_id=ml.message_id AND i.label_id=ml.label_id AND i.want=0)
		UNION SELECT message_id,label_id FROM intent.label_intents i WHERE want=1 AND EXISTS (SELECT 1 FROM messages m WHERE m.id=i.message_id)`);
	function meta(key: string) {
		return (
			(
				db.query('SELECT value FROM meta WHERE key=?').get(key) as {
					value: string;
				} | null
			)?.value ?? null
		);
	}
	function pendingRows() {
		return db
			.query('SELECT * FROM intent.label_intents ORDER BY seq')
			.all() as Intent[];
	}
	function pendingSummary() {
		return db
			.query(
				'SELECT count(*) AS count, min(asserted_at) AS oldestAt FROM intent.label_intents',
			)
			.get() as { count: number; oldestAt: string | null };
	}
	function foldLabels(messageId: string, labelIds: string[]) {
		db.transaction(() => {
			db.run('DELETE FROM message_labels WHERE message_id=?', [messageId]);
			for (const id of new Set(labelIds))
				db.run('INSERT INTO message_labels VALUES (?,?)', [messageId, id]);
		}).immediate();
	}
	function listLabels() {
		const found = db.query('SELECT * FROM labels').all() as Snapshot['labels'];
		return [
			...new Map(
				[...systemLabels, ...found].map((label) => [label.id, label]),
			).values(),
		].sort((a, b) => a.id.localeCompare(b.id));
	}
	function row(record: MessageRecord, names: Map<string, string>) {
		const labels = (
			db
				.query(
					'SELECT label_id AS id FROM effective_labels WHERE message_id=? ORDER BY label_id',
				)
				.all(record.id) as { id: string }[]
		).map(({ id }) => ({ id, name: names.get(id) ?? id }));
		const pending = (
			db
				.query(
					'SELECT * FROM intent.label_intents WHERE message_id=? ORDER BY label_id',
				)
				.all(record.id) as Intent[]
		).map((i) => ({
			id: i.label_id,
			name: names.get(i.label_id) ?? i.label_id,
			want: i.want === 1,
			assertedAt: i.asserted_at,
		}));
		return {
			id: record.id,
			threadId: record.thread_id,
			from: { name: record.from_name, address: record.from_address },
			to: record.to_text,
			subject: record.subject,
			snippet: record.snippet,
			date: new Date(record.internal_date).toISOString(),
			labels,
			unread: labels.some((l) => l.id === 'UNREAD'),
			starred: labels.some((l) => l.id === 'STARRED'),
			pending,
		};
	}
	return {
		db,
		close() {
			db.close();
		},
		pendingRows,
		pendingSummary,
		foldLabels,
		listLabels,
		replaceMirror(snapshot: Snapshot) {
			db.transaction(() => {
				db.exec(
					'DELETE FROM messages; DELETE FROM message_labels; DELETE FROM labels',
				);
				for (const m of snapshot.messages) {
					db.run('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)', [
						m.id,
						m.threadId,
						m.from.name,
						m.from.address,
						m.to,
						m.subject,
						m.snippet,
						m.body,
						m.internalDate,
					]);
					for (const label of new Set(m.labelIds ?? []))
						db.run('INSERT INTO message_labels VALUES (?,?)', [m.id, label]);
				}
				for (const l of snapshot.labels)
					db.run('INSERT INTO labels VALUES (?,?,?)', [l.id, l.name, l.type]);
				for (const [key, value] of [
					['cursor', snapshot.cursor],
					['refreshedAt', new Date().toISOString()],
				])
					db.run('INSERT OR REPLACE INTO meta VALUES (?,?)', [key!, value!]);
			}).immediate();
		},
		assert(pairs: { id: string; label: string; want: boolean }[]) {
			return db
				.transaction(() =>
					pairs.map((pair) => {
						db.exec("UPDATE intent.meta SET value=value+1 WHERE key='seq'");
						const seq = (
							db
								.query("SELECT value FROM intent.meta WHERE key='seq'")
								.get() as { value: number }
						).value;
						const asserted_at = new Date().toISOString();
						db.run(
							'INSERT OR REPLACE INTO intent.label_intents VALUES (?,?,?,?,?)',
							[pair.id, pair.label, Number(pair.want), seq, asserted_at],
						);
						return {
							message_id: pair.id,
							label_id: pair.label,
							want: Number(pair.want),
							seq,
							asserted_at,
						};
					}),
				)
				.immediate();
		},
		retire(rows: Intent[]) {
			db.transaction(() => {
				for (const i of rows)
					db.run(
						'DELETE FROM intent.label_intents WHERE message_id=? AND label_id=? AND seq=?',
						[i.message_id, i.label_id, i.seq],
					);
			}).immediate();
		},
		status() {
			return {
				refreshedAt: meta('refreshedAt'),
				cursor: meta('cursor'),
				messages: (
					db.query('SELECT count(*) AS n FROM messages').get() as { n: number }
				).n,
				pending: pendingSummary().count,
				oldestPendingAt: pendingSummary().oldestAt,
			};
		},
		search(query: string, limit: number) {
			const { where, params } = parseQuery(query);
			const total = (
				db
					.query(`SELECT count(*) AS n FROM messages m WHERE ${where}`)
					.get(...params) as { n: number }
			).n;
			const names = new Map(
				listLabels().map((label) => [label.id, label.name]),
			);
			const records = db
				.query(
					`SELECT m.* FROM messages m WHERE ${where} ORDER BY internal_date DESC, id DESC LIMIT ?`,
				)
				.all(...params, limit) as MessageRecord[];
			return { total, messages: records.map((record) => row(record, names)) };
		},
		show(id: string) {
			const record = db
				.query('SELECT * FROM messages WHERE id=?')
				.get(id) as MessageRecord | null;
			if (!record)
				throw new Error(
					`There is no message ${id} in the mirror; run epicenter mail refresh`,
				);
			const names = new Map(
				listLabels().map((label) => [label.id, label.name]),
			);
			return { ...row(record, names), body: record.body };
		},
		labelCounts() {
			return listLabels().map((label) => ({
				...label,
				type: label.type as 'system' | 'user',
				...(db
					.query(
						`SELECT count(*) AS total,
						coalesce(sum(EXISTS(
							SELECT 1 FROM effective_labels u
							WHERE u.message_id=e.message_id AND u.label_id='UNREAD'
						)),0) AS unread
						FROM effective_labels e WHERE e.label_id=?`,
					)
					.get(label.id) as { total: number; unread: number }),
			}));
		},
	};
}
export type Store = ReturnType<typeof openStore>;
