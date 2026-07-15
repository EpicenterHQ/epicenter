import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Value } from 'typebox/value';
import { type TokenSet, TokenSetSchema } from './tokens.ts';

/**
 * Where a realm's OAuth `TokenSet` lives, keyed by `realmId`: `auth` writes it,
 * `sync`, `status`, `watch`, and the app read it. The set never lives inside a company's
 * mirror db, so the agent's read-only SQL surface can never read it. `get`
 * returns `null` when nothing is stored; `set` throws if the write fails (disk,
 * permissions), which bubbles to the top-level CLI handler (`bin.ts`) rather than
 * threading a Result through every caller. See ADR-0062.
 */
export type TokenStore = {
	get(realmId: string): Promise<TokenSet | null>;
	set(token: TokenSet): Promise<void>;
};

/**
 * The `0600` JSON-file token store at `<data-dir>/credentials.json` (or wherever
 * `LOCAL_BOOKS_TOKEN_FILE` points). The set is not encrypted; the file mode is
 * the protection, the same tradeoff `git credential-store` and `~/.aws/credentials`
 * make. Works identically on a desktop, a headless server, an SSH session, and
 * CI, which is the property a tool whose recurring mode is unattended sync needs
 * most. Disk bytes are untrusted, so a read validates against `TokenSetSchema`
 * and treats a malformed entry as absent. See ADR-0062.
 */
export function createFileTokenStore(filePath: string): TokenStore {
	const load = (): Record<string, string> => {
		try {
			const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
			return typeof parsed === 'object' && parsed !== null ? parsed : {};
		} catch {
			return {};
		}
	};
	const save = (map: Record<string, string>) => {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, JSON.stringify(map, null, 2));
		chmodSync(filePath, 0o600);
	};
	return {
		async get(realmId) {
			const raw = load()[realmId];
			if (!raw) return null;
			try {
				const parsed: unknown = JSON.parse(raw);
				return Value.Check(TokenSetSchema, parsed) ? parsed : null;
			} catch {
				return null;
			}
		},
		async set(token) {
			const map = load();
			map[token.realmId] = JSON.stringify(token);
			save(map);
		},
	};
}
