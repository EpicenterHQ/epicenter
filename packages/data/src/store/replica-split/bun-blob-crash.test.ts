/**
 * Complete split replica Bun blob crash tests.
 *
 * Reopens the real file-backed blob owner at every promotion boundary and
 * verifies that repeated recovery sweeps retain only durable membership.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import type { RecordAddress } from '../../protocol/v1/index.js';
import { makeLimits } from '../../protocol/v1/kernel.test-support.js';
import { createSplitReplicaBlobStore } from './blob-store.js';
import { createBunBlobFileStore } from '../replica/bun-blob-files.js';
import { openSplitReplicaStore } from './replica-store.js';

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
				const replica = openSplitReplicaStore({
					database: adapter,
					limits: makeLimits(),
					initialize: {
						replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
						authorityLifetime: 'lifetime-one',
					},
				});
				replica.localWrite({ address: ADDRESS, op: 'replace', value: {} });
				const files = createBunBlobFileStore(root);
				const blobs = createSplitReplicaBlobStore(adapter, files, {
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
					openSplitReplicaStore({
						database: reopenedAdapter,
						limits: makeLimits(),
					});
					const reopenedFiles = createBunBlobFileStore(root);
					const reopenedBlobs = createSplitReplicaBlobStore(
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
