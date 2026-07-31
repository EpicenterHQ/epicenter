/**
 * `readBooksStatus`: the connection-and-mirror state of one company, read from
 * the token store and the mirror's `_meta` table. Where `queryBooks` answers
 * row-level questions, this answers "are you connected, and how fresh is the
 * local copy?": the cheap orientation read.
 *
 * It is a plain reader, not a `Result`: "not connected" and "mirror not built"
 * are reported states, not failures, so the shape is always returned. The
 * `status` CLI verb formats this for a human; the MCP `status` tool hands the
 * same object straight back as structured content (ADR-0072 leaves this seam
 * open exactly as it does for the other verb cores).
 */

import { existsSync } from 'node:fs';
import type { AppConfig, QbEnvironment } from '../config.ts';
import {
	type EntityStatus,
	MIRROR_FINGERPRINT_KEY,
	openBooksDb,
} from '../db.ts';
import { entityDef, MIRROR_FINGERPRINT } from '../entities.ts';
import { dbPath } from '../paths.ts';
import type { TokenStore } from '../token-store.ts';
import { isAccessTokenExpired, isRefreshTokenExpired } from '../tokens.ts';

export type TokenStatus = {
	/** False once the token is past its expiry (with the usual refresh skew for access). */
	valid: boolean;
	expiresAt: string;
};

export type BooksStatus = {
	realmId: string;
	environment: QbEnvironment;
	dataDir: string;
	tokenFile: string;
	/** Whether a token is stored for this realm at all. */
	connected: boolean;
	/** Null when not connected. */
	accessToken: TokenStatus | null;
	refreshToken: TokenStatus | null;
	/** Whether the local mirror file exists yet (a `sync --full` builds it). */
	mirrorBuilt: boolean;
	/**
	 * The remaining fields are null/empty until the mirror is built. This one is
	 * the declaration fingerprint the mirror was last built under.
	 */
	mirrorFingerprint: string | null;
	/**
	 * Whether that stamp differs from this build's declaration. A status read is
	 * read-only, so it reports a stale mirror rather than rebuilding it: the next
	 * writer open (`sync`) drops the tables and re-pulls.
	 */
	rebuildPending: boolean;
	cdcCursor: string | null;
	lastFullPullAt: string | null;
	lastSyncedAt: string | null;
	entities: EntityStatus[];
};

/** Read the connection + mirror state for one realm. Never throws on "absent". */
export async function readBooksStatus({
	config,
	realmId,
	store,
}: {
	config: AppConfig;
	realmId: string;
	store: TokenStore;
}): Promise<BooksStatus> {
	const token = await store.get(realmId);
	const now = Date.now();
	const base = {
		realmId,
		environment: config.environment,
		dataDir: config.dataDir,
		tokenFile: config.credentialsPath,
		connected: token !== null,
		accessToken: token
			? {
					valid: !isAccessTokenExpired(token, now, 0),
					expiresAt: token.accessTokenExpiresAt,
				}
			: null,
		refreshToken: token
			? {
					valid: !isRefreshTokenExpired(token, now),
					expiresAt: token.refreshTokenExpiresAt,
				}
			: null,
	};

	const path = dbPath(config.dataDir, realmId);
	if (!existsSync(path)) {
		return {
			...base,
			mirrorBuilt: false,
			mirrorFingerprint: null,
			rebuildPending: false,
			cdcCursor: null,
			lastFullPullAt: null,
			lastSyncedAt: null,
			entities: [],
		};
	}

	// Read-only: a status read must not stamp the mirror or block on a concurrent
	// sync's write lock (and a reader must never drop tables).
	const db = openBooksDb(path, { readonly: true });
	try {
		const realm = db.readRealmState();
		const stamped = db.getMeta(MIRROR_FINGERPRINT_KEY);
		return {
			...base,
			mirrorBuilt: true,
			mirrorFingerprint: stamped,
			rebuildPending: stamped !== MIRROR_FINGERPRINT,
			cdcCursor: realm.cdcCursor,
			lastFullPullAt: realm.lastFullPullAt,
			lastSyncedAt: realm.lastSyncedAt,
			entities: config.entities.map((name) => db.entityStatus(entityDef(name))),
		};
	} finally {
		db.close();
	}
}
