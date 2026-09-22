# 0349. Local blobs belong to the app on this device

- **Status:** Proposed
- **Date:** 2026-09-05
- **Unbuilt:** Store-owned blob acquisition and identity-preserving `copyFrom`; private remote presentation is tracked separately in ADR-0427.
- **Unverified:** Native Windows execution and abrupt-power-loss durability; installed desktop playback and physical microphone acceptance.

## Context

The former blob store used extensionless BlobIds. Desktop objects occupied a
directory containing `data` and `metadata.json`; browser objects occupied paired
`blob-data` and `blob-metadata` records. Those layouts preserved the supplied
content type and a separately recorded byte length.

The desired desktop artifact is an ordinary file with a useful extension.
Application rows own titles, transcripts, and any exact media description
their workflows require. The byte store does not need a sidecar to repeat
those facts. The same complete filename can identify a browser database value.

## Decision

**Each opened namespace selects one canonical local blob store within a storage
environment.** An application may open several Local stores and use each
store's `local.blobs`; the definition ID selects the namespace. Account, row,
and document generation do not select
its location. [ADR-0426](0426-blob-identities-survive-copies-between-scoped-locations.md)
defines the complete local and remote addresses; `id` selects the namespace and
`blobId` selects an object inside it.

| Environment | Address |
| --- | --- |
| Browser | IndexedDB database `epicenter/<namespace>/device/no-account/blobs`, within the browser profile and origin |
| Epicenter desktop | One ordinary file at `<dataRoot>/apps/<namespace>/device/no-account/blobs/<blobId>` |

Native startup selects `dataRoot` once. Rust recording and Bun reads use that
same value and directory grammar. A desktop WebView reaches the host store;
it does not persist a second copy in IndexedDB.

**A BlobId is the complete immutable storage key, including its extension.**
The grammar is `blob_` followed by 21 lowercase alphanumeric random characters,
one dot, and a lowercase alphanumeric extension of 1 to 10 characters. Keep
the existing random-body generation and `blob_` prefix. The prefix identifies
the kind of key; it provides no access control. A key contains no path,
application ID, recording title, account, or row identity.

The following examples use shortened random bodies for readability:

```text
Desktop: apps/<namespace>/device/no-account/blobs/
         |-- blob_abc.wav
         |-- blob_def.webm
         `-- blob_ghi.png

Browser: epicenter/<namespace>/device/no-account/blobs
         blobs["blob_abc.wav"]   -> { id, bytes, size }
         listing index          -> [id, size]

Row:     audioBlobId = "blob_abc.wav"
```

The entire key is stored in the row and used for exact lookup. Readers do not
scan for an extension, split the key into separately mutable fields, or look
up a filename in another catalog. Changing a title does not rename a blob.
Conversion creates another object; changing an extension does not convert bytes.

**The key describes the file format; the store does not preserve an arbitrary
original MIME string.** Creation selects an extension from the actual producer's
format or a supported imported filename. Browser capture uses its resulting
media type, not an assumption that every recording is WAV. A shared mapping
defines conventional media types for supported extensions. Unknown formats use
`.bin` and `application/octet-stream`; no content-sniffing framework is required.
An extension is a format declaration, not proof that untrusted bytes are safe.

The blob package owns one pure format policy for input selection, supported
aliases, conventional types, and format equivalence. Capture, import, hosting,
and export consume it; adapters do not maintain competing MIME tables. Selecting
a preferred extension and validating an equivalent format are different
operations over that policy. Transport may retain a supported original MIME
header without making it part of local persistence.

`add(File)` can use a supported filename extension when the supplied media type
is empty or generic. A meaningful supported media type takes precedence over a
conflicting filename. A plain Blob has no filename. Unsupported combinations
use `.bin` rather than claiming a conversion or inventing a format. Keep exact
MIME parameters in an application row only when a caller requires them.

**Desktop blobs have no per-object directory or JSON sidecar.** File size comes
from the filesystem. Browser objects use one IndexedDB record containing an
ArrayBuffer and its derived byte length in the `blobs` object store. Its
`keyPath: 'id'` derives the primary key from the record; callers do not supply
a second identity. An engine-maintained `[id, size]` index provides
metadata-only reads. The writer calculates size from the stored bytes and
commits both together; callers cannot supply size independently. Desktop gets
the equivalent information from the filename, file contents, and filesystem
size. The index is not an application metadata catalog. A separate
`blob-metadata` store is not part of the layout.

The target local API is `add`, `copyFrom`, `get`, `open`, `stat`, `list`, and
`delete`, as specified in [ADR-0372](0372-local-and-remote-blobs-open-independently.md).
`copyFrom` retains the source ID and bytes in this destination namespace.
`add` accepts standard Blob/File bytes, selects an extension, mints an immutable
BlobId, and reports success after publication. `get` returns a Blob. `open` acquires a disposable presentation URL;
disposing it releases playback resources without deleting stored bytes.
`stat` returns size and the conventional content type derived from the key
without reading the payload. `get` reconstructs a Blob with that conventional
type. Missing reads
return a typed error. Deleting an absent object succeeds.

Storage adapters and producers need atomic publication under an established
identity. The current raw contract uses `put`; its method name and boundary are
implementation choices, not required application API. The old unused raw `copy`
and batch-stat helpers do not prescribe the new public `copyFrom` contract.
Single-object metadata reads and size-bearing enumeration remain required.

`list({cursor, limit})` enumerates complete committed objects, including objects
with no row. Its exclusive cursor is a BlobId; enumeration is not a snapshot
against concurrent writes or deletion. Staging and old attachment addresses are
excluded. Listing does not determine whether deletion is safe.

**Successful publication exposes one complete immutable object.** The browser
commits its record and index in one transaction. Desktop capture/import writes
a private same-filesystem temporary file, finishes and flushes the file, then
publishes it without replacing an existing destination. Temporary names are
not valid BlobIds and do not appear in `list`. A plain overwriting file rename
preceded by an existence check does not satisfy the collision rule.

Each desktop writer owns its temporary files. Cleanup cannot delete another
writer's active file or an object whose publication succeeded but whose
acknowledgment was lost. Retry after ambiguous publication must keep the same
object identity. The publication primitive and durability barriers require
proof on supported filesystems; removing sidecars does not remove those duties.

The opened Local store owns blob access and acquired playback resources.
`local.close()` fences document and blob operations, retires dependent recorders,
and drains admitted work without deleting committed files. Public blob access
requires the owning store to open. Internal byte adapters remain separate from
the Yjs document; their separate storage does not introduce another public owner.

## Consequences

Account changes do not move, hide, or erase local files. A second account in the
same browser profile and origin can encounter the app's existing local files.
A different origin/profile is a different storage environment. Browser storage
remains subject to quotas, eviction policy, and user deletion; local save is not
an archival guarantee.

On September 17, 2026, the user confirmed zero users and no existing data and
authorized a clean break. Complete-key readers replace extensionless readers
without a migration, reset, fallback, or startup cleanup. An unexpected older
browser schema fails without converting or erasing its records.

Materialized documents and working-copy recovery preserve complete keys as row
values; they do not copy local bytes. Absolute HTTP(S) URLs remain opaque row
values, and materialization and recovery do not fetch, convert, or inline their
remotely hosted bytes. Structural archives and their byte-installation helpers
were removed under ADR-0379.

Exact input MIME round-tripping and the sidecar's expected-versus-actual size
check are withdrawn. A caller requiring original MIME parameters must preserve
them separately. A rowless object still has bytes and a format extension, but
no recording title or transcript can be reconstructed from that key.

## Considered alternatives

- Account- or library-scoped local bytes: makes local files follow authentication
  and creates multiple recorder destinations.
- Row-owned attachments: couples byte publication, row creation, and deletion.
- No enumeration: makes successful orphaned saves undiscoverable.
- One browser implementation everywhere: native recording would need a second
  permanent store or a whole-file transfer into the WebView.
- One blob owner across multiple stores: couples independently selected namespaces
  and lifetimes; each store instead owns its own blob capability.
- A per-blob directory with `data` and `metadata.json`: publishes a two-file
  object together but does not produce an ordinary extension-bearing media file.
- Flat bytes plus JSON sidecars: keeps exact MIME round-tripping at the cost of
  paired-file publication; that storage promise is not retained.
- A bare ID plus a separately stored extension: creates a second value needed
  for lookup when one immutable key can name the object.
- A shared SQLite chunk engine: changes capture transport and playback to
  achieve implementation uniformity that the shared saved-object contract does
  not require.
- Retain unused raw copy and batch-stat APIs: the public `copyFrom` operation
  serves explicit placement transfer; it does not require those old helpers.
