import {
	mkdir,
	mkdtemp,
	open,
	readFile,
	rename,
	rm,
	stat,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { type } from 'arktype';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type BlobId } from './blob-id.js';
import { parseBlobStorageId } from './attachment-key.js';
import { sameAttachmentContent } from './attachment-content.js';
import {
	type BlobAlreadyExists,
	type AttachmentContent,
	AttachmentTransferError,
	type BlobNotFound,
	type BlobStat,
	type BlobStore,
	BlobStoreError,
	type BlobStoreFailed,
} from './blob-store.js';

const DATA_FILE = 'data';
const METADATA_FILE = 'metadata.json';
const STAGING_DIRECTORY = '.staging';
const BUN_STAGING_DIRECTORY = 'bun';
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

type StoredMetadata = {
	size: number;
	contentType: string;
	attachment?: AttachmentContent & { originGeneration?: number | null };
};

/**
 * Parse on-disk metadata at the JSON boundary: `metadata.json` is untrusted
 * input like any file, so its shape is established here rather than asserted
 * downstream.
 */
const StoredMetadata = type({
	contentType: 'string',
	size: 'number',
	'attachment?': {
		sha256: /^[a-f0-9]{64}$/,
		size: 'number.integer >= 0',
		contentType: 'string',
		'originGeneration?': 'number.integer >= 0 | null',
	},
}).narrow(
	(metadata) =>
		Object.keys(metadata).every((key) =>
			['size', 'contentType', 'attachment'].includes(key),
		) &&
		Number.isSafeInteger(metadata.size) &&
		metadata.size >= 0 &&
		normalizeContentType(metadata.contentType) === metadata.contentType,
);

type BlobReadError = BlobNotFound | BlobStoreFailed;

type PutData = Blob | Request | Response;

/**
 * Bun's filesystem-backed local blob store.
 *
 * Each immutable blob is published by renaming a complete staged directory
 * into the global store. Readers therefore see either no object or both its
 * body and metadata, never a partially written object.
 */
export function createBunBlobStore({ directory }: { directory: string }) {
	const stagingDirectory = join(
		directory,
		STAGING_DIRECTORY,
		BUN_STAGING_DIRECTORY,
	);

	function validateId(id: BlobId): Result<BlobId, BlobStoreFailed> {
		const parsed = parseBlobStorageId(id);
		if (parsed !== undefined) return Ok(parsed);
		return BlobStoreError.BlobStoreFailed({
			id,
			cause: new Error('Invalid BlobId reached the Bun blob store.'),
		});
	}

	function blobDirectory(id: BlobId): string {
		return join(directory, id);
	}

	async function readMetadata(
		id: BlobId,
	): Promise<Result<StoredMetadata, BlobReadError>> {
		const objectDirectory = blobDirectory(id);
		try {
			const metadata = StoredMetadata(
				JSON.parse(
					await readFile(join(objectDirectory, METADATA_FILE), 'utf8'),
				),
			);
			if (metadata instanceof type.errors) {
				return BlobStoreError.BlobStoreFailed({
					id,
					cause: new Error('Blob metadata has an invalid shape.'),
				});
			}
			return Ok(metadata);
		} catch (cause) {
			if (isFileSystemError(cause, 'ENOENT')) {
				try {
					await stat(objectDirectory);
				} catch (directoryCause) {
					if (isFileSystemError(directoryCause, 'ENOENT')) {
						return BlobStoreError.BlobNotFound({ id });
					}
					return BlobStoreError.BlobStoreFailed({
						id,
						cause: directoryCause,
					});
				}
			}
			return BlobStoreError.BlobStoreFailed({ id, cause });
		}
	}

	async function putData(
		id: BlobId,
		data: PutData,
		contentType: string,
		attachmentOrigin?: { generation?: number | null },
	): Promise<Result<void, BlobAlreadyExists | BlobStoreFailed>> {
		const validatedId = validateId(id);
		if (validatedId.error !== null) return Err(validatedId.error);
		id = validatedId.data;
		let stagedDirectory: string | undefined;
		let stagedMetadata: StoredMetadata | undefined;
		try {
			await mkdir(stagingDirectory, { recursive: true });
			try {
				await stat(blobDirectory(id));
				if (!attachmentOrigin) return BlobStoreError.BlobAlreadyExists({ id });
			} catch (cause) {
				if (!isFileSystemError(cause, 'ENOENT')) throw cause;
			}

			stagedDirectory = await mkdtemp(join(stagingDirectory, `${id}-`));
			const dataPath = join(stagedDirectory, DATA_FILE);
			await writeData(dataPath, data);
			const size = (await stat(dataPath)).size;
			const metadata = {
				contentType: normalizeContentType(contentType),
				size,
				...(attachmentOrigin
					? {
							attachment: {
								sha256: await digestFile(dataPath),
								size,
								contentType: normalizeContentType(contentType),
								...(attachmentOrigin.generation === undefined
									? {}
									: { originGeneration: attachmentOrigin.generation }),
							},
						}
					: {}),
			} satisfies StoredMetadata;
			stagedMetadata = metadata;
			await Bun.write(
				join(stagedDirectory, METADATA_FILE),
				JSON.stringify(metadata),
			);
			await syncFile(dataPath);
			await syncFile(join(stagedDirectory, METADATA_FILE));
			await syncFile(stagedDirectory);
			await rename(stagedDirectory, blobDirectory(id));
			stagedDirectory = undefined;
			await syncPublication(blobDirectory(id));
			return Ok(undefined);
		} catch (cause) {
			try {
				await stat(blobDirectory(id));
				if (stagedMetadata?.attachment) {
					const existing = await readCompleteMetadata(id);
					if (
						!existing.error &&
						existing.data.attachment &&
						existing.data.attachment.originGeneration ===
							stagedMetadata.attachment.originGeneration &&
						sameAttachmentContent(
							existing.data.attachment,
							stagedMetadata.attachment,
						) &&
						(await digestFile(join(blobDirectory(id), DATA_FILE))) ===
							stagedMetadata.attachment.sha256
					) {
						await syncPublication(blobDirectory(id));
						return Ok(undefined);
					}
				}
				return BlobStoreError.BlobAlreadyExists({ id });
			} catch (statCause) {
				if (!isFileSystemError(statCause, 'ENOENT')) {
					return BlobStoreError.BlobStoreFailed({ id, cause: statCause });
				}
			}
			return BlobStoreError.BlobStoreFailed({ id, cause });
		} finally {
			if (stagedDirectory !== undefined) {
				await rm(stagedDirectory, { recursive: true, force: true }).catch(
					() => undefined,
				);
			}
		}
	}

	async function readCompleteMetadata(id: BlobId) {
		const metadata = await readMetadata(id);
		if (metadata.error !== null) return Err(metadata.error);
		const dataPath = join(blobDirectory(id), DATA_FILE);
		try {
			const dataStat = await stat(dataPath);
			if (!dataStat.isFile() || dataStat.size !== metadata.data.size) {
				return BlobStoreError.BlobStoreFailed({
					id,
					cause: new Error(
						'Blob data is not a regular file at its recorded size.',
					),
				});
			}
		} catch (cause) {
			return BlobStoreError.BlobStoreFailed({ id, cause });
		}
		return metadata;
	}

	async function statBlob(
		id: BlobId,
	): Promise<Result<BlobStat, BlobReadError>> {
		const validatedId = validateId(id);
		if (validatedId.error !== null) return Err(validatedId.error);
		const result = await readCompleteMetadata(validatedId.data);
		if (result.error) return result;
		const metadata = result.data;
		if (!metadata.attachment)
			return Ok({ size: metadata.size, contentType: metadata.contentType });
		let acknowledged = false;
		try {
			const receipt = JSON.parse(
				await readFile(join(blobDirectory(id), 'attachment-ack.json'), 'utf8'),
			);
			acknowledged =
				receipt.generation === metadata.attachment.originGeneration &&
				sameAttachmentContent(receipt, metadata.attachment);
		} catch (cause) {
			if (!isFileSystemError(cause, 'ENOENT'))
				return BlobStoreError.BlobStoreFailed({ id, cause });
		}
		try {
			// Rename makes files visible before publication or acknowledgment
			// barriers finish. Observation must settle them even after reopen.
			if (acknowledged)
				await syncFile(join(blobDirectory(id), 'attachment-ack.json'));
			await syncPublication(blobDirectory(id));
		} catch (cause) {
			return BlobStoreError.BlobStoreFailed({ id, cause });
		}
		return Ok({
			...metadata,
			attachment: {
				...metadata.attachment,
				pendingUpload:
					typeof metadata.attachment.originGeneration === 'number' &&
					!acknowledged,
			},
		} satisfies BlobStat);
	}

	async function openBlob(id: BlobId) {
		const validatedId = validateId(id);
		if (validatedId.error !== null) return Err(validatedId.error);
		id = validatedId.data;
		const metadata = await statBlob(id);
		if (metadata.error !== null) return Err(metadata.error);
		const dataPath = join(blobDirectory(id), DATA_FILE);
		const file = Bun.file(dataPath, {
			type: metadata.data.contentType,
		});
		return Ok({ file, stat: metadata.data });
	}

	const store = {
		attachments: {
			async upload(id, expected, ticket, signal) {
				expected = { ...expected };
				ticket = {
					url: ticket.url,
					requiredHeaders: { ...ticket.requiredHeaders },
				};
				let kind: AttachmentTransferError['kind'] = 'storage';
				try {
					signal.throwIfAborted();
					const opened = await openBlob(id);
					if (opened.error)
						return AttachmentTransferError.Failed({
							kind,
							cause: opened.error,
						});
					if (
						!sameAttachmentContent(expected, {
							sha256: await digestBlob(opened.data.file, signal),
							size: opened.data.stat.size,
							contentType: opened.data.stat.contentType,
						})
					)
						return AttachmentTransferError.Failed({
							kind: 'conflict',
							cause: 'Local bytes differ from the owner evidence.',
						});
					kind = 'transport';
					const response = await fetch(ticket.url, {
						method: 'PUT',
						body: opened.data.file,
						headers: ticket.requiredHeaders,
						signal,
						credentials: 'omit',
						redirect: 'error',
					});
					await response.body?.cancel();
					return response.ok
						? Ok(undefined)
						: AttachmentTransferError.Failed({
								kind,
								status: response.status,
								cause: 'Signed upload refused.',
							});
				} catch (cause) {
					return AttachmentTransferError.Failed({
						kind: signal.aborted ? 'transport' : kind,
						cause,
					});
				}
			},
			async download(id, expected, ticket, signal) {
				expected = {
					sha256: expected.sha256,
					size: expected.size,
					contentType: expected.contentType,
				};
				ticket = { url: ticket.url };
				if (
					!Number.isSafeInteger(expected.size) ||
					expected.size < 0 ||
					expected.size > 5 * 1024 ** 3
				)
					return AttachmentTransferError.Failed({
						kind: 'conflict',
						status: 409,
						cause: 'Invalid attachment size.',
					});
				const validated = validateId(id);
				if (validated.error)
					return AttachmentTransferError.Failed({
						kind: 'storage',
						cause: validated.error,
					});
				let staged: string | undefined;
				let response: Response | undefined;
				let kind: AttachmentTransferError['kind'] = 'transport';
				try {
					signal.throwIfAborted();
					response = await fetch(ticket.url, {
						signal,
						credentials: 'omit',
						redirect: 'error',
					});
					if (!response.ok)
						return AttachmentTransferError.Failed({
							kind,
							status: response.status,
							cause: 'Signed download refused.',
						});
					if (response.headers.get('content-type') !== expected.contentType)
						return AttachmentTransferError.Failed({
							kind: 'conflict',
							status: 409,
							cause: 'Downloaded content type differs.',
						});
					kind = 'storage';
					await mkdir(stagingDirectory, { recursive: true });
					staged = await mkdtemp(join(stagingDirectory, `${id}-`));
					const file = await open(join(staged, DATA_FILE), 'wx');
					const reader = response.body?.getReader();
					const hash = createHash('sha256');
					let size = 0;
					try {
						while (reader) {
							kind = 'transport';
							signal.throwIfAborted();
							const part = await reader.read();
							if (part.done) break;
							if (part.value.length > expected.size - size)
								return AttachmentTransferError.Failed({
									kind: 'conflict',
									status: 409,
									cause: 'Downloaded bytes exceed owner size.',
								});
							size += part.value.length;
							hash.update(part.value);
							kind = 'storage';
							let offset = 0;
							while (offset < part.value.length) {
								signal.throwIfAborted();
								const written = await file.write(
									part.value,
									offset,
									part.value.length - offset,
								);
								if (written.bytesWritten === 0)
									throw new Error('Download file write made no progress.');
								offset += written.bytesWritten;
							}
						}
					} finally {
						await reader?.cancel().catch(() => {});
						reader?.releaseLock();
						await file.close();
					}
					if (size !== expected.size || hash.digest('hex') !== expected.sha256)
						return AttachmentTransferError.Failed({
							kind: 'conflict',
							status: 409,
							cause: 'Downloaded bytes differ from owner evidence.',
						});
					kind = 'storage';
					await Bun.write(
						join(staged, METADATA_FILE),
						JSON.stringify({
							size,
							contentType: expected.contentType,
							attachment: expected,
						}),
					);
					await syncFile(join(staged, DATA_FILE));
					await syncFile(join(staged, METADATA_FILE));
					await syncFile(staged);
					signal.throwIfAborted();
					try {
						await rename(staged, blobDirectory(id));
						staged = undefined;
					} catch (cause) {
						const existing = await readCompleteMetadata(id);
						if (existing.error) throw cause;
						if (
							!existing.data.attachment ||
							!sameAttachmentContent(expected, existing.data.attachment) ||
							!sameAttachmentContent(expected, {
								...existing.data,
								sha256: await digestFile(join(blobDirectory(id), DATA_FILE)),
							})
						)
							return AttachmentTransferError.Failed({
								kind: 'conflict',
								status: 409,
								cause: 'Existing local bytes differ.',
							});
						// Preserve existing local origin and acknowledgment on an identical race.
					}
					await syncPublication(blobDirectory(id));
					return Ok(undefined);
				} catch (cause) {
					return AttachmentTransferError.Failed({
						kind: signal.aborted ? 'transport' : kind,
						cause,
					});
				} finally {
					await response?.body?.cancel().catch(() => {});
					if (staged)
						await rm(staged, { recursive: true, force: true }).catch(() => {});
				}
			},
			async put(id, file, originGeneration) {
				if (!(file instanceof Blob))
					return BlobStoreError.BlobStoreFailed({
						id,
						cause: 'Native tokens must be consumed by the native publisher.',
					});
				const published = await putData(id, file, file.type, {
					generation: originGeneration,
				});
				if (published.error?.name === 'BlobAlreadyExists') {
					const existing = await readCompleteMetadata(id);
					if (existing.error)
						return BlobStoreError.BlobStoreFailed({
							id,
							cause: existing.error,
						});
					try {
						const expected = {
							sha256: await digestBlob(file),
							size: file.size,
							contentType: normalizeContentType(file.type),
						};
						if (
							existing.data.attachment &&
							existing.data.attachment.originGeneration === originGeneration &&
							sameAttachmentContent(existing.data.attachment, expected) &&
							(await digestFile(join(blobDirectory(id), DATA_FILE))) ===
								expected.sha256
						) {
							await syncPublication(blobDirectory(id));
							return Ok(expected);
						}
					} catch (cause) {
						return BlobStoreError.BlobStoreFailed({ id, cause });
					}
				}
				if (published.error) return published;
				const metadata = await readCompleteMetadata(id);
				return metadata.error
					? BlobStoreError.BlobStoreFailed({ id, cause: metadata.error })
					: Ok(metadata.data.attachment!);
			},
			async acknowledge(id, expected, generation) {
				const metadata = await statBlob(id);
				if (metadata.error) return metadata;
				if (
					!metadata.data.attachment ||
					metadata.data.attachment.originGeneration !== generation ||
					!sameAttachmentContent(expected, metadata.data.attachment)
				)
					return BlobStoreError.BlobStoreFailed({
						id,
						cause: 'Acknowledgment does not match this local publication.',
					});
				try {
					const receipt = join(
						blobDirectory(id),
						`attachment-ack-${crypto.randomUUID()}.tmp`,
					);
					await Bun.write(receipt, JSON.stringify({ ...expected, generation }));
					await syncFile(receipt);
					await rename(receipt, join(blobDirectory(id), 'attachment-ack.json'));
					await syncFile(blobDirectory(id));
					return Ok(undefined);
				} catch (cause) {
					return BlobStoreError.BlobStoreFailed({ id, cause });
				}
			},
		},
		put(id, blob) {
			return putData(id, blob, blob.type);
		},

		async copy(
			sourceId: BlobId,
			destinationId: BlobId,
		): Promise<
			Result<void, BlobNotFound | BlobAlreadyExists | BlobStoreFailed>
		> {
			// BunFile.type may normalize MIME types; retain the stored metadata.
			const source = await openBlob(sourceId);
			if (source.error !== null) return source;
			return putData(
				destinationId,
				source.data.file,
				source.data.stat.contentType,
			);
		},

		/** Store an HTTP request body without first materializing it as a Blob. */
		putRequest(
			id: BlobId,
			request: Request,
			attachmentOrigin?: { generation?: number | null },
		) {
			return putData(
				id,
				request,
				request.headers.get('content-type') ?? DEFAULT_CONTENT_TYPE,
				attachmentOrigin,
			);
		},

		/** Store an HTTP response body without first materializing it as a Blob. */
		putResponse(id: BlobId, response: Response) {
			return putData(
				id,
				response,
				response.headers.get('content-type') ?? DEFAULT_CONTENT_TYPE,
			);
		},

		/** Open the lazy BunFile and its metadata for an HTTP file response. */
		openFile(id: BlobId) {
			return openBlob(id);
		},

		async get(id) {
			const opened = await openBlob(id);
			if (opened.error !== null) return Err(opened.error);
			return Ok(opened.data.file);
		},

		stat(id) {
			return statBlob(id);
		},
		statMany(ids) {
			return Promise.all(ids.map(statBlob));
		},

		async delete(id) {
			const validatedId = validateId(id);
			if (validatedId.error !== null) return Err(validatedId.error);
			try {
				await rm(blobDirectory(validatedId.data), {
					recursive: true,
					force: true,
				});
				return Ok(undefined);
			} catch (cause) {
				return BlobStoreError.BlobStoreFailed({ id, cause });
			}
		},
	} satisfies BlobStore & {
		putRequest(
			id: BlobId,
			request: Request,
			attachmentOrigin?: { generation?: number | null },
		): Promise<Result<void, BlobAlreadyExists | BlobStoreFailed>>;
		putResponse(
			id: BlobId,
			response: Response,
		): Promise<Result<void, BlobAlreadyExists | BlobStoreFailed>>;
		openFile(id: BlobId): ReturnType<typeof openBlob>;
	};
	return store;
}

export type BunBlobStore = ReturnType<typeof createBunBlobStore>;

function normalizeContentType(contentType: string): string {
	const normalized = contentType.trim();
	if (
		normalized === '' ||
		normalized.length > 255 ||
		Array.from(normalized).some((character) => {
			const codePoint = character.codePointAt(0);
			return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
		})
	) {
		return DEFAULT_CONTENT_TYPE;
	}
	return normalized;
}

function isFileSystemError(cause: unknown, code: string): boolean {
	return cause instanceof Error && 'code' in cause && cause.code === code;
}

async function writeData(path: string, data: PutData): Promise<void> {
	if (data instanceof Blob) {
		await Bun.write(path, data);
		return;
	}

	if (data.body === null) {
		await Bun.write(path, '');
		return;
	}

	const reader = data.body.getReader();
	const writer = Bun.file(path).writer({ highWaterMark: 1024 * 1024 });
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			writer.write(value);
		}
		await writer.end();
	} catch (cause) {
		try {
			await writer.end();
		} catch {
			// The original stream failure remains the operation's useful cause.
		}
		throw cause;
	} finally {
		reader.releaseLock();
	}
}

async function digestFile(path: string) {
	return digestBlob(Bun.file(path));
}

async function digestBlob(blob: Blob, signal?: AbortSignal) {
	const hash = createHash('sha256');
	const reader = blob.stream().getReader();
	try {
		while (true) {
			signal?.throwIfAborted();
			const next = await reader.read();
			if (next.done) break;
			hash.update(next.value);
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	return hash.digest('hex');
}

async function syncFile(path: string) {
	const file = await open(path, 'r');
	try {
		await file.sync();
	} finally {
		await file.close();
	}
}

async function syncPublication(directory: string) {
	await syncFile(join(directory, DATA_FILE));
	await syncFile(join(directory, METADATA_FILE));
	// A reopened publisher cannot know which ancestors an unconfirmed attempt
	// created. Repeat every directory barrier, including the existing root.
	let current = resolve(directory);
	while (true) {
		await syncFile(current);
		const parent = dirname(current);
		if (parent === current) return;
		current = parent;
	}
}
