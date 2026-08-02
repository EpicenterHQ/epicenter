import { existsSync } from 'node:fs';
import { mailDbPath, openMailDbReadonly } from './db.ts';
import { type PendingSummary, readPendingSummary } from './intent.ts';
import type { LocalMailRuntime } from './runtime.ts';
import { isAccessTokenExpired } from './tokens.ts';

export type MailStatus = {
	accountEmail: string;
	dataDir: string;
	tokenFile: string;
	connected: boolean;
	accessToken: { valid: boolean; expiresAt: string } | null;
	mirror: 'empty' | 'building' | 'ready';
	schemaVersion: string | null;
	historyId: string | null;
	lastFullPullAt: string | null;
	lastSyncedAt: string | null;
	rows: { messages: number; labels: number };
	/**
	 * Local triage Gmail has not been told about yet: how much, and how long the
	 * oldest has waited. Aggregates only. A surface that wants to say "3 changes
	 * pending, oldest 2 minutes" has everything it needs, and nothing per-row is
	 * durable enough to become a ledger.
	 */
	pending: PendingSummary;
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

	// Two files, two owners, two independent questions: the mirror answers for
	// Gmail's facts, and the intent store answers for what this machine still
	// owes Gmail. Read the second one FIRST and unconditionally, because the
	// mirror's absence tells us nothing about it: the mirror is deleted and
	// rebuilt on a shape change, and undelivered triage deliberately outlives
	// that. Reporting zero pending just because there is no mirror would hide the
	// user's own work at exactly the moment it is most easily lost.
	const pending = readPendingSummary({ dataDir: config.dataDir, accountEmail });

	const path = mailDbPath(config.dataDir, accountEmail);
	if (!existsSync(path)) {
		return {
			...base,
			mirror: 'empty',
			schemaVersion: null,
			historyId: null,
			lastFullPullAt: null,
			lastSyncedAt: null,
			rows: { messages: 0, labels: 0 },
			pending,
		};
	}

	const db = openMailDbReadonly({ dataDir: config.dataDir, accountEmail });
	try {
		const realm = db.realmState();
		return {
			...base,
			mirror: realm.historyId === null ? 'building' : 'ready',
			schemaVersion: db.schemaVersion(),
			historyId: realm.historyId,
			lastFullPullAt: realm.lastFullPullAt,
			lastSyncedAt: realm.lastSyncedAt,
			rows: db.counts(),
			pending,
		};
	} finally {
		db.close();
	}
}
