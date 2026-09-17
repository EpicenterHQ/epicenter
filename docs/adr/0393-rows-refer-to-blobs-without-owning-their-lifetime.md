# 0393. Rows refer to blobs without owning their lifetime

- **Status:** Proposed
- **Date:** 2026-09-12

## Decision

Blob references are ordinary declared row values. A row can store a local
BlobId, a remote URL, both, or neither. The framework does not introduce an
owning blob field, one-file-per-row rule, synchronization obligation, or server
reference-liveness index. Byte payloads are not embedded in the synced document.

Whispering stores audioBlobId as the full saved key, including its extension,
for device audio and an optional audioUrl
when explicit uploading succeeds. Stop saves bytes before row creation. A row
write can fail afterward, leaving a complete blob discoverable through local
list. Importing audio saves a Blob/File first and then creates the row.

Titles, transcripts, recording dates, and application-specific media details
belong in the recording row, not beside the audio in a JSON file. Preserve an
exact content type or codec description in a declared row field only when a
workflow needs more than the key's conventional format. Do not add a second
metadata catalog or require that field for ordinary key-only playback.

The row points to the blob; the blob does not store a reverse recording ID.
Two rows can refer to one immutable file. Changing a title leaves its key
unchanged. Conversion creates new bytes under a new key. The same
extension-bearing key identifies a desktop file and a browser database record,
but sharing a row does not copy bytes between those storage environments.

Deleting a row deletes the row. An application may separately attempt local or
remote deletion, but missed cleanup is accepted. A library may offer inspection
and cleanup while open; no background service must determine row existence.
Absence from one device's current row view is not proof that a blob is orphaned.

On September 17, 2026, the user confirmed zero users and no existing data and
authorized the complete-key clean break. Row validators accept full saved keys;
no migration, reset, or fallback reader runs.

Archive capture discovers local complete-key references, including references
split across rich-text runs. Absolute HTTP(S) URLs remain opaque row values.
Recovery preserves those URLs without fetching, converting, or inlining their
remote bytes into the local archive.

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
