import { mailMirror, openMailDbReadonly } from './db.ts';
import type { LocalMailRuntime } from './runtime.ts';
import { isAccessTokenExpired } from './tokens.ts';

/**
 * An artifact of an earlier declaration, still on disk. It is retained, not
 * consulted: no read path opens it, and it is listed here so that "there are two
 * corpora and one of them is dead weight" is visible rather than inferred from a
 * directory listing. Reclaiming it is an app decision made once the successor is
 * complete (ADR-0194), so nothing here deletes.
 */
export type RetainedArtifact = { fingerprint: string; path: string };

export type MailStatus = {
	accountEmail: string;
	dataDir: string;
	tokenFile: string;
	connected: boolean;
	accessToken: { valid: boolean; expiresAt: string } | null;
	mirror: 'empty' | 'building' | 'ready';
	/**
	 * The current artifact's path, whether or not it exists yet. Worth reporting
	 * now that the filename carries a fingerprint and is no longer guessable from
	 * the data dir and the account.
	 */
	mirrorPath: string;
	retained: RetainedArtifact[];
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
	const site = mailMirror(config.dataDir, accountEmail);
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
		mirrorPath: site.path,
		retained: site
			.artifacts()
			.filter((artifact) => !artifact.current)
			.map(({ fingerprint, path }) => ({ fingerprint, path })),
	};

	// An absent current artifact is `empty` even when a predecessor is retained:
	// a predecessor describes a shape this build cannot read, so reporting its
	// rows as the mirror's would be a lie about what the verbs can see.
	const db = openMailDbReadonly({ dataDir: config.dataDir, accountEmail });
	if (db === null) {
		return {
			...base,
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
