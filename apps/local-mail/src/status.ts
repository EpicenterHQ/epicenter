import { openMailDbReadonly } from './db.ts';
import { mailDbPath } from './paths.ts';
import type { LocalMailRuntime } from './runtime.ts';
import { isAccessTokenExpired } from './tokens.ts';

export type MailStatus = {
	accountEmail: string;
	dataDir: string;
	tokenFile: string;
	connected: boolean;
	accessToken: { valid: boolean; expiresAt: string } | null;
	/**
	 * How much of the fact tier this build can trust. `empty` is no file at all;
	 * `building` is a file whose history cursor has never been set, so no full
	 * pull has finished and the messages in it are a partial mailbox; `ready` is a
	 * cursor written by `finishFullPull`, after every page committed. A corpus
	 * bump clears the cursor, so it lands back in `building` until the re-pull
	 * finishes: a rebuilt fact tier is never authoritative merely for being newer.
	 */
	mirror: 'empty' | 'building' | 'ready';
	/**
	 * The mailbox file's path, whether or not it exists yet. It is stable for the
	 * life of the account: this is how a human or an agent finds the file to point
	 * `sqlite3` at.
	 */
	mirrorPath: string;
	historyId: string | null;
	lastFullPullAt: string | null;
	lastSyncedAt: string | null;
	rows: { messages: number; labels: number };
};

export async function readMailStatus({
	config,
	accountEmail,
	store,
}: LocalMailRuntime): Promise<MailStatus> {
	const token = await store.get(accountEmail);
	const base = {
		accountEmail,
		dataDir: config.dataDir,
		tokenFile: config.credentialsPath,
		connected: token !== null,
		accessToken: token
			? {
					valid: !isAccessTokenExpired(token, Date.now(), 0),
					expiresAt: token.accessTokenExpiresAt,
				}
			: null,
	};

	// One account, one mailbox file, one name. There is nothing to inventory and
	// no version to choose, so the path is pure string work that reports the same
	// answer before the file exists as after (ADR-0198).
	const shape = { mirrorPath: mailDbPath(config.dataDir, accountEmail) };

	// Read-only: a status read must not block on a concurrent sync's write lock,
	// and must never create the file it is reporting on.
	const db = openMailDbReadonly({ dataDir: config.dataDir, accountEmail });
	if (db === null) {
		return {
			...base,
			...shape,
			mirror: 'empty',
			historyId: null,
			lastFullPullAt: null,
			lastSyncedAt: null,
			rows: { messages: 0, labels: 0 },
		};
	}
	try {
		const realm = db.realmState();
		return {
			...base,
			...shape,
			mirror: realm.historyId === null ? 'building' : 'ready',
			historyId: realm.historyId,
			lastFullPullAt: realm.lastFullPullAt,
			lastSyncedAt: realm.lastSyncedAt,
			rows: db.counts(),
		};
	} finally {
		db.close();
	}
}
