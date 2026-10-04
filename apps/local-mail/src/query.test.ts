/**
 * The read-only SQL verb, at the boundary the fingerprint moved: "is there a
 * mirror to query" used to be an `existsSync` on a guessable filename, and is
 * now the opener reporting absence. What matters here is that a predecessor
 * never stands in for the artifact this build can actually read.
 */

import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mailMirror, openMailDb } from './db.ts';
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
		payload: { headers: [{ name: 'Subject', value: `Subject ${id}` }] },
	};
}

test('an absent mirror is reported by path, and querying does not create one', () => {
	const tmp = tempDir();
	const site = mailMirror(tmp.dir, ACCOUNT);

	const { data, error } = queryMail({
		dataDir: tmp.dir,
		accountEmail: ACCOUNT,
		sql: 'SELECT 1',
	});

	expect(data).toBeNull();
	expect(error?.message).toContain(site.path);
	expect(existsSync(site.path)).toBe(false);
	expect(existsSync(join(tmp.dir, ACCOUNT))).toBe(false);
	tmp.cleanup();
});

test('a retained predecessor is not a mirror this build can query', () => {
	const tmp = tempDir();
	const accountDir = join(tmp.dir, ACCOUNT);
	mkdirSync(accountDir, { recursive: true });
	writeFileSync(join(accountDir, `mail.${'e'.repeat(64)}.db`), '');

	const { error } = queryMail({
		dataDir: tmp.dir,
		accountEmail: ACCOUNT,
		sql: 'SELECT 1',
	});

	expect(error?.name).toBe('NoMirror');
	tmp.cleanup();
});

test('the current artifact answers, and rejects a write', () => {
	const tmp = tempDir();
	const db = openMailDb({ dataDir: tmp.dir, accountEmail: ACCOUNT });
	db.ingestFullPullPage([message('m1')], 's1');
	db.close();

	const read = queryMail({
		dataDir: tmp.dir,
		accountEmail: ACCOUNT,
		sql: 'SELECT id FROM messages',
	});
	expect(read.data?.rows).toEqual([{ id: 'm1' }]);

	const write = queryMail({
		dataDir: tmp.dir,
		accountEmail: ACCOUNT,
		sql: 'DELETE FROM messages',
	});
	expect(write.error?.name).toBe('QueryFailed');
	tmp.cleanup();
});
