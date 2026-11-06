/**
 * The hashes a store names a file by (ADR-0808): a file's version is the Git
 * blob id of what the repository stores at its path. For a note, and any
 * hidden file, that is the blob of its bytes; for an attachment (every
 * other file, `storedWithLfs`), the blob of its canonical Git LFS pointer,
 * which names its sha256 and size. Hashed with Web Crypto, so the same
 * code runs in a page, in Bun, and in Node.
 */
import { storedWithLfs } from '@epicenter/definition/contract';
import { writePointer } from '@epicenter/definition/merge';
import type { BlobId } from './device/store.js';

const encoder = new TextEncoder();

function hex(digest: ArrayBuffer): string {
	let out = '';
	for (const byte of new Uint8Array(digest))
		out += byte.toString(16).padStart(2, '0');
	return out;
}

/** The SHA-256 of `bytes`, as lowercase hex: an attachment's Git LFS object id. */
export async function sha256Of(bytes: Uint8Array): Promise<string> {
	return hex(
		await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>),
	);
}

/** The Git blob id of `bytes` (`git hash-object`): SHA-1 over `blob <length>\0<bytes>`. */
export async function gitBlobId(bytes: Uint8Array): Promise<BlobId> {
	const header = encoder.encode(`blob ${bytes.byteLength}\0`);
	const object = new Uint8Array(header.byteLength + bytes.byteLength);
	object.set(header);
	object.set(bytes, header.byteLength);
	return hex(await crypto.subtle.digest('SHA-1', object)) as BlobId;
}

/** The version of an attachment whose bytes hash to `oid` and are `size` long: its canonical pointer's blob id. */
export function pointerBlobId(oid: string, size: number): Promise<BlobId> {
	return gitBlobId(encoder.encode(writePointer({ oid, size })));
}

/** The version of `bytes` at `path`, as every store names it. */
export async function blobIdOf(
	path: string,
	bytes: Uint8Array,
): Promise<BlobId> {
	if (!storedWithLfs(path)) return gitBlobId(bytes);
	return pointerBlobId(await sha256Of(bytes), bytes.byteLength);
}
