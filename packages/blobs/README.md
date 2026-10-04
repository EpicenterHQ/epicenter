# @epicenter/blobs

Opaque blob identity and the shared blob contracts: one `BlobId` names an object locally, remotely, and in rows; `Blobs` is the canonical local store apps read and write; `BlobReplica` is the optional, explicit copy seam (upload, download, purge) to one remote under the same id; `BlobSources` acquires disposable playback URLs over the local bytes.

This package is the AGPL blob boundary. The root export owns the portable
contracts; platform subpaths own the implementations that satisfy them. The
browser subpath provides IndexedDB storage and object-URL sources. The Bun
subpath provides filesystem storage for desktop hosts and scripts. The WebView
subpath adapts the authenticated desktop origin back to the same portable
contracts, including sources that hand out its stable relative media URL.
Replica implementations compose over `Blobs` rather than inventing a second
application-facing store.

Browser replica implementations may compose directly over `Blobs`: the public
browser adapter is Blob-valued. Its IndexedDB codec stores `ArrayBuffer` plus
content type because WebKit rejects persisted `Blob`/`File` values, then
reconstructs a `Blob` on read. Desktop replication is host-owned instead. It
must stream between the Bun filesystem store and the remote without routing a
whole recording through the WebView; composing a desktop replica over the
WebView adapter's Blob-valued `get` would defeat that boundary.

## Identity

- `BlobId` is `blob_` + 21 lowercase alphanumerics (CSPRNG nanoid). Safe verbatim as a filesystem name, S3 key segment, URL path segment, and XML text.
- It is **not** a content hash. SHA-256 and dedup are not part of this contract.
- Mint with `generateBlobId()`; parse untrusted input with `parseBlobId()`. The
  `blob_` prefix exists so the parse boundary can reject the repo's bare-nanoid
  row ids at runtime, not just at compile time.

## Model

- The local store is canonical for app operations. Rows store only the `BlobId`; rows are the only manifest (no `list`, no `clear`).
- Blob bytes are immutable under an id. `put` refuses replacement, and `stat` reads size and content type without loading the bytes.
- Missing bytes and immutable-ID collisions are expected, typed answers:
  `BlobNotFound`, `RemoteBlobNotFound`, and `BlobAlreadyExists`. Operational
  failures (`BlobStoreFailed`, `BlobReplicaFailed`) are separate variants
  carrying `cause`.
- Replica operations are one-shot and explicit. There is no background sync, no eager download, no retry queue, and no persisted failure state.
- A replica download is idempotent. If the immutable id already exists in the
  canonical local store, the replica implementation consumes that collision as
  success because the requested local state is already present.
- Playback URLs come from `BlobSources`, a sibling capability beside the
  store, never a method on `Blobs`. Each `open` returns one standard
  `Disposable` handle: release is always safe and idempotent. The browser
  implementation revokes its object URL exactly once; the WebView
  implementation returns the host's stable same-origin locator and its
  disposer is a harmless no-op. Bounded imperative consumers may `using` the
  handle; component lifecycles call `[Symbol.dispose]()` from their cleanup.

For an independent local lifetime, compose the existing verbs: `get` the
source bytes, mint a new `BlobId`, then `put` those bytes under the new id. That
duplicates the bytes and makes the new id independently deletable. A dedicated
`copy` verb is not part of the contract until a live caller needs more than
that composition.

## Bun staging ownership

Bun uploads stage under `.staging/bun/`; the Rust recorder stages native
captures under `.staging/rust/`. Each operation removes its own staging
directory when it fails. Neither writer sweeps abandoned directories at
startup yet: safe crash cleanup needs an exclusive writer lease or equivalent
liveness proof, otherwise one process could erase another live publication.

## Deliberately absent

- A `BlobRef` wrapper: callers already have the `BlobId`, and `stat` returns the
  only metadata the store owns.
- Local `copy`: `get` + a new `BlobId` + `put` is the explicit independent-life
  composition, and there is no live caller that earns another primitive.
