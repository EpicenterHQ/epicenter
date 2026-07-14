# 0139. Portable workspaces are schema-directed folders applied as forward mutations

- **Status:** Accepted
- **Date:** 2026-07-14
- **Supersedes:** [ADR-0122](0122-logical-snapshots-are-the-portable-record-database-format-sqlite-files-are-runtime-state.md)
- **Amends:** [ADR-0121](0121-background-sync-is-automatic-and-database-boundary-merges-are-reviewable.md), [ADR-0124](0124-workspace-kv-keeps-one-logical-identity-outside-the-record-database.md), [ADR-0132](0132-an-obsolete-replica-exports-one-read-only-recovery-checkpoint.md)

## Context

A records-only logical snapshot is a sound synchronization baseline but not a
complete ownership escape hatch. A person needs one inspectable folder that
contains every declared durable plane without copying replica identity, cursors,
outboxes, or engine-private pages. Editing that folder also needs a safe meaning
that does not turn backup restore into authority rollback.

## Decision

A complete portable workspace export has this shape:

```text
workspace.json
tables.sqlite3
kv.json
documents/
blobs/
```

`workspace.json` records the exact application ID, version, workspace ID, lock
entry, canonical `tablesStateHash`, and content manifest. The state hash is
distinct from the SQLite file-byte hash in the content manifest.
`tables.sqlite3` is a newly built logical interchange database containing
declared application tables only. It is not a copied runtime replica. `kv.json`
stores the declared preference values. `documents/` and `blobs/` use
content-addressed files named by the manifest.

Export is schema-directed from the locked workspace definition. It does not
inspect arbitrary columns to guess document or blob meaning and it does not use
a second blob registry. A complete export fails if any referenced content is
unavailable. There is no partial export mode.

Exports are immutable ownership artifacts, not live restore points. There is no
same-ID restore, running-system rollback, backward snapshot pointer, or client
promotion to authority. Any future whole-folder importer must create a fresh
destination before clients join. Hosted catastrophe recovery remains an
operator procedure, not an ordinary workspace transition.

`epicenter tables apply <tables.sqlite3> --definition <module>` turns an edited
tables file into ordinary forward mutations. It validates the exact
application ID, version, schema, sibling `workspace.json`, and blob references;
reads the latest server head; computes the bounded desired-state diff from
current tables to the edited file; previews complete created and deleted rows,
before and after values for updates, overwritten newer state, and document or
blob fallout; then requires explicit approval. The server admits the patch
atomically only if its expected head is still current. If the head moved, the
client replans and asks again. Success makes live table state exactly match the
edited file. Version one does not apply KV, documents, or blob bytes and does
not perform a three-way merge.

During apply, the sibling manifest binds application identity and schema. The
edited `tables.sqlite3` is expected to differ from the manifest's original
`tablesStateHash`; that difference is the proposed forward change, not an
integrity failure.

## Consequences

- SQLite remains the familiar editable table artifact without becoming the
  runtime replication format.
- A complete backup is larger than the lightweight table snapshot because it
  includes reachable documents and blobs.
- Recovery never rewinds connected devices or silently replaces live history.
- Desired-state apply can overwrite concurrent work, but only after showing the
  exact latest-state diff and winning a compare-and-swap at the reviewed head.
- Synchronization checkpoints remain internal logical table snapshots. They are
  no longer the complete portable workspace format.

## Considered alternatives

- **Copy the runtime SQLite file.** Rejected because it includes private actor,
  cursor, outbox, index, and storage-revision state and excludes other planes.
- **Restore in place under the same workspace ID.** Rejected because connected
  stale clients would need a whole-workspace incarnation and succession protocol.
- **Treat a laptop as recovery authority.** Rejected because export is the
  ownership surface; ordinary clients do not gain server replacement powers.
- **Diff against the export's old base.** Rejected for the first apply surface.
  The reviewed contract is current live state to desired table state, guarded by
one head compare-and-swap. The SQLite file remains ordinary application tables;
the sibling manifest carries export identity instead of an internal runtime
metadata table.
- **Apply the whole folder initially.** Rejected because cross-plane atomicity
  would require coordinating SQLite, Yjs, and blob storage.
