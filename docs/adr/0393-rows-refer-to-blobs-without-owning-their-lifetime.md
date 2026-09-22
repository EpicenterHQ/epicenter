# 0393. Rows refer to blobs without owning their lifetime

- **Status:** Proposed
- **Date:** 2026-09-12
- **Unbuilt:** Application reference migration to same-ID copies with explicit remote scope; current Whispering still uses `audioBlobId` plus `audioUrl`.
- **Amends:** [ADR-0154](0154-blob-access-is-address-only.md) at local inventory: app-local blobs can be listed independently of rows; remote access remains address-only. [ADR-0355](0355-local-and-account-sessions-share-the-application-data-api.md) at attachment ownership: rows store ordinary references without owning publication, transfer, or deletion of bytes.

## Decision

Blob references are ordinary declared row values. A row stores a BlobId and
whatever placement scope its enclosing context does not already supply.
[ADR-0426](0426-blob-identities-survive-copies-between-scoped-locations.md) defines
identity separately from server, principal, and namespace. A credential-free
remote locator can remain a representation of that scope; temporary presentation
URLs and access grants must never become durable references. The framework does not introduce an
owning blob field, one-file-per-row rule, synchronization obligation, or server
reference-liveness index. Byte payloads are not embedded in the synced document.

Current Whispering stores `audioBlobId` as the full saved key and an optional
`audioUrl` after upload. The target copies the same ID, but does not erase the
need to remember the remote server/principal/namespace when the surrounding
store does not determine them. Device-local rows survive account changes; a new
sign-in must not silently reinterpret an earlier remote placement. Remove a
post-copy reference write only when the destination scope was already known.
Otherwise preserve completed copy identity and scope if later row publication
fails. Availability remains an observation, not a permanent uploaded boolean.
Stop saves bytes before row creation. A row
write can fail afterward, leaving a complete blob discoverable through local
list. Importing audio saves a Blob/File first and then creates the row.

Titles, transcripts, recording dates, and application-specific media details
belong in the recording row, not beside the audio in a JSON file. Preserve an
exact content type or codec description in a declared row field only when a
workflow needs more than the key's conventional format. Do not add a second
metadata catalog or require that field for ordinary key-only playback.

The row points to the blob; the blob does not store a reverse recording ID.
Two rows can refer to one immutable file. A row may refer to several blobs;
a blob may exist with no row. One recording per audio file is Whispering's
convention, not a framework cardinality or row-derived address. Changing a title
leaves its key unchanged. Conversion creates new bytes under a new key. The same
extension-bearing key identifies a desktop file and a browser database record,
but sharing a row does not copy bytes between those storage environments.

Deleting a row deletes the row. An application may separately attempt local or
remote deletion, but missed cleanup is accepted. A library may offer inspection
and cleanup while open; no background service must determine row existence.
Absence from one device's current row view is not proof that a blob is orphaned.
An application can compare local enumeration with its known references to
present cleanup candidates. It must account for other libraries, trashed rows,
and publication that has not yet created its row before deleting anything.
Unknown or unavailable library contents cannot certify a blob as unused.

A remote object can outlive the row's URL, and a row can retain a URL whose
object was deleted. Applications report unavailable content; storage does not
repair one side automatically.

On September 17, 2026, the user confirmed zero users and no existing data and
authorized the complete-key clean break. Row validators accept full saved keys;
no migration, reset, or fallback reader runs.

Materialization preserves blob IDs and credential-free placement references as
ordinary row values.
It copies no blob bytes and performs no remote fetch. A saved folder preserves
those references, not their availability (ADR-0394). Recovering old content
through Push has the same rule (ADR-0395).

The structural archive and its byte-installation helpers were removed after
the caller audit in ADR-0379. Materialization has no path that embeds blob bytes.

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
