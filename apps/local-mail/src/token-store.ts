import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { Value } from 'typebox/value';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { AppConfig } from './config.ts';
import { mailDbPath } from './paths.ts';
import { type TokenSet, TokenSetSchema } from './tokens.ts';

/**
 * Where an account's OAuth `TokenSet` lives, keyed by `accountEmail`: the
 * connect flow (Phase 2) writes it, `sync` reads it. The set never lives inside
 * an account's mailbox db, so the mailbox's read-only SQL surface can never read
 * it. `get` returns `null` when nothing is stored; `set` throws if the write
 * fails (disk, permissions), which bubbles to the caller rather than threading a
 * Result through every call site. Same shape as `apps/local-books`'
 * `token-store.ts`, see ADR-0062.
 */
export type TokenStore = {
	get(accountEmail: string): Promise<TokenSet | null>;
	listAccounts(): Promise<string[]>;
	set(token: TokenSet): Promise<void>;
};

export async function resolveAccount(
	config: AppConfig,
	store: TokenStore,
): Promise<Result<string, { message: string }>> {
	const accounts = await store.listAccounts();
	if (config.account) {
		// An override is valid when we hold credentials for it, or when the account
		// has a mailbox on disk: the read verbs (query, status) work without a
		// token, and a disconnected account's mailbox stays readable.
		if (accounts.includes(config.account)) return Ok(config.account);
		let hasMailbox = false;
		try {
			hasMailbox = existsSync(mailDbPath(config.dataDir, config.account));
		} catch {
			// Not even one path segment; the error below names the real accounts.
		}
		if (hasMailbox) return Ok(config.account);
		return Err({
			message:
				accounts.length === 0
					? `LOCAL_MAIL_ACCOUNT is set to ${config.account}, but no Gmail account is connected. Run "local-mail connect" first.`
					: `LOCAL_MAIL_ACCOUNT is set to ${config.account}, which is not a connected account (connected: ${accounts.join(', ')}).`,
		});
	}

	if (accounts.length === 1) return Ok(accounts[0] as string);
	if (accounts.length === 0) {
		return Err({
			message: 'No Gmail account connected. Run "local-mail connect" first.',
		});
	}
	return Err({
		message: `Multiple Gmail accounts connected (${accounts.join(', ')}). Set LOCAL_MAIL_ACCOUNT to choose one.`,
	});
}

/**
 * The `0600` JSON-file token store at `<data-dir>/credentials.json` (or wherever
 * `LOCAL_MAIL_TOKEN_FILE` points). The set is not encrypted; the file mode is
 * the protection, the same tradeoff `git credential-store` and `~/.aws/credentials`
 * make. Disk bytes are untrusted, so a read validates against `TokenSetSchema`
 * and treats a malformed entry as absent.
 */
export function createFileTokenStore(filePath: string): TokenStore {
	const parseToken = (raw: string | undefined): TokenSet | null => {
		if (!raw) return null;
		try {
			const parsed: unknown = JSON.parse(raw);
			return Value.Check(TokenSetSchema, parsed) ? parsed : null;
		} catch {
			return null;
		}
	};
	const load = (): Record<string, string> => {
		try {
			const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
			return typeof parsed === 'object' && parsed !== null ? parsed : {};
		} catch {
			return {};
		}
	};
	const save = (map: Record<string, string>) => {
		const dir = dirname(filePath);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
		writeFileSync(filePath, JSON.stringify(map, null, 2));
		chmodSync(filePath, 0o600);
	};
	return {
		async get(accountEmail) {
			return parseToken(load()[accountEmail]);
		},
		async listAccounts() {
			return Object.entries(load())
				.filter(([, raw]) => parseToken(raw) !== null)
				.map(([accountEmail]) => accountEmail)
				.sort();
		},
		async set(token) {
			const map = load();
			map[token.accountEmail] = JSON.stringify(token);
			save(map);
		},
	};
}
