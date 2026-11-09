/**
 * A file's version (ADR-0824): the SHA-256 of its bytes, for every path, on
 * every store and in every record, so one version names one file's bytes
 * on a computer, in the browser, and on the server. Hashed with Web Crypto,
 * so the same code runs in a page, in Bun, and in Node.
 */
import type { Version } from './device/store.js';

/**
 * Files up to this size are hashed whole when a store lists them; a larger
 * one is named by its stamp and hashed once per change (`stamp-cache.ts`).
 * The desktop shell lists by the same rule (`HASHED_WHOLE_BYTES` in
 * `storage.rs`).
 */
export const HASHED_WHOLE_BYTES = 64 * 1024;

/** The version of `bytes`: their SHA-256, as lowercase hex. */
export async function versionOf(bytes: Uint8Array): Promise<Version> {
	const digest = new Uint8Array(
		await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>),
	);
	let out = '';
	for (const byte of digest) out += byte.toString(16).padStart(2, '0');
	return out as Version;
}
