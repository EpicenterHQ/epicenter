# Workspace data model

An application data version owns queryable records, synchronized
preferences, collaborative documents attached to record identities, and
app-owned blobs. It freezes those durable contracts under one generated
workspace ID. Each plane still has its own runtime and synchronization model.

That sentence is the target architecture. It is also the rule for deciding
where new data belongs.

```text
application data version N
`-- workspace ID: <appId>-vN
    |-- active records epoch
    |   `-- records database
    |       `-- record tables
    |           `-- records
    |               |-- stable row id
    |               `-- named atomic cells
    |-- synchronized KV
    |-- child-document namespace
    |   `-- documents addressed through table + row id + document name + format
    `-- app-owned blob namespace
```

An application publishes ordered data versions, not a runtime workspace catalog.
Any durable contract change creates a new data version and a new namespace.
Several UI-only builds may keep using the same data version.

## Records are identified rows of atomic cells

A record is one identified row in a typed table. It consists of a stable row ID
and named atomic cells, and it has an explicit create, update, and delete
lifecycle.

```text
notes table
`-- note record
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
hash or application data version. The runtime storage revision owns and fences
physical representation changes.

Use records for product facts that need identity, queries, relationships,
explicit creation or deletion, or atomic updates alongside other fields. A
record can be primary product data, not merely metadata.

## KV is the data version's preference plane

Workspace KV is a bounded set of synchronized preferences. Its identity is
independent of the active records epoch and fixed inside one application data
version.

```text
editor.theme
sidebar.collapsed
transcription.language
```

KV has no row identity or record lifecycle. Missing or invalid values read as
fresh defaults. Adding a key, removing a key, or changing a key's meaning
publishes a new application data version. KV does not participate in records
snapshots or the records schema hash.

Use KV for bounded settings and preferences that do not need to change
atomically with a record. A value that must commit with a record belongs in
that record. Device-local or privacy-sensitive settings belong in device
storage, not workspace KV.

## Child documents hold merge-sensitive content

A table may declare child-document slots for its records. A child document is a
separate, lazy Yjs document with a format capability such as plain text, an XML
fragment, or validated keyed records.

```text
note record
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
address publishes a new application data version.

Fields and documents use separate declaration namespaces. A field and a child
document may both be named `body`: callers still distinguish `row.body` from
`table.docs.body`. Matching names do not make the two planes consistent or
choose an authority. Table and document names participate in persistent room
addresses, so renaming either creates a new data version. Capability-owned
internal Yjs root names are isolated from both public maps.

Use a child document when independent edits inside one value must survive and
converge. Do not put a large JSON object in one cell and expect its members to
merge; an atomic JSON cell is still replaced as a whole.

## The data version freezes every durable plane

The generated workspace namespace composes four durable planes:

| Plane | Unit | Best for | Evolution |
| --- | --- | --- | --- |
| Records | Identified record | Queryable product facts and metadata | Ordinary mutations stay in the data version; a schema change creates a new data version |
| Synchronized KV | Declared key | Bounded preferences with defaults | A declaration or meaning change creates a new data version |
| Child documents | Format-addressed Yjs document | Merge-sensitive bodies and collections | A format or address change creates a new data version |
| App-owned blobs | App-declared identity | Large binaries and artifacts | A naming or layout change creates a new data version |

The separation remains intentional, but the lifecycle boundary is shared. A
data version lock records each plane's exact identity. It does not describe
compatibility, migration edges, copying, or retirement. Old data versions remain
independent and writable.

## Schema identity follows the owned data

The records schema hash includes record tables and fields only. Workspace
identity, KV declarations, child documents, blobs, local indexes, and physical
SQLite storage do not enter it. The data version lock binds that records hash to
the identities of every other durable plane.

This gives each compatibility boundary one owner:

```text
record tables + fields  -> records schema hash
child-document content  -> document format hash
KV preferences          -> version-qualified KV identity
app-owned blobs          -> version-qualified blob identity
physical SQLite layout  -> runtime storage version
```

Ordinary record changes use ordinary mutations. The authority may mint a new
records epoch for same-descriptor restore or repair inside one data version. A
records schema change never mints a new epoch inside the same workspace; it
publishes a new application data version.

## Builds open one locked data version

Developers author `appId` and a positive `dataVersion`. Tooling derives
`<appId>-vN`, records that value and every durable-plane token in an append-only
data version lock, and refuses published-entry drift. Runtime openers accept only
a definition validated against that lock.

The current build inspects its own local root identity without creating storage.
An initialized identity opens normally. An invalid or partial identity refuses
to open. If the current data version is absent and its lock has predecessors, the
build asks before it creates anything: start the current version, or navigate to
an available historical build. The choice is not persisted. Once the current
root identity exists, its durable state selects normal boot.

Synchronization does not interpret application data versions. It receives the
generated workspace ID and the authority-minted records epoch. It exposes no
data version manifest, predecessor lookup, or copy route.

## Placement rule

The merge unit chooses the storage plane. Store a value in records when
server-ordered replacement of the whole cell preserves acceptable intent. Use a
child document when independent edits inside one value must survive and
converge.

Size does not choose the storage plane. Offline availability does not choose it:
records already support offline work. The required conflict boundary does.

Ask these questions in order:

1. Does this value need an identified create, update, and delete lifecycle, or
   direct queries and relationships? Put it in a record.
2. Does it need concurrent edits to merge inside the value? Put it in a child
   document declared by the relevant table.
3. Is it a bounded synchronized preference with a sensible default? Put it in
   workspace KV.
4. Is it local to one device, secret, or privacy-sensitive? Keep it outside the
   synchronized workspace.

A database-style spreadsheet can remain records when each logical cell is an
acceptable replacement boundary. A workbook with concurrent structural edits,
range operations, and collaborative undo may instead earn a dedicated document
format. The product label "spreadsheet" does not decide the model; its required
concurrent operations do.

The hard boundary is atomicity. If two values must change atomically, they must
share an authority. Convenience alone is not a reason to cross storage planes.

## Current adoption

The SQLite records path under `packages/workspace/src/sqlite` is the first
data-version-aware implementation. Other workspace paths do not gain a fallback,
alias, or import bridge from it. Each adopting application must inventory every
durable plane before it publishes its own data version lock.

This page states the current product model. The ADRs retain the detailed
identity, boot, synchronization, and refusal rationale.
