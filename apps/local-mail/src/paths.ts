import { chmodSync, mkdirSync } from 'node:fs';
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
 * The default file token store: `credentials.json` at the data-dir root, sibling
 * to each account's `<accountEmail>/` mirror dir. Deliberately not inside the
 * mirror dir, so a read-only SQL surface over `mail.db` can never read it. Same
 * reasoning as `apps/local-books` (ADR-0062).
 */
export function credentialsFilePath(dataDir: string): string {
	return join(dataDir, 'credentials.json');
}

/** The 0600 machine-level provider-credentials file, sibling to credentials.json. */
export function providerFilePath(dataDir: string): string {
	return join(dataDir, 'provider.json');
}

/**
 * One account's private directory: the disposable `mail.db` mirror, the durable
 * `intent.db`, and the `lock.db` that names the account's single writer all live
 * here. The account email names a path segment, so it must be exactly one:
 * emails reach here from Google's profile endpoint or a store-validated
 * override, and this guard keeps any other string from escaping the data dir.
 * Every file under this directory is derived from this one function, so the
 * guard has a single owner.
 */
export function accountDirPath(dataDir: string, accountEmail: string): string {
	if (
		accountEmail.length === 0 ||
		accountEmail === '.' ||
		accountEmail === '..' ||
		accountEmail.includes('/') ||
		accountEmail.includes('\\')
	) {
		throw new Error(
			`Account email ${JSON.stringify(accountEmail)} cannot name a directory.`,
		);
	}
	return join(dataDir, accountEmail);
}

/** The account directory, created `0700` if missing. Callers that are about to
 * open a file in it (mirror, intent store, lock) go through here. */
export function ensureAccountDir(
	dataDir: string,
	accountEmail: string,
): string {
	const accountDir = accountDirPath(dataDir, accountEmail);
	for (const dir of [dataDir, accountDir]) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
	}
	return accountDir;
}

/** Restrict a SQLite file and its WAL sidecars to the owner. Missing files are
 * skipped: a fresh database has no `-wal`/`-shm` until it is written. */
export function secureDbFiles(path: string): void {
	for (const file of [path, `${path}-wal`, `${path}-shm`]) {
		try {
			chmodSync(file, 0o600);
		} catch (error) {
			if ((error as { code?: unknown }).code !== 'ENOENT') throw error;
		}
	}
}
