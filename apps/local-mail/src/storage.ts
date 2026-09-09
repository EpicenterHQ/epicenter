import {
	type AppSqliteDatabase,
	isSecretLabel,
	type SecretLabel,
} from '@epicenter/device';
import type { ScopedSqlite } from '@epicenter/device/owner';
import { type SqliteHandle, sqliteHandle } from './handle.ts';

/**
 * This App's connected Gmail accounts and pending triage live in `local`.
 * Downloaded Gmail facts live in one disposable `mail-<sub>` file per subject.
 * App scopes both files and secrets to the selected Epicenter account.
 * The account namespace starts fresh; old device-owned files are left alone.
 */

export const LOCAL_MAIL_APP_ID = 'so.epicenter.local-mail';

/** The durable file. One per captured Epicenter account on this device; retained until erasure. */
export const LOCAL_DATABASE = 'local';

/**
 * Where one account's bytes are filed: the file it owns, and the label its
 * refresh token is kept under.
 *
 * Both derived from the Google subject, so nothing allocates either and
 * reconnecting an account lands on its own rows by arithmetic. They are minted
 * together because they are refused together: a subject the platform cannot
 * file is not a mailbox and not a credential, and `finishConnect` is where
 * that becomes a sentence, because "we cannot file your mail under that" is a
 * thing only this application can say. Google issues numeric subjects, so
 * nothing has reached it.
 */
export type AccountFiling = {
	readonly database: string;
	readonly secret: SecretLabel;
};

export function accountFiling(sub: string): AccountFiling | undefined {
	const database = `mail-${sub}`;
	return /^mail-[a-z0-9_-]+$/.test(database) && isSecretLabel(sub)
		? { database, secret: sub }
		: undefined;
}

/**
 * The same, for an account that is already connected, which by then is one.
 *
 * `finishConnect` refuses a subject this platform cannot file before a row for
 * it exists, so every `sub` read back out of the account table has passed. A
 * throw here is that invariant stated, not a condition a caller handles.
 */
export function requireAccountFiling(sub: string): AccountFiling {
	const filing = accountFiling(sub);
	if (filing === undefined) {
		throw new Error(`No mail file can be named for the subject '${sub}'.`);
	}
	return filing;
}

export type LocalMailStorage = {
	/** The durable file: who is connected, and what this machine owes Gmail. */
	local: AppSqliteDatabase;
	/** One account's borrowed copy, opened at the shape this build expects. */
	mail(sub: string): Promise<AppSqliteDatabase>;
	/** Unlink one account's borrowed copy and forget the handle to it. */
	forgetMail(sub: string): Promise<void>;
};

/**
 * Open the durable file and hand back the opener for the borrowed ones.
 *
 * A mail file is opened once per subject and held, exactly as the owner holds
 * every handle, and the `Promise` is what is cached rather than the handle, so
 * two callers asking at once join one open instead of racing it.
 */
export async function openLocalMailStorage(app: {
	sqlite: ScopedSqlite;
}): Promise<LocalMailStorage> {
	const local = await open(app, LOCAL_DATABASE);
	await initializeDurable(sqliteHandle(local));

	const mailboxes = new Map<string, Promise<AppSqliteDatabase>>();
	function opening(sub: string): Promise<AppSqliteDatabase> {
		const existing = mailboxes.get(sub);
		if (existing !== undefined) return existing;
		const opened = openBorrowed(app, requireAccountFiling(sub).database);
		// This open, not whatever is under the key when it fails.
		opened.catch(() => {
			if (mailboxes.get(sub) === opened) mailboxes.delete(sub);
		});
		mailboxes.set(sub, opened);
		return opened;
	}

	return {
		local,
		mail: opening,
		forgetMail: async (sub) => {
			// Settle an open already in flight before unlinking. ADR-0321 makes
			// sequencing the application's invariant to keep: a `sqlite.open`
			// landing after the `sqlite.delete` recreates the file this removed.
			const inflight = mailboxes.get(sub);
			mailboxes.delete(sub);
			await inflight?.catch(() => undefined);
			const gone = await app.sqlite.delete(requireAccountFiling(sub).database);
			if (gone.error !== null) throw gone.error;
		},
	};
}

async function open(
	app: { sqlite: ScopedSqlite },
	name: string,
): Promise<AppSqliteDatabase> {
	const opened = await app.sqlite.open(name);
	if (opened.error !== null) throw opened.error;
	return opened.data;
}

/**
 * The durable file's shape in the fresh account namespace.
 *
 * `user_version` identifies this schema because pending triage cannot be
 * fetched again. A file stamped ahead of this build belongs to a newer release
 * and is refused rather than opened: a downgrade that wrote through an older
 * schema would lose the columns it does not know about.
 */
export const LOCAL_SCHEMA_VERSION = 1;

export const LOCAL_SCHEMA = [
	`CREATE TABLE IF NOT EXISTS accounts (
		sub TEXT PRIMARY KEY,
		email TEXT NOT NULL,
		connected_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS label_intents (
		sub TEXT NOT NULL,
		message_id TEXT NOT NULL,
		label_id TEXT NOT NULL,
		want INTEGER NOT NULL,
		revision INTEGER NOT NULL,
		asserted_at TEXT NOT NULL,
		PRIMARY KEY (sub, message_id, label_id)
	)`,
	`CREATE TABLE IF NOT EXISTS intent_counters (
        sub TEXT PRIMARY KEY,
        next_revision INTEGER NOT NULL
    )`,
	`CREATE TABLE IF NOT EXISTS last_pass (
		sub TEXT PRIMARY KEY,
		finished_at TEXT NOT NULL,
		discarded TEXT NOT NULL,
		failure_kind TEXT,
		failure_name TEXT,
		failure_message TEXT
	)`,
] as const;

async function initializeDurable(handle: SqliteHandle): Promise<void> {
	const version = await userVersion(handle);
	if (version === LOCAL_SCHEMA_VERSION) return;
	if (version > LOCAL_SCHEMA_VERSION) {
		throw new Error(
			`This device's Local Mail data was written by a newer version (${version}); this build understands ${LOCAL_SCHEMA_VERSION}.`,
		);
	}
	await handle.batch([
		...LOCAL_SCHEMA.map((sql) => ({ sql })),
		{ sql: `PRAGMA user_version = ${LOCAL_SCHEMA_VERSION}` },
	]);
}

/**
 * The disposable copy of Gmail, one file per account.
 *
 * Three tiers and no fourth (ADR-0196): the verbatim `messages.get` resource,
 * every column SQLite can project from it, and exactly the columns SQL cannot
 * project that pushed-down search and sort need. A generated column cannot
 * disagree with the resource it came from, which is why every column that can
 * be one is one.
 *
 * No account column anywhere, because the file is the scope. A statement here
 * cannot reach another account's mail, which is the isolation an arbitrary-SQL
 * handle can actually enforce (ADR-0319).
 */
export const MAIL_SCHEMA_VERSION = 1;

export const MAIL_CACHE_SCHEMA = [
	`CREATE TABLE IF NOT EXISTS sync_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        history_id TEXT,
        last_synced_at TEXT
    )`,
	`INSERT OR IGNORE INTO sync_state (id) VALUES (1)`,
	`CREATE TABLE IF NOT EXISTS messages (
		id TEXT PRIMARY KEY,
		resource TEXT NOT NULL,
		snippet TEXT GENERATED ALWAYS AS (json_extract(resource, '$.snippet')) STORED,
		label_ids TEXT GENERATED ALWAYS AS (json_extract(resource, '$.labelIds')) VIRTUAL,
		internal_date INTEGER GENERATED ALWAYS AS (CAST(json_extract(resource, '$.internalDate') AS INTEGER)) STORED,
		subject TEXT,
		sender TEXT,
		body_text TEXT,
		synced_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS labels (
		id TEXT PRIMARY KEY,
		resource TEXT NOT NULL,
		name TEXT GENERATED ALWAYS AS (json_extract(resource, '$.name')) VIRTUAL,
		type TEXT GENERATED ALWAYS AS (json_extract(resource, '$.type')) VIRTUAL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_messages_recent ON messages(internal_date DESC)`,
] as const;

/** Open a known cache in place; rebuild only an unrecognized schema. */
async function openBorrowed(
	app: { sqlite: ScopedSqlite },
	name: string,
): Promise<AppSqliteDatabase> {
	const opened = await open(app, name);
	const handle = sqliteHandle(opened);
	const version = await userVersion(handle);
	if (version === MAIL_SCHEMA_VERSION) return opened;

	// A file nothing has ever written answers version zero and holds no tables,
	// which is the first account rather than a shape this build refuses. It is
	// stamped where it stands: deleting a file created one statement ago to
	// create it again is a round trip that buys nothing.
	if (await isUnwritten(handle)) {
		await applyMailSchema(handle);
		return opened;
	}

	const gone = await app.sqlite.delete(name);
	if (gone.error !== null) throw gone.error;
	const fresh = await open(app, name);
	await applyMailSchema(sqliteHandle(fresh));
	return fresh;
}

function applyMailSchema(handle: SqliteHandle): Promise<number[]> {
	return handle.batch([
		...MAIL_CACHE_SCHEMA.map((sql) => ({ sql })),
		{ sql: `PRAGMA user_version = ${MAIL_SCHEMA_VERSION}` },
	]);
}

/** Nothing has ever written here, as opposed to something this build refuses. */
async function isUnwritten(handle: SqliteHandle): Promise<boolean> {
	const rows = await handle.all<{ n: number }>(
		`SELECT count(*) AS n FROM sqlite_master`,
	);
	return (rows[0]?.n ?? 0) === 0;
}

/** SQLite's own schema stamp. A file nothing has written answers zero. */
async function userVersion(handle: SqliteHandle): Promise<number> {
	const [row] = await handle.all<{ user_version: number }>(
		'PRAGMA user_version',
	);
	return row?.user_version ?? 0;
}
