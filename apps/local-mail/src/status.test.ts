/**
 * Local Mail Status Tests
 *
 * Verifies the status report describes the local mirror lifecycle rather than
 * only whether the SQLite file exists.
 *
 * Key behaviors:
 * - missing mirror reports `empty`, without conjuring a file to report on
 * - a predecessor an earlier declaration left behind is listed as retained
 *   inventory, and never counted as the mirror
 * - mirror file with no history cursor reports `building`
 * - mirror with a history cursor reports `ready`
 */

import { expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from './config.ts';
import { mailMirror, openMailDb } from './db.ts';
import type { GmailMessage } from './schema.ts';
import { readMailStatus } from './status.ts';
import type { TokenStore } from './token-store.ts';

const ACCOUNT = 'you@example.com';

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), 'local-mail-status-test-'));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function config(dataDir: string): AppConfig {
	return {
		dataDir,
		apiBase: 'http://localhost:0',
		authorizeUrl: 'http://localhost:0/auth',
		tokenUrl: 'http://localhost:0/token',
		historySafeWindowDays: 5,
		fullBackstopDays: 30,
		pageSize: 100,
		credentialsPath: join(dataDir, 'credentials.json'),
		account: null,
		readOnly: false,
	};
}

const store: TokenStore = {
	async get() {
		return null;
	},
	async listAccounts() {
		return [];
	},
	async set() {},
};

function message(id: string): GmailMessage {
	return {
		id,
		threadId: `t-${id}`,
		labelIds: ['INBOX'],
		snippet: `snippet ${id}`,
		payload: { headers: [{ name: 'Subject', value: `Subject ${id}` }] },
	};
}

test('status reports empty when the mirror file does not exist', async () => {
	const tmp = tempDir();

	const status = await readMailStatus({
		config: config(tmp.dir),
		accountEmail: ACCOUNT,
		store,
	});

	expect(status.mirror).toBe('empty');
	expect(status.historyId).toBeNull();
	expect(status.rows).toEqual({ messages: 0, labels: 0 });
	expect(status.mirrorPath).toBe(mailMirror(tmp.dir, ACCOUNT).path);
	expect(status.retained).toEqual([]);
	// Reporting an absent mirror must not create one.
	expect(existsSync(status.mirrorPath)).toBe(false);
	tmp.cleanup();
});

test('a retained predecessor is inventory, never the mirror status reports', async () => {
	const tmp = tempDir();
	const accountDir = join(tmp.dir, ACCOUNT);
	const fingerprint = 'd'.repeat(64);
	mkdirSync(accountDir, { recursive: true });
	writeFileSync(join(accountDir, `mail.${fingerprint}.db`), '');
	// Neither of these is an artifact, so neither may appear as one.
	writeFileSync(join(accountDir, 'lock.db'), '');
	writeFileSync(join(accountDir, 'credentials.json'), '{}');

	const status = await readMailStatus({
		config: config(tmp.dir),
		accountEmail: ACCOUNT,
		store,
	});

	expect(status.mirror).toBe('empty');
	expect(status.rows).toEqual({ messages: 0, labels: 0 });
	expect(status.retained).toEqual([
		{ fingerprint, path: join(accountDir, `mail.${fingerprint}.db`) },
	]);
	tmp.cleanup();
});

test('status reports building when the mirror file exists without a cursor', async () => {
	const tmp = tempDir();
	const db = openMailDb({ dataDir: tmp.dir, accountEmail: ACCOUNT });
	db.ingestFullPullPage([message('m1')], '2026-07-01T00:00:00.000Z');
	db.close();

	const status = await readMailStatus({
		config: config(tmp.dir),
		accountEmail: ACCOUNT,
		store,
	});

	expect(status.mirror).toBe('building');
	expect(status.historyId).toBeNull();
	expect(status.rows.messages).toBe(1);
	tmp.cleanup();
});

test('status reports ready when the mirror has a cursor', async () => {
	const tmp = tempDir();
	const db = openMailDb({ dataDir: tmp.dir, accountEmail: ACCOUNT });
	db.ingestFullPullPage([message('m1')], '2026-07-01T00:00:00.000Z');
	db.finishFullPull('1000', '2026-07-01T00:00:00.000Z');
	db.close();

	const status = await readMailStatus({
		config: config(tmp.dir),
		accountEmail: ACCOUNT,
		store,
	});

	expect(status.mirror).toBe('ready');
	expect(status.historyId).toBe('1000');
	expect(status.rows.messages).toBe(1);
	tmp.cleanup();
});
