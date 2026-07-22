import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { customAlphabet } from 'nanoid';

import { createEpicenter } from './epicenter.js';
import { SCALAR_SYNC_V1_LIMITS } from './protocol/v1/index.js';
import { createRecordEpicenter } from './record-epicenter.js';
import { openReplica } from './replica/index.js';
import { createBunBlobFileStore } from './store/replica/bun-blob-files.js';
import {
	createReplicaBlobStore,
	openReplicaStore,
} from './store/replica/index.js';

const mintReplicaId = customAlphabet(
	'abcdefghijklmnopqrstuvwxyz0123456789',
	24,
);

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
	await mkdir(directory, { recursive: true });
	const rawDatabase = new Database(join(directory, 'epicenter.sqlite3'), {
		create: true,
		strict: true,
	});
	try {
		const database = createBunSqliteAdapter(rawDatabase);
		const replica = openReplicaStore({
			database,
			limits: SCALAR_SYNC_V1_LIMITS,
			initialize: { replicaId: mintReplicaId() },
		});
		const blobs = createReplicaBlobStore(
			database,
			createBunBlobFileStore(directory),
		);
		await blobs.reopenSweep();
		return createRecordEpicenter({
			replica,
			blobs,
			dispose: () => rawDatabase.close(),
		});
	} catch (cause) {
		rawDatabase.close();
		throw cause;
	}
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
