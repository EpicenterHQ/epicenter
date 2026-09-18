/**
 * One account's mailbox and intent store over in-memory databases, for tests.
 *
 * The two databases are separate here for the same reason they are separate in
 * production: the mail copy is one file per account and the durable file is one
 * per device, so a fixture that shared one database would make the cache reset
 * promise untestable and would let a mail statement reach a row it cannot reach
 * for real (ADR-0319).
 */

import type { AppSqliteDatabase } from '@epicenter/device';
import { createTestAppSqlite } from './app-sqlite.test-support.ts';
import { type IntentStore, openIntentStore } from './intent-store.ts';
import { type Mailbox, openMailbox } from './mailbox.ts';
import { openPassRecord, type PassRecord } from './outbox.ts';
import { LOCAL_SCHEMA, MAIL_CACHE_SCHEMA } from './storage.ts';

export type TestSession = {
	sub: string;
	mailbox: Mailbox;
	intents: IntentStore;
	passes: PassRecord;
	/** The two databases, for a test that reopens handles over them. */
	mailboxDatabase: AppSqliteDatabase;
	localDatabase: AppSqliteDatabase;
	/**
	 * One row straight out of the cache, for a test that wants to see what
	 * landed rather than what a read model says about it.
	 */
	row<TRow>(
		sql: string,
		parameters?: readonly (string | number | null)[],
	): Promise<TRow | undefined>;
	close(): void;
};

export async function openTestSession(
	sub = 'account-one',
): Promise<TestSession> {
	const mail = createTestAppSqlite();
	const local = createTestAppSqlite();
	for (const sql of MAIL_CACHE_SCHEMA) {
		const applied = await mail.run(sql);
		if (applied.error !== null) throw applied.error;
	}
	for (const sql of LOCAL_SCHEMA) {
		const applied = await local.run(sql);
		if (applied.error !== null) throw applied.error;
	}
	return {
		sub,
		mailboxDatabase: mail,
		localDatabase: local,
		mailbox: openMailbox(mail),
		intents: openIntentStore(local, sub),
		passes: openPassRecord(local, sub),
		async row<TRow>(
			sql: string,
			parameters: readonly (string | number | null)[] = [],
		) {
			const rows = await mail.all(sql, parameters);
			if (rows.error !== null) throw rows.error;
			return rows.data[0] as TRow | undefined;
		},
		close: () => {
			mail.close();
			local.close();
		},
	};
}
