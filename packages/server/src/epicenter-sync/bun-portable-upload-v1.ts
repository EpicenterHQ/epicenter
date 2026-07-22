import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

const BACKUP_ID_CHARACTERS = /^[a-z0-9]+$/u;
const SHA256_CHARACTERS = /^[a-f0-9]{64}$/u;
const MAX_UPLOAD_PART_BYTES = 64 * 1024 * 1024;
const MAX_UPLOAD_PARTS = 512;
const STREAM_CHUNK_BYTES = 64 * 1024;

const SCHEMA_STATEMENTS = [
	`CREATE TABLE portable_uploads (
		request_id TEXT PRIMARY KEY
			CHECK (length(request_id) = 24 AND request_id NOT GLOB '*[^a-z0-9]*'),
		backup_id TEXT NOT NULL UNIQUE
			CHECK (length(backup_id) = 24 AND backup_id NOT GLOB '*[^a-z0-9]*'),
		state TEXT NOT NULL
			CHECK (state IN ('uploading', 'uploaded', 'materializing', 'sealed')),
		part_count INTEGER CHECK (part_count IS NULL OR part_count BETWEEN 1 AND 512),
		record_count INTEGER
			CHECK (record_count IS NULL OR
				(record_count BETWEEN 0 AND 9007199254740991)),
		CHECK ((state = 'uploading' AND part_count IS NULL) OR
			(state != 'uploading' AND part_count IS NOT NULL)),
		CHECK ((state = 'sealed' AND record_count IS NOT NULL) OR
			(state != 'sealed' AND record_count IS NULL))
	) STRICT`,
	`CREATE TABLE portable_upload_parts (
		request_id TEXT NOT NULL REFERENCES portable_uploads(request_id)
			ON DELETE CASCADE,
		part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 512),
		byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 67108864),
		sha256 TEXT NOT NULL
			CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
		PRIMARY KEY (request_id, part_number)
	) STRICT`,
] as const;

type UploadRow = {
	request_id: string;
	backup_id: string;
	state: 'uploading' | 'uploaded' | 'materializing' | 'sealed';
	part_count: number | null;
	record_count: number | null;
};

type UploadPartRow = {
	request_id: string;
	part_number: number;
	byte_length: number;
	sha256: string;
};

export type BunPortableUploadV1 = {
	requestId: string;
	backupId: string;
	state: UploadRow['state'];
};

export type BunPortableUploadPartV1Result =
	| { kind: 'stored' }
	| { kind: 'upload-not-found' }
	| { kind: 'upload-conflict' }
	| { kind: 'invalid-upload-part' };

export type BunPortableUploadCompletionV1Result =
	| { kind: 'completed'; backup: { backupId: string; recordCount: number } }
	| { kind: 'upload-not-found' }
	| { kind: 'upload-conflict' }
	| { kind: 'invalid-upload-completion' }
	| { kind: 'invalid-portable-backup' };

type PublishedBackup = { recordCount: number };

export type BunPortableUploadMaterialize = (input: {
	backupId: string;
	bytes: ReadableStream<Uint8Array>;
}) => Promise<PublishedBackup | { invalidPortableBackup: true }>;

export type BunPortableUploadInspectPublished = (
	backupId: string,
) => Promise<PublishedBackup | undefined>;

function validateRequestId(requestId: string): void {
	if (requestId.length !== 24 || !BACKUP_ID_CHARACTERS.test(requestId)) {
		throw new TypeError(
			'portable upload request ID must be 24 lowercase alphanumeric characters',
		);
	}
}

function validatePartNumber(partNumber: number): void {
	if (
		!Number.isSafeInteger(partNumber) ||
		partNumber < 1 ||
		partNumber > MAX_UPLOAD_PARTS
	) {
		throw new RangeError(
			'portable upload part number must be between 1 and 512',
		);
	}
}

function validatePartMetadata(byteLength: number, sha256: string): void {
	if (
		!Number.isSafeInteger(byteLength) ||
		byteLength < 1 ||
		byteLength > MAX_UPLOAD_PART_BYTES
	) {
		throw new RangeError(
			'portable upload part byte length must be between 1 and 67108864',
		);
	}
	if (!SHA256_CHARACTERS.test(sha256)) {
		throw new TypeError(
			'portable upload part SHA-256 must be 64 lowercase hexadecimal characters',
		);
	}
}

function validateRecordCount(recordCount: number | null): number {
	if (!Number.isSafeInteger(recordCount) || (recordCount ?? -1) < 0) {
		throw new Error('portable Backup record count is not recognized');
	}
	return recordCount as number;
}

function mintBackupId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(12));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
		'',
	);
}

function partFileName(partNumber: number): string {
	return partNumber.toString().padStart(3, '0');
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
	const handle = await open(path, 'r');
	try {
		const buffer = new Uint8Array(STREAM_CHUNK_BYTES);
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength);
			if (bytesRead === 0) break;
			hasher.update(buffer.subarray(0, bytesRead));
		}
	} finally {
		await handle.close();
	}
	return hasher.digest('hex');
}

async function lstatIfExists(path: string) {
	return lstat(path).catch((cause: NodeJS.ErrnoException) => {
		if (cause.code === 'ENOENT') return undefined;
		throw cause;
	});
}

/**
 * Open the host-owned ledger for resumable Bun portable Backup uploads.
 *
 * The ledger and immutable part files belong to the host, not to any live
 * authority lifetime. The injected materializer owns atomic Backup publication.
 */
export function createBunPortableUploadV1Owner({
	directory,
	materialize,
	inspectPublished,
}: {
	directory: string;
	materialize: BunPortableUploadMaterialize;
	inspectPublished: BunPortableUploadInspectPublished;
}) {
	mkdirSync(directory, { recursive: true });
	const partsRoot = join(directory, 'parts');
	mkdirSync(partsRoot, { recursive: true });
	const raw = new Database(join(directory, 'control-v1.sqlite'), {
		create: true,
		strict: true,
	});
	raw.run('PRAGMA busy_timeout = 5000');
	raw.run('PRAGMA foreign_keys = ON');
	try {
		raw.run('PRAGMA journal_mode = WAL');
		raw.run('PRAGMA synchronous = FULL');
		const objects = raw
			.query<{ name: string; type: string; sql: string }, []>(
				`SELECT name, type, sql FROM sqlite_schema
				WHERE name NOT LIKE 'sqlite_%'
				ORDER BY type, name`,
			)
			.all();
		if (objects.length === 0) {
			raw.transaction(() => {
				for (const statement of SCHEMA_STATEMENTS) raw.run(statement);
			})();
		} else if (
			objects.length !== SCHEMA_STATEMENTS.length ||
			objects.some(
				(object) =>
					object.type !== 'table' ||
					!SCHEMA_STATEMENTS.some((statement) => statement === object.sql),
			)
		) {
			throw new Error('Bun portable upload control schema is not recognized');
		}
	} catch (cause) {
		raw.close();
		throw cause;
	}

	let closed = false;
	let operationTail = Promise.resolve();

	function readUpload(requestId: string): UploadRow | undefined {
		return (
			raw
				.query<UploadRow, [string]>(
					`SELECT request_id, backup_id, state, part_count, record_count
				FROM portable_uploads WHERE request_id = ?`,
				)
				.get(requestId) ?? undefined
		);
	}

	function readPart(
		requestId: string,
		partNumber: number,
	): UploadPartRow | undefined {
		return (
			raw
				.query<UploadPartRow, [string, number]>(
					`SELECT request_id, part_number, byte_length, sha256
				FROM portable_upload_parts
				WHERE request_id = ? AND part_number = ?`,
				)
				.get(requestId, partNumber) ?? undefined
		);
	}

	function uploadResult(upload: UploadRow): BunPortableUploadV1 {
		return {
			requestId: upload.request_id,
			backupId: upload.backup_id,
			state: upload.state,
		};
	}

	function partDirectory(requestId: string): string {
		return join(partsRoot, requestId);
	}

	function partPath(requestId: string, partNumber: number): string {
		return join(partDirectory(requestId), partFileName(partNumber));
	}

	async function deletePartFiles(requestId: string): Promise<void> {
		await rm(partDirectory(requestId), { recursive: true, force: true });
		await syncDirectory(partsRoot);
		raw
			.query('DELETE FROM portable_upload_parts WHERE request_id = ?')
			.run(requestId);
	}

	async function publishUpload(
		upload: UploadRow,
		published: PublishedBackup,
	): Promise<{ backupId: string; recordCount: number }> {
		const recordCount = validateRecordCount(published.recordCount);
		raw
			.query(
				`UPDATE portable_uploads
				SET state = 'sealed', record_count = ?
				WHERE request_id = ? AND state = 'materializing'`,
			)
			.run(recordCount, upload.request_id);
		await deletePartFiles(upload.request_id);
		return { backupId: upload.backup_id, recordCount };
	}

	async function recoverMaterializing(
		upload: UploadRow,
	): Promise<{ backupId: string; recordCount: number } | undefined> {
		const published = await inspectPublished(upload.backup_id);
		if (published !== undefined) return publishUpload(upload, published);
		raw
			.query(
				`UPDATE portable_uploads SET state = 'uploaded', record_count = NULL
				WHERE request_id = ? AND state = 'materializing'`,
			)
			.run(upload.request_id);
		return undefined;
	}

	async function sweepPartDebris(): Promise<void> {
		const uploads = raw
			.query<UploadRow, []>(
				`SELECT request_id, backup_id, state, part_count, record_count
				FROM portable_uploads`,
			)
			.all();
		const knownUploads = new Set(uploads.map((upload) => upload.request_id));
		for (const entry of await readdir(partsRoot, { withFileTypes: true })) {
			const requestDirectory = join(partsRoot, entry.name);
			if (!entry.isDirectory() || !knownUploads.has(entry.name)) {
				await rm(requestDirectory, { recursive: true, force: true });
				continue;
			}
			const knownParts = new Set(
				raw
					.query<{ part_number: number }, [string]>(
						`SELECT part_number FROM portable_upload_parts
						WHERE request_id = ?`,
					)
					.all(entry.name)
					.map((part) => partFileName(part.part_number)),
			);
			for (const part of await readdir(requestDirectory, {
				withFileTypes: true,
			})) {
				if (!part.isFile() || !knownParts.has(part.name)) {
					await rm(join(requestDirectory, part.name), {
						recursive: true,
						force: true,
					});
				}
			}
		}
		await syncDirectory(partsRoot);
	}

	const ready = (async () => {
		await sweepPartDebris();
		const interrupted = raw
			.query<UploadRow, []>(
				`SELECT request_id, backup_id, state, part_count, record_count
				FROM portable_uploads WHERE state = 'materializing'`,
			)
			.all();
		for (const upload of interrupted) await recoverMaterializing(upload);
		const sealed = raw
			.query<{ request_id: string }, []>(
				`SELECT request_id FROM portable_uploads WHERE state = 'sealed'`,
			)
			.all();
		for (const upload of sealed) await deletePartFiles(upload.request_id);
	})();

	function exclusive<TResult>(
		operation: () => Promise<TResult>,
	): Promise<TResult> {
		if (closed) {
			return Promise.reject(new Error('Bun portable upload owner is closed'));
		}
		const result = operationTail.then(async () => {
			await ready;
			return operation();
		});
		operationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	function createUpload(requestId: string): Promise<BunPortableUploadV1> {
		validateRequestId(requestId);
		return exclusive(async () => {
			const prior = readUpload(requestId);
			if (prior !== undefined) return uploadResult(prior);
			let backupId = mintBackupId();
			while (
				raw
					.query<{ found: number }, [string]>(
						'SELECT 1 AS found FROM portable_uploads WHERE backup_id = ?',
					)
					.get(backupId) !== null
			) {
				backupId = mintBackupId();
			}
			raw
				.query(
					`INSERT INTO portable_uploads
					(request_id, backup_id, state, part_count, record_count)
					VALUES (?, ?, 'uploading', NULL, NULL)`,
				)
				.run(requestId, backupId);
			const created = readUpload(requestId);
			if (created === undefined) {
				throw new Error('Bun portable upload creation was not durable');
			}
			return uploadResult(created);
		});
	}

	function putUploadPart(
		requestId: string,
		partNumber: number,
		byteLength: number,
		sha256: string,
		bytes: ReadableStream<Uint8Array>,
	): Promise<BunPortableUploadPartV1Result> {
		validateRequestId(requestId);
		validatePartNumber(partNumber);
		validatePartMetadata(byteLength, sha256);
		return exclusive(async () => {
			const upload = readUpload(requestId);
			if (upload === undefined) return { kind: 'upload-not-found' };
			if (upload.state === 'materializing' || upload.state === 'sealed') {
				return { kind: 'upload-conflict' };
			}
			const prior = readPart(requestId, partNumber);
			if (
				prior !== undefined &&
				(prior.byte_length !== byteLength || prior.sha256 !== sha256)
			) {
				return { kind: 'upload-conflict' };
			}
			if (prior === undefined && upload.state !== 'uploading') {
				return { kind: 'upload-conflict' };
			}
			const publishedPath = partPath(requestId, partNumber);
			if (prior !== undefined) {
				const info = await lstatIfExists(publishedPath);
				if (
					info?.isFile() &&
					!info.isSymbolicLink() &&
					info.size === byteLength &&
					(await hashFile(publishedPath)) === sha256
				) {
					return { kind: 'stored' };
				}
			}

			const targetDirectory = partDirectory(requestId);
			await mkdir(targetDirectory, { recursive: true });
			const temporaryPath = join(
				targetDirectory,
				`.${partFileName(partNumber)}.${crypto.randomUUID()}.part`,
			);
			const handle = await open(temporaryPath, 'wx');
			const hasher = new Bun.CryptoHasher('sha256');
			const reader = bytes.getReader();
			let actualLength = 0;
			let valid = false;
			try {
				try {
					for (;;) {
						const chunk = await reader.read();
						if (chunk.done) break;
						actualLength += chunk.value.byteLength;
						if (actualLength > byteLength) break;
						hasher.update(chunk.value);
						let offset = 0;
						while (offset < chunk.value.byteLength) {
							const written = await handle.write(
								chunk.value,
								offset,
								chunk.value.byteLength - offset,
							);
							if (written.bytesWritten === 0) {
								throw new Error('portable upload part write made no progress');
							}
							offset += written.bytesWritten;
						}
					}
					valid =
						actualLength === byteLength && hasher.digest('hex') === sha256;
					if (valid) await handle.sync();
				} finally {
					if (!valid) await reader.cancel().catch(() => undefined);
					await handle.close();
				}
			} catch (cause) {
				await rm(temporaryPath, { force: true });
				throw cause;
			}
			if (!valid) {
				await rm(temporaryPath, { force: true });
				return { kind: 'invalid-upload-part' };
			}
			try {
				await rm(publishedPath, { force: true });
				await rename(temporaryPath, publishedPath);
				await syncDirectory(targetDirectory);
				if (prior === undefined) {
					raw
						.query(
							`INSERT INTO portable_upload_parts
							(request_id, part_number, byte_length, sha256)
							VALUES (?, ?, ?, ?)`,
						)
						.run(requestId, partNumber, byteLength, sha256);
				}
			} catch (cause) {
				await rm(temporaryPath, { force: true });
				if (prior === undefined) await rm(publishedPath, { force: true });
				throw cause;
			}
			return { kind: 'stored' };
		});
	}

	function validateOrderedParts(
		requestId: string,
		rawOrderedParts: unknown,
	):
		| UploadPartRow[]
		| { kind: 'invalid-upload-completion' }
		| { kind: 'upload-conflict' } {
		if (
			!Array.isArray(rawOrderedParts) ||
			rawOrderedParts.length === 0 ||
			rawOrderedParts.length > MAX_UPLOAD_PARTS
		) {
			return { kind: 'invalid-upload-completion' };
		}
		for (const [index, partNumber] of rawOrderedParts.entries()) {
			if (partNumber !== index + 1) {
				return { kind: 'invalid-upload-completion' };
			}
		}
		const stored = raw
			.query<UploadPartRow, [string]>(
				`SELECT request_id, part_number, byte_length, sha256
				FROM portable_upload_parts WHERE request_id = ?
				ORDER BY part_number`,
			)
			.all(requestId);
		if (
			stored.length !== rawOrderedParts.length ||
			stored.some((part, index) => part.part_number !== rawOrderedParts[index])
		) {
			return { kind: 'upload-conflict' };
		}
		return stored;
	}

	async function validateStoredParts(
		parts: readonly UploadPartRow[],
	): Promise<boolean> {
		for (const part of parts) {
			const path = partPath(part.request_id, part.part_number);
			const info = await lstatIfExists(path);
			if (
				!info?.isFile() ||
				info.isSymbolicLink() ||
				info.size !== part.byte_length ||
				(await hashFile(path)) !== part.sha256
			) {
				return false;
			}
		}
		return true;
	}

	function openUploadBytes(parts: readonly UploadPartRow[]): {
		bytes: ReadableStream<Uint8Array>;
		close(): Promise<void>;
	} {
		let partIndex = 0;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		let offset = 0;
		async function close(): Promise<void> {
			await handle?.close();
			handle = undefined;
		}
		const bytes = new ReadableStream<Uint8Array>({
			async pull(controller) {
				for (;;) {
					const part = parts[partIndex];
					if (part === undefined) {
						await handle?.close();
						handle = undefined;
						controller.close();
						return;
					}
					if (handle === undefined) {
						handle = await open(
							partPath(part.request_id, part.part_number),
							'r',
						);
						offset = 0;
					}
					const buffer = new Uint8Array(
						Math.min(STREAM_CHUNK_BYTES, part.byte_length - offset),
					);
					const { bytesRead } = await handle.read(
						buffer,
						0,
						buffer.byteLength,
						offset,
					);
					if (bytesRead === 0) {
						await handle.close();
						handle = undefined;
						partIndex += 1;
						continue;
					}
					offset += bytesRead;
					controller.enqueue(buffer.subarray(0, bytesRead));
					return;
				}
			},
			cancel: close,
		});
		return { bytes, close };
	}

	function completeUpload(
		requestId: string,
		rawOrderedParts: unknown,
	): Promise<BunPortableUploadCompletionV1Result> {
		validateRequestId(requestId);
		return exclusive(async () => {
			let upload = readUpload(requestId);
			if (upload === undefined) return { kind: 'upload-not-found' };
			if (upload.state === 'sealed') {
				await deletePartFiles(upload.request_id);
				return {
					kind: 'completed',
					backup: {
						backupId: upload.backup_id,
						recordCount: validateRecordCount(upload.record_count),
					},
				};
			}
			if (upload.state === 'materializing') {
				const recovered = await recoverMaterializing(upload);
				if (recovered !== undefined) {
					return { kind: 'completed', backup: recovered };
				}
				upload = { ...upload, state: 'uploaded' };
			}
			const parts = validateOrderedParts(requestId, rawOrderedParts);
			if (!Array.isArray(parts)) return parts;
			if (!(await validateStoredParts(parts))) {
				return { kind: 'upload-conflict' };
			}
			if (upload.state === 'uploading') {
				raw
					.query(
						`UPDATE portable_uploads SET state = 'uploaded', part_count = ?
						WHERE request_id = ? AND state = 'uploading'`,
					)
					.run(parts.length, requestId);
			} else if (upload.part_count !== parts.length) {
				return { kind: 'upload-conflict' };
			}
			raw
				.query(
					`UPDATE portable_uploads SET state = 'materializing'
					WHERE request_id = ? AND state = 'uploaded'`,
				)
				.run(requestId);
			const materializing = {
				...upload,
				state: 'materializing',
				part_count: parts.length,
			} satisfies UploadRow;
			const uploadSource = openUploadBytes(parts);
			try {
				let result: Awaited<ReturnType<BunPortableUploadMaterialize>>;
				try {
					result = await materialize({
						backupId: upload.backup_id,
						bytes: uploadSource.bytes,
					});
				} finally {
					await uploadSource.close();
				}
				const published = await inspectPublished(upload.backup_id);
				if (published !== undefined) {
					if (
						!('invalidPortableBackup' in result) &&
						result.recordCount !== published.recordCount
					) {
						throw new Error(
							'portable materializer record count is inconsistent',
						);
					}
					return {
						kind: 'completed',
						backup: await publishUpload(materializing, published),
					};
				}
				if ('invalidPortableBackup' in result) {
					raw
						.query(
							`UPDATE portable_uploads SET state = 'uploaded'
							WHERE request_id = ? AND state = 'materializing'`,
						)
						.run(requestId);
					return { kind: 'invalid-portable-backup' };
				}
				throw new Error('portable materializer did not publish its Backup');
			} catch (cause) {
				try {
					const recovered = await recoverMaterializing(materializing);
					if (recovered !== undefined) {
						return { kind: 'completed', backup: recovered };
					}
				} catch (reconciliationCause) {
					throw new AggregateError(
						[cause, reconciliationCause],
						'portable upload materialization outcome is indeterminate',
					);
				}
				throw cause;
			}
		});
	}

	function deleteUpload(requestId: string): Promise<boolean> {
		validateRequestId(requestId);
		return exclusive(async () => {
			const upload = readUpload(requestId);
			if (upload === undefined || upload.state === 'sealed') return false;
			await deletePartFiles(requestId);
			raw
				.query('DELETE FROM portable_uploads WHERE request_id = ?')
				.run(requestId);
			return true;
		});
	}

	async function close(): Promise<void> {
		if (closed) return;
		closed = true;
		await ready;
		await operationTail;
		raw.close();
	}

	return {
		createUpload,
		putUploadPart,
		completeUpload,
		deleteUpload,
		close,
	};
}

export type BunPortableUploadV1Owner = ReturnType<
	typeof createBunPortableUploadV1Owner
>;
