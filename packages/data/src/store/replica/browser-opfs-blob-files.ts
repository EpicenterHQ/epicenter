import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import type { BlobFileStore, OwnedBlobFile, StagedBlob } from './blob-store.js';

const SAFE_COMPONENT = /^[a-f0-9]{64}$/u;

type SyncAccessHandle = {
	write(buffer: Uint8Array, options: { at: number }): number;
	flush(): void;
	close(): void;
};

type OpfsHandle = {
	kind: 'file' | 'directory';
	name: string;
};

type OpfsFileHandle = OpfsHandle & {
	kind: 'file';
	getFile(): Promise<Blob>;
	createSyncAccessHandle(): Promise<SyncAccessHandle>;
	move(directory: OpfsDirectoryHandle, name: string): Promise<void>;
};

export type OpfsDirectoryHandle = OpfsHandle & {
	kind: 'directory';
	getDirectoryHandle(
		name: string,
		options?: { create?: boolean },
	): Promise<OpfsDirectoryHandle>;
	getFileHandle(
		name: string,
		options?: { create?: boolean },
	): Promise<OpfsFileHandle>;
	removeEntry(name: string): Promise<void>;
	values(): AsyncIterableIterator<OpfsHandle>;
};

function requireComponent(value: string, label: string): void {
	if (!SAFE_COMPONENT.test(value)) {
		throw new Error(`invalid ${label} path component`);
	}
}

function asOpfsFile(handle: OpfsFileHandle): OpfsFileHandle {
	if (!('createSyncAccessHandle' in handle) || !('move' in handle)) {
		throw new Error('browser OPFS lacks required sync-access or move support');
	}
	return handle as OpfsFileHandle;
}

function asIterableDirectory(
	directory: OpfsDirectoryHandle,
): OpfsDirectoryHandle {
	if (!('values' in directory)) {
		throw new Error('browser OPFS directory iteration is unavailable');
	}
	return directory;
}

async function optionalFile(
	directory: OpfsDirectoryHandle,
	name: string,
): Promise<OpfsFileHandle | null> {
	try {
		return await directory.getFileHandle(name);
	} catch (cause) {
		if (
			typeof cause === 'object' &&
			cause !== null &&
			'name' in cause &&
			cause.name === 'NotFoundError'
		) {
			return null;
		}
		throw cause;
	}
}

async function verify(handle: OpfsFileHandle, digest: string): Promise<Blob> {
	const file = await handle.getFile();
	const hasher = sha256.create();
	const reader = file.stream().getReader();
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			hasher.update(result.value);
		}
	} finally {
		reader.releaseLock();
	}
	if (bytesToHex(hasher.digest()) !== digest) {
		throw new Error('owned blob bytes failed digest verification');
	}
	return file;
}

/** Dedicated-worker OPFS implementation of the replica blob staging law. */
export async function createBrowserOpfsBlobFileStore(
	root?: OpfsDirectoryHandle,
): Promise<BlobFileStore<Blob, Blob>> {
	const storageRoot =
		root ??
		(await (
			navigator as unknown as {
				storage: { getDirectory(): Promise<OpfsDirectoryHandle> };
			}
		).storage.getDirectory());
	const blobRoot = await storageRoot.getDirectoryHandle('blobs', {
		create: true,
	});
	const stagingRoot = await blobRoot.getDirectoryHandle('staging', {
		create: true,
	});
	const contentRoot = await blobRoot.getDirectoryHandle('content', {
		create: true,
	});

	function requireStaged(staged: StagedBlob): void {
		requireComponent(staged.digest, 'staged blob digest');
		if (staged.id !== `${staged.digest}.tmp`) {
			throw new Error('invalid staged blob identity');
		}
	}

	async function stage(source: Blob): Promise<StagedBlob> {
		const temporaryName = `${crypto.randomUUID()}.capture`;
		const temporary = asOpfsFile(
			await stagingRoot.getFileHandle(temporaryName, { create: true }),
		);
		const access = await temporary.createSyncAccessHandle();
		const hasher = sha256.create();
		const reader = source.stream().getReader();
		let offset = 0;
		try {
			while (true) {
				const result = await reader.read();
				if (result.done) break;
				hasher.update(result.value);
				let chunkOffset = 0;
				while (chunkOffset < result.value.byteLength) {
					const bytesWritten = access.write(
						result.value.subarray(chunkOffset),
						{ at: offset },
					);
					if (bytesWritten === 0) {
						throw new Error('blob staging write made no progress');
					}
					chunkOffset += bytesWritten;
					offset += bytesWritten;
				}
			}
			access.flush();
		} catch (cause) {
			access.close();
			await stagingRoot.removeEntry(temporaryName).catch(() => undefined);
			throw cause;
		} finally {
			reader.releaseLock();
		}
		access.close();

		const digest = bytesToHex(hasher.digest());
		const staged = { id: `${digest}.tmp`, digest };
		const existing = await optionalFile(stagingRoot, staged.id);
		if (existing === null) {
			await temporary.move(stagingRoot, staged.id);
		} else {
			await verify(existing, digest);
			await stagingRoot.removeEntry(temporaryName);
		}
		return staged;
	}

	async function promote(
		staged: StagedBlob,
		owner: OwnedBlobFile,
	): Promise<void> {
		requireStaged(staged);
		requireComponent(owner.ownerKey, 'blob owner');
		requireComponent(owner.digest, 'blob digest');
		if (staged.digest !== owner.digest) {
			throw new Error('staged blob digest does not match its owner');
		}
		const source = asOpfsFile(await stagingRoot.getFileHandle(staged.id));
		const ownerRoot = await contentRoot.getDirectoryHandle(owner.ownerKey, {
			create: true,
		});
		const existing = await optionalFile(ownerRoot, owner.digest);
		if (existing === null) {
			await source.move(ownerRoot, owner.digest);
		} else {
			await verify(existing, owner.digest);
			await stagingRoot.removeEntry(staged.id);
		}
	}

	async function open(owner: OwnedBlobFile): Promise<Blob> {
		requireComponent(owner.ownerKey, 'blob owner');
		requireComponent(owner.digest, 'blob digest');
		const ownerRoot = await contentRoot.getDirectoryHandle(owner.ownerKey);
		return verify(await ownerRoot.getFileHandle(owner.digest), owner.digest);
	}

	async function sweepStaging(): Promise<void> {
		for await (const entry of asIterableDirectory(stagingRoot).values()) {
			if (entry.kind === 'file') await stagingRoot.removeEntry(entry.name);
		}
	}

	async function sweepContent(owned: readonly OwnedBlobFile[]): Promise<void> {
		const retained = new Set(
			owned.map((owner) => {
				requireComponent(owner.ownerKey, 'blob owner');
				requireComponent(owner.digest, 'blob digest');
				return `${owner.ownerKey}/${owner.digest}`;
			}),
		);
		for await (const ownerEntry of asIterableDirectory(contentRoot).values()) {
			if (ownerEntry.kind !== 'directory') continue;
			const ownerRoot = await contentRoot.getDirectoryHandle(ownerEntry.name);
			let empty = true;
			for await (const blobEntry of asIterableDirectory(ownerRoot).values()) {
				if (blobEntry.kind !== 'file') {
					empty = false;
					continue;
				}
				if (retained.has(`${ownerEntry.name}/${blobEntry.name}`)) {
					empty = false;
				} else {
					await ownerRoot.removeEntry(blobEntry.name);
				}
			}
			if (empty) await contentRoot.removeEntry(ownerEntry.name);
		}
	}

	return { stage, promote, open, sweepStaging, sweepContent };
}
