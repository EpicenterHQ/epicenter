/**
 * Lazily open a write-capable QuickBooks client for a realm. The `report` and
 * `recategorize` verbs (the live-QuickBooks capabilities) hold this thunk rather
 * than credentials: it reloads the token from the store on each call, so it
 * always starts from the newest persisted (possibly rotated) credentials.
 *
 * It is its own seam so the live capabilities never reach into the token store
 * directly, and so app-owned CLI, HTTP, or MCP adapters can share one opener.
 */

import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { AppConfig } from '../config.ts';
import { createQbClient, type QbClient } from '../qb-client.ts';
import { createTokenManager } from '../token-manager.ts';
import type { TokenStore } from '../token-store.ts';

/**
 * The one way opening a client can fail: the realm has no stored credentials.
 * This membrane owns the failure so its verbs (`report`, `recategorize`) and the
 * sync loops propagate it as-is instead of each re-typing "openQb returned Err"
 * into its own variant with a less accurate prefix.
 */
export const QbAccessError = defineErrors({
	NotAuthenticated: ({ realmId }: { realmId: string }) => ({
		message: `No stored credentials for company ${realmId}. Run "local-books auth".`,
	}),
});
export type QbAccessError = InferErrors<typeof QbAccessError>;

/** Opens a QB client for the realm, or the reason it cannot. */
export type OpenQbClient = () => Promise<Result<QbClient, QbAccessError>>;

export function createQbAccess({
	config,
	realmId,
	store,
	now,
	log,
}: {
	config: AppConfig;
	realmId: string;
	store: TokenStore;
	now: () => number;
	/** Optional client-level log sink; the CLI routes it to stderr, MCP omits it. */
	log?: (message: string) => void;
}): OpenQbClient {
	return async () => {
		const token = await store.get(realmId);
		if (!token) {
			return QbAccessError.NotAuthenticated({ realmId });
		}
		const tokens = createTokenManager({ config, store, token, now });
		return Ok(createQbClient({ config, realmId, tokens, log }));
	};
}
