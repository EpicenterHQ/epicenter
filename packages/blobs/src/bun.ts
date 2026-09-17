import {
	mkdir,
	mkdtemp,
	open,
	readFile,
	readdir,
	rename,
	rm,
	stat,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { type } from 'arktype';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { parseBlobId, type BlobId } from './blob-id.js';
import { blobListOptions, normalizeContentType } from './blob-metadata.js';
import {
	type BlobAlreadyExists,
	type BlobNotFound,
	type BlobStat,
	type BlobListOptions,
	type BlobListPage,
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
};

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
		Object.keys(metadata).every((key) =>
			['size', 'contentType'].includes(key),
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
			const metadata: StoredMetadata = {
				contentType: normalizeContentType(contentType),
				size: (await stat(dataPath)).size,
			};
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
			if (
				isFileSystemError(cause, 'EEXIST') ||
				isFileSystemError(cause, 'ENOTEMPTY')
			)
				return BlobStoreError.BlobAlreadyExists({ id });
			return BlobStoreError.BlobStoreFailed({ id, cause });
		} finally {
			if (stagedDirectory !== undefined)
				await rm(stagedDirectory, { recursive: true, force: true }).catch(
					() => {},
				);
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
		return Ok({ size: result.data.size, contentType: result.data.contentType });
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
		async list(
			options?: BlobListOptions,
		): Promise<Result<BlobListPage, BlobStoreFailed>> {
			try {
				const { cursor, limit } = blobListOptions(options);
				let names: string[];
				try {
					names = await readdir(directory);
				} catch (cause) {
					if (isFileSystemError(cause, 'ENOENT')) return Ok({ items: [] });
					throw cause;
				}
				const items: BlobListPage['items'] = [];
				for (const name of names.sort()) {
					const id = parseBlobId(name);
					if (!id || (cursor !== undefined && id <= cursor)) continue;
					// Filesystem metadata confirms completeness without reading the body.
					try {
						const [body, metadataFile] = await Promise.all([
							stat(join(blobDirectory(id), DATA_FILE)),
							stat(join(blobDirectory(id), METADATA_FILE)),
						]);
						if (!body.isFile() || !metadataFile.isFile()) continue;
					} catch (cause) {
						if (
							isFileSystemError(cause, 'ENOENT') ||
							isFileSystemError(cause, 'ENOTDIR')
						)
							continue;
						throw cause;
					}
					const metadata = await readCompleteMetadata(id);
					if (metadata.error) {
						if (
							metadata.error.name === 'BlobNotFound' ||
							isFileSystemError(metadata.error.cause, 'ENOENT')
						)
							continue;
						return Err(metadata.error);
					}
					items.push({
						id,
						size: metadata.data.size,
						contentType: metadata.data.contentType,
					});
					if (items.length > limit) break;
				}
				const hasMore = items.length > limit;
				if (hasMore) items.pop();
				return Ok({
					items,
					...(hasMore ? { nextCursor: items.at(-1)!.id } : {}),
				});
			} catch (cause) {
				return BlobStoreError.BlobStoreFailed({ cause });
			}
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
	return store;
}

export type BunBlobStore = ReturnType<typeof createBunBlobStore>;

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
