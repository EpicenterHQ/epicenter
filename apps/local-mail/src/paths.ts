import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * `LOCAL_MAIL_DIR` beats the OS-appropriate application-data directory for
 * the mirror. Scoping the db by account email keeps multiple connected Gmail
 * accounts from colliding.
 *
 * macOS: `~/Library/Application Support/local-mail`
 * Linux/other: `$XDG_DATA_HOME/local-mail` or `~/.local/share/local-mail`
 */
export function resolveDataDir(): string {
	const env = process.env.LOCAL_MAIL_DIR;
	if (env && env.length > 0) return env;
	if (process.platform === 'darwin') {
		return join(homedir(), 'Library', 'Application Support', 'local-mail');
	}
	const xdg = process.env.XDG_DATA_HOME;
	if (xdg && xdg.length > 0) return join(xdg, 'local-mail');
	return join(homedir(), '.local', 'share', 'local-mail');
}

/**
 * One account's directory: `<data-dir>/<accountEmail>/`. Everything an account
 * owns lives here (the mirror artifact and its sidecars, plus `lock.db`), and
 * this is the directory the mirror is materialized at, so the account email must
 * be exactly one path segment. Emails reach here from Google's profile endpoint
 * or a store-validated override; this guard keeps any other string from escaping
 * the data dir.
 *
 * The check lives here rather than in the mirror, which knows nothing about
 * tenants: ADR-0194 puts per-tenant naming and its path-traversal validation on
 * the caller that picks the directory.
 */
export function accountDir(dataDir: string, accountEmail: string): string {
	if (
		accountEmail.length === 0 ||
		accountEmail === '.' ||
		accountEmail === '..' ||
		accountEmail.includes('/') ||
		accountEmail.includes('\\')
	) {
		throw new Error(
			`Account email ${JSON.stringify(accountEmail)} cannot name a mirror directory.`,
		);
	}
	return join(dataDir, accountEmail);
}

/**
 * The default file token store: `credentials.json` at the data-dir root, sibling
 * to each account's `<accountEmail>/` mirror dir. Deliberately not inside the
 * mirror dir, so a read-only SQL surface over the mirror can never read it. Same
 * reasoning as `apps/local-books` (ADR-0062).
 */
export function credentialsFilePath(dataDir: string): string {
	return join(dataDir, 'credentials.json');
}

/** The 0600 machine-level provider-credentials file, sibling to credentials.json. */
export function providerFilePath(dataDir: string): string {
	return join(dataDir, 'provider.json');
}
