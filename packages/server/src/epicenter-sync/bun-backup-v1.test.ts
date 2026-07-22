import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	BLOB_PUBLICATION_VERSION,
	blobFileOwner,
} from '@epicenter/data/blob-v1';
import { createBunBlobFileStore } from '@epicenter/data/bun';
import {
	DOCUMENT_PUBLICATION_VERSION,
	documentPayloadDigest,
} from '@epicenter/data/document-v1';
import {
	parseFactsRequest,
	parseSubmissionRequest,
	type RecordAddress,
	SCALAR_SYNC_V1_LIMITS,
	sha256Hex,
} from '@epicenter/data/protocol/v1';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import { expectOk } from 'wellcrafted/testing';

import { openScalarAuthorityV1 } from './authority-v1.js';
import { createAuthorityBlobV1 } from './blob-authority-v1.js';
import {
	bunPortableBlobPath,
	createBunBackupV1Owner,
	validateBunPortableDirectory,
} from './bun-backup-v1.js';
import {
	constructBunAuthorityFromPortable,
	recoverBunRestoreConstructionParent,
} from './bun-restore-v1.js';
import { createAuthorityCaptureManifestV1 } from './capture-manifest-v1.js';

const LIFETIME = 'lifetime-one';
const REPLICA = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const LIVE = {
	namespace: 'so.epicenter.notes',
	collection: 'notes',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
} as const;
const UNSET = { ...LIVE, recordKey: 'bbbbbbbbbbbbbbbbbbbbbbbb' } as const;
const TOMBSTONE = { ...LIVE, recordKey: 'cccccccccccccccccccccccc' } as const;

async function* bytes(value: string): AsyncIterable<Uint8Array> {
	yield new TextEncoder().encode(value);
}

async function textOf(source: ReadableStream<Uint8Array>): Promise<string> {
	const chunks: Uint8Array[] = [];
	const reader = source.getReader();
	try {
		for (;;) {
			const result = await reader.read();
			if (result.done) break;
			chunks.push(result.value);
		}
	} finally {
		reader.releaseLock();
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

function documentUpdate(value: string): Uint8Array {
	const document = new Y.Doc({ gc: true });
	document.get('body').insert(0, value);
	const update = new Uint8Array(Y.encodeStateAsUpdateV2(document));
	document.destroy();
	return update;
}

async function setup() {
	const storageRoot = await mkdtemp(join(tmpdir(), 'epicenter-backup-test-'));
	const raw = new Database(join(storageRoot, 'authority.sqlite'), {
		create: true,
		strict: true,
	});
	const database = createBunSqliteAdapter(raw);
	const authority = openScalarAuthorityV1({
		database,
		limits: SCALAR_SYNC_V1_LIMITS,
		initialize: { authorityLifetime: LIFETIME },
	});
	const captures = createAuthorityCaptureManifestV1(database);
	const blobs = createAuthorityBlobV1(
		database,
		createBunBlobFileStore(storageRoot),
	);
	const backups = createBunBackupV1Owner({
		backupsRoot: join(storageRoot, 'backups'),
		captures,
		blobs,
	});
	let submissionNumber = 1;
	function submit(
		address: RecordAddress,
		op: 'replace' | 'unset' | 'tombstone',
	): void {
		expectOk(
			authority.submit(
				expectOk(
					parseSubmissionRequest(
						{
							authorityLifetime: LIFETIME,
							replicaId: REPLICA,
							submissionNumber,
							intents: [
								op === 'replace'
									? { address, op, value: { title: address.recordKey } }
									: { address, op },
							],
						},
						SCALAR_SYNC_V1_LIMITS,
					),
				),
			),
		);
		submissionNumber += 1;
	}
	return {
		storageRoot,
		raw,
		authority,
		captures,
		blobs,
		backups,
		submit,
		async close() {
			raw.close();
			await rm(storageRoot, { recursive: true, force: true });
		},
	};
}

test('Bun Backup publishes and validates one identity-free complete directory', async () => {
	const context = await setup();
	try {
		context.submit(LIVE, 'replace');
		context.submit(UNSET, 'replace');
		context.submit(UNSET, 'unset');
		context.submit(TOMBSTONE, 'replace');
		context.submit(TOMBSTONE, 'tombstone');

		const update = documentUpdate('portable document');
		expect(
			context.authority.acceptDocument({
				authorityLifetime: LIFETIME,
				address: LIVE,
				protocolVersion: DOCUMENT_PUBLICATION_VERSION,
				payload: update,
				digest: documentPayloadDigest(update),
			}),
		).toMatchObject({ kind: 'accepted' });
		const digest = sha256Hex('portable blob');
		expect(
			await context.blobs.accept(
				{
					authorityLifetime: LIFETIME,
					address: LIVE,
					protocolVersion: BLOB_PUBLICATION_VERSION,
					digest,
				},
				bytes('portable blob'),
			),
		).toMatchObject({ kind: 'accepted' });

		const backup = await context.backups.create();
		expect(backup.recordCount).toBe(2);
		expect(await validateBunPortableDirectory(backup.directory)).toEqual({
			recordCount: 2,
		});
		expect(await context.backups.list()).toEqual([backup]);
		const artifact = new Database(join(backup.directory, 'epicenter.sqlite'), {
			readonly: true,
			strict: true,
		});
		const declaration = artifact
			.query('SELECT * FROM _epicenter_artifact')
			.get() as Record<string, unknown>;
		artifact.close();
		expect(declaration).toEqual({
			singleton: 1,
			kind: 'portable',
			format_version: 1,
		});
		expect(Object.keys(declaration)).not.toContain('authority_lifetime');

		const successorDirectory = join(context.storageRoot, 'successor');
		const restoreDebris = join(
			context.storageRoot,
			'.successor.restore-interrupted',
		);
		await mkdir(restoreDebris);
		await writeFile(join(restoreDebris, 'partial'), 'partial');
		let restoreSettled = false;
		const restore = constructBunAuthorityFromPortable({
			portableDirectory: backup.directory,
			targetDirectory: successorDirectory,
			authorityLifetime: 'lifetime-two',
		}).finally(() => {
			restoreSettled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(restoreSettled).toBe(false);
		expect(await restore).toEqual({
			authorityLifetime: 'lifetime-two',
			recordCount: 2,
		});
		expect(await readdir(context.storageRoot)).not.toContain(
			'.successor.restore-interrupted',
		);
		expect(
			await constructBunAuthorityFromPortable({
				portableDirectory: backup.directory,
				targetDirectory: successorDirectory,
				authorityLifetime: 'lifetime-two',
			}),
		).toEqual({ authorityLifetime: 'lifetime-two', recordCount: 2 });
		const successorRaw = new Database(
			join(successorDirectory, 'data-v1.sqlite'),
			{ strict: true },
		);
		const successorDatabase = createBunSqliteAdapter(successorRaw);
		const successor = openScalarAuthorityV1({
			database: successorDatabase,
			limits: SCALAR_SYNC_V1_LIMITS,
		});
		const restored = expectOk(
			successor.readFacts(
				expectOk(
					parseFactsRequest({ afterSequence: 0 }, SCALAR_SYNC_V1_LIMITS),
				),
			),
		);
		expect(restored.authorityLifetime).toBe('lifetime-two');
		expect(restored.facts.map((fact) => fact.state)).toEqual(['live', 'unset']);
		const restoredDocument = successor.exportDocument(LIVE);
		if (restoredDocument === undefined)
			throw new Error('document was not restored');
		const document = new Y.Doc({ gc: true });
		Y.applyUpdateV2(document, restoredDocument);
		expect(document.get('body').toString()).toBe('portable document');
		document.destroy();
		const successorBlobs = createAuthorityBlobV1(
			successorDatabase,
			createBunBlobFileStore(successorDirectory),
		);
		const restoredBlob = await successorBlobs.read(LIVE);
		if (restoredBlob === undefined) throw new Error('blob was not restored');
		expect(await textOf(restoredBlob)).toBe('portable blob');
		successorRaw.close();
		const tamperedSuccessor = new Database(
			join(successorDirectory, 'data-v1.sqlite'),
			{ strict: true },
		);
		tamperedSuccessor.run(
			`INSERT INTO record_documents (record_id, seq, kind, bytes)
			VALUES (999, 1, 'baseline', ?)`,
			[documentUpdate('orphan')],
		);
		tamperedSuccessor.close();
		await expect(
			constructBunAuthorityFromPortable({
				portableDirectory: backup.directory,
				targetDirectory: successorDirectory,
				authorityLifetime: 'lifetime-two',
			}),
		).rejects.toThrow('not the requested construction');

		const extraOwner = 'f'.repeat(64);
		const extraDigest = 'e'.repeat(64);
		await mkdir(join(backup.directory, 'blobs', extraOwner));
		await writeFile(
			join(backup.directory, 'blobs', extraOwner, extraDigest),
			'extra',
		);
		await expect(
			validateBunPortableDirectory(backup.directory),
		).rejects.toThrow('blob membership is incomplete');
		await rm(join(backup.directory, 'blobs', extraOwner), {
			recursive: true,
			force: true,
		});

		await context.backups.delete(backup.backupId);
		expect(await context.backups.list()).toEqual([]);
		await context.backups.close();
		await expect(context.backups.create()).rejects.toThrow(
			'Bun Backup owner is closed',
		);
	} finally {
		await context.close();
	}
});

test('Bun Restore refuses corrupt input without publishing a target', async () => {
	const context = await setup();
	try {
		context.submit(LIVE, 'replace');
		const digest = sha256Hex('portable blob');
		expect(
			await context.blobs.accept(
				{
					authorityLifetime: LIFETIME,
					address: LIVE,
					protocolVersion: BLOB_PUBLICATION_VERSION,
					digest,
				},
				bytes('portable blob'),
			),
		).toMatchObject({ kind: 'accepted' });
		const backup = await context.backups.create();
		const claimedTarget = join(context.storageRoot, 'claimed-successor');
		const claimedRestore = constructBunAuthorityFromPortable({
			portableDirectory: backup.directory,
			targetDirectory: claimedTarget,
			authorityLifetime: 'claimed-lifetime',
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		await expect(
			constructBunAuthorityFromPortable({
				portableDirectory: backup.directory,
				targetDirectory: claimedTarget,
				authorityLifetime: 'competing-lifetime',
			}),
		).rejects.toThrow('already active');
		expect(await claimedRestore).toEqual({
			authorityLifetime: 'claimed-lifetime',
			recordCount: 1,
		});
		await rm(claimedTarget, { recursive: true });
		const staleTarget = join(context.storageRoot, 'stale-successor');
		await writeFile(
			join(context.storageRoot, '.stale-successor.restore.lock'),
			JSON.stringify({ token: 'stale-owner' }),
		);
		await expect(
			constructBunAuthorityFromPortable({
				portableDirectory: backup.directory,
				targetDirectory: staleTarget,
				authorityLifetime: 'stale-recovery-lifetime',
			}),
		).rejects.toThrow('already active');
		await recoverBunRestoreConstructionParent(context.storageRoot);
		expect(
			await constructBunAuthorityFromPortable({
				portableDirectory: backup.directory,
				targetDirectory: staleTarget,
				authorityLifetime: 'stale-recovery-lifetime',
			}),
		).toEqual({
			authorityLifetime: 'stale-recovery-lifetime',
			recordCount: 1,
		});
		await rm(staleTarget, { recursive: true });
		await writeFile(bunPortableBlobPath(backup.directory, LIVE, digest), 'bad');

		const targetDirectory = join(context.storageRoot, 'refused-successor');
		await expect(
			constructBunAuthorityFromPortable({
				portableDirectory: backup.directory,
				targetDirectory,
				authorityLifetime: 'lifetime-two',
			}),
		).rejects.toThrow('digest verification failed');
		expect(await readdir(context.storageRoot)).not.toContain(
			'refused-successor',
		);
		expect(
			(await readdir(context.storageRoot)).some((entry) =>
				entry.startsWith('.refused-successor.restore-'),
			),
		).toBe(false);
	} finally {
		await context.close();
	}
});

test('compiled Bun Restore embeds its worker entrypoint', async () => {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-restore-compiled-'));
	try {
		const fixture = join(root, 'fixture.ts');
		const worker = join(root, 'bun-restore-v1-worker.ts');
		const binary = join(root, 'restore-smoke');
		const portableDirectory = join(root, 'portable');
		await mkdir(portableDirectory);
		const restoreModule = fileURLToPath(
			new URL('./bun-restore-v1.ts', import.meta.url),
		);
		const workerModule = fileURLToPath(
			new URL('./bun-restore-v1-worker.ts', import.meta.url),
		);
		await writeFile(worker, `import ${JSON.stringify(workerModule)};`);
		await writeFile(
			fixture,
			`import { constructBunAuthorityFromPortable } from ${JSON.stringify(restoreModule)};
try {
	await constructBunAuthorityFromPortable({
		portableDirectory: Bun.argv[2],
		targetDirectory: Bun.argv[3],
		authorityLifetime: 'compiled-lifetime',
	}, { createWorker: () => new Worker(new URL('./bun-restore-v1-worker.js', import.meta.url), { ref: true }) });
	process.exit(2);
} catch (cause) {
	if (!(cause instanceof Error) || !cause.message.includes('shape is not recognized')) {
		throw cause;
	}
	console.log('restore-worker-loaded');
}`,
		);
		const built = await Bun.build({
			entrypoints: [fixture, worker],
			compile: { outfile: binary },
		});
		expect(built.success).toBe(true);
		const child = Bun.spawn(
			[binary, portableDirectory, join(root, 'successor')],
			{ stdout: 'pipe', stderr: 'pipe' },
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
		expect(stdout.trim()).toBe('restore-worker-loaded');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('Bun Backup refuses corrupt pinned bytes and publishes no partial directory', async () => {
	const context = await setup();
	try {
		context.submit(LIVE, 'replace');
		const digest = sha256Hex('original');
		await context.blobs.accept(
			{
				authorityLifetime: LIFETIME,
				address: LIVE,
				protocolVersion: BLOB_PUBLICATION_VERSION,
				digest,
			},
			bytes('original'),
		);
		const owner = blobFileOwner(LIVE, digest);
		await writeFile(
			join(context.storageRoot, 'blobs', 'content', owner.ownerKey, digest),
			'corrupt',
		);
		await expect(context.backups.create()).rejects.toThrow(
			/digest verification/,
		);
		expect(await context.backups.list()).toEqual([]);
		expect(
			context.raw
				.query<{ state: string }, []>(
					'SELECT state FROM capture_manifests ORDER BY rowid DESC LIMIT 1',
				)
				.get()?.state,
		).toBe('cancelled');
		expect(
			(await readdir(join(context.storageRoot, 'backups'))).every(
				(entry) => !entry.startsWith('.'),
			),
		).toBe(true);

		await mkdir(join(context.storageRoot, 'backups', '.crash-debris'));
		await createBunBackupV1Owner({
			backupsRoot: join(context.storageRoot, 'backups'),
			captures: context.captures,
			blobs: context.blobs,
		}).list();
		expect(await readdir(join(context.storageRoot, 'backups'))).not.toContain(
			'.crash-debris',
		);
	} finally {
		await context.close();
	}
});

test('Bun Backup reconciles a transient manifest failure after publication', async () => {
	const context = await setup();
	try {
		context.submit(LIVE, 'replace');
		let refused = false;
		const captures = {
			...context.captures,
			finish(...parameters: Parameters<typeof context.captures.finish>): void {
				if (!refused && parameters[1] === 'succeeded') {
					refused = true;
					throw new Error('injected manifest completion failure');
				}
				context.captures.finish(...parameters);
			},
		};
		const backups = createBunBackupV1Owner({
			backupsRoot: join(context.storageRoot, 'reconciled-backups'),
			captures,
			blobs: context.blobs,
		});
		const backup = await backups.create();
		expect(refused).toBe(true);
		expect(await backups.list()).toEqual([backup]);
		expect(
			context.raw
				.query<{ state: string }, [string]>(
					'SELECT state FROM capture_manifests WHERE capture_id = ?',
				)
				.get(backup.backupId)?.state,
		).toBe('succeeded');
	} finally {
		await context.close();
	}
});
