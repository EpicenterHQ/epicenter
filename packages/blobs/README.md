# @epicenter/blobs

Stores own blob access through `local.blobs` and `personal.blobs` in
`@epicenter/app`. This package owns immutable byte adapters, IDs, formats, and
presentation contracts. Rows hold descriptive metadata and BlobIds; deleting a
row does not delete bytes. Whispering borrows blob access from these stores.

## Storage and identity

Local uses the fixed no-account namespace. Personal captures its authority,
principal, and definition ID. Local bytes do not synchronize.

`add(Blob)` and `destination.copyFrom(source, id)` return fresh destination IDs.
Copying preserves exact bytes. Repeated calls may create duplicate objects.
Both source and destination track the transfer. Local accepts Local or Personal;
Personal accepts Local. Shared and Personal-to-Personal copies are deferred.

| Platform | Location |
| --- | --- |
| Browser | IndexedDB database `epicenter/<appId>/device/<owner>/blobs`, within the origin/profile |
| Desktop | One ordinary file at `<dataRoot>/apps/<appId>/device/<owner>/blobs/<blobId>` |
| Remote | `principals/<principalId>/apps/<appId>/blobs/<blobId>` in the server's object store |

`<owner>` is `no-account` for LocalBlobs. Account changes leave these bytes in
place. Historical account-local directories remain untouched. Native capture and
Bun HTTP reads use the source handle's directory. Desktop WebViews read that
HTTP store instead of maintaining another copy in IndexedDB.

`BlobId` is `blob_`, 21 random lowercase alphanumeric characters, one dot, and a
lowercase alphanumeric extension of 1 to 10 characters. Mint a complete key with
`generateBlobId(extension)` and validate external input with `parseBlobId()`.
The key is an opaque identity, not a content hash. Changing a title leaves it
unchanged; conversion creates different bytes under a different key.

The September 17, 2026 cutover is a clean break: the user confirmed there are
zero users and no existing data. There is no migration, reset, fallback reader,
or automatic cleanup. Extensionless references are rejected. Opening a prior
browser schema fails without converting or erasing it.

## Local operations

The raw `BlobStore` exposes `put`, `get`, `stat`, `list`, and `delete`.
Store-owned access replaces raw `put` with `add(Blob)`, which selects the format
and mints the key, and adds immutable `copyFrom` and `open` for presentation. Known declared media types
must agree with the key's format; saving does not convert bytes.

`put` refuses an occupied final key. Missing reads return `BlobNotFound`,
collisions return `BlobAlreadyExists`, and storage failures return
`BlobStoreFailed`. Deleting missing bytes succeeds. Local deletion acts on one
validated key and does not consult rows or remote storage.

`stat` returns `{ size, contentType }` without reading the payload.
`list({ cursor?, limit? })` returns `{ items, nextCursor? }`; each item contains
`{ id, size, contentType }`. Pages sort keys lexically and start strictly after
the cursor. The default limit is 100 and the maximum is 1,000. Listing includes
rowless saved objects, excludes staging and nonregular entries, and is not a
snapshot across concurrent writes.

Browser schema version 2 contains one `blobs` object store with `keyPath: 'id'`.
Each record is `{ id, bytes, size }`, where `bytes` is an ArrayBuffer and the
writer derives `size` from those bytes. One transaction commits the record and
its `[id, size]` index entry. `stat` and `list` use index key cursors instead of
retrieving audio buffers. No per-object media type or recording metadata is
stored in IndexedDB.

The browser store receives `idb: { factory, keyRange }` from its runtime.
Production supplies the native IndexedDB factory and key-range constructor;
memory runtimes supply both from their simulation without replacing browser
globals. Compound index ranges use the constructor paired with that factory.

Desktop files have no per-blob directories or JSON sidecars. Bun and Rust write
same-directory temporary files named `.bun-*.tmp` and `.rust-*.tmp`. Publication
flushes completed bytes, then creates a hard link without replacing an occupied
name. Unix publishers sync directory entries before acknowledging success.
Readers reject symbolic links and nonregular final entries. The configured app
directory and its ancestors are trusted; these path-based operations do not
protect against hostile replacement of the directory itself.

Failed publication retains finalized bytes for retry. A failure after linking
can leave a readable final object before the caller receives success. Bun
compares fresh retry bodies against its retained staged bytes; native capture
keeps its publication receipt. Cleanup acts only on the writer's own staging.
Startup does not sweep historical files or another publisher's work.

`open(key)` returns a disposable presentation URL. Browser sources revoke object
URLs on release; host sources point to the local HTTP store. Persist the key,
not a presentation URL. Store closure releases acquired display resources and
drains admitted operations without deleting committed bytes.

Bun's `openFile(key)` lends a descriptor-backed `{ file, stat, close }` for
streaming. Its caller must close the handle after consumption, cancellation,
or failure. The desktop host owns that cleanup for GET, ranges, and uploads;
HEAD only reads metadata. Browser operations rely on IndexedDB transactions for
atomic publication. The owning store fences admission and drains operations before releasing
its storage ownership; the blob store does not acquire per-operation Web Locks.

## Format and filenames

`blob-format.ts` owns supported media types, suffixes, aliases, and equivalence.
A supported producer MIME type wins. Only an absent or generic MIME type can use
a File's supported suffix; unknown formats use `.bin`. Filename evidence
survives Blob-typed inputs without requiring a runtime `File` constructor.

Local reads return the conventional type for the key. For example, `.wav` is
`audio/wav`, `.webm` is `video/webm`, and `.ogg` and `.opus` are `audio/ogg`.
JSON and text use `application/json;charset=utf-8` and
`text/plain;charset=utf-8`, matching Bun's Blob behavior. These labels do not
preserve arbitrary producer MIME parameters or convert the bytes.

Direct uploads retain a declared MIME type and its parameters. Empty-MIME Files
use the same format policy as local saves. Uploading a saved file uses its
conventional type. Backup-specific storage and structural archives have been
removed. Local bytes and explicitly hosted objects remain independent of row
lifetime and working-copy recovery.

The [ADR-0394 folder direction](../../docs/adr/0394-materialization-contains-documents-and-blob-references.md)
is document-only: Markdown, settings, and the checkout manifest carry
references, without copying or fetching local or remote blob payloads. The
[ADR-0395 recovery direction](../../docs/adr/0395-restore-is-one-request-that-carries-its-own-safety-copy.md)
uses the current working-copy baseline rather than replacing it with an old
manifest.

Download callers supply complete friendly filenames. Download adapters save
those names without choosing another audio extension. ZIP exports remain ZIPs.

## Recording and hosting

Successful recording Stop publishes completed audio and returns
`{ blobId, durationMs, byteLength }`. `localBlobs.open(blobId)` resolves that
saved key on either platform. Native capture produces WAV; browser capture uses
its actual recorder output format. The saved key remains fixed through retries.
Row creation happens afterward, so a failed row write can leave enumerable
saved bytes. Cancel and Store closure cannot retract a committed blob.

Personal exposes `add`, `copyFrom`, `get`, `open`, and `delete`, addressed by
BlobId. Collection POST uses the authenticated principal and allocates a fresh
server ID. Conditional S3 creation prevents replacement; an occupied key fails. Remote publication
remains bounded to 25 MiB. No synchronization queue or hash registry is added.

Native uploads carry source namespace and ID through the captured Account.
Native downloads use a private publication command; only its terminal 201
acknowledgment with the destination ID establishes placement. Neither routes payloads through the WebView.
A lost native acknowledgment retains both store claims because client cancellation
does not prove host cleanup. Uncertain local publication carries the destination ID. A lost remote creation
response can leave that ID unknown; repeating the call may create another object. Close preserves committed bytes.

Personal presentation acquires a pinned HEAD version and then streams GET/Range
requests through the same captured Account. The page owns a five-minute disposable
source; a stateless service worker routes requests back to that page. No bearer
or persisted bytes enter the worker. Every acquisition is independent, and
another page cannot redeem its URL. See the [app setup instructions](../app/README.md#blobs-and-recording).

The server forwards HEAD, single ranges, and version preconditions, preserving
206/416 and metadata. Reads retain attachment, sandbox, and `nosniff` protections.
Account retirement ends future authorization without deleting the Personal cache.
No claim is made that already delivered or decoded bytes can be revoked.

## Verification

Run focused storage and native interoperability checks from the repository root.
The native Stop smoke requires Cargo, FFprobe, and FFmpeg:

```sh
bun test packages/blobs/src
bun packages/blobs/scripts/native-smoke.ts
bun packages/blobs/scripts/native-flat-smoke.ts
bun packages/blobs/scripts/browser-smoke.ts
```

Synthetic browser recording, playback, reload, and metadata measurements cover
WebKit and Chromium. Rust/Bun fixtures exercise independent publication and
reading. The private-media harness additionally exercises actual WKWebView through the
desktop broker. These checks do not establish physical microphone behavior or
real object-provider acceptance. Native Windows publication
is implemented; its execution and abrupt-power-loss durability remain unverified.
