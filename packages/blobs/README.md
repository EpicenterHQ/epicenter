# @epicenter/blobs

Local byte storage and one-shot attachment I/O. `BlobStore` holds immutable
files, and `BlobSources` acquires disposable playback URLs over local bytes.
The data library owns attachment destinations, transfer obligations and retries.
The legacy `BlobRemote` copy primitive remains for low-level compatibility;
opened applications no longer expose its upload/download/purge coordination.

This package is the AGPL blob boundary. The root export owns the portable
contracts; platform subpaths own the implementations that satisfy them. The
browser subpath provides IndexedDB storage and object-URL sources, one
database per application per account at
`epicenter/<app-id>/accounts/<authority-id>/<principal-id>/blobs`
(`browserBlobStoreName`), the sibling of that account's replica address;
`createBrowserBlobStore` takes the scope and never a raw name. The local
partition uses the same scoped codec with the `local` principal. `eraseBlobStore`
deletes one scoped database under an exclusive Web Lock. The Bun
subpath provides filesystem storage for desktop hosts and scripts. The WebView
subpath adapts the authenticated desktop origin back to the same portable
contracts, including sources that hand out its stable relative media URL.
Remote implementations compose over `BlobStore` rather than inventing a second
application-facing store.

Browser remote implementations may compose directly over `BlobStore`: the
public browser adapter is Blob-valued. Its IndexedDB codec stores
`ArrayBuffer` plus content type because WebKit rejects persisted `Blob`/`File`
values, then reconstructs a `Blob` on read. Desktop remote transfer is
host-owned instead. Native attachments stream through Rust reqwest over the
same filesystem store without routing audio through the WebView; composing a
desktop remote over the WebView adapter's Blob-valued `get` would defeat that
boundary.

## Identity

- `BlobId` is `blob_` + 21 lowercase alphanumerics (CSPRNG nanoid). Safe verbatim as a filesystem name, S3 key segment, URL path segment, and XML text.
- It is **not** a content hash. Attachments use a distinct row-derived storage
  address and retain SHA-256, size and MIME evidence for immutable verification.
- Mint with `generateBlobId()`; parse untrusted input with `parseBlobId()`. The
  `blob_` prefix exists so the parse boundary can reject the repo's bare-nanoid
  row ids at runtime, not just at compile time.

## Model

- The local store is canonical for app operations. Blob capabilities are address-only: they act on ids the application already knows (no `list`, no `clear`), and application data supplies each id's meaning.
- Blob bytes are immutable under an id. `put` refuses replacement, and `stat` reads size and content type without loading the bytes. `statMany(ids)` returns one result per supplied id in order; the browser uses one metadata transaction and never enumerates ids.
- Missing bytes and immutable-ID collisions are expected, typed answers:
  `BlobNotFound`, `RemoteBlobNotFound`, and `BlobAlreadyExists`. Operational
  failures (`BlobStoreFailed`, `BlobRemoteFailed`) are separate variants
  carrying `cause`.
- Attachment I/O is one-shot. The owning data library derives automatic uploads
  and downloads from completed rows and local origin/acknowledgment metadata.
  Applications do not run reconciliation or interpret historical upload markers.
- Attachment downloads verify complete bytes before immutable installation.
  An occupied address succeeds only after identical-content verification.
  Downloaded files carry no upload origin. The older `BlobRemote` collision
  semantics are not used by attachment synchronization.
- Playback URLs come from `BlobSources`, a sibling capability beside the
  store, never a method on `BlobStore`. Each `open` returns one standard
  `Disposable` handle: release is always safe and idempotent. The browser
  implementation revokes its object URL exactly once; the WebView
  implementation returns the host's stable same-origin locator and its
  disposer is a harmless no-op. Bounded imperative consumers may `using` the
  handle; component lifecycles call `[Symbol.dispose]()` from their cleanup.

For an independent local lifetime, mint a new `BlobId` and call
`copy(sourceId, destinationId)`. Both ids belong to the same captured store.
COPY preserves the source and refuses an existing destination, even when
both ids are equal. The new id can be deleted independently. Missing sources
return `BlobNotFound`; destination collisions return `BlobAlreadyExists`.

The browser holds its shared erase lock across `get` and immutable `put`.
Bun composes the same verbs with a lazy `BunFile`, so `Bun.write` copies the
file without a recording-sized JavaScript buffer. `createWebviewBlobs` captures
`{ appId, account }` once for local operations, playback, and remote transfer.
`account` is an `AccountIdentity` from `@epicenter/principal`, or explicit `null`
for the local library. Local URLs use `/api/apps/:appId/local/blobs/:blobId`;
account URLs use
`/api/apps/:appId/accounts/:authorityId/:principalId/blobs/:blobId`.
COPY appends `/copy` to the destination URL and sends JSON `{ sourceId }`.
Query selectors and the previous route families are rejected; omitted identity
does not select local storage. The host resolves both ids in that one
store; bytes never travel through the WebView. HTTP 404 names the source,
409 names the destination, and 204 reports success.

## Bun staging ownership

The native counterpart is `apps/epicenter/src-tauri/src/blobs.rs`. It owns
validated application/dataset paths, generic metadata, publication, and native
staging cleanup. The recorder supplies WAV bytes and their content type; audio
decoding belongs to the host's audio module. The `/native` TypeScript subpath
captures `{ appId, scope }` at the IPC boundary for recording, transcription,
and upload encoding. These are addresses in the same store, never paths supplied
by a WebView.

`bun packages/blobs/scripts/native-smoke.ts` verifies that the Bun store reads
actual Rust-produced publication fixtures, including normalized metadata.

Bun uploads stage under `.staging/bun/`; the Rust recorder stages native
captures under `.staging/rust/`. Each operation removes its own staging
directory when it fails.

COPY uses the existing staged publication path. A successful rename exposes
the complete body and metadata together. This is an atomic visibility
guarantee, not a power-loss durability guarantee: Bun does not fsync the files
or containing directories. A process crash can leave unreferenced staging
files, and this package does not recover or promote them.

The Rust recorder additionally deletes `.staging/rust/` wholesale at host
startup, because a recording is now written progressively and a host that dies
mid-capture leaves a partial WAV behind (ADR-0184). That sweep is safe only
because the subtree has exactly one writer and Epicenter is single-instance, so
no live publication can be in it. It deletes and never promotes: a partial
capture is not a blob and startup does not make it one. Bun has no equivalent
sweep, and adding one would need the exclusive writer lease this deliberately
does not require.

## Deliberately absent

- A `BlobRef` wrapper: callers already have the `BlobId`, and `stat` returns the
  only metadata the store owns.
