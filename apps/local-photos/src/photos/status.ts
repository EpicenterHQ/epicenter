import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { photosDbPath } from '../paths.js';

export type PhotosStatus = {
	dataDir: string;
	archive: 'empty' | 'ready';
	lastImportAt: string | null;
	imports: number;
	blobs: number;
	assets: number;
	claims: number;
	tombstones: number;
};

export function readPhotosStatus(dataDir: string): PhotosStatus {
	const path = photosDbPath(dataDir);
	if (!existsSync(path)) {
		return {
			dataDir,
			archive: 'empty',
			lastImportAt: null,
			imports: 0,
			blobs: 0,
			assets: 0,
			claims: 0,
			tombstones: 0,
		};
	}

	const db = new Database(path, { readonly: true });
	try {
		const counts = db
			.query<
				{
					imports: number;
					blobs: number;
					assets: number;
					claims: number;
					tombstones: number;
				},
				[]
			>(`SELECT
				(SELECT count(*) FROM imports) AS imports,
				(SELECT count(*) FROM blobs) AS blobs,
				(SELECT count(*) FROM assets) AS assets,
				(SELECT count(*) FROM claims) AS claims,
				(SELECT count(*) FROM tombstones) AS tombstones`)
			.get();
		return {
			dataDir,
			archive: (counts?.imports ?? 0) === 0 ? 'empty' : 'ready',
			lastImportAt:
				db
					.query<{ finished_at: string | null }, []>(
						'SELECT max(finished_at) AS finished_at FROM imports',
					)
					.get()?.finished_at ?? null,
			imports: counts?.imports ?? 0,
			blobs: counts?.blobs ?? 0,
			assets: counts?.assets ?? 0,
			claims: counts?.claims ?? 0,
			tombstones: counts?.tombstones ?? 0,
		};
	} finally {
		db.close();
	}
}
