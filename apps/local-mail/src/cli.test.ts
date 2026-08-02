/**
 * Local Mail CLI Parser Tests
 *
 * Covers parse-time argument validation that protects command handlers from
 * ambiguous or unsafe flag values, plus the two refusals a triage verb makes
 * before it records anything.
 *
 * Key behaviors:
 * - `--watch` accepts only positive millisecond values
 * - invalid watch intervals fail before the reconcile loop can start polling
 */

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, runCli } from './cli.ts';
import { loadConfig } from './config.ts';
import { acquireReconcileLock } from './lock.ts';
import { createFileTokenStore } from './token-store.ts';
import type { TokenSet } from './tokens.ts';

test('--watch rejects unit-suffixed intervals', () => {
	expect(() => parseArgs(['reconcile', '--watch=30s'])).toThrow(
		'Invalid --watch interval "30s"',
	);
});

test('--watch rejects zero milliseconds', () => {
	expect(() => parseArgs(['reconcile', '--watch=0'])).toThrow(
		'Invalid --watch interval "0"',
	);
});

test('--watch accepts a space-separated interval', () => {
	const args = parseArgs(['reconcile', '--watch', '5000']);
	expect(args.watch).toBe(true);
	expect(args.watchIntervalMs).toBe(5000);
	expect(args.positionals).toEqual([]);
});

test('--watch space form validates the value instead of swallowing it', () => {
	expect(() => parseArgs(['reconcile', '--watch', '30s'])).toThrow(
		'Invalid --watch interval "30s"',
	);
});

test('--watch followed by another flag stays flag-only', () => {
	const args = parseArgs(['reconcile', '--watch', '--full']);
	expect(args.watch).toBe(true);
	expect(args.full).toBe(true);
	expect(args.watchIntervalMs).toBeUndefined();
});

test('app parses the port flag', () => {
	const args = parseArgs(['app', '--port', '4177']);
	expect(args.command).toBe('app');
	expect(args.port).toBe(4177);
	expect(() => parseArgs(['app', '--port', 'abc'])).toThrow(
		'--port must be a non-negative integer, got "NaN"',
	);
});

test('triage verbs collect ids as positionals', () => {
	const args = parseArgs(['mark-read', 'm1', 'm2']);
	expect(args.command).toBe('mark-read');
	expect(args.positionals).toEqual(['m1', 'm2']);
	expect(args.addLabels).toEqual([]);
	expect(args.removeLabels).toEqual([]);
});

test('label parses repeatable label changes and --json', () => {
	const args = parseArgs([
		'label',
		'm1',
		'm2',
		'--add',
		'Work',
		'--add=Label_2',
		'--remove',
		'Travel',
		'--json',
	]);
	expect(args.command).toBe('label');
	expect(args.positionals).toEqual(['m1', 'm2']);
	expect(args.addLabels).toEqual(['Work', 'Label_2']);
	expect(args.removeLabels).toEqual(['Travel']);
	expect(args.json).toBe(true);
});

test('LOCAL_MAIL_READ_ONLY enables read-only config mode', () => {
	const previous = process.env.LOCAL_MAIL_READ_ONLY;
	process.env.LOCAL_MAIL_READ_ONLY = '1';
	try {
		expect(loadConfig().readOnly).toBe(true);
	} finally {
		if (previous === undefined) delete process.env.LOCAL_MAIL_READ_ONLY;
		else process.env.LOCAL_MAIL_READ_ONLY = previous;
	}
});

test('label honors LOCAL_MAIL_READ_ONLY before resolving labels', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'local-mail-cli-readonly-test-'));
	const token: TokenSet = {
		accountEmail: 'you@example.com',
		clientIdUsed: 'client-id',
		accessToken: 'access-token',
		refreshToken: 'refresh-token',
		accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
		obtainedAt: new Date(0).toISOString(),
	};
	await createFileTokenStore(join(dir, 'credentials.json')).set(token);
	const previousDir = process.env.LOCAL_MAIL_DIR;
	const previousAccount = process.env.LOCAL_MAIL_ACCOUNT;
	const previousTokenFile = process.env.LOCAL_MAIL_TOKEN_FILE;
	const previousReadOnly = process.env.LOCAL_MAIL_READ_ONLY;
	const errors: string[] = [];
	const originalError = console.error;
	process.env.LOCAL_MAIL_DIR = dir;
	process.env.LOCAL_MAIL_ACCOUNT = '';
	process.env.LOCAL_MAIL_TOKEN_FILE = '';
	process.env.LOCAL_MAIL_READ_ONLY = '1';
	console.error = (message?: unknown) => {
		errors.push(String(message));
	};
	try {
		expect(await runCli(['label', 'm1', '--add', 'Missing Label'])).toBe(1);
		expect(errors.join('\n')).toContain('Refusing to write: read-only mode');
		expect(errors.join('\n')).not.toContain('Unknown Gmail label');
	} finally {
		console.error = originalError;
		if (previousDir === undefined) delete process.env.LOCAL_MAIL_DIR;
		else process.env.LOCAL_MAIL_DIR = previousDir;
		if (previousAccount === undefined) delete process.env.LOCAL_MAIL_ACCOUNT;
		else process.env.LOCAL_MAIL_ACCOUNT = previousAccount;
		if (previousTokenFile === undefined)
			delete process.env.LOCAL_MAIL_TOKEN_FILE;
		else process.env.LOCAL_MAIL_TOKEN_FILE = previousTokenFile;
		if (previousReadOnly === undefined) delete process.env.LOCAL_MAIL_READ_ONLY;
		else process.env.LOCAL_MAIL_READ_ONLY = previousReadOnly;
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * Drive `runCli` against a stored account whose reconcile lock is already held
 * by another owner (the open app or a watch loop), capturing both streams.
 * Proves a one-shot pass yields without opening a session or hitting the
 * network.
 */
async function runWithLockHeld(
	argv: string[],
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
	const dir = mkdtempSync(join(tmpdir(), 'local-mail-cli-lock-test-'));
	const token: TokenSet = {
		accountEmail: 'you@example.com',
		clientIdUsed: 'client-id',
		accessToken: 'access-token',
		refreshToken: 'refresh-token',
		accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
		obtainedAt: new Date(0).toISOString(),
	};
	await createFileTokenStore(join(dir, 'credentials.json')).set(token);
	const previousDir = process.env.LOCAL_MAIL_DIR;
	const previousAccount = process.env.LOCAL_MAIL_ACCOUNT;
	const previousTokenFile = process.env.LOCAL_MAIL_TOKEN_FILE;
	const stdout: string[] = [];
	const stderr: string[] = [];
	const originalLog = console.log;
	const originalError = console.error;
	process.env.LOCAL_MAIL_DIR = dir;
	process.env.LOCAL_MAIL_ACCOUNT = '';
	process.env.LOCAL_MAIL_TOKEN_FILE = '';
	console.log = (message?: unknown) => {
		stdout.push(String(message));
	};
	console.error = (message?: unknown) => {
		stderr.push(String(message));
	};
	const held = acquireReconcileLock({
		dataDir: dir,
		accountEmail: 'you@example.com',
	});
	expect(held).not.toBeNull();
	try {
		const code = await runCli(argv);
		return { code, stdout, stderr };
	} finally {
		console.log = originalLog;
		console.error = originalError;
		held?.release();
		if (previousDir === undefined) delete process.env.LOCAL_MAIL_DIR;
		else process.env.LOCAL_MAIL_DIR = previousDir;
		if (previousAccount === undefined) delete process.env.LOCAL_MAIL_ACCOUNT;
		else process.env.LOCAL_MAIL_ACCOUNT = previousAccount;
		if (previousTokenFile === undefined)
			delete process.env.LOCAL_MAIL_TOKEN_FILE;
		else process.env.LOCAL_MAIL_TOKEN_FILE = previousTokenFile;
		rmSync(dir, { recursive: true, force: true });
	}
}

test('reconcile yields a human note on stdout when another owner holds the lock', async () => {
	const { code, stdout } = await runWithLockHeld(['reconcile']);
	expect(code).toBe(0);
	// The terminal outcome lands on stdout like the success/failure summaries do.
	expect(stdout.join('\n')).toContain('already reconciling you@example.com');
});

test('reconcile --json yields a structured payload on stdout when the lock is held', async () => {
	const { code, stdout } = await runWithLockHeld(['reconcile', '--json']);
	expect(code).toBe(0);
	// The whole yield must be a single clean JSON value on stdout, not a human
	// note on stderr: a --json consumer piping stdout has to see it.
	const payload = JSON.parse(stdout.join('\n'));
	expect(payload.reconciled).toBe(false);
	expect(payload.reason).toBe('reconcile-owner-active');
	expect(payload.message).toContain('you@example.com');
});

test('status --json resolves the sole stored account and prints JSON', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'local-mail-cli-test-'));
	const token: TokenSet = {
		accountEmail: 'you@example.com',
		clientIdUsed: 'client-id',
		accessToken: 'access-token',
		refreshToken: 'refresh-token',
		accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
		obtainedAt: new Date(0).toISOString(),
	};
	await createFileTokenStore(join(dir, 'credentials.json')).set(token);
	const previousDir = process.env.LOCAL_MAIL_DIR;
	const previousAccount = process.env.LOCAL_MAIL_ACCOUNT;
	const previousTokenFile = process.env.LOCAL_MAIL_TOKEN_FILE;
	const logs: string[] = [];
	const originalLog = console.log;
	process.env.LOCAL_MAIL_DIR = dir;
	process.env.LOCAL_MAIL_ACCOUNT = '';
	process.env.LOCAL_MAIL_TOKEN_FILE = '';
	console.log = (message?: unknown) => {
		logs.push(String(message));
	};
	try {
		expect(await runCli(['status', '--json'])).toBe(0);
		expect(JSON.parse(logs[0] ?? '{}').accountEmail).toBe('you@example.com');
	} finally {
		console.log = originalLog;
		if (previousDir === undefined) delete process.env.LOCAL_MAIL_DIR;
		else process.env.LOCAL_MAIL_DIR = previousDir;
		if (previousAccount === undefined) delete process.env.LOCAL_MAIL_ACCOUNT;
		else process.env.LOCAL_MAIL_ACCOUNT = previousAccount;
		if (previousTokenFile === undefined)
			delete process.env.LOCAL_MAIL_TOKEN_FILE;
		else process.env.LOCAL_MAIL_TOKEN_FILE = previousTokenFile;
		rmSync(dir, { recursive: true, force: true });
	}
});
