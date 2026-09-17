# 0393. Rows refer to blobs without owning their lifetime

- **Status:** Proposed
- **Date:** 2026-09-12
- **Revised:** 2026-09-17
- **Unbuilt:** No remaining implementation work in this decision; row fields, consumers, and obsolete attachment paths have been updated.

## Decision

Blob references are ordinary declared row values. A row can store a local
BlobId, a remote URL, both, or neither. The framework does not introduce an
owning blob field, one-file-per-row rule, synchronization obligation, or server
reference-liveness index. Byte payloads are not embedded in the synced document.

Whispering stores audioBlobId for saved device audio and an optional audioUrl
when explicit uploading succeeds. Stop saves bytes before row creation. A row
write can fail afterward, leaving a complete blob discoverable through local
list. Importing audio saves a Blob first and then creates the row.

Deleting a row deletes the row. An application may separately attempt local or
remote deletion, but missed cleanup is accepted. A library may offer inspection
and cleanup while open; no background service must determine row existence.
Absence from one device's current row view is not proof that a blob is orphaned.

The user selected a fresh-start transition with old files preserved untouched.
Old attachment rows and their storage are not silently adopted, renamed, or
removed by the new blob implementation.

## Consequences

Row synchronization does not imply audio availability. Applications decide how
to present missing local files and whether to upload or fetch remote content.
There is no atomic transaction across Yjs, local bytes, and remote storage.

The former finished-file handoff, attachment content evidence, automatic byte
queue, and generation admission do not belong to the application blob path.
Recording owns publication and ordinary rows carry its resulting address.

## Considered alternatives

- Address files by table and row: couples independent identities and prevents
  storing a file before a row exists.
- Delete bytes whenever a row disappears: requires a reliable global liveness
  view and creates data-loss races with offline replicas.
- Guarantee no orphan objects: requires transactions or durable reconciliation
  across storage systems.
- Store small image bytes in Yjs: adds payload and initial-hydration cost to every
  replica, including devices that never display the image.
