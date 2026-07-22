import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { customAlphabet } from 'nanoid';

import { SCALAR_SYNC_V1_LIMITS } from './protocol/v1/index.js';
import { createRecordOwner } from './record-epicenter.js';
import { createBunBlobFileStore } from './store/replica/bun-blob-files.js';
import {
	createReplicaBlobStore,
	openReplicaStore,
} from './store/replica/index.js';

const mintReplicaId = customAlphabet(
	'abcdefghijklmnopqrstuvwxyz0123456789',
	24,
);

/** Open the Bun storage resources retained by one universal-record owner. */
export async function openBunRecordOwner({ directory }: { directory: string }) {
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
		const owner = createRecordOwner({
			replica,
			blobs,
			dispose: () => rawDatabase.close(),
		});
		return { owner, replica, blobs };
	} catch (cause) {
		rawDatabase.close();
		throw cause;
	}
}

export type BunRecordOwner = Awaited<ReturnType<typeof openBunRecordOwner>>;
