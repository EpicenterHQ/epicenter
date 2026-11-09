import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Value } from 'typebox/value';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { AppConfig } from './config.ts';
import { type TokenSet, TokenSetSchema } from './tokens.ts';

/**
 * Where a realm's OAuth `TokenSet` lives, keyed by `realmId`: `auth` writes it,
 * `sync` / `status` / the daemon read it. The set never lives inside a company's
 * mirror db, so the agent's read-only SQL surface can never read it. `get`
 * returns `null` when nothing is stored; `set` throws if the write fails (disk,
 * permissions), which bubbles to the top-level CLI handler (`bin.ts`) rather than
 * threading a Result through every caller. See ADR-0062.
 */
export type TokenStore = {
	get(realmId: string): Promise<TokenSet | null>;
	listRealms(): Promise<string[]>;
	set(token: TokenSet): Promise<void>;
};

/**
 * Pick the company to act on: explicit `--realm`/`LOCAL_BOOKS_QB_REALM`, else
 * the sole connected one. Ambiguity is an error, not a silent guess.
 *
 * The store is the authority on which companies are connected, because it is
 * keyed by `realmId` and holds the tokens that make a company usable. There is
 * no sidecar index: one would be a second copy of the same list that could
 * disagree with the first, and the partition directories are a weaker answer
 * still, since a company authenticated and never synced has no directory and is
 * connected all the same (ADR-0201).
 *
 * An override is taken at its word rather than checked against the store: the
 * read verbs work without a token, so `query --realm` over a mirror belonging to
 * a disconnected company (or the `demo` company, which never authenticates) has
 * to stay possible. `companyDir` validates the segment before it names anything.
 */
export async function resolveRealm(
	config: Pick<AppConfig, 'realmOverride'>,
	store: TokenStore,
): Promise<Result<string, string>> {
	if (config.realmOverride) return Ok(config.realmOverride);

	const realms = await store.listRealms();
	if (realms.length === 1) return Ok(realms[0] as string);
	if (realms.length === 0) {
		return Err('No authenticated company. Run "local-books auth" first.');
	}
	// Both inputs are named because the MCP server returns this string verbatim to
	// a foreign caller that has no command line: its host sets the environment
	// variable instead (ADR-0073).
	return Err(
		`Multiple companies authenticated (${realms.join(', ')}). Pass --realm <realmId> or set LOCAL_BOOKS_QB_REALM.`,
	);
}

/**
 * The `0600` JSON-file token store at `<app-dir>/credentials.json` (or wherever
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
	const parse = (raw: string | undefined): TokenSet | null => {
		if (!raw) return null;
		try {
			const parsed: unknown = JSON.parse(raw);
			return Value.Check(TokenSetSchema, parsed) ? parsed : null;
		} catch {
			return null;
		}
	};
	return {
		async get(realmId) {
			return parse(load()[realmId]);
		},
		async listRealms() {
			return Object.entries(load())
				.filter(([, raw]) => parse(raw) !== null)
				.map(([realmId]) => realmId)
				.sort();
		},
		async set(token) {
			const map = load();
			map[token.realmId] = JSON.stringify(token);
			save(map);
		},
	};
}
