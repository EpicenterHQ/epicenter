import { randomUUID } from 'node:crypto';
import {
	closeSync,
	createReadStream,
	fsyncSync,
	mkdirSync,
	openSync,
} from 'node:fs';
import { open, readdir, rename, rmdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import type {
	BlobFileStore,
	OwnedBlobFile,
	StagedBlob,
} from '../../blob-v1/index.js';

export type BlobByteSource =
	| AsyncIterable<Uint8Array>
	| ReadableStream<Uint8Array>;

export type BunBlobRead = ReadableStream<Uint8Array> & {
	/** Exact physical file length observed by the blob owner. */
	readonly byteLength: number;
};

const SAFE_COMPONENT = /^[a-f0-9]{64}$/u;

function requireComponent(value: string, label: string): void {
	if (!SAFE_COMPONENT.test(value)) {
		throw new Error(`invalid ${label} path component`);
	}
}

async function* chunks(source: BlobByteSource): AsyncIterable<Uint8Array> {
	if (typeof (source as ReadableStream<Uint8Array>).getReader === 'function') {
		const reader = (source as ReadableStream<Uint8Array>).getReader();
		try {
			while (true) {
				const result = await reader.read();
				if (result.done) return;
				if (!(result.value instanceof Uint8Array)) {
					throw new TypeError('blob source yielded a non-byte chunk');
				}
				yield result.value;
			}
		} finally {
			try {
				reader.releaseLock();
			} catch {
				// Bun network request bodies can throw here after a complete read.
				// Staging owns terminal consumption, so cleanup cannot overturn it.
			}
		}
	}

	for await (const chunk of source as AsyncIterable<Uint8Array>) {
		if (!(chunk instanceof Uint8Array)) {
			throw new TypeError('blob source yielded a non-byte chunk');
		}
		yield chunk;
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw cause;
	}
}

async function syncDirectory(path: string): Promise<void> {
	const directory = await open(path, 'r');
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

function syncDirectoryNow(path: string): void {
	const descriptor = openSync(path, 'r');
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

async function verify(path: string, digest: string): Promise<void> {
	const hasher = new Bun.CryptoHasher('sha256');
	for await (const chunk of createReadStream(path)) hasher.update(chunk);
	if (hasher.digest('hex') !== digest) {
		throw new Error('owned blob bytes failed digest verification');
	}
}

/** Native raw-file implementation of the replica blob staging law. */
export function createBunBlobFileStore(
	storageRoot: string,
): BlobFileStore<BlobByteSource, BunBlobRead> {
	const blobRoot = join(storageRoot, 'blobs');
	const stagingRoot = join(blobRoot, 'staging');
	const contentRoot = join(blobRoot, 'content');
	mkdirSync(stagingRoot, { recursive: true });
	mkdirSync(contentRoot, { recursive: true });
	for (const path of [stagingRoot, contentRoot, blobRoot, storageRoot]) {
		syncDirectoryNow(path);
	}

	function stagingPath(staged: StagedBlob): string {
		requireComponent(staged.digest, 'staged blob digest');
		if (staged.id !== `${staged.digest}.tmp`) {
			throw new Error('invalid staged blob identity');
		}
		return join(stagingRoot, staged.id);
	}

	function contentPath(owner: OwnedBlobFile): string {
		requireComponent(owner.ownerKey, 'blob owner');
		requireComponent(owner.digest, 'blob digest');
		return join(contentRoot, owner.ownerKey, owner.digest);
	}

	async function stage(source: BlobByteSource): Promise<StagedBlob> {
		const temporaryPath = join(stagingRoot, `${randomUUID()}.capture`);
		const file = await open(temporaryPath, 'wx');
		const hasher = new Bun.CryptoHasher('sha256');
		try {
			for await (const chunk of chunks(source)) {
				hasher.update(chunk);
				let offset = 0;
				while (offset < chunk.byteLength) {
					const written = await file.write(
						chunk,
						offset,
						chunk.byteLength - offset,
					);
					if (written.bytesWritten === 0) {
						throw new Error('blob staging write made no progress');
					}
					offset += written.bytesWritten;
				}
			}
			await file.sync();
		} catch (cause) {
			await file.close();
			await unlink(temporaryPath).catch(() => undefined);
			throw cause;
		}
		await file.close();

		const digest = hasher.digest('hex');
		const staged = { id: `${digest}.tmp`, digest };
		const finalStagingPath = stagingPath(staged);
		if (await exists(finalStagingPath)) {
			await verify(finalStagingPath, digest);
			await unlink(temporaryPath);
		} else {
			await rename(temporaryPath, finalStagingPath);
		}
		await syncDirectory(stagingRoot);
		return staged;
	}

	async function promote(
		staged: StagedBlob,
		owner: OwnedBlobFile,
	): Promise<void> {
		if (staged.digest !== owner.digest) {
			throw new Error('staged blob digest does not match its owner');
		}
		const source = stagingPath(staged);
		const ownerRoot = join(contentRoot, owner.ownerKey);
		const destination = contentPath(owner);
		mkdirSync(ownerRoot, { recursive: true });
		await syncDirectory(contentRoot);
		if (await exists(destination)) {
			await verify(destination, owner.digest);
			await unlink(source);
		} else {
			await rename(source, destination);
		}
		await syncDirectory(ownerRoot);
		await syncDirectory(stagingRoot);
	}

	async function openOwned(owner: OwnedBlobFile): Promise<BunBlobRead> {
		const path = contentPath(owner);
		await verify(path, owner.digest);
		const byteLength = (await stat(path)).size;
		const stream = Readable.toWeb(
			createReadStream(path),
		) as unknown as ReadableStream<Uint8Array>;
		return Object.assign(stream, { byteLength });
	}

	async function sweepStaging(): Promise<void> {
		for (const entry of await readdir(stagingRoot, { withFileTypes: true })) {
			if (entry.isFile()) await unlink(join(stagingRoot, entry.name));
		}
		await syncDirectory(stagingRoot);
	}

	async function sweepContent(owned: readonly OwnedBlobFile[]): Promise<void> {
		const retained = new Set(
			owned.map((owner) => {
				requireComponent(owner.ownerKey, 'blob owner');
				requireComponent(owner.digest, 'blob digest');
				return `${owner.ownerKey}/${owner.digest}`;
			}),
		);
		for (const ownerEntry of await readdir(contentRoot, {
			withFileTypes: true,
		})) {
			if (!ownerEntry.isDirectory()) continue;
			const ownerRoot = join(contentRoot, ownerEntry.name);
			for (const blobEntry of await readdir(ownerRoot, {
				withFileTypes: true,
			})) {
				if (
					blobEntry.isFile() &&
					!retained.has(`${ownerEntry.name}/${blobEntry.name}`)
				) {
					await unlink(join(ownerRoot, blobEntry.name));
				}
			}
			if ((await readdir(ownerRoot)).length === 0) await rmdir(ownerRoot);
		}
		await syncDirectory(contentRoot);
	}

	return {
		stage,
		promote,
		open: openOwned,
		sweepStaging,
		sweepContent,
	};
}
