/**
 * Library recovery publication with real archive validation, SQLite and immutable files.
 * Imported file bytes survive unchanged, failures never publish, and a retry
 * preserves the original capture across a lifetime that no longer exists: every
 * reopen here builds a new coordinator over the same directory. The public
 * `restore` method is still absent; its durable half is exercised through the
 * unmounted attempt owner.
 */
import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type BlobId,
	type BlobStore,
	BlobStoreError,
	generateBlobId,
} from '@epicenter/blobs';
import { createBunBlobStore } from '@epicenter/blobs/bun';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { captureArchive, prepareArchive } from './artifact/archive.js';
import { installArchive } from './artifact/archive-storage.js';
import { createLibraryRecovery } from './recovery.js';
import { createRecoveryJournal } from './recovery-journal.js';
import { createFileJournalStorage } from './recovery-journal.test-support.js';
import { openCurrentAuthority } from './sync/authority.js';

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});
async function setup() {
	const directory = await mkdtemp(join(tmpdir(), 'library-backups-'));
	directories.push(directory);
	const database = new Database(join(directory, 'authority.sqlite'));
	const authority = openCurrentAuthority({
		sqlite: createBunSqliteAdapter(database),
	});
	const identity = { appId: 'so.epicenter.notes', dataId: 'so.epicenter.data' };
	const library = `libraries/apps/${identity.appId}/personal/alice/data/${identity.dataId}`;
	const blobs = createBunBlobStore({ directory: join(directory, 'blobs') });
	const archives = createBunBlobStore({
		directory: join(directory, 'backups'),
	});
	const journal = createRecoveryJournal(
		createFileJournalStorage(join(directory, 'journal')),
	);
	const doc = new Y.Doc();
	const blobId = generateBlobId();
	expectOk(await blobs.put(blobId, new Blob(['audio'], { type: 'audio/wav' })));
	doc.get('root').setAttr('audio', blobId);
	doc.get('root').insert(0, 'original', { bold: true });
	authority.ensureCurrent(Y.encodeStateAsUpdateV2(doc));
	const resources = { authority, identity, library, blobs, archives, journal };
	const reopened: Database[] = [];
	/**
	 * A coordinator built the way a fresh page builds one: new authority handle,
	 * new stores, new journal, and nothing carried over in memory.
	 */
	function restart(
		overrides: Partial<Parameters<typeof createLibraryRecovery>[0]> = {},
	) {
		const database = new Database(join(directory, 'authority.sqlite'));
		reopened.push(database);
		return createLibraryRecovery({
			...resources,
			authority: openCurrentAuthority({
				sqlite: createBunSqliteAdapter(database),
			}),
			blobs: createBunBlobStore({ directory: join(directory, 'blobs') }),
			archives: createBunBlobStore({ directory: join(directory, 'backups') }),
			journal: createRecoveryJournal(
				createFileJournalStorage(join(directory, 'journal')),
			),
			...overrides,
		});
	}
	return {
		...resources,
		resources,
		directory,
		database,
		doc,
		blobId,
		restart,
		recovery: createLibraryRecovery(resources),
		[Symbol.dispose]() {
			doc.destroy();
			for (const handle of reopened.splice(0)) handle.close();
			database.close();
		},
	};
}

test('manual backup and pretty-printed import preserve exact files and embedded attachments after reopening', async () => {
	using s = await setup();
	const manual = expectOk(await s.recovery.backup());
	expect(manual).toMatchObject({
		...s.identity,
		reason: 'manual',
		source: { generation: 1, head: 1 },
		version: 2,
	});
	const saved = expectOk(await s.recovery.download(manual.id));
	const uploaded = new TextEncoder().encode(
		`\n${JSON.stringify(JSON.parse(new TextDecoder().decode(saved)), null, 2)}\n`,
	);
	const imported = expectOk(
		await s.recovery.import(new Blob([uploaded], { type: 'text/plain' })),
	);
	expect(imported.id).not.toBe(manual.id);
	expect(imported.reason).toBe('imported');
	expect(imported.byteLength).toBe(uploaded.length);
	expect(imported.digest).not.toBe(manual.digest);
	expect(s.authority.capture().generation).toBe(1);
	const database = new Database(join(s.directory, 'authority.sqlite'));
	try {
		const reopened = createLibraryRecovery({
			...s.resources,
			authority: openCurrentAuthority({
				sqlite: createBunSqliteAdapter(database),
			}),
			archives: createBunBlobStore({ directory: join(s.directory, 'backups') }),
			journal: createRecoveryJournal(
				createFileJournalStorage(join(s.directory, 'journal')),
			),
		});
		expect(expectOk(reopened.list())).toHaveLength(2);
		const downloaded = expectOk(await reopened.download(imported.id));
		expect(downloaded).toEqual(new Uint8Array(uploaded));
		expectOk(await s.blobs.delete(s.blobId));
		const prepared = expectOk(
			await prepareArchive(expectOk(await reopened.download(manual.id))),
		);
		expect(await prepared.blobs[0]!.blob.text()).toBe('audio');
		expect(prepared.blobs[0]!.blob.type).toBe('audio/wav');
	} finally {
		database.close();
	}
});

test('invalid archives and incompatible app or data identities never write or publish', async () => {
	using s = await setup();
	let writes = 0;
	const recovery = createLibraryRecovery({
		...s.resources,
		archives: {
			get: s.archives.get,
			async put(id, blob) {
				writes++;
				return s.archives.put(id, blob);
			},
		},
	});
	const valid = expectOk(
		await captureArchive(s.authority.capture(), s.blobs, s.identity),
	);
	const v1 = JSON.parse(new TextDecoder().decode(valid));
	v1.version = 1;
	const missing = JSON.parse(new TextDecoder().decode(valid));
	delete missing.body.identity;
	for (const bytes of [
		new TextEncoder().encode('{}'),
		new TextEncoder().encode(JSON.stringify(v1)),
		new TextEncoder().encode(JSON.stringify(missing)),
		expectOk(
			await captureArchive(s.authority.capture(), s.blobs, {
				...s.identity,
				appId: 'so.other.app',
			}),
		),
		expectOk(
			await captureArchive(s.authority.capture(), s.blobs, {
				...s.identity,
				dataId: 'so.other.data',
			}),
		),
	])
		expectErr(await recovery.import(new Blob([new Uint8Array(bytes)])));
	expect(writes).toBe(0);
	expect(expectOk(recovery.list())).toEqual([]);
});

test('failed write, missing read-back, wrong bytes and wrong MIME never publish', async () => {
	for (const phase of ['write', 'missing', 'bytes', 'mime'] as const) {
		using s = await setup();
		const other = expectOk(
			await captureArchive(
				{ ...s.authority.capture(), generation: 9 },
				s.blobs,
				s.identity,
			),
		);
		const archives: Pick<BlobStore, 'put' | 'get'> = {
			async put(id, blob) {
				return phase === 'write'
					? BlobStoreError.BlobStoreFailed({ id, cause: 'disk full' })
					: s.archives.put(id, blob);
			},
			async get(id) {
				if (phase === 'missing') return BlobStoreError.BlobNotFound({ id });
				if (phase === 'bytes') {
					expect(other.length).toBe(expectOk(await s.archives.get(id)).size);
					return Ok(
						new Blob([new Uint8Array(other)], {
							type: 'application/json;charset=utf-8',
						}),
					);
				}
				const saved = expectOk(await s.archives.get(id));
				return Ok(
					new Blob([await saved.arrayBuffer()], { type: 'text/plain' }),
				);
			},
		};
		const recovery = createLibraryRecovery({ ...s.resources, archives });
		expectErr(await recovery.backup());
		expect(expectOk(recovery.list())).toEqual([]);
	}
});

test('retry after failed read-back preserves the original manual capture despite later accepted writes', async () => {
	using s = await setup();
	let failed = true;
	const recovery = createLibraryRecovery({
		...s.resources,
		archives: {
			put: s.archives.put,
			async get(id) {
				return failed
					? BlobStoreError.BlobStoreFailed({ id, cause: 'interrupted read' })
					: s.archives.get(id);
			},
		},
	});
	expectErr(await recovery.backup());
	const before = Y.encodeStateVector(s.doc);
	s.doc.get('root').insert(8, ' later');
	expectOk(s.authority.bind(1).append(Y.encodeStateAsUpdateV2(s.doc, before)));
	failed = false;
	const record = expectOk(await recovery.backup());
	expect(record.source).toEqual({ generation: 1, head: 1 });
	expect(s.authority.capture().head).toBe(2);
	expect(expectOk(recovery.list())).toEqual([record]);
	const restored = new Y.Doc();
	try {
		Y.applyUpdateV2(
			restored,
			expectOk(
				await prepareArchive(expectOk(await recovery.download(record.id))),
			).bytes,
		);
		expect(restored.get('root').toString()).toContain('>original</>');
	} finally {
		restored.destroy();
	}
});

test('a capture interrupted before publication is finished by a coordinator that never made it', async () => {
	using s = await setup();
	// The read-back fails, so nothing is published and the live lifetime ends.
	expectErr(
		await s
			.restart({
				archives: {
					put: s.archives.put,
					async get(id) {
						return BlobStoreError.BlobStoreFailed({ id, cause: 'interrupted' });
					},
				},
			})
			.backup(),
	);
	// Work is accepted afterwards. A recapture would publish this instead.
	const before = Y.encodeStateVector(s.doc);
	s.doc.get('root').insert(8, ' later');
	expectOk(s.authority.bind(1).append(Y.encodeStateAsUpdateV2(s.doc, before)));
	expect(s.authority.capture().head).toBe(2);

	const restarted = s.restart();
	const record = expectOk(await restarted.backup());
	expect(record.source).toEqual({ generation: 1, head: 1 });
	expect(expectOk(restarted.list())).toEqual([record]);
	const restored = new Y.Doc();
	try {
		Y.applyUpdateV2(
			restored,
			expectOk(
				await prepareArchive(expectOk(await restarted.download(record.id))),
			).bytes,
		);
		expect(restored.get('root').toString()).not.toContain('later');
	} finally {
		restored.destroy();
	}
	// The intent is resolved, so the next backup is a new capture of today.
	const next = expectOk(await s.restart().backup());
	expect(next.id).not.toBe(record.id);
	expect(next.source).toEqual({ generation: 1, head: 2 });
});

test('a pending import is resumed only by the same file, and blocks a manual backup', async () => {
	using s = await setup();
	const file = expectOk(
		await captureArchive(s.authority.capture(), s.blobs, s.identity),
	);
	const failing = {
		put: s.archives.put,
		async get(id: BlobId) {
			return BlobStoreError.BlobStoreFailed({ id, cause: 'interrupted' });
		},
	};
	expectErr(
		await s
			.restart({ archives: failing })
			.import(new Blob([new Uint8Array(file)])),
	);
	const restarted = s.restart();
	expect(expectErr(await restarted.backup()).message).toContain(
		'A different backup publication is pending',
	);
	const other = new TextEncoder().encode(
		`\n${new TextDecoder().decode(file)}\n`,
	);
	expect(
		expectErr(await restarted.import(new Blob([other]))).message,
	).toContain('A different backup publication is pending');
	const record = expectOk(
		await restarted.import(new Blob([new Uint8Array(file)])),
	);
	expect(record.reason).toBe('imported');
	expect(expectOk(restarted.list())).toEqual([record]);
});

test('an attempt keeps one safety backup across an interrupted publication and a later failure', async () => {
	using s = await setup();
	const source = expectOk(await s.recovery.backup());

	const interrupted = s.restart({
		archives: {
			put: s.archives.put,
			async get(id) {
				// The destination capture is published; only its read-back is lost.
				return id === source.id
					? s.archives.get(id)
					: BlobStoreError.BlobStoreFailed({ id, cause: 'interrupted' });
			},
		},
	});
	const attempt = expectOk(await interrupted.attempts.begin(source.id));
	expect(attempt).toMatchObject({ status: 'pending', backupId: source.id });
	expectErr(await interrupted.attempts.safetyBackup(attempt.operation));
	// Nothing usable was published, and the slot is still held by this attempt.
	expect(expectOk(interrupted.list()).map((record) => record.id)).toEqual([
		source.id,
	]);

	const restarted = s.restart();
	expect(expectOk(await restarted.attempts.begin(source.id)).operation).toBe(
		attempt.operation,
	);
	const safety = expectOk(
		await restarted.attempts.safetyBackup(attempt.operation),
	);
	expect(safety.reason).toBe('before-restore');
	expect(safety.source).toEqual({ generation: 1, head: 1 });
	// Asking again returns the one record, never a second capture.
	expect(
		expectOk(await s.restart().attempts.safetyBackup(attempt.operation)),
	).toEqual(safety);

	const failed = s.restart();
	expect(expectOk(failed.attempts.fail(attempt.operation)).status).toBe(
		'failed',
	);
	// The outcome outlives the lifetime that produced it and keeps the slot
	// until someone acknowledges it.
	const after = s.restart();
	expect(expectOk(await after.attempts.pending())).toMatchObject({
		attempt: { operation: attempt.operation, status: 'failed' },
		receipt: undefined,
	});
	expect(expectErr(await after.backup())).toMatchObject({
		name: 'AttemptPending',
		operation: attempt.operation,
	});
	expectOk(await after.attempts.acknowledge(attempt.operation));

	// The safety backup outlives the attempt that failed, and the slot is free.
	const released = s.restart();
	expect(
		expectOk(released.list())
			.map((record) => record.id)
			.sort(),
	).toEqual([source.id, safety.id].sort());
	expect(expectOk(await released.attempts.pending())).toBeUndefined();
	expect(expectOk(await released.backup()).reason).toBe('manual');
});

test('an unresolved restore refuses a backup, and the prepared request is retained rather than rebuilt', async () => {
	using s = await setup();
	const source = expectOk(await s.recovery.backup());
	const attempt = expectOk(await s.recovery.attempts.begin(source.id));
	expect(expectErr(await s.restart().backup())).toMatchObject({
		name: 'AttemptPending',
		operation: attempt.operation,
	});
	expect(
		expectErr(await s.recovery.attempts.begin(generateBlobId())).name,
	).toBe('AttemptPending');
	expectOk(await s.recovery.attempts.safetyBackup(attempt.operation));

	const prepared = expectOk(
		await installArchive({
			archive: expectOk(await s.recovery.download(source.id)),
			blobs: s.blobs,
		}),
	);
	const pinned = expectOk(
		await s.recovery.attempts.pin(attempt.operation, prepared.bytes),
	);
	// The destination the safety backup covered, not the archive's own position.
	expect(pinned.destination).toEqual({ generation: 1, head: 1 });

	const restarted = s.restart();
	expect(
		expectOk(await restarted.attempts.activationBytes(attempt.operation)),
	).toEqual(new Uint8Array(prepared.bytes));
	// Reconstructing again authors a different lineage, so it is refused.
	const rebuilt = expectOk(
		await installArchive({
			archive: expectOk(await restarted.download(source.id)),
			blobs: s.blobs,
		}),
	);
	expect(new Uint8Array(rebuilt.bytes)).not.toEqual(
		new Uint8Array(prepared.bytes),
	);
	expect(
		expectErr(await restarted.attempts.pin(attempt.operation, rebuilt.bytes))
			.name,
	).toBe('AttemptConflict');
	// The outcome is observable with archive storage unreachable.
	const outcome = expectOk(
		s
			.restart({
				archives: {
					async put(id) {
						return BlobStoreError.BlobStoreFailed({ id, cause: 'offline' });
					},
					async get(id) {
						return BlobStoreError.BlobStoreFailed({ id, cause: 'offline' });
					},
				},
			})
			.attempts.outcome(attempt.operation),
	);
	expect(outcome.attempt?.status).toBe('pending');
	expect(outcome.receipt).toBeUndefined();
});

test('an activation that committed while the page was gone is reported with its receipt, once', async () => {
	using s = await setup();
	const source = expectOk(await s.recovery.backup());
	const attempt = expectOk(await s.recovery.attempts.begin(source.id));
	expectOk(await s.recovery.attempts.safetyBackup(attempt.operation));
	const prepared = expectOk(
		await installArchive({
			archive: expectOk(await s.recovery.download(source.id)),
			blobs: s.blobs,
		}),
	);
	expect(
		expectOk(await s.recovery.attempts.pin(attempt.operation, prepared.bytes))
			.destination,
	).toEqual({ generation: 1, head: 1 });
	// The response is lost, but the activation commits.
	const receipt = (
		await s.authority.prepareActivation({
			operation: attempt.operation,
			expected: { generation: 1, head: 1 },
			bytes: expectOk(
				await s.recovery.attempts.activationBytes(attempt.operation),
			),
		})
	).activate();
	expect(receipt).toMatchObject({ status: 'activated', generation: 2 });

	const restarted = s.restart();
	const observed = expectOk(await restarted.attempts.pending());
	expect(observed).toMatchObject({
		attempt: { operation: attempt.operation, status: 'activated' },
		receipt: { status: 'activated', generation: 2, head: 1 },
	});
	// Reading does not forget: the outcome is still there for the next reader.
	expect(expectOk(await s.restart().attempts.pending())).toMatchObject({
		attempt: { operation: attempt.operation, status: 'activated' },
	});
	expect(expectErr(await restarted.backup())).toMatchObject({
		name: 'AttemptPending',
		operation: attempt.operation,
	});
	expectOk(await restarted.attempts.acknowledge(attempt.operation));
	expect(expectOk(await s.restart().attempts.pending())).toBeUndefined();
	// The backup history survived the generation it replaced.
	const after = s.restart();
	expect(expectOk(after.list())).toHaveLength(2);
	expect(expectOk(await after.backup()).source).toEqual({
		generation: 2,
		head: 1,
	});
});

test('a coordinator with no local reference still sees the attempt the authority holds', async () => {
	using s = await setup();
	const source = expectOk(await s.recovery.backup());
	const attempt = expectOk(await s.recovery.attempts.begin(source.id));

	// A second tab, a second device, or this device after its site data was
	// cleared. The journal knows nothing; the library is still mid-restore.
	const stranger = s.restart({
		journal: createRecoveryJournal(
			createFileJournalStorage(join(s.directory, 'other-journal')),
		),
	});
	expect(expectOk(await stranger.attempts.pending())).toMatchObject({
		attempt: { operation: attempt.operation, status: 'pending' },
		intent: undefined,
	});
	expect(expectErr(await stranger.backup())).toMatchObject({
		name: 'AttemptPending',
		operation: attempt.operation,
	});
	expect(expectErr(await stranger.import(new Blob(['{}'])))).toMatchObject({
		name: 'AttemptPending',
		operation: attempt.operation,
	});
	expect(expectErr(await stranger.attempts.begin(source.id)).name).toBe(
		'AttemptPending',
	);
	// Resolving it through the authority frees every coordinator, not just one.
	expectOk(stranger.attempts.fail(attempt.operation));
	expectOk(await stranger.attempts.acknowledge(attempt.operation));
	expect(expectOk(await stranger.backup()).reason).toBe('manual');
});

test('a refused begin leaves no reference behind to block the next backup', async () => {
	using s = await setup();
	const source = expectOk(await s.recovery.backup());
	const holder = expectOk(await s.recovery.attempts.begin(source.id));
	const stranger = s.restart({
		journal: createRecoveryJournal(
			createFileJournalStorage(join(s.directory, 'other-journal')),
		),
	});
	expect(expectErr(await stranger.attempts.begin(source.id))).toMatchObject({
		name: 'AttemptPending',
		operation: holder.operation,
	});
	// The refusal names the attempt that actually holds the slot. A reference
	// written before the reservation would name an operation reserved nowhere.
	expect(expectErr(await stranger.backup())).toMatchObject({
		name: 'AttemptPending',
		operation: holder.operation,
	});
	expect(expectOk(await stranger.attempts.pending())).toMatchObject({
		attempt: { operation: holder.operation },
		intent: undefined,
	});
	expectOk(stranger.attempts.fail(holder.operation));
	expectOk(await stranger.attempts.acknowledge(holder.operation));
	// Nothing was reserved by the refused call, so nothing names it afterwards.
	expect(expectOk(await stranger.attempts.pending())).toBeUndefined();
	expect(expectOk(await stranger.backup()).reason).toBe('manual');
});

test('an attempt that pinned no preparation cannot activate', async () => {
	using s = await setup();
	const source = expectOk(await s.recovery.backup());
	const attempt = expectOk(await s.recovery.attempts.begin(source.id));
	expectOk(await s.recovery.attempts.safetyBackup(attempt.operation));
	// Bytes this attempt never retained, offered under its identity.
	expect(
		(
			await s.authority.prepareActivation({
				operation: attempt.operation,
				expected: { generation: 1, head: 1 },
				bytes: new Uint8Array([1, 2, 3]),
			})
		).activate(),
	).toEqual({ status: 'operation-conflict' });
	expect(s.authority.capture().generation).toBe(1);
	expect(expectOk(s.recovery.attempts.outcome(attempt.operation)).receipt).toBe(
		undefined,
	);
});
