# 0154. Blob access is address-only

- **Status:** Accepted
- **Date:** 2026-07-19
- **Amends:** [ADR-0089](0089-the-blob-store-is-a-presigned-s3-kernel-and-the-bucket-is-its-only-index.md) and [ADR-0091](0091-blobs-trade-a-file-for-a-durable-content-addressed-url-documents-are-the-only-manifest.md)
- **Amended by:** [ADR-0393](0393-a-blob-is-addressed-by-its-row-and-the-account-holds-every-one.md) at "takes a `BlobId` the caller already holds" and "Bulk operations iterate ids from application data": the address is the row, `<table>/<row-id>`, and the inventory is the rows whose one declared `field.blob()` cell is not null. Address-only and the absence of `list` stand for clients; the library's authority enumerates its own objects for the reclaim pass in [ADR-0394](0394-a-backup-is-the-library-s-folder-kept-by-the-authority.md).

## Context

The blob store exposed `GET /api/blobs`, `client.blobs.list`, and `epicenter
blobs ls`, which enumerate a principal's remote objects. Enumeration teaches a
second source of truth: it invites recovery flows and sync tools that
reconstruct application state from storage keys, while the actual meaning of
every blob lives in the application data that cites it. ADR-0149 already made
local stores canonical and remote copies explicit one-shot operations.

## Decision

Blob capabilities are address-only. Every public blob operation (local store,
remote copy, HTTP route, CLI verb) takes a `BlobId` the caller already holds;
none enumerates ids or reconstructs application state. Application data
supplies each id's meaning: rows, documents, and citations are the only
inventory. The bucket remains the store's only internal index; server-side
prefix listing survives solely as a deployment operation (account deletion's
sweep), never as a public surface.

## Consequences

`GET /api/blobs`, `client.blobs.list`, and `epicenter blobs ls` are removed
without replacement. A blob whose every citation is lost is unreachable by
design; there is no recovery-by-enumeration, and total loss of the citing data
is accepted as loss of the blobs. Bulk operations iterate ids from application
data. Storage metering, if ever needed, is a deployment-internal measurement,
not a user-facing listing.

## Considered alternatives

- Keep listing as a hidden admin verb: preserves the recovery temptation while
  pretending the surface is gone; deployment sweeps already cover the one real
  internal need.
- Replace listing with a per-app manifest export: rebuilds the same second
  source of truth one layer higher.
