import { Err, Ok, type Result } from 'wellcrafted/result';
import { type AppConfig, loadConfig } from './config.ts';
import { openMailDb } from './db.ts';
import { createGmailClient } from './gmail-client.ts';
import type { SyncDeps } from './sync.ts';
import { createTokenManager } from './token-manager.ts';
import {
	createFileTokenStore,
	resolveAccount,
	type TokenStore,
} from './token-store.ts';

/**
 * The composition root for every account-scoped verb (sync, query, status,
 * and the MCP server). Config, the credential store, and THE account are
 * resolved exactly once per process; nothing downstream re-resolves any of
 * them. That is a deliberate lifetime rule, not just deduplication: a
 * long-lived MCP server must keep one stable account identity for its whole
 * session (connecting a second account mid-session must not flip which
 * mailbox existing tools talk to), and the write tools inherit that guarantee by
 * construction. It matters more under ADR-0198, where each account owns its own
 * `intent.db` and its own assertion sequence: a process that could flip accounts
 * mid-session could assert into the wrong ledger.
 *
 * `connect` and `seed-token` stay outside: they create accounts, so there is
 * no account to resolve yet.
 */
export type LocalMailRuntime = {
	config: AppConfig;
	store: TokenStore;
	accountEmail: string;
};

export async function openLocalMailRuntime(): Promise<
	Result<LocalMailRuntime, { message: string }>
> {
	const config = loadConfig();
	const store = createFileTokenStore(config.credentialsPath);
	const { data: accountEmail, error } = await resolveAccount(config, store);
	if (error) return Err(error);
	return Ok({ config, store, accountEmail });
}

/**
 * Build a runtime for an already-known connected account, bypassing
 * `resolveAccount`'s "which one" decision. The desktop `app` serves EVERY
 * connected account under one origin, so it enumerates them from the store
 * itself and holds one of these per account; there is no single account to
 * resolve. CLI and MCP keep using `openLocalMailRuntime`, which freezes exactly
 * one account for the whole process.
 */
export function runtimeForAccount(
	config: AppConfig,
	store: TokenStore,
	accountEmail: string,
): LocalMailRuntime {
	return { config, store, accountEmail };
}

export type SyncSession = {
	deps: SyncDeps;
	close(): void;
};

/**
 * Everything one sync pass needs, assembled from the runtime: the stored
 * token, a refreshing token manager, the Gmail client, and the writer db.
 * Both sync surfaces (CLI verb, MCP tool) build their pass through here, so
 * the assembly cannot drift between them.
 */
export async function openSyncSession(
	runtime: LocalMailRuntime,
	{
		gmailLog,
		syncLog,
	}: {
		gmailLog?: (message: string) => void;
		syncLog?: (message: string) => void;
	} = {},
): Promise<Result<SyncSession, { message: string }>> {
	const { config, store, accountEmail } = runtime;
	const now = () => Date.now();
	const token = await store.get(accountEmail);
	if (!token) {
		return Err({
			message: `No token stored for ${accountEmail}. Run "local-mail connect" first.`,
		});
	}
	const tokens = createTokenManager({ config, store, token, now });
	const client = createGmailClient({ tokens, config, log: gmailLog });
	const db = openMailDb({ dataDir: config.dataDir, accountEmail });
	return Ok({
		deps: { db, client, config, now, log: syncLog },
		close: () => db.close(),
	});
}
