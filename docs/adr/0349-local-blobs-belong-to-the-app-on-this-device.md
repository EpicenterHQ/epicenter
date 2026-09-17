# 0349. Local blobs belong to the app on this device

- **Status:** Proposed
- **Date:** 2026-09-05
- **Revised:** 2026-09-17
- **Unbuilt:** Installed desktop WebView acceptance of the new storage namespace remains outstanding; WebKit and native-to-Bun storage checks pass.

## Decision

An app has one canonical local blob store within a storage environment. Account,
library, row, and document generation do not select its location. Application
code uses the full `app.blobs.local` path; do not destructure `local` or `remote`
from `app.blobs`.

| Environment | Address |
| --- | --- |
| Browser | IndexedDB database `epicenter/<appId>/blobs`, within the browser profile and origin |
| Epicenter desktop | `<dataRoot>/apps/<appId>/blobs/<blobId>/{data,metadata.json}` |

Native startup selects `dataRoot` once. Rust recording and Bun reads use that
same value and directory grammar. A desktop WebView reaches the host store;
it does not persist a second copy in IndexedDB. Browser bytes remain an
ArrayBuffer plus metadata in IndexedDB, reconstructed as Blob on read.

The local API is `add`, `get`, `open`, `stat`, `list`, and `delete`. `add` accepts
standard Blob/File bytes, mints an immutable BlobId, and reports success after
publication. `get` returns a Blob. `open` acquires a disposable presentation URL;
disposing it releases playback resources without deleting stored bytes.
`stat` reads size and content type without reading the payload. Missing reads
return a typed error. Deleting an absent object succeeds.

`list({cursor, limit})` enumerates complete committed objects, including objects
with no row. Its exclusive cursor is a BlobId; enumeration is not a snapshot
against concurrent writes or deletion. Staging and old attachment addresses are
excluded. Listing does not determine whether deletion is safe.

Bytes and metadata publish together: one IndexedDB transaction in the browser,
a complete staged-directory rename with durability barriers on desktop. All
writers normalize content type alike, using application/octet-stream when no
valid type is supplied. Metadata records size and content type, not row owners,
accounts, generations, upload acknowledgments, or a cleanup ledger.

The App owns access and acquired playback resources. App closure revokes its
handles and drains admitted operations; it does not delete committed files or
invalidate independent handles to the same store. Standalone blob access does
not open a Yjs document.

## Consequences

Account changes do not move, hide, or erase local files. A second account in the
same browser profile and origin can encounter the app's existing local files.
A different origin/profile is a different storage environment. Browser storage
remains subject to quotas, eviction policy, and user deletion; local save is not
an archival guarantee.

The transition starts fresh. Existing account-scoped blob databases, directories,
and old recording files stay untouched. There is no migration, fallback reader,
or startup sweep of old storage. The user selected this disposition explicitly.

## Considered alternatives

- Account- or library-scoped local bytes: makes local files follow authentication
  and creates multiple recorder destinations.
- Row-owned attachments: couples byte publication, row creation, and deletion.
- No enumeration: makes successful orphaned saves undiscoverable.
- One browser implementation everywhere: native recording would need a second
  permanent store or a whole-file transfer into the WebView.
- A new createBlobs namespace wrapper: repeats the App's existing composition
  boundary without owning another lifetime.
