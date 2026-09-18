# @epicenter/blobs

An app stores immutable bytes under a complete, extension-bearing key. That key
is the desktop filename, browser database key, and reference held by a row.
Applications use `app.blobs.local` for device bytes and `app.blobs.remote` for
explicit hosting. Recording titles, transcripts, and other descriptive
information belong in rows. Deleting a row does not delete its bytes.

## Storage and identity

The App's captured account selects both local and remote ownership. Local
storage remains on this device; it does not synchronize because it has an owner.

| Platform | Location |
| --- | --- |
| Browser | IndexedDB database `epicenter/<appId>/device/<owner>/blobs`, within the origin/profile |
| Desktop | One ordinary file at `<dataRoot>/apps/<appId>/device/<owner>/blobs/<blobId>` |
| Remote | `principals/<principalId>/apps/<appId>/blobs/<blobId>` in the server's object store |

`<owner>` is `no-account` or `accounts/<encoded-authority>/<encoded-principal>`,
with identity components encoded as UTF-8 hex. Account changes select another
local namespace without moving or erasing existing bytes. Library changes
within one App keep the same bytes. Native capture and Bun HTTP reads share
the captured app/account directory. Desktop WebViews use that HTTP store instead
of maintaining another copy in IndexedDB.

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
Application access replaces raw `put` with `add(Blob)`, which selects the format
and mints the key, and adds `open(key)` for playback. Known declared media types
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
not a presentation URL. App closure releases acquired display resources and
drains admitted operations without deleting committed bytes.

Bun's `openFile(key)` lends a descriptor-backed `{ file, stat, close }` for
streaming. Its caller must close the handle after consumption, cancellation,
or failure. The desktop host owns that cleanup for GET, ranges, and uploads;
HEAD only reads metadata. `eraseBlobStore({ appId })` explicitly deletes the
browser app's whole blob database and is not account-library cleanup.

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

The [ADR-0394 folder direction](../../docs/adr/0394-a-backup-is-the-library-s-folder-kept-by-the-authority.md)
is document-only: Markdown, settings, and the checkout manifest carry
references, without copying or fetching local or remote blob payloads. The
[ADR-0395 recovery direction](../../docs/adr/0395-restore-is-one-request-that-carries-its-own-safety-copy.md)
uses the current working-copy baseline rather than replacing it with an old
manifest.

Download callers supply complete friendly filenames. Download adapters save
those names without choosing another audio extension. ZIP exports remain ZIPs.

## Recording and hosting

Successful recording Stop publishes completed audio and returns
`{ blobId, durationMs, byteLength }`. `app.blobs.local.open(blobId)` resolves that
saved key on either platform. Native capture produces WAV; browser capture uses
its actual recorder output format. The saved key remains fixed through retries.
Row creation happens afterward, so a failed row write can leave enumerable
saved bytes. Cancel and App closure cannot retract a committed blob.

`RemoteBlobs` supports `add(Blob)`, `addLocal(key)`, `get(url)`, `open(url)`, and
`delete(url)`. Each explicit upload creates an independent remote key with a
25 MiB limit. There is no synchronization queue or requirement to save locally
before uploading. Desktop `addLocal` sends a control request through its captured
Account; the host checks size and streams bytes without routing audio through
the WebView.

Uploads return an owner-pinned locator:

```text
https://<server>/api/apps/<appId>/principals/<principalId>/blobs/<blobId>
```

The URL identifies a private object; it grants no access. Reads and deletes use
the captured Account and refuse foreign owners, apps, origins, and redirects.
Account retirement disables that transport. Sharing a row does not share its
owner's private audio. Failed or interrupted uploads preserve their local source
and can leave an unreferenced remote object.

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
reading. These checks do not establish physical microphone behavior, installed
WebView playback, or real object-provider acceptance. Native Windows publication
is implemented; its execution and abrupt-power-loss durability remain unverified.
