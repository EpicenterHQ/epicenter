import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SqliteDatabase } from '@epicenter/sqlite';
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
	test('new-record admission rolls back a crash after its SQLite insert', async () => {
		const root = await mkdtemp(join(tmpdir(), 'epicenter-new-blob-sql-crash-'));
		const databasePath = join(root, 'epicenter.sqlite3');
		try {
			const raw = new Database(databasePath, { create: true, strict: true });
			const base = createBunSqliteAdapter(raw);
			const crash = new Error('crash after admission insert');
			const database: SqliteDatabase = {
				...base,
				run(sql, parameters) {
					base.run(sql, parameters);
					if (
						sql.includes('INSERT INTO records') &&
						sql.includes('blob_sha256')
					) {
						throw crash;
					}
				},
			};
			const replica = openReplicaStore({
				database,
				limits: makeLimits(),
				initialize: {
					replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
					authorityLifetime: 'lifetime-one',
				},
			});
			const blobs = createReplicaBlobStore(
				database,
				createBunBlobFileStore(root),
			);
			await expect(
				blobs.captureNewRecord(ADDRESS, source('sqlite crash'), (digest) =>
					replica.admitLocalRecordWithBlob({
						address: ADDRESS,
						payload: { title: 'never visible' },
						digest,
					}),
				),
			).rejects.toBe(crash);
			raw.close();

			const reopenedRaw = new Database(databasePath, { strict: true });
			try {
				const reopenedAdapter = createBunSqliteAdapter(reopenedRaw);
				const reopenedReplica = openReplicaStore({
					database: reopenedAdapter,
					limits: makeLimits(),
				});
				const reopenedBlobs = createReplicaBlobStore(
					reopenedAdapter,
					createBunBlobFileStore(root),
				);
				await reopenedBlobs.reopenSweep();
				expect(reopenedReplica.visible(ADDRESS)).toBeNull();
				expect(reopenedBlobs.inspect(ADDRESS)).toEqual({ kind: 'absent' });
				expect(await readdir(join(root, 'blobs', 'content'))).toEqual([]);
				expect(reopenedRaw.query('PRAGMA integrity_check').get()).toEqual({
					integrity_check: 'ok',
				});
			} finally {
				reopenedRaw.close();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

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
						boundary === 'afterMembership' ? 'owed' : 'absent',
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

	for (const boundary of [
		'afterStage',
		'afterPromote',
		'afterMembership',
	] as const) {
		test(`new-record admission reopens atomically after ${boundary}`, async () => {
			const root = await mkdtemp(join(tmpdir(), 'epicenter-new-blob-crash-'));
			const databasePath = join(root, 'epicenter.sqlite3');
			try {
				const raw = new Database(databasePath, { create: true, strict: true });
				const adapter = createBunSqliteAdapter(raw);
				const replica = openReplicaStore({
					database: adapter,
					limits: makeLimits(),
					initialize: {
						replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
						authorityLifetime: 'lifetime-one',
					},
				});
				const blobs = createReplicaBlobStore(
					adapter,
					createBunBlobFileStore(root),
					{
						[boundary]: () => {
							throw new Error(`crash ${boundary}`);
						},
					},
				);
				await expect(
					blobs.captureNewRecord(ADDRESS, source(boundary), (digest) =>
						replica.admitLocalRecordWithBlob({
							address: ADDRESS,
							payload: { boundary },
							digest,
						}),
					),
				).rejects.toThrow(`crash ${boundary}`);
				raw.close();

				const reopenedRaw = new Database(databasePath, { strict: true });
				try {
					const reopenedAdapter = createBunSqliteAdapter(reopenedRaw);
					const reopenedReplica = openReplicaStore({
						database: reopenedAdapter,
						limits: makeLimits(),
					});
					const reopenedBlobs = createReplicaBlobStore(
						reopenedAdapter,
						createBunBlobFileStore(root),
					);
					await reopenedBlobs.reopenSweep();
					await reopenedBlobs.reopenSweep();
					const committed = boundary === 'afterMembership';
					expect(reopenedReplica.visible(ADDRESS)?.state ?? null).toBe(
						committed ? 'live' : null,
					);
					expect(reopenedBlobs.inspect(ADDRESS).kind).toBe(
						committed ? 'pending' : 'absent',
					);
					expect(reopenedRaw.query('PRAGMA integrity_check').get()).toEqual({
						integrity_check: 'ok',
					});
				} finally {
					reopenedRaw.close();
				}
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	}
});
