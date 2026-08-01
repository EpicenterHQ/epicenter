/**
 * Local Mail Status Tests
 *
 * Verifies the status report describes how far the fact tier has been pulled
 * rather than only whether the SQLite file exists.
 *
 * Key behaviors:
 * - missing mailbox reports `empty`
 * - mailbox file with no history cursor reports `building`
 * - mailbox with a history cursor reports `ready`
 * - the reported path is one stable name, and reporting it creates nothing
 */

import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from './config.ts';
import { openMailDb } from './db.ts';
import { mailDbPath } from './paths.ts';
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

test('status reporting an absent mailbox does not create one', async () => {
	const tmp = tempDir();

	const status = await readMailStatus({
		config: config(tmp.dir),
		accountEmail: ACCOUNT,
		store,
	});

	// The path is reported so a human can find the file; reporting it must not
	// bring it into existence.
	expect(status.mirrorPath).toBe(mailDbPath(tmp.dir, ACCOUNT));
	expect(existsSync(status.mirrorPath)).toBe(false);
	expect(existsSync(join(tmp.dir, ACCOUNT))).toBe(false);
	tmp.cleanup();
});

test('the reported path is the same one the mailbox is built at', async () => {
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

	// One name before the file exists and after: there is no version to choose
	// and no earlier copy to report beside it.
	expect(status.mirrorPath).toBe(mailDbPath(tmp.dir, ACCOUNT));
	expect(existsSync(status.mirrorPath)).toBe(true);
	expect(status.mirror).toBe('ready');
	expect(status.rows.messages).toBe(1);
	tmp.cleanup();
});
