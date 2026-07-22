import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { openBunRecordOwner } from './bun-record-owner.js';
import { createEpicenter } from './epicenter.js';
import { openReplica } from './replica/index.js';

export {
	type BlobByteSource,
	type BunBlobRead,
	createBunBlobFileStore,
} from './store/replica/bun-blob-files.js';

export type OpenBunEpicenterOptions =
	| { path: string; directory?: never }
	| { path?: never; directory: string };

export type OpenBunRecordEpicenterOptions = { directory: string };

/** Open the greenfield V1 record replica and its raw-file blob owner. */
export async function openBunRecordEpicenter({
	directory,
}: OpenBunRecordEpicenterOptions) {
	return (await openBunRecordOwner({ directory })).owner;
}

/** Open one Bun SQLite-backed Epicenter replica. */
export async function openBunEpicenter(
	options: OpenBunEpicenterOptions,
): Promise<ReturnType<typeof createEpicenter>> {
	const path =
		options.path ??
		(await mkdir(options.directory, { recursive: true }).then(() =>
			join(options.directory, 'epicenter.sqlite3'),
		));
	const rawDatabase = new Database(path, { create: true });
	try {
		const database = createBunSqliteAdapter(rawDatabase);
		const opened = openReplica({ database });
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
