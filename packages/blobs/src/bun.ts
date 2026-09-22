import { constants, type Stats } from 'node:fs';
import {
	link,
	lstat,
	mkdir,
	open,
	readdir,
	realpath,
	unlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BunFile } from 'bun';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { assertBlobFormat, blobKeyFormat } from './blob-format.js';
import type { BlobId } from './blob-id.js';
import { parseBlobId } from './blob-id.js';
import { blobListOptions } from './blob-metadata.js';
import type { BlobStore } from './blob-store.js';
import {
	type BlobAlreadyExists,
	type BlobListOptions,
	type BlobListPage,
	type BlobNotFound,
	type BlobStat,
	BlobStoreError,
	type BlobStoreFailed,
} from './blob-store.js';

type PutData = Blob | Request | Response;
type PublicationReceipt = {
	input: PutData;
	path: string;
	dev: number;
	ino: number;
	published: boolean;
};

/**
 * App-local immutable files. The caller must supply an app-owned directory
 * whose ancestors cannot be replaced by untrusted writers. No historical files
 * or abandoned staging entries are swept.
 *
 * link(2) atomically installs a second name without replacing an existing name.
 * The staged file is synced before linking; directory barriers precede removal
 * of its staging name. macOS link(2) documents EEXIST for occupied destinations.
 */
export function createBunBlobStore({ directory }: { directory: string }) {
	const pending = new Map<BlobId, PublicationReceipt>();
	const active = new Map<BlobId, Promise<void>>();

	function validate(id: BlobId) {
		if (!parseBlobId(id)) throw new TypeError('Invalid complete blob key.');
	}

	async function putData(
		id: BlobId,
		input: PutData,
	): Promise<Result<void, BlobAlreadyExists | BlobStoreFailed>> {
		let path: string | undefined;
		let ownsAttempt = false;
		let finished: (() => void) | undefined;
		try {
			validate(id);
			assertBlobFormat(
				id,
				input instanceof Blob
					? input
					: new Blob([], {
							type: input.headers.get('content-type') ?? '',
						}),
			);
			// A collision means published bytes exist, not merely a writer in flight.
			while (active.has(id)) await active.get(id);
			const completion = Promise.withResolvers<void>();
			active.set(id, completion.promise);
			finished = completion.resolve;
			ownsAttempt = true;
			let receipt = pending.get(id);
			if (receipt && receipt.input !== input) {
				if (!(await matchesStagedBytes(input, receipt)))
					throw new Error('Retry bytes differ from the retained publication.');
				// A fresh HTTP request is consumed by verification. Its identity can
				// resume another failed barrier without reading that body again.
				receipt.input = input;
			}
			if (!receipt) {
				await mkdir(directory, { recursive: true });
				const candidate = join(directory, `.bun-${crypto.randomUUID()}.tmp`);
				const handle = await open(candidate, 'wx', 0o600);
				path = candidate;
				try {
					const stream = input instanceof Blob ? input.stream() : input.body;
					if (stream) {
						const reader = stream.getReader();
						try {
							while (true) {
								const { value, done } = await reader.read();
								if (done) break;
								let offset = 0;
								while (offset < value.byteLength) {
									const { bytesWritten } = await handle.write(
										value.subarray(offset),
									);
									if (bytesWritten === 0)
										throw new Error('Blob write made no progress.');
									offset += bytesWritten;
								}
							}
						} finally {
							try {
								await reader.cancel();
							} finally {
								reader.releaseLock();
							}
						}
					}
					const { dev, ino } = await handle.stat();
					receipt = { input, path, dev, ino, published: false };
					pending.set(id, receipt);
				} finally {
					await handle.close();
				}
			}
			const finalPath = join(directory, id);
			if (!receipt.published) {
				const staged = await lstat(receipt.path);
				if (
					!staged.isFile() ||
					staged.dev !== receipt.dev ||
					staged.ino !== receipt.ino
				)
					throw new Error('Staged blob no longer matches its pending receipt.');
				await syncPath(receipt.path);
				await link(receipt.path, finalPath);
				receipt.published = true;
			} else {
				const final = await lstat(finalPath);
				if (
					!final.isFile() ||
					final.dev !== receipt.dev ||
					final.ino !== receipt.ino
				)
					throw new Error(
						'Published blob no longer matches its pending receipt.',
					);
			}
			// Windows has no portable directory fsync. Flush the linked file again.
			if (process.platform === 'win32') await syncPath(receipt.path);
			else await syncDirectories(directory);
			await unlink(receipt.path);
			pending.delete(id);
			return Ok(undefined);
		} catch (cause) {
			if (isFileSystemError(cause, 'EEXIST')) {
				// The losing publisher owns only its temporary file, never the winner.
				const receipt = pending.get(id);
				if (ownsAttempt && receipt?.input === input && !receipt.published) {
					path = receipt.path;
					pending.delete(id);
					return BlobStoreError.BlobAlreadyExists({ id });
				}
			}
			return BlobStoreError.BlobStoreFailed({ id, cause });
		} finally {
			if (ownsAttempt) {
				active.delete(id);
				finished?.();
			}
			if (path && pending.get(id)?.path !== path)
				await unlink(path).catch(() => {});
		}
	}

	async function openFile(id: BlobId): Promise<
		Result<
			{
				file: BunFile;
				stat: BlobStat;
				close(): Promise<void>;
			},
			BlobNotFound | BlobStoreFailed
		>
	> {
		try {
			validate(id);
			// O_NONBLOCK prevents a malicious FIFO from blocking before fstat.
			const handle = await open(
				join(directory, id),
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
			try {
				const info = await handle.stat();
				if (!info.isFile())
					throw new Error('Blob entry is not a regular file.');
				const stat = {
					size: info.size,
					contentType: blobKeyFormat(id).contentType,
				};
				return Ok({
					file: Bun.file(handle.fd, { type: stat.contentType }),
					stat,
					/** Close after response streaming completes or is cancelled. */
					close: () => handle.close(),
				});
			} catch (cause) {
				await handle.close();
				throw cause;
			}
		} catch (cause) {
			if (isFileSystemError(cause, 'ENOENT'))
				return BlobStoreError.BlobNotFound({ id });
			return BlobStoreError.BlobStoreFailed({ id, cause });
		}
	}

	return {
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
					let info: Stats;
					try {
						info = await lstat(join(directory, id));
					} catch (cause) {
						if (isFileSystemError(cause, 'ENOENT')) continue;
						throw cause;
					}
					if (!info.isFile()) continue;
					items.push({
						id,
						size: info.size,
						contentType: blobKeyFormat(id).contentType,
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
			return putData(id, blob);
		},
		/** Stream an HTTP body without first materializing a Blob. */
		putRequest(id: BlobId, request: Request) {
			return putData(id, request);
		},
		/** Publish a response under a fresh key and release its body. */
		async putResponse(id: BlobId, response: Response) {
			try {
				return await putData(id, response);
			} finally {
				await response.body?.cancel();
			}
		},
		/** Borrow a descriptor-backed BunFile. The caller must close it. */
		openFile,
		async get(id): Promise<Result<Blob, BlobNotFound | BlobStoreFailed>> {
			const opened = await openFile(id);
			if (opened.error) return Err(opened.error);
			try {
				const blob = new Blob([await opened.data.file.arrayBuffer()], {
					type: opened.data.stat.contentType,
				});
				await opened.data.close();
				return Ok(blob);
			} catch (cause) {
				await opened.data.close().catch(() => {});
				return BlobStoreError.BlobStoreFailed({ id, cause });
			}
		},
		async stat(id): ReturnType<BlobStore['stat']> {
			try {
				validate(id);
				const info = await lstat(join(directory, id));
				if (!info.isFile())
					throw new Error('Blob entry is not a regular file.');
				return Ok({
					size: info.size,
					contentType: blobKeyFormat(id).contentType,
				});
			} catch (cause) {
				if (isFileSystemError(cause, 'ENOENT'))
					return BlobStoreError.BlobNotFound({ id });
				return BlobStoreError.BlobStoreFailed({ id, cause });
			}
		},
		async delete(id) {
			try {
				validate(id);
				const info = await lstat(join(directory, id));
				if (!info.isFile())
					throw new Error('Blob entry is not a regular file.');
				await unlink(join(directory, id));
				return Ok(undefined);
			} catch (cause) {
				if (isFileSystemError(cause, 'ENOENT')) return Ok(undefined);
				return BlobStoreError.BlobStoreFailed({ id, cause });
			}
		},
	} satisfies BlobStore & {
		putRequest(id: BlobId, request: Request): ReturnType<typeof putData>;
		putResponse(id: BlobId, response: Response): ReturnType<typeof putData>;
		openFile: typeof openFile;
	};
}

export type BunBlobStore = ReturnType<typeof createBunBlobStore>;

/** Compare a retry to finalized bytes using at most one 64 KiB disk buffer. */
async function matchesStagedBytes(input: PutData, receipt: PublicationReceipt) {
	const handle = await open(
		receipt.path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.dev !== receipt.dev || info.ino !== receipt.ino)
			throw new Error('Staged blob no longer matches its pending receipt.');
		const stream = input instanceof Blob ? input.stream() : input.body;
		if (!stream) return info.size === 0;
		const reader = stream.getReader();
		let finished = false;
		try {
			const buffer = new Uint8Array(64 * 1024);
			let position = 0;
			while (true) {
				const { value, done } = await reader.read();
				if (done) {
					finished = true;
					return position === info.size;
				}
				if (position + value.byteLength > info.size) return false;
				let offset = 0;
				while (offset < value.byteLength) {
					const length = Math.min(buffer.byteLength, value.byteLength - offset);
					const { bytesRead } = await handle.read(buffer, 0, length, position);
					if (bytesRead === 0) return false;
					for (let index = 0; index < bytesRead; index++) {
						if (buffer[index] !== value[offset + index]) return false;
					}
					offset += bytesRead;
					position += bytesRead;
				}
			}
		} finally {
			if (!finished) await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
	} finally {
		await handle.close();
	}
}

function isFileSystemError(cause: unknown, code: string) {
	return cause instanceof Error && 'code' in cause && cause.code === code;
}

async function syncPath(path: string) {
	const handle = await open(
		path,
		(process.platform === 'win32' ? constants.O_RDWR : constants.O_RDONLY) |
			constants.O_NOFOLLOW,
	);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function syncDirectories(directory: string) {
	let current = await realpath(directory);
	while (true) {
		await syncPath(current);
		const parent = dirname(current);
		if (parent === current) return;
		current = parent;
	}
}
