# 0426. Copies create independent blobs at their destination

- **Status:** Accepted
- **Date:** 2026-09-22
- **Amended by:** [ADR-0428](0428-whispering-recordings-reference-audio-in-their-containing-store.md) at the Whispering `remoteAudio` example below: recordings resolve audio within their containing store, and saving to Personal creates an independent recording. The generic rule for scope on references crossing stores remains valid.
- **Amends:** [ADR-0089](0089-the-blob-store-is-a-presigned-s3-kernel-and-the-bucket-is-its-only-index.md) at content-addressed keys, mandatory presigned transfer, and its fixed size doctrine; [ADR-0090](0090-the-blob-layer-stays-plaintext-confidentiality-belongs-to-the-encrypting-consumer.md) at its content-hash addressing assumption only; [ADR-0091](0091-blobs-trade-a-file-for-a-durable-content-addressed-url-documents-are-the-only-manifest.md) at URL-as-identity; [ADR-0092](0092-identity-is-the-partition.md) at blob route/key grammar; [ADR-0201](0201-epicenter-owns-one-app-data-root-and-an-app-partitions-its-one-directory-by-a-stable-authority-identifier.md) and [ADR-0404](0404-the-opened-account-owns-application-local-storage.md) at local blob addressing only.

## Context

Preserving an opaque BlobId across independently writable locations made copying
responsible for proving that an occupied destination contained exactly the source
bytes. Random IDs make accidental collisions unlikely, but do not authenticate
an ID supplied by another writer. Lost acknowledgments also required comparison
before a repeated copy could report success.

The application needs a saved copy and a reference to it. It accepts another
remote copy when retrying. Cross-location identity and deduplication do not earn
their protocol or byte-comparison machinery.

## Decision

**Every `add` and `copyFrom` creates a fresh destination BlobId.** Copying preserves
exact bytes and format, returns `Result<BlobId, E>`, and never deletes the source.
The caller saves the returned ID. Separate calls may create duplicate objects.
There is no destination-ID override, public arbitrary-ID writer, global identity
registry, or content-addressed deduplication.

```ts
const copied = await personal.blobs.copyFrom(local.blobs, localId, { signal });
if (copied.error) return copied;
const remoteId = copied.data;
const retained = await local.blobs.copyFrom(personal.blobs, remoteId, { signal });
// retained.data is another new Local ID on success.
```

The destination owns allocation. Remote creation is an authenticated collection
POST at `/api/apps/:appId/principals/:principalId/blobs`; the server allocates
the ID and returns `201 { id }`. Object routes support reads and deletion, not
caller-chosen publication. Local copy allocates once per admitted operation.
Native commands carry distinct validated source and destination IDs.

A BlobId is `blob_`, 21 random lowercase alphanumeric characters, a dot, and a
lowercase alphanumeric extension of 1 to 10 characters. Its format suffix is a
declaration, not content validation. Namespace and ownership belong to the
captured store, not the ID.

| Location | Physical storage |
| --- | --- |
| Browser Local | Origin/profile IndexedDB `epicenter/<namespace>/device/no-account/blobs`, key `blobId` |
| Desktop Local | `<dataRoot>/apps/<namespace>/device/no-account/blobs/<blobId>` |
| Personal | `principals/<principalId>/apps/<namespace>/blobs/<blobId>` in the authority's configured bucket |

Local is independent of sign-in. These paths do not authorize migration or
adoption of historical account-local data. Desktop files remain ordinary files
without metadata sidecars. Browser records commit bytes and their size index
in one transaction.

### Fresh IDs simplify publication, not its lifetime

Publication remains atomic and refuses an occupied key. The server uses
conditional object creation. Completed-object equality checks and success on
an occupied identical key are removed. Source snapshots, descriptor ownership,
cancellation, and both stores' transfer admission/drain remain necessary.

A lost acknowledgment can leave complete destination bytes. Failure does not
promise rollback. When the server allocated the ID but its response was lost,
the client may know only the destination scope. Retrying creates a new object;
there is no hidden reconciliation scan or durable retry queue. Local failures
can retain the destination ID and uncertain native cleanup retains store claims.

A recorder's Stop retry remains one publication attempt with one retained ID
and receipt. Comparing a retry body with that attempt's staged bytes protects
that receipt. This is distinct from comparing two completed objects during a
new copy operation and remains supported.

### Rows retain destination references

A row stores the returned BlobId plus any scope not supplied by its enclosing
store: namespace, authority, and principal. Presentation URLs and credentials
are never durable references. A Local Whispering recording keeps `audioBlobId`
and an optional scoped `remoteAudio` reference. Playback only resolves that
reference through the matching captured Personal account.

The row write follows publication. If it fails, return the new reference so the
caller can recover it; do not delete a potentially useful published object.
Neither row deletion nor store closure deletes blobs. Each copy has independent
retention and deletion. An upload reference is not proof of current availability.

## Consequences

This deletes completed-object byte comparison, same-ID conflict reconciliation,
and client-chosen remote publication. It costs duplicate storage on retries and
an explicit destination reference in callers. It introduces no reservation,
manifest record, physical-key indirection, hash registry, or automatic cleanup.

The public operation is independent of transfer size. The current implementation
still buffers and caps remote uploads at 25 MiB. Replacing that path with bounded
multipart transfer is separate work; this decision does not claim large-upload
or restart-resume support. A future multipart attempt can retain its own private
upload ID without changing the public `copyFrom` result.

See [ADR-0372](0372-local-and-remote-blobs-open-independently.md) for ownership
and [ADR-0427](0427-opening-a-blob-acquires-presentation-without-retaining-a-copy.md)
for disposable presentation.

## Considered alternatives

- Preserve IDs across copies: requires occupied-byte verification across writers
  for a guarantee callers do not need.
- Use a small manifest pointing to immutable physical objects: can support stable
  logical IDs, but adds resolution and cleanup without a current caller.
- Hash all bytes: permits content-addressed comparison but adds hashing and
  cross-owner policy without eliminating transfer lifecycle requirements.
- Remove conditional publication because collisions are rare: weakens immutable
  storage for negligible benefit.
