import { join } from 'node:path';
import {
	appDataDir,
	epicenterDataRoot,
	partitionDir,
} from '@epicenter/constants/app-data';

/**
 * Local Books' one directory: `<epicenter-root>/apps/so.epicenter.local-books`.
 *
 * The app computes no OS application-data path of its own. Epicenter owns
 * exactly one root and `EPICENTER_DATA_DIR` is the only override, so a CLI run
 * from a terminal and the desktop host operate on the same books (ADR-0201).
 * Everything below the result belongs to this app, and nothing outside it
 * receives a path into it.
 *
 * The CLI defaults to production storage. Set EPICENTER_DATA_DIR explicitly
 * to use a development directory. Local Books owns its app identifier.
 */
export function booksDataDir(): string {
	return appDataDir(epicenterDataRoot(), 'so.epicenter.local-books');
}

/**
 * One directory per company, named by QuickBooks' `realmId` under
 * `companies/`. It holds the company's mirror artifacts (named by corpus
 * version, see `booksDbFile` in `db.ts`) and the `app` verb's `lock.db`. This is
 * the directory the mirror is opened at, so `realmId` is the only per-tenant
 * naming the mirror sees.
 *
 * `realmId` reaches here straight from the Intuit callback or `--realm`, so the
 * shared `partitionDir` guard validating it as exactly one path component is the
 * point of routing through it rather than joining (ADR-0201).
 */
export function companyDir(dataDir: string, realmId: string): string {
	return partitionDir(dataDir, 'companies', realmId);
}

/**
 * The default file token store: `credentials.json` at the app-directory root,
 * sibling to `companies/`. Deliberately not inside a company's partition, so the
 * agent's read-only SQL surface over the mirror can never read it (and one
 * company's mirror can be shared without its refresh token). See ADR-0062.
 */
export function credentialsFilePath(dataDir: string): string {
	return join(dataDir, 'credentials.json');
}
