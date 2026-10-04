import { type } from 'arktype';
import { customAlphabet } from 'nanoid';
import type { Brand } from 'wellcrafted/brand';

/**
 * @fileoverview BlobId: the one opaque identifier a blob carries everywhere.
 *
 * A blob is minted exactly one id at record time, and that same id names the
 * object in the local store, on the optional remote replica, and in the row
 * that references it. The id is NOT a content hash: it says nothing about the
 * bytes, and SHA-256 or dedup never appear in this contract.
 *
 * Representation: `blob_` followed by 16 lowercase alphanumerics
 * (CSPRNG-backed nanoid, ~82.7 bits, the same envelope as the workspace id
 * generator). Every character is safe as a filesystem name, an S3 key
 * segment, a URL path segment, and XML text, so implementations can use the
 * id verbatim as a storage key.
 *
 * The `blob_` prefix is runtime nominal identity: the repo's other minted ids
 * are bare 16-char nanoids, so an unprefixed BlobId would be
 * indistinguishable from a row id at every parse boundary. The prefix lets
 * the validator actually reject foreign ids instead of accepting any nanoid.
 */

/**
 * Lowercase alphanumeric body, minted by nanoid. Mirrors the workspace id
 * envelope (36-symbol alphabet, 16 chars): collision-only, never a secret.
 */
const generateBody = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 16);

/**
 * Opaque, globally unique blob identifier.
 *
 * Validator-first dual declaration: `BlobId` is the arktype validator in
 * value position (parse untrusted input with `BlobId(value)` and branch on
 * `instanceof type.errors`) and the branded string type in type position.
 * Mint fresh ids with {@link generateBlobId}; never cast raw strings.
 *
 * The literal pattern must stay in lockstep with {@link generateBlobId}; the
 * mint/parse round-trip test locks the two together.
 */
export const BlobId = type(/^blob_[a-z0-9]{16}$/).as<
	string & Brand<'BlobId'>
>();
export type BlobId = typeof BlobId.infer;

/**
 * Mint a fresh {@link BlobId}. The only place a BlobId comes into existence;
 * every other appearance of the id (row cell, local store key, replica key)
 * is a copy of a minted value or a parse of one via the {@link BlobId}
 * validator.
 */
export function generateBlobId(): BlobId {
	return `blob_${generateBody()}` as BlobId;
}
