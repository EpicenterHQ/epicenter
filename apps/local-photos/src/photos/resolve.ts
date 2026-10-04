import { existsSync } from 'node:fs';
import { openPhotosDb } from '../db.js';

export function resolvePhotos(dbPath: string): number {
	if (!existsSync(dbPath)) {
		throw new Error(
			`No Local Photos archive at ${dbPath}. Run an import first.`,
		);
	}
	const db = openPhotosDb(dbPath);
	try {
		return db.resolveAssets();
	} finally {
		db.close();
	}
}
