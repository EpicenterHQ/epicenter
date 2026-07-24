# 0148. Blobs use opaque identifiers rather than content hashes

- **Status:** Superseded
- **Date:** 2026-07-18
- **Superseded by:** [ADR-0173](0173-each-row-owns-at-most-one-write-once-immutable-blob.md)
- **Amends:** [ADR-0089](0089-the-blob-store-is-a-presigned-s3-kernel-and-the-bucket-is-its-only-index.md), [ADR-0091](0091-blobs-trade-a-file-for-a-durable-content-addressed-url-documents-are-the-only-manifest.md), and [ADR-0092](0092-identity-is-the-partition.md)

## Context

Content addressing makes every caller buffer and hash complete inputs, exposes
integrity machinery as product identity, and couples local recording storage to
the hosted object's key. Epicenter now needs one identity that a browser,
desktop host, workspace row, and optional remote store can share without a
mapping table.

## Decision

Each blob receives one caller-minted opaque `BlobId`, represented as `blob_`
plus 21 lowercase alphanumeric characters, and every store uses that ID
verbatim. Blob bytes are immutable under their ID. A content hash may exist as
private transport-integrity metadata, but it is not an address, public field,
deduplication key, or API parameter.

## Consequences

The client no longer needs to hash a complete object before naming it, and the
server no longer performs a HEAD request for deduplication. Local rows and
remote objects use the same ID without a hash mapping. Identical bytes occupy
separate objects, and an ID collision must be refused rather than overwrite
bytes. Existing hash-shaped remote URLs and objects become unreachable at the
cutover. There is no legacy validator, redirect, rekeying migration, or
dual-identity reader. The clean break also removes mandatory upload pre-hashing:
a private transport-integrity mechanism may remain only if it supports one-pass
transfer.

Remote creation signs `If-None-Match: *` so the object store atomically refuses
replacement under an existing ID. This is immutable creation, not content
deduplication, and removes the racy HEAD-before-PUT check. Presigned uploads use
`UNSIGNED-PAYLOAD`; TLS, authenticated ticket minting, the signed object key,
and the object store's durability are the accepted integrity boundary.

## Considered alternatives

- Keep SHA-256 as the public ID: preserves current URLs but retains mandatory
  hashing and couples identity to byte representation.
- Add an opaque ID to hash mapping: preserves deduplication by adding a second
  index and identity, the exact complexity this decision removes.
