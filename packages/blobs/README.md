# @epicenter/blobs

Opaque blob identity and the shared blob contracts: one `BlobId` names an object locally, remotely, and in rows; `Blobs` is the canonical local store apps read and write; `BlobReplica` is the optional, explicit copy seam (upload, download, purge) to one remote under the same id.

This package is the AGPL contract leaf. It ships no store implementation: local stores are platform-owned (Tauri filesystem, browser IndexedDB) and the replica implementation composes over a `Blobs` store plus the API client. Its only dependencies are `arktype`, `nanoid`, and `wellcrafted`.

## Identity

- `BlobId` is `blob_` + 16 lowercase alphanumerics (CSPRNG nanoid). Safe verbatim as a filesystem name, S3 key segment, URL path segment, and XML text.
- It is **not** a content hash. SHA-256 and dedup are not part of this contract.
- Mint with `generateBlobId()`; parse untrusted input with the `BlobId` arktype validator. The `blob_` prefix exists so the parse boundary can reject the repo's bare-nanoid row ids at runtime, not just at compile time.

## Model

- The local store is canonical for app operations. Rows store only the `BlobId`; rows are the only manifest (no `list`, no `clear`).
- Missing bytes are expected, typed answers: `BlobNotFound` locally, `RemoteBlobNotFound` on the replica. Operational failures (`BlobStoreFailed`, `BlobReplicaFailed`) are separate variants carrying `cause`.
- Replica operations are one-shot and explicit. There is no background sync, no eager download, no retry queue, and no persisted failure state.

## Deliberately absent

- `stat`/`exists`: presence rides `get`'s `BlobNotFound`; size and content type ride the returned `Blob`.
- A `BlobRef`/metadata shape: the web `Blob` already carries `size` and `type`.
- Local `copy`: copying is the replica's job.
