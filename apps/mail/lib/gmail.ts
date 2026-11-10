/** A stand-in for Gmail, persisted in fixture-gmail.local.sqlite.
 * It survives processes and cache wipes and is never tracked.
 * modifyMessage is the only mailbox write; only reconcile calls it. */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { labels, type Message, messages } from './fixture.js';

export class GmailError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
		this.name = 'GmailError';
	}
}

export function openFixtureGmail(dir: string) {
	mkdirSync(dir, { recursive: true });
	const db = new Database(join(dir, 'fixture-gmail.local.sqlite'));
	db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
	if (
		(db.query('PRAGMA user_version').get() as { user_version: number })
			.user_version === 0
	) {
		db.transaction(() => {
			db.exec(
				`CREATE TABLE messages(id TEXT PRIMARY KEY, resource TEXT NOT NULL);
				CREATE TABLE labels(id TEXT PRIMARY KEY, name TEXT, type TEXT);
				CREATE TABLE meta(history_id INTEGER);
				INSERT INTO meta VALUES(1)`,
			);
			for (const message of messages)
				db.run('INSERT INTO messages VALUES (?,?)', [
					message.id,
					JSON.stringify(message),
				]);
			for (const label of labels)
				db.run('INSERT INTO labels VALUES (?,?,?)', [
					label.id,
					label.name,
					label.type,
				]);
			db.exec('PRAGMA user_version=1');
		}).immediate();
	}
	return {
		close() {
			db.close();
		},
		getProfile() {
			return {
				historyId: String(
					(
						db.query('SELECT history_id FROM meta').get() as {
							history_id: number;
						}
					).history_id,
				),
			};
		},
		listLabels() {
			return db
				.query('SELECT * FROM labels ORDER BY id')
				.all() as typeof labels;
		},
		listMessages(): Message[] {
			return (
				db.query('SELECT resource FROM messages ORDER BY id').all() as {
					resource: string;
				}[]
			).map((row) => JSON.parse(row.resource));
		},
		// Only the reconcile pass calls modifyMessage: it is the single writer to Gmail.
		modifyMessage(
			id: string,
			{
				addLabelIds = [],
				removeLabelIds = [],
			}: { addLabelIds?: string[]; removeLabelIds?: string[] },
		): Message {
			return db
				.transaction(() => {
					const row = db
						.query('SELECT resource FROM messages WHERE id=?')
						.get(id) as { resource: string } | null;
					if (!row) throw new GmailError(404, `No message ${id}`);
					for (const label of [...addLabelIds, ...removeLabelIds])
						if (!db.query('SELECT id FROM labels WHERE id=?').get(label))
							throw new GmailError(400, `No label ${label}`);
					const message: Message = JSON.parse(row.resource);
					const next = new Set(message.labelIds ?? []);
					for (const label of addLabelIds) next.add(label);
					for (const label of removeLabelIds) next.delete(label);
					if (next.size) message.labelIds = [...next].sort();
					else delete message.labelIds;
					db.run('UPDATE messages SET resource=? WHERE id=?', [
						JSON.stringify(message),
						id,
					]);
					db.exec('UPDATE meta SET history_id=history_id+1');
					return message;
				})
				.immediate();
		},
	};
}
export type Gmail = {
	getProfile(): { historyId: string } | Promise<{ historyId: string }>;
	listLabels(): typeof labels | Promise<typeof labels>;
	listMessages(): Message[] | Promise<Message[]>;
	modifyMessage(
		id: string,
		change: { addLabelIds?: string[]; removeLabelIds?: string[] },
	): Message | Promise<Message>;
};
