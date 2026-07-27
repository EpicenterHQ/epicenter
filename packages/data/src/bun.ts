import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import { createEpicenter } from './epicenter.js';
import { openReplicaV1 } from './replica/v1-replica.js';

export type OpenBunEpicenterOptions =
	| { path: string; directory?: never }
	| { path?: never; directory: string };

/** The one file name a Bun-owned Epicenter uses inside its directory. */
export const EPICENTER_FILE_NAME = 'epicenter.sqlite3';

/**
 * Resolve the database path without opening it.
 *
 * Exported because inspection opens a second, read-only connection to the same
 * file, and both openers must agree on the path by construction rather than by
 * repeating the join.
 */
export function epicenterPath(options: OpenBunEpicenterOptions): string {
	return options.path ?? join(options.directory, EPICENTER_FILE_NAME);
}

/** Open one Bun SQLite-backed Epicenter replica. */
export async function openBunEpicenter(
	options: OpenBunEpicenterOptions,
): Promise<ReturnType<typeof createEpicenter>> {
	if (options.directory !== undefined) {
		await mkdir(options.directory, { recursive: true });
	}
	const path = epicenterPath(options);
	const rawDatabase = new Database(path, { create: true });
	try {
		const database = createBunSqliteAdapter(rawDatabase);
		const opened = openReplicaV1({ database });
		if (opened.error !== null) throw opened.error;
		return createEpicenter({
			replica: opened.data,
			database,
			dispose: () => rawDatabase.close(),
		});
	} catch (cause) {
		rawDatabase.close();
		throw cause;
	}
}
