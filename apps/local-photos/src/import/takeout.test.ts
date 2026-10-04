/**
 * Takeout Import Ledger Tests
 *
 * Drives extracted directories through hashing, blob storage, evidence rows,
 * claims, and resolution. These tests protect the two defining invariants:
 * repeated evidence is idempotent, and source absence never deletes an asset.
 *
 * Key behaviors:
 * - Media and sidecars become blobs, items, claims, and resolved assets
 * - Re-importing the same evidence reuses its immutable manifest
 * - A later smaller batch leaves earlier assets visible
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blobsDir, photosDbPath } from '../paths.js';
import { queryPhotos } from '../photos/query.js';
import { importTakeout } from './takeout.js';

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
	const root = await mkdtemp(join(tmpdir(), 'local-photos-test-'));
	temporaryRoots.add(root);
	const dataDir = join(root, 'archive');
	const takeoutDir = join(root, 'takeout');
	await mkdir(takeoutDir, { recursive: true });
	return { dataDir, takeoutDir };
}

async function writeMedia(
	takeoutDir: string,
	name: string,
	contents: string,
): Promise<void> {
	const directory = join(
		takeoutDir,
		'Takeout',
		'Google Photos',
		'Photos from 2020',
	);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, name), contents);
}

test('import preserves evidence and resolves Takeout metadata', async () => {
	const { dataDir, takeoutDir } = await setup();
	await writeMedia(takeoutDir, 'IMG_0001.jpg', 'first-photo');
	await writeMedia(takeoutDir, 'IMG_0002.jpg', 'second-photo');
	const directory = join(
		takeoutDir,
		'Takeout',
		'Google Photos',
		'Photos from 2020',
	);
	await writeFile(
		join(directory, 'IMG_0001.jpg.supplemental-metadata.json'),
		JSON.stringify({
			title: 'IMG_0001.jpg',
			photoTakenTime: { timestamp: '1577934245' },
			geoData: { latitude: 0, longitude: -122.4194 },
		}),
	);
	await writeFile(
		join(directory, 'metadata.json'),
		JSON.stringify({ title: 'Photos from 2020' }),
	);

	const first = await importTakeout({ dataDir, path: takeoutDir });
	expect(first).toMatchObject({
		filesSeen: 4,
		blobsNew: 2,
		sidecarsSeen: 1,
		wasAlreadyImported: false,
	});

	const evidence = queryPhotos({
		dbPath: photosDbPath(dataDir),
		sql: `SELECT
			(SELECT count(*) FROM assets) AS assets,
			(SELECT count(*) FROM claims) AS claims,
			(SELECT count(*) FROM import_items WHERE kind = 'album_metadata') AS album_metadata,
			(SELECT taken_at FROM assets WHERE taken_at IS NOT NULL) AS taken_at,
			(SELECT geo_lat FROM assets WHERE geo_lat IS NOT NULL) AS geo_lat`,
	});
	expect(evidence.rows).toEqual([
		{
			assets: 2,
			claims: 3,
			album_metadata: 1,
			taken_at: '2020-01-02T03:04:05.000Z',
			geo_lat: 0,
		},
	]);

	const second = await importTakeout({ dataDir, path: takeoutDir });
	expect(second.id).toBe(first.id);
	expect(second.wasAlreadyImported).toBe(true);

	const imported = queryPhotos({
		dbPath: photosDbPath(dataDir),
		sql: 'SELECT count(*) AS count FROM imports',
	});
	expect(imported.rows).toEqual([{ count: 1 }]);

	const hash = queryPhotos({
		dbPath: photosDbPath(dataDir),
		sql: 'SELECT hash FROM blobs ORDER BY hash LIMIT 1',
	}).rows[0]?.hash;
	expect(typeof hash).toBe('string');
	if (typeof hash === 'string') {
		const blobPath = join(blobsDir(dataDir), hash.slice(0, 2), hash);
		expect((await stat(blobPath)).mode & 0o777).toBe(0o600);
	}
});

test('later source absence leaves earlier assets visible', async () => {
	const { dataDir, takeoutDir: firstTakeout } = await setup();
	const secondTakeout = join(firstTakeout, '..', 'takeout-incremental');
	await mkdir(secondTakeout, { recursive: true });
	await writeMedia(firstTakeout, 'A.jpg', 'asset-a');
	await writeMedia(firstTakeout, 'B.jpg', 'asset-b');
	await writeMedia(secondTakeout, 'A.jpg', 'asset-a');

	await importTakeout({ dataDir, path: firstTakeout });
	await importTakeout({ dataDir, path: secondTakeout, incremental: true });

	const counts = queryPhotos({
		dbPath: photosDbPath(dataDir),
		sql: `SELECT
			(SELECT count(*) FROM imports) AS imports,
			(SELECT count(*) FROM assets) AS assets,
			(SELECT count(*) FROM tombstones) AS tombstones`,
	});
	expect(counts.rows).toEqual([{ imports: 2, assets: 2, tombstones: 0 }]);
});

test('query connection rejects writes', async () => {
	const { dataDir, takeoutDir } = await setup();
	await writeMedia(takeoutDir, 'A.jpg', 'asset-a');
	await importTakeout({ dataDir, path: takeoutDir });

	expect(() =>
		queryPhotos({
			dbPath: photosDbPath(dataDir),
			sql: 'DELETE FROM assets',
		}),
	).toThrow();
});
