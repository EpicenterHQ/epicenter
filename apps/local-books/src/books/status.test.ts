/**
 * `readBooksStatus` over the mirror: what the orientation read reports before
 * anything is built, while a full pull is still in flight, after one finishes,
 * and once a version bump has left a predecessor on disk.
 *
 * The point of these cases is that none of them is a fault. Under the old
 * hand-stamped scheme, "the file says v1 and the code says v2" was a mismatch the
 * opener repaired by dropping tables. There is no such state now: an artifact is
 * either the one this build's version names or it is a retained earlier version
 * nothing reads (ADR-0197), and status reports which of those exist.
 */

import { describe, expect, test } from 'bun:test';
import {
	createMemoryTokenStore,
	makeConfig,
	tempDir,
} from '../../test/helpers.ts';
import { booksDbFile, openBooksDb } from '../db.ts';
import type { DbFile } from '../db-file.ts';
import { dbFileAt } from '../db-file.ts';
import { entityDef } from '../entities.ts';
import { companyDir } from '../paths.ts';
import { readBooksStatus } from './status.ts';

const REALM = 'r1';

/** Status for one temp data dir, optionally against a substitute mirror. */
async function statusFor(dataDir: string, mirror?: DbFile) {
	return readBooksStatus({
		config: makeConfig({ dataDir, entities: ['Invoice'] }),
		realmId: REALM,
		mirror: mirror ?? booksDbFile(dataDir, REALM),
		store: createMemoryTokenStore(),
	});
}

describe('readBooksStatus', () => {
	test('reports an unbuilt mirror without creating it', async () => {
		const tmp = tempDir();
		const mirror = booksDbFile(tmp.dir, REALM);

		const status = await statusFor(tmp.dir);
		expect(status.mirror).toBe('empty');
		expect(status.mirrorPath).toBe(mirror.path);
		expect(status.predecessors).toEqual([]);
		expect(status.entities).toEqual([]);
		// A status read is not a build: the reader conjured nothing.
		expect(mirror.versions()).toEqual([]);
		tmp.cleanup();
	});

	test('reports an artifact with rows but no finished full pull as building', async () => {
		const tmp = tempDir();
		const mirror = booksDbFile(tmp.dir, REALM);
		// Rows without a realm cursor: what a full pull that failed partway leaves
		// behind. The file exists and it has content, and it is still not a corpus.
		const db = openBooksDb(mirror);
		db.ingest([{ def: entityDef('Invoice'), objects: [{ Id: 'i1' }] }], {
			syncedAt: '2026-01-01T00:00:00Z',
		});
		db.close();

		const status = await statusFor(tmp.dir);
		expect(status.mirror).toBe('building');
		expect(status.cdcCursor).toBeNull();
		// The rows landed but no full pull committed its latch, so the entity is
		// honestly uninitialized: a half pull never reads as a corpus.
		expect(status.entities).toEqual([
			{ entity: 'Invoice', rows: 1, deleted: 0, initialized: false },
		]);
		tmp.cleanup();
	});

	test('reports the built mirror, its path, and its counts', async () => {
		const tmp = tempDir();
		const mirror = booksDbFile(tmp.dir, REALM);
		const db = openBooksDb(mirror);
		db.ingest([{ def: entityDef('Invoice'), objects: [{ Id: 'i1' }] }], {
			syncedAt: '2026-01-01T00:00:00Z',
			fullPulled: ['Invoice'],
			realmState: {
				cdcCursor: 'c1',
				lastFullPullAt: 'c1',
				lastSyncedAt: 'c1',
			},
		});
		db.close();

		const status = await statusFor(tmp.dir);
		expect(status.mirror).toBe('ready');
		expect(status.mirrorPath).toBe(mirror.path);
		expect(status.predecessors).toEqual([]);
		expect(status.cdcCursor).toBe('c1');
		expect(status.entities).toEqual([
			{ entity: 'Invoice', rows: 1, deleted: 0, initialized: true },
		]);
		tmp.cleanup();
	});

	test('reports a retained predecessor as inventory, not as a mismatch', async () => {
		const tmp = tempDir();
		// Build under today's version, then read status as a build whose corpus
		// version has since been bumped.
		const built = booksDbFile(tmp.dir, REALM);
		openBooksDb(built).close();

		const next = dbFileAt({
			version: built.version + 1,
			directory: companyDir(tmp.dir, REALM),
		});

		const status = await statusFor(tmp.dir, next);
		// The current version has no materialization; the earlier one is listed but
		// never opened, consulted, or read as a fallback.
		expect(status.mirror).toBe('empty');
		expect(status.mirrorPath).toBe(next.path);
		expect(status.predecessors).toEqual([built.version]);
		tmp.cleanup();
	});
});
