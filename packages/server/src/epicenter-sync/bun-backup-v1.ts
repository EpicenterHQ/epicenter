import { Database } from 'bun:sqlite';
import { createReadStream } from 'node:fs';
import {
	link,
	lstat,
	mkdir,
	open,
	opendir,
	readdir,
	rename,
	rm,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { blobFileOwner } from '@epicenter/data/blob-v1';
import type { BunBlobRead } from '@epicenter/data/bun';
import {
	scanPortableArtifactIndex,
	writePortableArtifactIndex,
} from '@epicenter/data/portable';
import type { SqliteRow } from '@epicenter/sqlite';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import type { AuthorityBlobV1 } from './blob-authority-v1.js';
import { createBunPortableTarMaterializer } from './bun-portable-tar-v1.js';
import { createBunPortableUploadV1Owner } from './bun-portable-upload-v1.js';
import type { createAuthorityCaptureManifestV1 } from './capture-manifest-v1.js';
import { waitForPortableMaterializerResponse } from './portable-tar-materializer.js';

const BACKUP_ID_CHARACTERS = /^[a-z0-9]+$/u;
const INDEX_FILE = 'epicenter.sqlite';
const BLOBS_DIRECTORY = 'blobs';
const MAX_CAPTURE_MILLISECONDS = 30 * 60 * 1_000;

type CaptureManifests = ReturnType<typeof createAuthorityCaptureManifestV1>;
type BunAuthorityBlobs = AuthorityBlobV1<
	AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
	BunBlobRead
>;

export type BunBackupV1CaptureSource = {
	captures: CaptureManifests;
	blobs: BunAuthorityBlobs;
};

export type BunBackup = {
	backupId: string;
	directory: string;
	recordCount: number;
};

function isBackupId(backupId: string): boolean {
	return backupId.length === 24 && BACKUP_ID_CHARACTERS.test(backupId);
}

function validateBackupId(backupId: string): void {
	if (!isBackupId(backupId)) {
		throw new TypeError(
			'backup ID must be 24 lowercase alphanumeric characters',
		);
	}
}

function mintBackupId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(12));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
		'',
	);
}

export function bunPortableBlobPath(
	directory: string,
	address: Parameters<typeof blobFileOwner>[0],
	digest: string,
): string {
	const owner = blobFileOwner(address, digest);
	return join(directory, BLOBS_DIRECTORY, owner.ownerKey, owner.digest);
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, 'r');
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function hashFile(path: string): Promise<string> {
	const hasher = new Bun.CryptoHasher('sha256');
	for await (const chunk of createReadStream(path)) hasher.update(chunk);
	return hasher.digest('hex');
}

async function copyPinnedBlob(
	read: BunBlobRead,
	path: string,
	digest: string,
): Promise<void> {
	const parent = dirname(path);
	await mkdir(parent, { recursive: true });
	const handle = await open(path, 'wx');
	const hasher = new Bun.CryptoHasher('sha256');
	try {
		const reader = read.getReader();
		let completed = false;
		try {
			for (;;) {
				const result = await reader.read();
				if (result.done) {
					completed = true;
					break;
				}
				hasher.update(result.value);
				let offset = 0;
				while (offset < result.value.byteLength) {
					const written = await handle.write(
						result.value,
						offset,
						result.value.byteLength - offset,
					);
					if (written.bytesWritten === 0) {
						throw new Error('portable blob copy made no progress');
					}
					offset += written.bytesWritten;
				}
			}
		} finally {
			if (!completed) await reader.cancel();
			reader.releaseLock();
		}
		await handle.sync();
	} finally {
		await handle.close();
	}
	if (hasher.digest('hex') !== digest) {
		throw new Error('portable blob bytes do not match their digest');
	}
	await syncDirectory(parent);
	await syncDirectory(dirname(parent));
}

async function countPortableBlobFiles(directory: string): Promise<number> {
	const root = join(directory, BLOBS_DIRECTORY);
	let count = 0;
	const owners = await opendir(root);
	for await (const owner of owners) {
		if (!owner.isDirectory() || !/^[a-f0-9]{64}$/.test(owner.name)) {
			throw new Error('portable artifact contains an unexpected blob entry');
		}
		const ownerRoot = join(root, owner.name);
		let ownerFiles = 0;
		const blobs = await opendir(ownerRoot);
		for await (const blob of blobs) {
			if (!blob.isFile() || !/^[a-f0-9]{64}$/.test(blob.name)) {
				throw new Error('portable artifact contains an unexpected blob entry');
			}
			ownerFiles += 1;
			count += 1;
		}
		if (ownerFiles === 0) {
			throw new Error('portable artifact contains an unexpected blob entry');
		}
	}
	return count;
}

/** Validate one complete directory-form portable Epicenter, including blobs. */
export async function validateBunPortableDirectory(
	directory: string,
): Promise<{ recordCount: number }> {
	const topLevel = await readdir(directory, { withFileTypes: true });
	const names = topLevel.map((entry) => entry.name).sort();
	if (
		names.length !== 2 ||
		names[0] !== BLOBS_DIRECTORY ||
		names[1] !== INDEX_FILE ||
		!topLevel.find((entry) => entry.name === BLOBS_DIRECTORY)?.isDirectory() ||
		!topLevel.find((entry) => entry.name === INDEX_FILE)?.isFile()
	) {
		throw new Error('portable artifact directory shape is not recognized');
	}

	const raw = new Database(join(directory, INDEX_FILE), {
		readonly: true,
		strict: true,
	});
	let expectedBlobCount = 0;
	let metadata: { recordCount: number };
	try {
		const database = createBunSqliteAdapter(raw);
		metadata = scanPortableArtifactIndex({
			database,
			onPage(page) {
				for (const record of page) {
					if (record.blobSha256 !== null) expectedBlobCount += 1;
				}
			},
		});

		type BlobRow = SqliteRow & {
			namespace: string;
			collection: string;
			record_key: string;
			blob_sha256: string;
		};
		let cursor: [string, string, string] | undefined;
		for (;;) {
			const rows = database.all<BlobRow>(
				`SELECT namespace, collection, record_key, blob_sha256
				FROM _epicenter_records
				WHERE blob_sha256 IS NOT NULL
					${cursor === undefined ? '' : 'AND (namespace, collection, record_key) > (?, ?, ?)'}
				ORDER BY namespace, collection, record_key LIMIT 16`,
				cursor,
			);
			if (rows.length === 0) break;
			for (const row of rows) {
				const path = bunPortableBlobPath(
					directory,
					{
						namespace: row.namespace,
						collection: row.collection,
						recordKey: row.record_key,
					},
					row.blob_sha256,
				);
				const info = await lstat(path).catch(() => undefined);
				if (info === undefined || !info.isFile() || info.isSymbolicLink()) {
					throw new Error('portable artifact blob membership is incomplete');
				}
				if ((await hashFile(path)) !== row.blob_sha256) {
					throw new Error('portable artifact blob digest verification failed');
				}
			}
			const last = rows.at(-1);
			if (last === undefined) break;
			cursor = [last.namespace, last.collection, last.record_key];
			if (rows.length < 16) break;
		}
	} finally {
		raw.close();
	}

	const actualBlobCount = await countPortableBlobFiles(directory);
	if (actualBlobCount !== expectedBlobCount) {
		throw new Error('portable artifact blob membership is incomplete');
	}
	return { recordCount: metadata.recordCount };
}

async function sweepDebris(backupsRoot: string): Promise<void> {
	await mkdir(backupsRoot, { recursive: true });
	for (const entry of await readdir(backupsRoot, { withFileTypes: true })) {
		if (entry.name.startsWith('.') && entry.isDirectory()) {
			await rm(join(backupsRoot, entry.name), { recursive: true, force: true });
		}
	}
}

async function createDownloadSnapshot(
	sourceDirectory: string,
	targetDirectory: string,
): Promise<void> {
	try {
		await mkdir(join(targetDirectory, BLOBS_DIRECTORY), { recursive: true });
		await link(
			join(sourceDirectory, INDEX_FILE),
			join(targetDirectory, INDEX_FILE),
		);
		for await (const owner of await opendir(
			join(sourceDirectory, BLOBS_DIRECTORY),
		)) {
			if (!owner.isDirectory()) {
				throw new Error('portable Backup blob owner is not a directory');
			}
			const sourceOwner = join(sourceDirectory, BLOBS_DIRECTORY, owner.name);
			const targetOwner = join(targetDirectory, BLOBS_DIRECTORY, owner.name);
			await mkdir(targetOwner);
			for await (const blob of await opendir(sourceOwner)) {
				if (!blob.isFile()) {
					throw new Error('portable Backup blob is not a regular file');
				}
				await link(join(sourceOwner, blob.name), join(targetOwner, blob.name));
			}
		}
	} catch (cause) {
		await rm(targetDirectory, { recursive: true, force: true });
		throw cause;
	}
}

/** Host-owned Bun Backup registry over immutable portable directories. */
export function createBunBackupV1Owner({
	backupsRoot,
	uploadsRoot,
}: {
	backupsRoot: string;
	uploadsRoot: string;
}) {
	const ready = sweepDebris(backupsRoot);
	const operations = new Set<Promise<unknown>>();
	const activeDownloads = new Map<
		string,
		Set<(reason: unknown) => Promise<void>>
	>();
	let operationTail = Promise.resolve();
	let closed = false;

	function track<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
		if (closed) return Promise.reject(new Error('Bun Backup owner is closed'));
		const result = operationTail.then(operation);
		operationTail = result.then(
			() => undefined,
			() => undefined,
		);
		operations.add(result);
		void result.finally(() => operations.delete(result)).catch(() => undefined);
		return result;
	}

	async function createBackup({
		captures,
		blobs,
	}: BunBackupV1CaptureSource): Promise<BunBackup> {
		await ready;
		const backupId = mintBackupId();
		const temporary = join(
			backupsRoot,
			`.${backupId}.capture-${crypto.randomUUID()}`,
		);
		const published = join(backupsRoot, backupId);
		let renamed = false;
		let publishedBackup: BunBackup | undefined;
		captures.start(backupId);
		try {
			const captureDeadline = Date.now() + MAX_CAPTURE_MILLISECONDS;
			let sealed:
				| Extract<ReturnType<typeof captures.seal>, { kind: 'sealed' }>
				| undefined;
			while (Date.now() < captureDeadline) {
				const progress = captures.advance(backupId);
				if (progress.kind === 'document-not-settled') {
					throw new Error(
						`portable capture document is not settled: ${progress.address.namespace}/${progress.address.collection}/${progress.address.recordKey}`,
					);
				}
				if (progress.caughtUp) {
					const outcome = captures.seal(backupId);
					if (outcome.kind === 'document-not-settled') {
						throw new Error('portable capture document is not settled');
					}
					if (outcome.kind === 'sealed') {
						sealed = outcome;
						break;
					}
				}
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			if (sealed === undefined) {
				throw new Error('portable capture could not reach a bounded final cut');
			}

			await mkdir(join(temporary, BLOBS_DIRECTORY), { recursive: true });
			const raw = new Database(join(temporary, INDEX_FILE), {
				create: true,
				strict: true,
			});
			try {
				const records = function* () {
					let after = 0;
					for (;;) {
						const page = captures.readPage(backupId, after);
						yield* page.entries;
						if (page.nextAfterRecordId === undefined) return;
						after = page.nextAfterRecordId;
					}
				};
				writePortableArtifactIndex({
					database: createBunSqliteAdapter(raw),
					records: records(),
				});
			} finally {
				raw.close();
			}

			let after = 0;
			for (;;) {
				const page = captures.readPage(backupId, after);
				for (const record of page.entries) {
					if (record.blobSha256 === null) continue;
					const read = await blobs.readCapture(
						backupId,
						record.address,
						record.blobSha256,
					);
					if (read === undefined) {
						throw new Error('portable capture blob pin is missing');
					}
					await copyPinnedBlob(
						read,
						bunPortableBlobPath(temporary, record.address, record.blobSha256),
						record.blobSha256,
					);
				}
				if (page.nextAfterRecordId === undefined) break;
				after = page.nextAfterRecordId;
			}

			const validated = await validateBunPortableDirectory(temporary);
			publishedBackup = {
				backupId,
				directory: published,
				recordCount: validated.recordCount,
			};
			await syncDirectory(temporary);
			await rename(temporary, published);
			renamed = true;
			await syncDirectory(backupsRoot);
			captures.finish(backupId, 'succeeded');
			return publishedBackup;
		} catch (cause) {
			if (!renamed) {
				await rm(temporary, { recursive: true, force: true });
				try {
					captures.finish(backupId, 'cancelled');
				} catch {
					// Reopen recovery owns an interrupted manifest if cancellation failed.
				}
			} else {
				try {
					await syncDirectory(backupsRoot);
					captures.finish(backupId, 'succeeded');
					if (publishedBackup === undefined) throw cause;
					return publishedBackup;
				} catch {
					try {
						captures.finish(backupId, 'crashed');
					} catch {
						// Reopen recovery owns the manifest after repeated storage failure.
					}
				}
			}
			throw cause;
		}
	}

	async function listBackups(): Promise<BunBackup[]> {
		await ready;
		const backups: BunBackup[] = [];
		for (const entry of await readdir(backupsRoot, { withFileTypes: true })) {
			if (!entry.isDirectory() || !isBackupId(entry.name)) continue;
			const directory = join(backupsRoot, entry.name);
			const validation = await validateBunPortableDirectory(directory);
			backups.push({
				backupId: entry.name,
				directory,
				recordCount: validation.recordCount,
			});
		}
		return backups.sort((left, right) =>
			left.backupId.localeCompare(right.backupId),
		);
	}

	async function getBackup(backupId: string): Promise<BunBackup | undefined> {
		await ready;
		validateBackupId(backupId);
		const directory = join(backupsRoot, basename(backupId));
		const entry = await lstat(directory).catch((cause) => {
			if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
			throw cause;
		});
		if (entry === undefined) return undefined;
		if (!entry.isDirectory() || entry.isSymbolicLink()) return undefined;
		const validation = await validateBunPortableDirectory(directory);
		return { backupId, directory, recordCount: validation.recordCount };
	}

	function leaseDownload(
		backupId: string,
		response: Response,
		settled: Promise<void>,
		cleanup: () => Promise<void>,
	): Response {
		if (response.body === null) {
			void cleanup();
			return response;
		}
		const active =
			activeDownloads.get(backupId) ??
			new Set<(reason: unknown) => Promise<void>>();
		activeDownloads.set(backupId, active);
		const reader = response.body.getReader();
		const pulls = new Set<Promise<void>>();
		let outwardController:
			| ReadableStreamDefaultController<Uint8Array>
			| undefined;
		let cancellationRequested = false;
		let released = false;
		let cleanupPromise: Promise<void> | undefined;
		function clean(): Promise<void> {
			cleanupPromise ??= cleanup();
			return cleanupPromise;
		}
		let cancel!: (reason: unknown) => Promise<void>;
		function release(): void {
			if (released) return;
			released = true;
			reader.releaseLock();
			active.delete(cancel);
			if (active.size === 0) activeDownloads.delete(backupId);
		}
		cancel = async (reason) => {
			if (released) return;
			cancellationRequested = true;
			try {
				outwardController?.error(reason);
			} catch {
				// Consumer cancellation may already have closed the outward stream.
			}
			try {
				await reader.cancel(reason);
			} finally {
				try {
					await Promise.allSettled([...pulls]);
					await settled;
					await clean();
				} finally {
					release();
				}
			}
		};
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					outwardController = controller;
				},
				pull(controller) {
					const pulling = (async () => {
						try {
							const chunk = await reader.read();
							if (cancellationRequested) return;
							if (chunk.done) {
								await settled;
								await clean();
								controller.close();
								release();
							} else {
								controller.enqueue(chunk.value);
							}
						} catch (cause) {
							if (!cancellationRequested) {
								await clean().catch(() => undefined);
								release();
								controller.error(cause);
							}
						}
					})();
					pulls.add(pulling);
					void pulling.finally(() => pulls.delete(pulling));
					return pulling;
				},
				cancel,
			}),
			{
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			},
		);
	}

	async function cancelDownloads(backupId: string): Promise<void> {
		const active = activeDownloads.get(backupId);
		if (active === undefined) return;
		await Promise.all(
			[...active].map((cancel) =>
				cancel(new Error('Backup download was cancelled by deletion')),
			),
		);
	}

	async function cancelAllDownloads(): Promise<void> {
		await Promise.all(
			[...activeDownloads.keys()].map((backupId) => cancelDownloads(backupId)),
		);
	}

	async function downloadBackup(
		backupId: string,
	): Promise<Response | undefined> {
		const backup = await getBackup(backupId);
		if (backup === undefined) return undefined;
		const snapshot = join(
			backupsRoot,
			`.${backupId}.download-${crypto.randomUUID()}`,
		);
		await createDownloadSnapshot(backup.directory, snapshot);
		try {
			const response = await createBunPortableTarMaterializer({
				exportDirectory: snapshot,
			})(new Request('http://epicenter.internal/export', { method: 'POST' }));
			return leaseDownload(
				backupId,
				response,
				waitForPortableMaterializerResponse(response),
				() => rm(snapshot, { recursive: true, force: true }),
			);
		} catch (cause) {
			await rm(snapshot, { recursive: true, force: true });
			throw cause;
		}
	}

	async function inspectUploadedBackup(
		backupId: string,
	): Promise<{ recordCount: number } | undefined> {
		const backup = await getBackup(backupId);
		return backup === undefined
			? undefined
			: { recordCount: backup.recordCount };
	}

	async function materializeUpload({
		backupId,
		bytes,
	}: {
		backupId: string;
		bytes: ReadableStream<Uint8Array>;
	}) {
		validateBackupId(backupId);
		const temporaryDirectory = join(
			backupsRoot,
			`.${backupId}.import-${crypto.randomUUID()}`,
		);
		const publishedDirectory = join(backupsRoot, backupId);
		const response = await createBunPortableTarMaterializer({
			importTarget: { temporaryDirectory, publishedDirectory },
		})(
			new Request('http://epicenter.internal/import', {
				method: 'POST',
				body: bytes,
			}),
		);
		if (response.status === 400)
			return { invalidPortableBackup: true } as const;
		if (response.status !== 204) {
			throw new Error(`portable Bun Backup import failed (${response.status})`);
		}
		return validateBunPortableDirectory(publishedDirectory);
	}

	const uploads = createBunPortableUploadV1Owner({
		directory: uploadsRoot,
		materialize: materializeUpload,
		inspectPublished: inspectUploadedBackup,
	});

	async function deleteBackup(backupId: string): Promise<boolean> {
		await ready;
		validateBackupId(backupId);
		await cancelDownloads(backupId);
		try {
			await rm(join(backupsRoot, basename(backupId)), {
				recursive: true,
				force: false,
			});
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
			throw cause;
		}
		await syncDirectory(backupsRoot);
		return true;
	}

	return Object.freeze({
		create: (source: BunBackupV1CaptureSource) =>
			track(() => createBackup(source)),
		list: () => track(listBackups),
		get: (backupId: string) => track(() => getBackup(backupId)),
		download: (backupId: string) => track(() => downloadBackup(backupId)),
		createUpload: (requestId: string) =>
			track(() => uploads.createUpload(requestId)),
		putUploadPart: (
			requestId: string,
			partNumber: number,
			byteLength: number,
			sha256: string,
			bytes: ReadableStream<Uint8Array>,
		) =>
			track(() =>
				uploads.putUploadPart(requestId, partNumber, byteLength, sha256, bytes),
			),
		completeUpload: (requestId: string, parts: unknown) =>
			track(() => uploads.completeUpload(requestId, parts)),
		deleteUpload: (requestId: string) =>
			track(() => uploads.deleteUpload(requestId)),
		delete: (backupId: string) => track(() => deleteBackup(backupId)),
		async close(): Promise<void> {
			closed = true;
			const results = await Promise.allSettled([ready, ...operations]);
			const shutdown = await Promise.allSettled([
				cancelAllDownloads(),
				uploads.close(),
			]);
			const failures = results
				.concat(shutdown)
				.filter(
					(result): result is PromiseRejectedResult =>
						result.status === 'rejected',
				)
				.map((result) => result.reason);
			if (failures.length > 0) {
				throw new AggregateError(failures, 'Bun Backup operations failed');
			}
		},
	});
}

export type BunBackupV1Owner = ReturnType<typeof createBunBackupV1Owner>;
