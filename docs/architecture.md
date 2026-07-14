# Epicenter architecture

Epicenter is a local-first workspace platform. Apps publish immutable data
versions, clients keep complete local data, and a hosted or self-hosted star
keeps devices synchronized while they sleep.

The workspace model is the center of the architecture:

> A workspace version freezes records, synchronized preferences,
> child-document identities, and app-owned blobs under one generated workspace
> namespace.

This page is the five-minute map. See the
[workspace data model](reference/workspace-data-model.md) for the placement rule
and [`docs/adr`](adr/README.md) for the decisions behind it.

## The stack

Apps compose middleware and core packages. Dependencies point downward; product
policy stays in the app that can name it.

```text
+----------------------------------------------------------------------------+
| APPS                                                                       |
|                                                                            |
| opensidian   whispering   tab-manager   vocab                              |
| honeycrisp   self-host    api           landing                            |
+----------------------------------------------------------------------------+
                                      |
                                      v
+----------------------------------------------------------------------------+
| MIDDLEWARE                                                                 |
|                                                                            |
| @epicenter/svelte      @epicenter/filesystem                               |
| @epicenter/skills      @epicenter/workspace/agent                          |
+----------------------------------------------------------------------------+
                                      |
                                      v
+----------------------------------------------------------------------------+
| CORE                                                                       |
|                                                                            |
| @epicenter/workspace   @epicenter/record-sync   @epicenter/sync            |
| @epicenter/field       @epicenter/constants     @epicenter/ui              |
+----------------------------------------------------------------------------+
```

`@epicenter/workspace` owns the app-facing data contract and runtime handles.
`@epicenter/field` supplies the lower-level persisted cell vocabulary;
`@epicenter/workspace/sqlite` composes it with `field.doc` and `field.blob`.
The record protocol
orders logical record mutations; Yjs sync carries KV and child-document
updates. Middleware turns those capabilities into reactive state, filesystems,
agent tools, and other app-shaped surfaces.

## A workspace version composes four storage planes

The application owns a stable `appId` and publishes a positive, increasing
`version`. The framework derives `<appId>-vN` as the workspace ID and
uses it as the storage, synchronization, and access-policy boundary for that
workspace version.

```text
workspace version N
`-- workspace ID: <appId>-vN
    |-- active records epoch
    |   `-- records database
    |       `-- tables
    |           `-- records
    |               |-- stable row id
    |               `-- named atomic cells
    |-- synchronized KV
    |-- child-document namespace
    |   `-- format-addressed Yjs documents reached through records
    `-- app-owned blob namespace
```

Any durable contract change publishes a new workspace version. UI-only builds may keep
using the same one.

### Records are queryable product facts

A record is one identified row in a typed table. It has a stable row ID, named
atomic cells, and explicit create, update, and delete lifecycles. The records
database is the complete queryable collection of those tables under one
immutable logical schema.

Every synchronized device materializes the records database in local SQLite.
The authority stores the same logical records, mutations, snapshots, and
canonical head. Every durable materialization also stores the canonical records
descriptor beside its hash, so the tables and portable constraints remain
understandable without the application bundle. The authority treats that
descriptor as opaque text. It does not synchronize a device's SQLite file.
Local indexes, pages, triggers, cursors, and outboxes are runtime state rather
than part of the records schema.

### KV is for bounded synchronized preferences

Workspace KV stores declared preferences such as theme, language, or collapsed
UI state. Its identity is fixed inside one workspace version. Missing
or invalid values read as defaults. Adding a key or changing its meaning
publishes a new workspace version.

KV has no row lifecycle and does not participate in records snapshots or schema
hashes. A value that must commit atomically with a record belongs in
that record. Device-local and privacy-sensitive settings belong in device
storage.

### Child documents are for merge-sensitive content

A table may declare child-document slots for its records. Each opened child is
a separate lazy Yjs document with an Epicenter-owned format capability, such as
plain text, an XML fragment, or validated keyed records.

The record gives the document its product relationship and row identity, but
the document bytes do not live in the record. Its address includes the
version-qualified workspace ID, table, a collision-resistant digest of the
full row ID, document name, and document format hash. Document format identity
is independent of the records schema hash but frozen inside the workspace version.

## Definitions travel; locks freeze them

The SQLite workspace candidate is pure. It declares `appId`, `version`, tables,
and KV preferences without opening storage or a network connection. Each
table's field map also declares its child documents and blob references. Tooling records its
derived identities in an append-only workspace version lock. Runtime openers accept
only the validated locked definition.

```text
defineWorkspace({ appId, version, tables, kv })
        |
        | pure candidate
        v
lockWorkspace(candidate, versionLock)
        |
        | validated immutable workspace version
        v
openStandaloneWorkspace(...)        local runtime
openWorkspaceReplica(...)           synchronized runtime
```

`defineTable` declares one field map. Ordinary fields become atomic SQLite cells
and record-wire values. `field.blob()` becomes a validated `BlobRef` cell while
the bytes remain external. `field.doc(format)` becomes a lazy child document and
no SQLite cell. `defineKv` declares a preference schema and fresh default
factory; KV keeps its separate storage and conflict model.

Runtime openers supply the resources that cannot travel with the definition:
the environment's SQLite service, record sync port, Yjs persistence and
collaboration, and platform APIs. App-facing code should enter through the
workspace definition instead of rebuilding addresses or storage topology
itself.

## The records path

Record writes use three semantic operations:

```text
createRow(table, rowId, complete cells)
updateRow(table, rowId, changed cells)
deleteRow(table, rowId)
```

The authority orders accepted mutations and advances the epoch sequence. Each
device applies the same ordered stream to its complete local SQLite replica.
Applications retain typed table helpers and direct SQL queryability without
making physical SQLite files the wire format.

Authority discovery binds one canonical descriptor and hash to one opaque
records epoch. Ordinary push, pull, and snapshot requests carry only that epoch;
there is no second per-request schema identity that can disagree with it.

```text
app action / UI event
        |
        v
typed table operation
        |
        +----------------------+
        | local SQLite commit  |
        | local observation    |
        +----------------------+
        |
        v
record authority
        |
        v
ordered mutations to other replicas
```

Child-document edits follow their own Yjs path. KV edits use the eager KV Yjs
document. The workspace composes these paths but does not pretend they have one
conflict model.

## Portable workspaces are logical folders

A complete ownership export has one fixed shape:

```text
workspace.json
tables.sqlite3
kv.json
documents/
blobs/
```

The tables file is a clean logical interchange database, not a copied runtime
replica. It excludes actor identity, cursors, outboxes, indexes, and pending sync
machinery. The locked table declarations identify blob references and document
fields, so export follows the schema instead of guessing from SQLite metadata.

Exports are immutable ownership archives and escape hatches. They do not make
live workspaces roll backward, and Epicenter provides no generic whole-folder
importer. An application may deliberately re-ingest files through its ordinary
APIs. `epicenter tables apply` is the one generic path back into a live
workspace: it translates an edited `tables.sqlite3` into reviewed forward
mutations guarded by the current server head. It validates the sibling
`workspace.json`, replans and asks again when the head moves, and never replaces
history or merges the other storage planes.

## Durable contract changes start a new workspace version

One workspace version has one records schema and one exact identity
for every other durable plane. A change to any of them publishes a new
workspace version, even when the change is additive. Epicenter does not translate
mutations, KV, child documents, or blobs between workspace versions. Older versions
remain independent and writable.

A records epoch is narrower. The authority mints it for one continuous records
history inside one workspace version. Records-authority repair may mint a new
epoch to fence stale cursors and writes. An epoch-fenced replica can export one
self-describing recovery checkpoint containing its local rows and pending
logical mutations. The checkpoint has no automatic import or replay operation.

The current build owns workspace-version-aware boot:

```text
inspect current root identity without creating storage
        |
        |-- initialized -> open current workspace version
        |-- invalid     -> refuse to open
        `-- absent
              |-- no predecessors -> initialize current workspace version
              `-- predecessors    -> ask before creating anything
                    |-- start current version
                    `-- continue at a historical build route
```

The choice is not persisted. Starting the current workspace version leaves every
predecessor unchanged. Continuing to a previous version does not initialize the
current namespace. The first implementation adds no copy, seed, importer,
migration chain, or read-only retirement fence.

## The star owns availability, not application meaning

A star is the runnable deployment that holds a person's synchronized data. The
hosted Cloud app and the self-hosted instance use the same shared server library
but resolve principals differently.

The records authority owns ordering, the current records epoch, and ordinary
snapshot bootstrap. It receives the generated workspace ID but knows nothing
about application IDs, workspace versions, predecessor order, or current
builds. Yjs rooms carry KV and child-document updates. The blob store holds
large binaries by reference.

This separation keeps the privacy question concrete. Epicenter can run the
star, or the user can run it. In either topology, apps keep their schema meaning
and product policy at the client boundary.

## Current adoption

The workspace-version-aware SQLite implementation lives under
`packages/workspace/src/sqlite`. The older public workspace path still stores
record tables and KV in one root Y.Doc. It does not gain a version-one alias,
fallback probe, or import bridge from the SQLite path.

Each adopting application must inventory records, KV, child documents, and
app-owned blobs before it publishes a workspace version lock. The code and accepted
ADRs remain current implementation truth.
