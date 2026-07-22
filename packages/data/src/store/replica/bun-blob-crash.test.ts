import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import type { RecordAddress } from '../../protocol/v1/index.js';
import { makeLimits } from '../../protocol/v1/kernel.test-support.js';
import { createReplicaBlobStore } from './blob-store.js';
import { createBunBlobFileStore } from './bun-blob-files.js';
import { openReplicaStore } from './replica-store.js';

const ADDRESS: RecordAddress = {
	namespace: 'so.epicenter.notes',
	collection: 'assets',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
};

async function* source(value: string): AsyncIterable<Uint8Array> {
	yield new TextEncoder().encode(value);
}

describe('Bun blob owner crash conformance', () => {
	for (const boundary of [
		'afterStage',
		'afterPromote',
		'afterMembership',
	] as const) {
		test(`closes, reopens, and sweeps a crash ${boundary}`, async () => {
			const root = await mkdtemp(join(tmpdir(), 'epicenter-blob-crash-'));
			const databasePath = join(root, 'epicenter.sqlite3');
			try {
				const raw = new Database(databasePath, {
					create: true,
					strict: true,
				});
				const adapter = createBunSqliteAdapter(raw);
				const replica = openReplicaStore({
					database: adapter,
					limits: makeLimits(),
					initialize: {
						replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
						authorityLifetime: 'lifetime-one',
					},
				});
				replica.localWrite({ address: ADDRESS, op: 'replace', value: {} });
				const files = createBunBlobFileStore(root);
				const blobs = createReplicaBlobStore(adapter, files, {
					[boundary]: () => {
						throw new Error(`crash ${boundary}`);
					},
				});
				await expect(blobs.capture(ADDRESS, source(boundary))).rejects.toThrow(
					`crash ${boundary}`,
				);
				raw.close();

				const reopenedRaw = new Database(databasePath, { strict: true });
				try {
					const reopenedAdapter = createBunSqliteAdapter(reopenedRaw);
					openReplicaStore({
						database: reopenedAdapter,
						limits: makeLimits(),
					});
					const reopenedFiles = createBunBlobFileStore(root);
					const reopenedBlobs = createReplicaBlobStore(
						reopenedAdapter,
						reopenedFiles,
					);
					await reopenedBlobs.reopenSweep();
					await reopenedBlobs.reopenSweep();
					expect(reopenedRaw.query('PRAGMA integrity_check').get()).toEqual({
						integrity_check: 'ok',
					});
					expect(reopenedBlobs.inspect(ADDRESS).kind).toBe(
						boundary === 'afterMembership' ? 'pending' : 'absent',
					);
					expect(await readdir(join(root, 'blobs', 'staging'))).toEqual([]);
					const ownerDirectories = await readdir(
						join(root, 'blobs', 'content'),
					);
					expect(ownerDirectories.length).toBe(
						boundary === 'afterMembership' ? 1 : 0,
					);
				} finally {
					reopenedRaw.close();
				}
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	}
});
