/**
 * The read-only SQL surface. What matters beyond "does a SELECT work" is that a
 * read never writes: `queryMail` opens the current artifact read-only and, when
 * that artifact does not exist, reports it rather than conjuring an empty file
 * on disk (ADR-0197).
 */

import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mailDbFile, openMailDb } from './db.ts';
import { accountDir } from './paths.ts';
import { queryMail } from './query.ts';
import type { GmailMessage } from './schema.ts';

const ACCOUNT = 'you@example.com';

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), 'local-mail-query-test-'));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function message(id: string): GmailMessage {
	return {
		id,
		threadId: `t-${id}`,
		labelIds: ['INBOX'],
		snippet: `snippet ${id}`,
		internalDate: '1719000000000',
		payload: { headers: [{ name: 'Subject', value: `Subject ${id}` }] },
	};
}

test('querying an absent mirror reports it and creates nothing', () => {
	const tmp = tempDir();

	const { data, error } = queryMail({
		dataDir: tmp.dir,
		accountEmail: ACCOUNT,
		sql: 'SELECT 1',
	});

	expect(data).toBeNull();
	expect(error?.name).toBe('NoMirror');
	expect(error?.message).toContain(mailDbFile(tmp.dir, ACCOUNT).path);
	expect(existsSync(mailDbFile(tmp.dir, ACCOUNT).path)).toBe(false);
	expect(existsSync(accountDir(tmp.dir, ACCOUNT))).toBe(false);
	tmp.cleanup();
});

test('reads rows from the current artifact', () => {
	const tmp = tempDir();
	const db = openMailDb({ dataDir: tmp.dir, accountEmail: ACCOUNT });
	db.ingestFullPullPage([message('m1')], 's1');
	db.close();

	const { data, error } = queryMail({
		dataDir: tmp.dir,
		accountEmail: ACCOUNT,
		sql: 'SELECT id, subject FROM messages ORDER BY id',
	});

	expect(error).toBeNull();
	expect(data?.rows).toEqual([{ id: 'm1', subject: 'Subject m1' }]);
	tmp.cleanup();
});

test('the query surface refuses writes', () => {
	const tmp = tempDir();
	const db = openMailDb({ dataDir: tmp.dir, accountEmail: ACCOUNT });
	db.ingestFullPullPage([message('m1')], 's1');
	db.close();

	const { error } = queryMail({
		dataDir: tmp.dir,
		accountEmail: ACCOUNT,
		sql: 'DELETE FROM messages',
	});

	expect(error?.name).toBe('QueryFailed');
	const readBack = queryMail({
		dataDir: tmp.dir,
		accountEmail: ACCOUNT,
		sql: 'SELECT id, subject FROM messages',
	});
	expect(readBack.error).toBeNull();
	expect(readBack.data?.rows).toEqual([{ id: 'm1', subject: 'Subject m1' }]);
	tmp.cleanup();
});
