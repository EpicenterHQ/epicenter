/**
 * Server-only derived identifiers built from a `PrincipalId`.
 *
 * `PrincipalId` itself lives in `@epicenter/identity` because it flows through
 * `/api/session`, the persisted auth cell, and every client (browser,
 * extension, CLI, daemon). What lives here are the durable strings only
 * a server cares about: Durable Object names, R2 object keys, and the
 * partition path segment they all share.
 *
 * Per-user and instance share the exact same path shape. The partition
 * segment is always `principals/<principalId>`. In the hosted topology the
 * principal may be a Better Auth user id; on an instance it is the pinned constant
 * `INSTANCE_PRINCIPAL_ID` (the literal `instance`). The path is honest either way:
 * every durable identifier the server writes is rooted at
 * `principals/<principalId>`.
 *
 * Every durable string follows the rule:
 *   `principals/<principalId>/<resource type>/<id>`
 *
 * One shape, one helper per resource type, no ternary.
 */

import type { BlobId } from '@epicenter/blobs';
import type { PrincipalId } from '@epicenter/identity';

/**
 * Durable Object name template for one AttachRelay pair (ADR-0115). One DO per
 * `(principalId, hostId)`: the host and every client of that pair route to the
 * same actor, which is the invariant the in-DO {@link createAttachRelay}
 * coordinator needs to see both sockets. The `principalId` segment is the
 * partition, so a client that guesses another principal's `hostId` still lands
 * in its OWN partition's DO (an empty one) and pairs with no host.
 */
export type AttachHostDoName = `principals/${string}/attach-hosts/${string}`;

/**
 * R2 object key template for an opaque-id blob, single form. The BlobId is
 * used verbatim: R2 is the index, with no separate database row. See
 * ADR-0089 (presigned S3 kernel) as amended by ADR-0148 (opaque BlobId).
 */
export type BlobR2Key = `principals/${string}/blobs/${string}`;

/** Common prefix for one partition's blobs, used by the S3 client's list enumeration. */
export type BlobPrincipalPrefix = `principals/${string}/blobs/`;

/** Durable name of one AttachRelay pair's Cloudflare Durable Object. */
export function attachHostDoName(
	principalId: PrincipalId,
	hostId: string,
): AttachHostDoName {
	return `principals/${principalId}/attach-hosts/${hostId}`;
}

/** Durable key of an opaque-id blob's R2 object. */
export function blobKey(principalId: PrincipalId, blobId: BlobId): BlobR2Key {
	return `principals/${principalId}/blobs/${blobId}`;
}

/** Prefix matching every blob this partition has stored. */
export function blobPrincipalPrefix(
	principalId: PrincipalId,
): BlobPrincipalPrefix {
	return `principals/${principalId}/blobs/`;
}
