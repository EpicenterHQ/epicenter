# @epicenter/blobs

This package owns device-local byte adapters, BlobIds, formats, and the canonical
Personal hosted URL grammar. `@epicenter/app` lends `local.blobs` from a Local
store. Hosted publication is an Account-bound client in `@epicenter/client`.
Rows hold ordinary references and do not delete bytes.

## Storage and identity

Local uses the fixed no-account namespace. `add(Blob)` and
`destination.copyFrom(source, id)` return fresh BlobIds; Local copies preserve
bytes and give each destination an independent deletion lifetime.

| Platform | Location |
| --- | --- |
| Browser Local | IndexedDB database `epicenter/<appId>/device/<owner>/blobs`, within the origin/profile |
| Desktop Local | One file at `<dataRoot>/apps/<appId>/device/<owner>/blobs/<blobId>` |
| Personal hosted | `personal/<principalId>/<private|public>/<key>` in the server object store |

`<owner>` is `no-account` for LocalBlobs. Account changes leave Local bytes in
place. Historical account-local directories remain untouched. Native capture
and Bun HTTP reads use the Local source handle's directory.

`BlobId` is `blob_`, 21 random lowercase alphanumeric characters, one dot, and a
lowercase alphanumeric extension of 1 to 10 characters. Mint a complete key with
`generateBlobId(extension)` and validate external input with `parseBlobId()`.
The key is an opaque identity, not a content hash. Changing a title leaves it
unchanged; conversion creates different bytes under a different key.

Personal hosted objects use complete authority URLs. The path binds principal,
visibility, and a 128-bit random key. The canonical parser rejects another
origin, credentials, queries, fragments, and alternate path encodings. The
server derives the physical key from the URL path; a hosted object has no
store definition ID or separate public BlobId.

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

Hosted publication sends the supplied `Blob.type`, or
`application/octet-stream` when it is empty. It does not infer a type from a
File's name. Public objects with an unknown type download as attachments.
Backup-specific storage and structural archives have been removed. Local bytes
and explicitly hosted objects remain independent of row lifetime and
working-copy recovery.

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

Personal publication uses `createPersonalHostedBlobs(account)` from
`@epicenter/client`. The client has `publishPrivate`, `publishPublic`,
`download`, and `delete`; it returns the complete URL after a create-only write.
Publication is bounded to 25 MiB. Public safe media can be read directly from
its URL; private reads require the captured Account. GET and HEAD support single
ranges and conditional requests. The server has no user-facing listing.

A lost publication response can leave bytes whose URL the caller never learned.
A known URL remains available to retry a failed row write. Account retirement
fences client network work; closing a Yjs store does not close the Account-bound
client or delete committed objects.

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
reading. These checks do not establish physical microphone behavior or
real object-provider acceptance. Native Windows publication
is implemented; its execution and abrupt-power-loss durability remain unverified.
