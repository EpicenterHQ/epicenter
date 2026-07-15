import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSyncLock } from '../src/lock.ts';

test('one realm has one sync owner and a crashed-safe lock can be reacquired', () => {
	const dataDir = mkdtempSync(join(tmpdir(), 'local-books-lock-'));
	try {
		const first = acquireSyncLock({ dataDir, realmId: 'realm-1' });
		expect(first).not.toBeNull();
		expect(acquireSyncLock({ dataDir, realmId: 'realm-1' })).toBeNull();

		first?.release();
		const next = acquireSyncLock({ dataDir, realmId: 'realm-1' });
		expect(next).not.toBeNull();
		next?.release();
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test('different realms have independent sync owners', () => {
	const dataDir = mkdtempSync(join(tmpdir(), 'local-books-lock-'));
	try {
		const first = acquireSyncLock({ dataDir, realmId: 'realm-1' });
		const second = acquireSyncLock({ dataDir, realmId: 'realm-2' });
		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		first?.release();
		second?.release();
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
});
