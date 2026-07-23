# 0089. The blob store is a presigned-S3 kernel and the bucket is its only index

- **Status:** Accepted
- **Date:** 2026-07-01
- **Amended by:** [ADR-0092](0092-identity-is-the-partition.md), [ADR-0148](0148-blobs-use-opaque-identifiers-rather-than-content-hashes.md), [ADR-0154](0154-blob-access-is-address-only.md), and [ADR-0173](0173-each-row-owns-at-most-one-write-once-immutable-blob.md) (S3 may remain a private byte backend, but the record slot is the public identity and authority membership source; the bucket and hash are not)

> **2026-07-02 amendment:** Blob keys now use `principals/<principalId>/blobs/<sha256>`. The bucket-only index and presigned-S3 kernel decision are unchanged.

## Context

Epicenter needs a home for bytes too large for git or a Yjs doc (media, archives, exports). Worker request-body caps are edge-enforced, so bytes must not transit the Worker; R2 enforces a whole-object `x-amz-checksum-sha256` only on a single PutObject, so multipart uploads cannot carry content addressing; and a Workers-native `R2Bucket` binding is a runtime lock-in that a SigV4 presigned URL is not. A previous blob subsystem was deleted in January 2026 for having no consumers, so the surface must stay minimal.

## Decision

Blobs live in one S3-compatible bucket under owner-scoped content-addressed keys, `owners/<ownerId>/blobs/<sha256>`, and the bucket is the store's only state. The original server implementation minted a presigned single PUT with the base64 checksum and content type pinned into the signature (the client echoed them verbatim; the store rejected bytes that did not match their address), and answered reads with a 302 to a short-TTL presigned GET. There was no blob database, queue, or confirm endpoint: the object appearing under its hash was the record of a successful upload, and listing was a signed `ListObjectsV2`. Everything used standard SigV4, so the same code ran against R2, MinIO, Garage, or S3 from a Worker or a Bun process. ADR-0173 later deleted this public surface and retained object storage only as a private byte backend beneath record-owned membership.

## Consequences

Dedupe is a HEAD on the owner-scoped key, so re-uploading identical bytes is free and idempotent within one owner; content is deliberately never addressed across owners (a cross-owner store would be an equality oracle). The 5 GiB single-PUT ceiling is the integrity contract, not a temporary limit: multipart is refused because its composite checksum breaks content addressing. Usage is computed by list-and-sum until real metering lands. The store never learns whether bytes are plaintext or ciphertext (see ADR-0090).

## Considered alternatives

- `R2Bucket` binding: Workers-only API, and the body cap forces multipart, which forfeits store-enforced content addressing.
- A blob table beside the bucket: two sources of truth that drift; the bucket already answers every query the system asks.
- An upload-confirm endpoint: redundant; the object under its hash is the confirmation.
