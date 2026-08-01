import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * `LOCAL_MAIL_DIR` beats the OS-appropriate application-data directory for
 * the mailbox. Scoping the db by account email keeps multiple connected Gmail
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
 * One account's directory: `<dataDir>/<accountEmail>/`. The account email names
 * a directory, so it must be exactly one path segment: emails reach here from
 * Google's profile endpoint or a store-validated override, and this guard keeps
 * any other string from escaping the data dir.
 *
 * This is the whole of Local Mail's per-tenant naming: one account, one
 * directory, one mailbox file inside it (ADR-0198).
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
			`Account email ${JSON.stringify(accountEmail)} cannot name an account directory.`,
		);
	}
	return join(dataDir, accountEmail);
}

/**
 * One account's mailbox database: `<dataDir>/<accountEmail>/mail.db`. The name is
 * stable and always will be. Nothing versions it, nothing else in the directory
 * is a mailbox, and a shape change rebuilds this file rather than naming another
 * one, because it holds local state Gmail cannot supply again (ADR-0198).
 */
export function mailDbPath(dataDir: string, accountEmail: string): string {
	return join(accountDir(dataDir, accountEmail), 'mail.db');
}

/**
 * The default file token store: `credentials.json` at the data-dir root, sibling
 * to each account's `<accountEmail>/` directory. Deliberately not inside that
 * directory, so a read-only SQL surface over the mailbox can never read it. Same
 * reasoning as `apps/local-books` (ADR-0062).
 */
export function credentialsFilePath(dataDir: string): string {
	return join(dataDir, 'credentials.json');
}

/** The 0600 machine-level provider-credentials file, sibling to credentials.json. */
export function providerFilePath(dataDir: string): string {
	return join(dataDir, 'provider.json');
}
