import { type } from 'arktype';
import { customAlphabet } from 'nanoid';
import type { Brand } from 'wellcrafted/brand';

/**
 * @fileoverview BlobId: the one opaque identifier a blob carries everywhere.
 *
 * Each immutable blob has one ID across local and remote copies. Creating an
 * owning attachment from an existing blob copies its bytes into a fresh ID,
 * so deleting either attachment cannot delete the other's bytes.
 * The id is NOT a content hash: it says nothing about the
 * bytes, and SHA-256 or dedup never appear in this contract.
 *
 * Representation: `blob_` followed by 21 lowercase alphanumerics
 * (CSPRNG-backed nanoid, ~108.6 bits). Every character is safe as a filesystem name, an S3 key
 * segment, a URL path segment, and XML text, so implementations can use the
 * id verbatim as a storage key.
 *
 * The `blob_` prefix is runtime nominal identity: the repo's other minted ids
 * are bare 16-char nanoids, so an unprefixed BlobId would be
 * indistinguishable from a row id at every parse boundary. The prefix lets
 * the validator actually reject foreign ids instead of accepting any nanoid.
 */

/**
 * Lowercase alphanumeric body, minted by nanoid. The 21-character body has a
 * materially larger collision envelope than the repo's device-local row ids;
 * blob ids become durable object keys across devices, stores, and apps.
 */
const generateBody = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 21);

/** Unanchored BlobId pattern for URL routers that add their own boundaries. */
export const BLOB_ID_ROUTE_REGEX = 'blob_[a-z0-9]{21}';

/**
 * Opaque, globally unique blob identifier.
 *
 * The type is declared first and the validator is annotated to it, so the brand
 * is written once and the pattern conforms to it rather than the reverse. Both
 * carry one PascalCase name: `BlobId` is the branded string in type position
 * and the arktype validator in value position (parse untrusted input with
 * `BlobId(value)` and branch on `instanceof type.errors`). Mint fresh ids with
 * {@link generateBlobId}; never cast raw strings.
 *
 * The literal pattern must stay in lockstep with {@link generateBlobId}; the
 * mint/parse round-trip test locks the two together.
 */
export type BlobId = string & Brand<'BlobId'>;
export const BlobId = type(new RegExp(`^${BLOB_ID_ROUTE_REGEX}$`)).as<BlobId>();

/**
 * Mint a fresh {@link BlobId}. Every other appearance of the id in TypeScript
 * (row cell, local store key, remote key) is a copy of a minted value or a
 * parse of one via the {@link BlobId} validator.
 *
 * One other implementation mints this same shape: Epicenter's native recorder,
 * in `apps/epicenter/src-tauri/src/recorder/blob.rs`, because the host decides
 * which recording exists and hands the id back over IPC. The two mints must
 * agree, and each side has a round-trip test against its own parse to keep them
 * from drifting apart.
 */
export function generateBlobId(): BlobId {
	return `blob_${generateBody()}` as BlobId;
}

/** Parse an untrusted value without exposing Arktype's error representation. */
export function parseBlobId(value: unknown): BlobId | undefined {
	const parsed = BlobId(value);
	return parsed instanceof type.errors ? undefined : parsed;
}
