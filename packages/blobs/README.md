# @epicenter/blobs

Immutable local byte storage, disposable display sources, and contracts for
explicit remote hosting. Applications normally use `app.blobs.local` and
`app.blobs.remote` from `@epicenter/app`.

Rows store ordinary IDs or URLs. This package knows nothing about tables,
row deletion, Yjs, transfer queues, or upload obligations.

## Storage standard

| Platform | Canonical location |
| --- | --- |
| Browser | IndexedDB `epicenter/<appId>/blobs`, within the origin/profile |
| Desktop | `<dataRoot>/apps/<appId>/blobs/<blobId>/{data,metadata.json}` |
| Remote | `principals/<principalId>/apps/<appId>/blobs/<blobId>` in the server's object store |

Local identity is the app ID on this device. Switching accounts or libraries
does not move, hide, or erase local bytes. Remote identity includes both the
account and app. Old account-scoped local directories/databases remain untouched;
the new readers start fresh without migration or fallback.

`BlobId` is `blob_` followed by 21 lowercase alphanumeric characters generated
with a CSPRNG. It is an opaque identity, not a content hash. Mint with
`generateBlobId()` and validate external input with `parseBlobId()`.

## Local primitives

`BlobStore` exposes immutable `put`, `get`, `stat`, `list`, `delete`, `copy`,
and `statMany`. `put` refuses replacement. Missing bytes and collisions return
`BlobNotFound` and `BlobAlreadyExists`; operational failures return
`BlobStoreFailed`. Metadata includes byte size and normalized content type.

`list({ cursor?, limit? })` returns `{ items, nextCursor? }`. Each item contains
`{ id, size, contentType }`. Pages sort IDs lexically and start strictly after
the cursor. The default limit is 100 and the maximum is 1,000. Enumeration reads
metadata without loading bodies, excludes staging and incomplete entries, and
does not promise a snapshot across concurrent writes.

The browser adapter uses IndexedDB transactions and stores ArrayBuffer plus
content type because WebKit does not reliably persist Blob values. The Bun
adapter publishes a directory containing `data` and `metadata.json`, with
staged writes, file/directory sync, and atomic rename. A failed final sync can
leave a committed object even when its caller receives an error.

`copy(sourceId, destinationId)` creates an independently deletable local object
and refuses an occupied destination. Bun uses lazy file reads; the WebView
uses the host's `/api/apps/:appId/blobs/:blobId/copy` route, keeping bytes outside
the WebView. `statMany` preserves input order and per-ID failures.

`BlobSources.open(id)` returns a disposable `{ url }` for display. Browser
sources revoke object URLs on release. Host sources point to the same local
HTTP store; their disposer is a no-op. App ownership releases held display
sources at closure. The source URL is not the persisted reference.

`createBrowserBlobStore({ appId })`, `createBunBlobStore({ directory })`, and
`createWebviewBlobs({ appId })` implement these contracts. The host serves its
canonical app directory; WebViews never maintain a parallel IndexedDB copy.
`eraseBlobStore({ appId })` deletes the browser app's entire blob database and
must not be used for removing one account library.

## Explicit hosting

`RemoteBlobs` supports `add(Blob)`, `addLocal(blobId)`, `get(url)`, `open(url)`,
and `delete(url)`. `@epicenter/client` implements the captured-account transport.
Each upload creates a fresh remote object, initially limited to 25 MiB. There
are no signed upload tickets or persistent transfer workers.

An upload returns a durable, owner-pinned locator:

```text
https://<server>/api/apps/<appId>/principals/<principalId>/blobs/<blobId>
```

The URL is predictable from its components after the server allocates its ID.
It is not a bearer grant. `get` authenticates and returns a Blob; `open` acquires
a temporary display source. Persist the upload URL, release the display source.
Sharing a row does not share its owner's private remote objects.

On desktop, `addLocal` uses the captured account's HTTP broker with a validated
local BlobId. The host checks size before reading the file and streams the file
through its account transport. Audio does not cross the WebView IPC body path.
An interrupted upload can leave an unreferenced remote object. Deleting its row
or local copy does not delete that object.

## Recording publication

`apps/epicenter/src-tauri/src/blobs.rs` and the Bun adapter share the same
canonical path and metadata. Successful native recording Stop publishes there
before returning its BlobId. The browser recorder writes through its runtime's
raw store before returning. No public finished-file token remains.

Bun stages below `.staging/bun/`; native capture stages below `.staging/rust/`.
Only publication exposes complete objects to enumeration. The single host
removes abandoned native staging on startup and never promotes unfinished
recordings. This is not crash recovery.

Run `bun packages/blobs/scripts/native-smoke.ts` to check Rust-produced files
through the independent Bun reader. `bun run --cwd packages/blobs smoke:webkit`
checks browser persistence and disposable sources in WebKit.
