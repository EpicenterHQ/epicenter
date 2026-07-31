import { existsSync } from 'node:fs';
import { mailDbPath, openMailDbReadonly } from './db.ts';
import { MIRROR_FINGERPRINT } from './mirror-schema.ts';
import type { LocalMailRuntime } from './runtime.ts';
import { isAccessTokenExpired } from './tokens.ts';

export type MailStatus = {
	accountEmail: string;
	dataDir: string;
	tokenFile: string;
	connected: boolean;
	accessToken: { valid: boolean; expiresAt: string } | null;
	mirror: 'empty' | 'building' | 'ready';
	/** The shape fingerprint stamped on the file, or null before one is built. */
	mirrorFingerprint: string | null;
	/**
	 * The file's shape no longer matches this build's declaration, so the next
	 * sync drops it and re-pulls. Reporting it is all a reader may do.
	 */
	mirrorStale: boolean;
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

	const path = mailDbPath(config.dataDir, accountEmail);
	if (!existsSync(path)) {
		return {
			...base,
			mirror: 'empty',
			mirrorFingerprint: null,
			mirrorStale: false,
			historyId: null,
			lastFullPullAt: null,
			lastSyncedAt: null,
			rows: { messages: 0, labels: 0 },
		};
	}

	const db = openMailDbReadonly({ dataDir: config.dataDir, accountEmail });
	try {
		const realm = db.realmState();
		const mirrorFingerprint = db.mirrorFingerprint();
		return {
			...base,
			mirror: realm.historyId === null ? 'building' : 'ready',
			mirrorFingerprint,
			mirrorStale: mirrorFingerprint !== MIRROR_FINGERPRINT,
			historyId: realm.historyId,
			lastFullPullAt: realm.lastFullPullAt,
			lastSyncedAt: realm.lastSyncedAt,
			rows: db.counts(),
		};
	} finally {
		db.close();
	}
}
