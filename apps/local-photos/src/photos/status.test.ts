/**
 * Local Photos Status Tests
 *
 * Verifies that database existence alone does not claim the archive is ready.
 * The first completed evidence batch is the readiness boundary.
 *
 * Key behaviors:
 * - A migrated database with no imports still reports an empty archive
 * - The archive directory and database use private filesystem modes
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPhotosDb } from '../db.js';
import { photosDbPath } from '../paths.js';
import { readPhotosStatus } from './status.js';

const temporaryRoots = new Set<string>();

afterEach(async () => {
	await Promise.all(
		[...temporaryRoots].map((path) =>
			rm(path, { recursive: true, force: true }),
		),
	);
	temporaryRoots.clear();
});

async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'local-photos-status-test-'));
	temporaryRoots.add(root);
	const dataDir = join(root, 'archive');
	const dbPath = photosDbPath(dataDir);
	const db = openPhotosDb(dbPath);
	db.close();
	return { dataDir, dbPath };
}

test('database without a completed import reports an empty private archive', async () => {
	const { dataDir, dbPath } = await setup();

	expect(readPhotosStatus(dataDir)).toMatchObject({
		archive: 'empty',
		imports: 0,
		assets: 0,
	});
	expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
	expect((await stat(dbPath)).mode & 0o777).toBe(0o600);
});
