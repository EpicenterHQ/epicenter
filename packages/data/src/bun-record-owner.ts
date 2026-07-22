import { Database } from 'bun:sqlite';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { customAlphabet } from 'nanoid';

import type { LensDefinition } from './lens.js';
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
const mintSnapshotId = customAlphabet(
	'abcdefghijklmnopqrstuvwxyz0123456789',
	24,
);

const SNAPSHOT_PENDING_PREFIX = '.snapshot-';
const SNAPSHOT_PENDING_SUFFIX = '.pending';
const SNAPSHOT_ARTIFACT_PATTERN = /^snapshot-[a-z0-9]{24}\.sqlite3$/u;

async function sweepSnapshotDebris(directory: string): Promise<void> {
	await mkdir(directory, { recursive: true });
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (
			entry.isFile() &&
			((entry.name.startsWith(SNAPSHOT_PENDING_PREFIX) &&
				entry.name.endsWith(SNAPSHOT_PENDING_SUFFIX)) ||
				SNAPSHOT_ARTIFACT_PATTERN.test(entry.name))
		) {
			await rm(join(directory, entry.name), { force: true });
		}
	}
}

/** Open the Bun storage resources retained by one universal-record owner. */
export async function openBunRecordOwner({ directory }: { directory: string }) {
	await mkdir(directory, { recursive: true });
	const snapshotDirectory = join(directory, 'snapshots');
	await sweepSnapshotDebris(snapshotDirectory);
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
		return {
			owner,
			replica,
			blobs,
			async captureSnapshot({ lens }: { lens?: LensDefinition } = {}) {
				const id = mintSnapshotId();
				const filename = `snapshot-${id}.sqlite3`;
				const pendingPath = join(
					snapshotDirectory,
					`${SNAPSHOT_PENDING_PREFIX}${id}${SNAPSHOT_PENDING_SUFFIX}`,
				);
				const path = join(snapshotDirectory, filename);
				const artifact = new Database(pendingPath, {
					create: true,
					strict: true,
				});
				let artifactOpen = true;
				try {
					const metadata = replica.captureSnapshot({
						database: createBunSqliteAdapter(artifact),
						...(lens === undefined ? {} : { lens }),
					});
					artifact.close();
					artifactOpen = false;
					await rename(pendingPath, path);
					return { path, metadata };
				} catch (cause) {
					if (artifactOpen) artifact.close(false);
					await rm(pendingPath, { force: true });
					throw cause;
				}
			},
		};
	} catch (cause) {
		rawDatabase.close();
		throw cause;
	}
}

export type BunRecordOwner = Awaited<ReturnType<typeof openBunRecordOwner>>;
