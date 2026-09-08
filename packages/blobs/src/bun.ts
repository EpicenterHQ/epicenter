import { mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type } from 'arktype';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type BlobId, parseBlobId } from './blob-id.js';
import {
	type BlobAlreadyExists,
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

type StoredMetadata = BlobStat;

/**
 * Parse on-disk metadata at the JSON boundary: `metadata.json` is untrusted
 * input like any file, so its shape is established here rather than asserted
 * downstream.
 */
const StoredMetadata = type({
	contentType: 'string',
	size: 'number',
}).narrow(
	(metadata) =>
		Object.keys(metadata).length === 2 &&
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
		const parsed = parseBlobId(id);
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
	): Promise<Result<void, BlobAlreadyExists | BlobStoreFailed>> {
		const validatedId = validateId(id);
		if (validatedId.error !== null) return Err(validatedId.error);
		id = validatedId.data;
		let stagedDirectory: string | undefined;
		try {
			await mkdir(stagingDirectory, { recursive: true });
			try {
				await stat(blobDirectory(id));
				return BlobStoreError.BlobAlreadyExists({ id });
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
			} satisfies StoredMetadata;
			await Bun.write(
				join(stagedDirectory, METADATA_FILE),
				JSON.stringify(metadata),
			);
			await rename(stagedDirectory, blobDirectory(id));
			stagedDirectory = undefined;
			return Ok(undefined);
		} catch (cause) {
			try {
				await stat(blobDirectory(id));
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

	async function statBlob(id: BlobId) {
		const validatedId = validateId(id);
		if (validatedId.error !== null) return Err(validatedId.error);
		return readCompleteMetadata(validatedId.data);
	}

	async function openBlob(id: BlobId) {
		const validatedId = validateId(id);
		if (validatedId.error !== null) return Err(validatedId.error);
		id = validatedId.data;
		const metadata = await readCompleteMetadata(id);
		if (metadata.error !== null) return Err(metadata.error);
		const dataPath = join(blobDirectory(id), DATA_FILE);
		const file = Bun.file(dataPath, {
			type: metadata.data.contentType,
		});
		return Ok({ file, stat: metadata.data });
	}

	return {
		put(id, blob) {
			return putData(id, blob, blob.type);
		},

		/** Store an HTTP request body without first materializing it as a Blob. */
		putRequest(id: BlobId, request: Request) {
			return putData(
				id,
				request,
				request.headers.get('content-type') ?? DEFAULT_CONTENT_TYPE,
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
		): Promise<Result<void, BlobAlreadyExists | BlobStoreFailed>>;
		putResponse(
			id: BlobId,
			response: Response,
		): Promise<Result<void, BlobAlreadyExists | BlobStoreFailed>>;
		openFile(id: BlobId): ReturnType<typeof openBlob>;
	};
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
