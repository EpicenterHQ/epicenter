import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export type StoredBlob = {
	hash: string;
	bytes: number;
	mime: string | null;
	isNew: boolean;
};

async function ensurePrivateDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	await chmod(path, 0o700);
}

/** Hash a file incrementally so importing a large video never buffers it in memory. */
export async function hashFile(path: string): Promise<string> {
	const hasher = new Bun.CryptoHasher('sha256');
	for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
	return hasher.digest('hex');
}

/**
 * Put one file in the immutable blob store. The final path is derived only from
 * its bytes, so a repeated import reuses the existing file.
 */
export async function storeBlob({
	sourcePath,
	blobDir,
	hash: knownHash,
}: {
	sourcePath: string;
	blobDir: string;
	hash?: string;
}): Promise<StoredBlob> {
	const hash = knownHash ?? (await hashFile(sourcePath));
	const shardDir = join(blobDir, hash.slice(0, 2));
	const destination = join(shardDir, hash);
	await ensurePrivateDir(blobDir);
	await ensurePrivateDir(shardDir);

	const sourceStat = await stat(sourcePath);
	const file = Bun.file(sourcePath);
	const mime = file.type || null;
	const exists = await Bun.file(destination).exists();
	if (!exists) {
		const temporary = join(shardDir, `.${hash}.${randomUUID()}.tmp`);
		try {
			await copyFile(sourcePath, temporary);
			await chmod(temporary, 0o600);
			await rename(temporary, destination);
		} finally {
			await rm(temporary, { force: true });
		}
	}

	return {
		hash,
		bytes: sourceStat.size,
		mime,
		isNew: !exists,
	};
}
