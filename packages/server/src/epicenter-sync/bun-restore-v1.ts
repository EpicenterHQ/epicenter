import { Database } from 'bun:sqlite';
import { createReadStream } from 'node:fs';
import {
	link,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	unlink,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { blobFileOwner } from '@epicenter/data/blob-v1';
import { createBunBlobFileStore } from '@epicenter/data/bun';
import { scanPortableArtifactIndex } from '@epicenter/data/portable';
import {
	canonicalize,
	SCALAR_SYNC_V1_LIMITS,
} from '@epicenter/data/protocol/v1';
import type { SqliteRow } from '@epicenter/sqlite';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import { openScalarAuthorityV1 } from './authority-v1.js';
import { openAuthorityV1Schema } from './authority-v1-schema.js';
import {
	bunPortableBlobPath,
	validateBunPortableDirectory,
} from './bun-backup-v1.js';

const BLOB_PAGE = 16;

export type BunRestoreConstruction = {
	authorityLifetime: string;
	recordCount: number;
};

export type BunRestoreConstructionRequest = {
	portableDirectory: string;
	targetDirectory: string;
	authorityLifetime: string;
};

export type BunRestoreWorkerResponse =
	| { ok: true; result: BunRestoreConstruction }
	| { ok: false; message: string; stack?: string };

export type BunRestoreWorkerOptions = {
	/** Host-owned static factory, required when Bun compiles the caller. */
	createWorker?: () => Worker;
};

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw cause;
	}
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, 'r');
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function sweepRestoreDebris(parent: string, targetName: string) {
	const prefix = `.${targetName}.restore-`;
	for (const entry of await readdir(parent, { withFileTypes: true })) {
		if (entry.isDirectory() && entry.name.startsWith(prefix)) {
			await rm(join(parent, entry.name), { recursive: true, force: true });
		}
	}
	await syncDirectory(parent);
}

type RestoreClaim = { token: string };

function isRestoreClaim(value: unknown): value is RestoreClaim {
	return (
		value !== null &&
		typeof value === 'object' &&
		typeof (value as Partial<RestoreClaim>).token === 'string'
	);
}

/** Reap Restore crash residue before this host starts accepting owner work. */
export async function recoverBunRestoreConstructionParent(
	parent: string,
): Promise<void> {
	await mkdir(parent, { recursive: true });
	for (const entry of await readdir(parent, { withFileTypes: true })) {
		const crashResidue =
			/^\..+\.restore\.lock$/u.test(entry.name) ||
			/^\..+\.restore-claim-[0-9a-f-]+$/u.test(entry.name) ||
			/^\..+\.restore-[0-9a-f-]+$/u.test(entry.name);
		if (!crashResidue) continue;
		await rm(join(parent, entry.name), { recursive: true, force: true });
	}
	await syncDirectory(parent);
}

async function acquireRestoreClaim(
	parent: string,
	targetName: string,
): Promise<() => Promise<void>> {
	const lockPath = join(parent, `.${targetName}.restore.lock`);
	const token = crypto.randomUUID();
	const ownerPath = join(parent, `.${targetName}.restore-claim-${token}`);
	const claim = { token } satisfies RestoreClaim;
	let acquired = false;
	try {
		const owner = await open(ownerPath, 'wx');
		try {
			await owner.writeFile(JSON.stringify(claim));
			await owner.sync();
		} finally {
			await owner.close();
		}
		for (;;) {
			try {
				await link(ownerPath, lockPath);
				acquired = true;
				break;
			} catch (cause) {
				if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
				let incumbent: unknown;
				try {
					incumbent = JSON.parse(await readFile(lockPath, 'utf8'));
				} catch {
					throw new Error('Restore construction claim is unreadable');
				}
				if (!isRestoreClaim(incumbent)) {
					throw new Error('Restore construction claim is invalid');
				}
				throw new Error(
					'Restore construction is already active for this target',
				);
			}
		}
		await unlink(ownerPath).catch(() => undefined);
		await syncDirectory(parent);
	} catch (cause) {
		await unlink(ownerPath).catch(() => undefined);
		throw cause;
	}
	if (!acquired) throw new Error('Restore construction claim was not acquired');

	return async () => {
		let incumbent: unknown;
		try {
			incumbent = JSON.parse(await readFile(lockPath, 'utf8'));
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
			throw cause;
		}
		if (!isRestoreClaim(incumbent) || incumbent.token !== token) {
			throw new Error('Restore construction claim changed owners');
		}
		await unlink(lockPath);
		await syncDirectory(parent);
	};
}

async function hashFile(path: string): Promise<string> {
	const hasher = new Bun.CryptoHasher('sha256');
	for await (const chunk of createReadStream(path)) hasher.update(chunk);
	return hasher.digest('hex');
}

function sameBytes(left: Uint8Array | ArrayBuffer, right: Uint8Array): boolean {
	const candidate =
		left instanceof Uint8Array ? left : new Uint8Array(left.slice(0));
	return (
		candidate.byteLength === right.byteLength &&
		candidate.every((byte, index) => byte === right[index])
	);
}

async function validateExistingConstruction({
	portableDirectory,
	targetDirectory,
	authorityLifetime,
}: BunRestoreConstructionRequest): Promise<BunRestoreConstruction> {
	const validated = await validateBunPortableDirectory(portableDirectory);
	const targetRaw = new Database(join(targetDirectory, 'data-v1.sqlite'), {
		readonly: true,
		strict: true,
	});
	const sourceRaw = new Database(join(portableDirectory, 'epicenter.sqlite'), {
		readonly: true,
		strict: true,
	});
	try {
		const target = createBunSqliteAdapter(targetRaw);
		openAuthorityV1Schema(target, undefined);
		type Summary = SqliteRow & {
			authority_lifetime: string;
			next_sequence: number;
			next_capture_revision: number;
			record_count: number;
			minimum_sequence: number | null;
			maximum_sequence: number | null;
			minimum_capture_revision: number | null;
			maximum_capture_revision: number | null;
			invalid_state_count: number;
			orphan_document_count: number;
			witness_count: number;
			manifest_count: number;
		};
		const summary = target.all<Summary>(
			`SELECT meta.authority_lifetime, meta.next_sequence,
				meta.next_capture_revision,
				(SELECT count(*) FROM records) AS record_count,
				(SELECT min(sequence) FROM records) AS minimum_sequence,
				(SELECT max(sequence) FROM records) AS maximum_sequence,
				(SELECT min(capture_revision) FROM records)
					AS minimum_capture_revision,
				(SELECT max(capture_revision) FROM records)
					AS maximum_capture_revision,
				(SELECT count(*) FROM records WHERE state = 'tombstone')
					AS invalid_state_count,
				(SELECT count(*) FROM record_documents AS document
					LEFT JOIN records AS record ON record.record_id = document.record_id
					WHERE record.record_id IS NULL) AS orphan_document_count,
				(SELECT count(*) FROM replica_witness) AS witness_count,
				(SELECT count(*) FROM capture_manifests) AS manifest_count
			FROM meta WHERE singleton = 1`,
		)[0];
		if (
			summary === undefined ||
			summary.authority_lifetime !== authorityLifetime ||
			summary.record_count !== validated.recordCount ||
			summary.next_sequence !== validated.recordCount + 1 ||
			summary.next_capture_revision !== validated.recordCount + 1 ||
			(summary.record_count === 0
				? summary.minimum_sequence !== null ||
					summary.maximum_sequence !== null ||
					summary.minimum_capture_revision !== null ||
					summary.maximum_capture_revision !== null
				: summary.minimum_sequence !== 1 ||
					summary.maximum_sequence !== summary.record_count ||
					summary.minimum_capture_revision !== 1 ||
					summary.maximum_capture_revision !== summary.record_count) ||
			summary.invalid_state_count !== 0 ||
			summary.orphan_document_count !== 0 ||
			summary.witness_count !== 0 ||
			summary.manifest_count !== 0
		) {
			throw new Error(
				'existing Restore target is not the requested construction',
			);
		}
		const integrity = target.all<{ integrity_check: string }>(
			'PRAGMA integrity_check',
		);
		if (
			integrity.length !== 1 ||
			integrity[0]?.integrity_check.toLowerCase() !== 'ok'
		) {
			throw new Error('existing Restore target failed integrity check');
		}

		type ExistingRecord = SqliteRow & {
			record_id: number;
			state: 'live' | 'unset';
			payload: string | null;
			accepted_blob_sha256: string | null;
		};
		type ExistingDocument = SqliteRow & {
			seq: number;
			kind: 'baseline' | 'update';
			bytes: Uint8Array | ArrayBuffer;
		};
		scanPortableArtifactIndex({
			database: createBunSqliteAdapter(sourceRaw),
			onPage(page) {
				for (const record of page) {
					const row = target.all<ExistingRecord>(
						`SELECT record_id, state, payload, accepted_blob_sha256
						FROM records WHERE namespace = ? AND collection = ?
							AND record_key = ?`,
						[
							record.address.namespace,
							record.address.collection,
							record.address.recordKey,
						],
					)[0];
					const expectedPayload =
						record.scalar.state === 'live'
							? canonicalize(record.scalar.payload)
							: null;
					if (
						row === undefined ||
						row.state !== record.scalar.state ||
						row.payload !== expectedPayload ||
						row.accepted_blob_sha256 !== record.blobSha256
					) {
						throw new Error(
							'existing Restore target differs from the portable artifact',
						);
					}
					const documents = target.all<ExistingDocument>(
						`SELECT seq, kind, bytes FROM record_documents
						WHERE record_id = ? ORDER BY seq`,
						[row.record_id],
					);
					if (
						record.documentUpdateV2 === null
							? documents.length !== 0
							: documents.length !== 1 ||
								documents[0]?.seq !== 1 ||
								documents[0].kind !== 'baseline' ||
								!sameBytes(documents[0].bytes, record.documentUpdateV2)
					) {
						throw new Error(
							'existing Restore target document differs from the portable artifact',
						);
					}
				}
			},
		});

		type BlobRow = SqliteRow & {
			namespace: string;
			collection: string;
			record_key: string;
			blob_sha256: string;
		};
		const blobs = target.all<BlobRow>(
			`SELECT namespace, collection, record_key,
				accepted_blob_sha256 AS blob_sha256
			FROM records WHERE accepted_blob_sha256 IS NOT NULL`,
		);
		for (const row of blobs) {
			const owner = blobFileOwner(
				{
					namespace: row.namespace,
					collection: row.collection,
					recordKey: row.record_key,
				},
				row.blob_sha256,
			);
			const path = join(
				targetDirectory,
				'blobs',
				'content',
				owner.ownerKey,
				owner.digest,
			);
			if ((await hashFile(path)) !== row.blob_sha256) {
				throw new Error(
					'existing Restore target blob failed digest validation',
				);
			}
		}
		return { authorityLifetime, recordCount: validated.recordCount };
	} finally {
		targetRaw.close();
		sourceRaw.close();
	}
}

/** Worker-thread body for constructing one inactive fresh-lifetime authority. */
export async function constructBunAuthorityFromPortableInWorker({
	portableDirectory,
	targetDirectory,
	authorityLifetime,
}: BunRestoreConstructionRequest): Promise<BunRestoreConstruction> {
	const targetParent = dirname(targetDirectory);
	const targetName = basename(targetDirectory);
	await mkdir(targetParent, { recursive: true });
	await sweepRestoreDebris(targetParent, targetName);
	if (await exists(targetDirectory)) {
		return validateExistingConstruction({
			portableDirectory,
			targetDirectory,
			authorityLifetime,
		});
	}
	const validated = await validateBunPortableDirectory(portableDirectory);
	const temporary = join(
		targetParent,
		`.${targetName}.restore-${crypto.randomUUID()}`,
	);
	await mkdir(temporary, { recursive: false });

	let targetRaw: Database | undefined;
	let sourceRaw: Database | undefined;
	let published = false;
	try {
		targetRaw = new Database(join(temporary, 'data-v1.sqlite'), {
			create: true,
			strict: true,
		});
		sourceRaw = new Database(join(portableDirectory, 'epicenter.sqlite'), {
			readonly: true,
			strict: true,
		});
		const target = createBunSqliteAdapter(targetRaw);
		openScalarAuthorityV1({
			database: target,
			limits: SCALAR_SYNC_V1_LIMITS,
			initialize: { authorityLifetime },
		});
		let nextSequence = 1;
		scanPortableArtifactIndex({
			database: createBunSqliteAdapter(sourceRaw),
			onPage(page) {
				target.transaction(() => {
					for (const record of page) {
						const recordId = nextSequence;
						target.run(
							`INSERT INTO records (
								record_id, namespace, collection, record_key, state, payload,
								sequence, capture_revision, accepted_blob_sha256
							) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
							[
								recordId,
								record.address.namespace,
								record.address.collection,
								record.address.recordKey,
								record.scalar.state,
								record.scalar.state === 'live'
									? canonicalize(record.scalar.payload)
									: null,
								nextSequence,
								nextSequence,
								record.blobSha256,
							],
						);
						if (record.documentUpdateV2 !== null) {
							target.run(
								`INSERT INTO record_documents (
									record_id, seq, kind, bytes
								) VALUES (?, 1, 'baseline', ?)`,
								[recordId, record.documentUpdateV2],
							);
						}
						nextSequence += 1;
					}
				});
			},
		});
		sourceRaw.close();
		sourceRaw = undefined;
		target.run(
			`UPDATE meta SET next_sequence = ?, next_capture_revision = ?
			WHERE singleton = 1`,
			[nextSequence, nextSequence],
		);

		const files = createBunBlobFileStore(temporary);
		type BlobRow = SqliteRow & {
			namespace: string;
			collection: string;
			record_key: string;
			blob_sha256: string;
		};
		let cursor: [string, string, string] | undefined;
		for (;;) {
			const rows = target.all<BlobRow>(
				`SELECT namespace, collection, record_key,
					accepted_blob_sha256 AS blob_sha256
				FROM records
				WHERE accepted_blob_sha256 IS NOT NULL
					${cursor === undefined ? '' : 'AND (namespace, collection, record_key) > (?, ?, ?)'}
				ORDER BY namespace, collection, record_key LIMIT ${BLOB_PAGE}`,
				cursor,
			);
			if (rows.length === 0) break;
			for (const row of rows) {
				const address = {
					namespace: row.namespace,
					collection: row.collection,
					recordKey: row.record_key,
				};
				const staged = await files.stage(
					createReadStream(
						bunPortableBlobPath(portableDirectory, address, row.blob_sha256),
					) as AsyncIterable<Uint8Array>,
				);
				if (staged.digest !== row.blob_sha256) {
					throw new Error(
						'portable Restore blob digest changed after validation',
					);
				}
				await files.promote(staged, blobFileOwner(address, row.blob_sha256));
			}
			const last = rows.at(-1);
			if (last === undefined) break;
			cursor = [last.namespace, last.collection, last.record_key];
			if (rows.length < BLOB_PAGE) break;
		}

		if (nextSequence - 1 !== validated.recordCount) {
			throw new Error('portable Restore did not construct every record');
		}
		const integrity = target.all<{ integrity_check: string }>(
			'PRAGMA integrity_check',
		);
		if (
			integrity.length !== 1 ||
			integrity[0]?.integrity_check.toLowerCase() !== 'ok'
		) {
			throw new Error('constructed Restore authority failed integrity check');
		}
		targetRaw.run('PRAGMA wal_checkpoint(TRUNCATE)');
		targetRaw.close();
		targetRaw = undefined;
		await syncDirectory(temporary);
		await rename(temporary, targetDirectory);
		published = true;
		await syncDirectory(targetParent);
		return { authorityLifetime, recordCount: validated.recordCount };
	} catch (cause) {
		try {
			targetRaw?.close();
		} catch {}
		try {
			sourceRaw?.close();
		} catch {}
		if (!published) {
			await rm(temporary, { recursive: true, force: true });
		}
		throw cause;
	}
}

/** Construct one inactive authority without blocking the Bun server event loop. */
export async function constructBunAuthorityFromPortable(
	request: BunRestoreConstructionRequest,
	options: BunRestoreWorkerOptions = {},
): Promise<BunRestoreConstruction> {
	const resolvedTarget = resolve(request.targetDirectory);
	const targetName = basename(resolvedTarget);
	if (targetName.length === 0 || targetName === '.' || targetName === '..') {
		throw new Error('Restore target directory must name one authority');
	}
	const unresolvedParent = dirname(resolvedTarget);
	await mkdir(unresolvedParent, { recursive: true });
	const targetParent = await realpath(unresolvedParent);
	const targetDirectory = join(targetParent, targetName);
	const portableDirectory = await realpath(resolve(request.portableDirectory));
	const releaseClaim = await acquireRestoreClaim(targetParent, targetName);
	try {
		return await new Promise<BunRestoreConstruction>(
			(resolveResult, reject) => {
				const worker =
					options.createWorker?.() ??
					new Worker(
						new URL('./bun-restore-v1-worker.ts', import.meta.url).href,
						{ ref: true },
					);
				let settled = false;
				function finish(operation: () => void) {
					if (settled) return;
					settled = true;
					worker.terminate();
					operation();
				}
				worker.onmessage = (event: MessageEvent<BunRestoreWorkerResponse>) => {
					const response = event.data;
					if (response.ok) {
						finish(() => resolveResult(response.result));
						return;
					}
					const error = new Error(response.message);
					if (response.stack !== undefined) error.stack = response.stack;
					finish(() => reject(error));
				};
				worker.onerror = (event) => {
					finish(() => reject(new Error(event.message)));
				};
				worker.addEventListener('close', (event) => {
					if (settled) return;
					const close = event as CloseEvent;
					finish(() =>
						reject(
							new Error(
								`Restore construction worker exited before replying (${close.code})`,
							),
						),
					);
				});
				worker.postMessage({
					...request,
					portableDirectory,
					targetDirectory,
				});
			},
		);
	} finally {
		await releaseClaim();
	}
}
