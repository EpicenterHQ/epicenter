/**
 * The server's byte port for Git LFS objects (the hosting plan's blob byte
 * port), apart from the device's `BlobStore` (client/blobs), whose contract
 * differs: a device names bytes by sealing them, a server is told the oid
 * and size and keeps bytes only if they are those. `put` never overwrites;
 * a successful one means the whole verified object is durable and readable,
 * and only then does the wire record presence (`server.upload`).
 *
 * Adapters: memory (`memory-lfs-store.ts`), the filesystem default for a
 * self-hosted server (`bun/lfs-store.ts`), and R2 (`r2-lfs-store.ts`, not
 * deployed yet). Each passes `LFS_STORE_CHECKS` (`lfs-store.checks.ts`).
 */
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

export const LFS_OID = /^[0-9a-f]{64}$/;

export const LfsStoreError = defineErrors({
	Mismatch: () => ({
		message: 'The bytes do not match the object id and size',
	}),
	Failed: ({ cause }: { cause: unknown }) => ({
		message: `The bytes could not be stored: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type LfsStoreError = InferErrors<typeof LfsStoreError>;

/** Durable server-side bytes. Successful put means a complete verified object is readable. */
export type LfsStore = {
	put(
		oid: string,
		size: number,
		body: ReadableStream<Uint8Array>,
	): Promise<Result<'stored' | 'present', LfsStoreError>>;
	has(oid: string): Promise<boolean>;
	get(
		oid: string,
	): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>;
};
