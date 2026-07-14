# Workspace data model

A workspace version owns queryable tables, synchronized preferences,
collaborative documents attached to rows, and externally stored blobs. It
freezes those durable contracts under one generated workspace ID. Each plane
still has its own runtime and synchronization model.

That sentence is the target architecture. It is also the rule for deciding
where new data belongs.

```text
workspace version N
`-- workspace ID: <appId>-vN
    |-- active records epoch
    |   `-- records database
    |       `-- tables
    |           `-- rows
    |               |-- stable row id
    |               `-- named atomic cells
    |-- synchronized KV
    |-- child-document namespace
    |   `-- documents addressed through table + row id + document name + format
    `-- content-addressed blob store reached through BlobRef cells
```

An application publishes ordered workspace versions, not a runtime workspace catalog.
Any durable contract change creates a new workspace version and a new namespace.
Several UI-only builds may keep using the same workspace version.

## Tables contain identified rows of atomic cells

A row is one identified value in a typed table. It consists of a stable row ID
and named atomic cells, and it has an explicit create, update, and delete
lifecycle.

```text
notes table
`-- note row
    |-- id: "note_123"
    |-- title: "Trip planning"
    |-- pinned: true
    `-- updatedAt: "2026-07-12T18:30:00Z"
```

A cell is atomic because assigning it replaces its complete value. Concurrent
assignments to different cells compose; concurrent assignments to the same cell
resolve by server acceptance order. A value that needs character-level or
structural merging is not a cell; it belongs in a child document.

A table is the typed collection that organizes records. The records database is
the complete queryable collection of those tables under one immutable records
schema. The name describes the logical product data, not its physical storage:

```text
logical records database
|-- authority: canonical rows, mutations, snapshots, and head
`-- each device: local SQLite materialization
```

SQLite pages, indexes, triggers, cursors, outboxes, and mutation history do not
define the logical records database. They also do not enter the records schema
hash or workspace version. The runtime storage revision owns and fences
physical representation changes.

Use table rows for product facts that need identity, queries, relationships,
explicit creation or deletion, or atomic updates alongside other fields. A
record can be primary product data, not merely metadata.

## KV is the workspace version's preference plane

Workspace KV is a bounded set of synchronized preferences. Its identity is
independent of the active records epoch and fixed inside one workspace version.

```text
editor.theme
sidebar.collapsed
transcription.language
```

KV has no row identity or record lifecycle. Missing or invalid values read as
fresh defaults. Adding a key, removing a key, or changing a key's meaning
publishes a new workspace version. KV does not participate in records
snapshots or the records schema hash.

Use KV for bounded settings and preferences that do not need to change
atomically with a record. A value that must commit with a record belongs in
that record. Device-local or privacy-sensitive settings belong in device
storage, not workspace KV.

## Child documents hold merge-sensitive content

A table may declare child-document fields for its rows. A child document is a
separate, lazy Yjs document with a format capability such as plain text, an XML
fragment, or validated keyed records.

```text
note row
|-- records database: title, pinned, updatedAt
`-- child document: body
```

The record supplies the product relationship and part of the address, but it
does not contain the document bytes. The workspace derives a document address
from the workspace, table, a collision-resistant digest of the full row ID,
document name, and format identity. The digest accepts application IDs without
turning the room-address grammar into a record-schema restriction. Opening the
document owns its persistence, synchronization, caching, readiness, and
disposal.

Not every table declares documents, and a declared document remains unopened
until a caller needs it. Child-document formats have compatibility identities
independent of the records schema. Adding a document or changing its format or
address publishes a new workspace version.

Cells and documents share one declaration map but remain different runtime
values. `body: field.doc(document.plainText)` creates no SQLite column and opens
through `table.docs.body`; `audio: field.blob()` creates a SQLite `BlobRef` cell
whose bytes remain outside SQLite. Table and field names participate in durable
identity, so renaming either creates a new workspace version.

Use a child document when independent edits inside one value must survive and
converge. Do not put a large JSON object in one cell and expect its members to
merge; an atomic JSON cell is still replaced as a whole.

## The workspace version freezes every durable plane

The generated workspace namespace composes four durable planes:

| Plane | Unit | Best for | Evolution |
| --- | --- | --- | --- |
| Tables | Identified row | Queryable product facts and metadata | Ordinary mutations stay in the workspace version; a schema change creates a new workspace version |
| Synchronized KV | Declared key | Bounded preferences with defaults | A declaration or meaning change creates a new workspace version |
| Child documents | Format-addressed Yjs document | Merge-sensitive bodies and collections | A format or address change creates a new workspace version |
| Blobs | Immutable `BlobRef` cell | Large binaries and artifacts | Reference schema changes create a new workspace version; bytes are content-addressed |

The separation remains intentional, but the lifecycle boundary is shared. A
workspace version lock records each plane's exact identity. It does not describe
compatibility, migration edges, copying, or retirement. Old workspace versions remain
independent and writable.

## Schema identity follows the owned data

The records schema hash includes SQLite columns, including the `BlobRef` marker.
Workspace identity, KV declarations, child documents, local indexes, and
physical SQLite storage do not enter it. The workspace version lock binds that
hash to the identities of the other durable planes.

This gives each compatibility boundary one owner:

```text
table columns           -> records schema hash
child-document content  -> document format hash
KV preferences          -> version-qualified KV identity
blob bytes               -> principal + content hash
physical SQLite layout  -> runtime storage version
```

Ordinary record changes use ordinary mutations. The authority may mint a new
records epoch for same-descriptor restore or repair inside one workspace version. A
records schema change never mints a new epoch inside the same workspace; it
publishes a new workspace version.

## Builds open one locked workspace version

Developers author `appId` and a positive `version`. Tooling derives
`<appId>-vN`, records that value and every durable-plane token in an append-only
workspace version lock, and refuses published-entry drift. Runtime openers accept only
a definition validated against that lock.

The current build inspects its own local root identity without creating storage.
An initialized identity opens normally. An invalid or partial identity refuses
to open. If the current workspace version is absent and its lock has predecessors, the
build asks before it creates anything: start the current version, or navigate to
an available historical build. The choice is not persisted. Once the current
root identity exists, its durable state selects normal boot.

Synchronization does not interpret workspace versions. It receives the
generated workspace ID and the authority-minted records epoch. It exposes no
workspace version manifest, predecessor lookup, or copy route.

## Placement rule

The merge unit chooses the storage plane. Store a value in records when
server-ordered replacement of the whole cell preserves acceptable intent. Use a
child document when independent edits inside one value must survive and
converge.

Size does not choose the storage plane. Offline availability does not choose it:
records already support offline work. The required conflict boundary does.

Ask these questions in order:

1. Does this value need an identified create, update, and delete lifecycle, or
   direct queries and relationships? Put it in a table row.
2. Does it need concurrent edits to merge inside the value? Put it in a child
   document declared by the relevant table.
3. Is it a bounded synchronized preference with a sensible default? Put it in
   workspace KV.
4. Is it a large immutable binary? Store a `BlobRef` cell and upload its bytes
   before committing the reference.
5. Is it local to one device, secret, or privacy-sensitive? Keep it outside the
   synchronized workspace.

## Portable ownership is a complete folder

A complete export contains `workspace.json`, `tables.sqlite3`, `kv.json`,
`documents/`, and `blobs/`. The SQLite file is built from logical table state;
it is not a copied replica file and carries no actor, cursor, outbox, or pending
sync identity. Export follows the locked field declarations, never SQLite
introspection that guesses which values are blobs or documents.

The folder is an immutable backup and ownership escape hatch. It does not imply
that a live workspace can roll backward. Import targets a fresh destination.
`epicenter tables apply <tables.sqlite3> --definition <module>` validates the
sibling manifest and locked definition, reads the latest authority state,
previews the exact desired-state diff and unreachable content, and requires
approval. The authority commits the whole bounded operation set only when the
reviewed head is still current. A moved head causes a new diff and a new
approval; it never reuses the old answer.

A database-style spreadsheet can remain records when each logical cell is an
acceptable replacement boundary. A workbook with concurrent structural edits,
range operations, and collaborative undo may instead earn a dedicated document
format. The product label "spreadsheet" does not decide the model; its required
concurrent operations do.

The hard boundary is atomicity. If two values must change atomically, they must
share an authority. Convenience alone is not a reason to cross storage planes.

## Current adoption

The SQLite records path under `packages/workspace/src/sqlite` is the first
workspace-version-aware implementation. Other workspace paths do not gain a fallback,
alias, or import bridge from it. Each adopting application must inventory every
durable plane before it publishes its own workspace version lock.

This page states the current product model. The ADRs retain the detailed
identity, boot, synchronization, and refusal rationale.
