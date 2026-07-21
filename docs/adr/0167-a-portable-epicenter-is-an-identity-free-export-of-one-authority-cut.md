# 0167. A portable Epicenter is an identity-free export of one authority cut

- **Status:** Proposed
- **Date:** 2026-07-20
- **Amends:** [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md) and [ADR-0162](0162-epicenter-home-owns-relational-inspection-applications-receive-no-sql.md)

## Context

One Epicenter must remain portable without exposing a private live replica file
or turning export into another synchronization system. A synchronized authority
may not own changes or blobs that remain only on an offline device, so
"complete" must name one real durability boundary rather than imply global
coordination across every device.

## Decision

A portable Epicenter is an identity-free, provider-independent export of one
selected owner's complete accepted current logical state at one durability cut.
It represents the same logical Epicenter as the live system, but it is a
separate inert artifact, not a live authority database or replica database.

For a synchronized Epicenter, the selected owner is the principal authority.
The artifact contains every scalar row and value, accepted compact row-document
state, and remotely owned blob byte present at the authority cut. It does not
contain pending changes or local-only blobs that another offline device has
never uploaded. For a local-only Epicenter, the selected local store is the
authority and exports its own durable cut.

The logical artifact contains:

```txt
portable Epicenter
├── logical SQLite
│   ├── rows with scalar fields, compact documents, and blob digests
│   └── scalar values
└── one raw blob file for every row whose blob digest is present
```

Its relations expose the stable structured logical addresses:

```sql
rows(
  namespace_key,
  table_key,
  row_id,
  fields_json,
  document_update_v2 BLOB NULL,
  blob_sha256 TEXT NULL
)
values(namespace_key, value_key, value_json)
```

ADR-0161's representative 512 MiB quantity is a versioned benchmark proxy over
structured addresses, row fields, and value content. It excludes
`document_update_v2`, `blob_sha256`, raw blob bytes, container framing, and
private synchronization state. It is neither a maximum row size, a maximum
portable-Epicenter size, nor a claim that the portable artifact has canonical
bytes. The maintained benchmark contract owns the proxy encoding.

`document_update_v2` is one self-contained compact Yjs V2 update for the whole
document, never a state vector or copied live update log. `NULL` means no
document state has ever been persisted for the row. `blob_sha256` records the
accepted bytes in the row's zero-or-one blob slot. The row relation is therefore
the complete document and blob membership inventory.

Export requires one matching raw file for every non-null `blob_sha256` and
verifies its digest. It carries no separate blob relation, document inventory,
blob metadata file, or membership `manifest.json`. A generic container seal may
still protect artifact completeness and format integrity; it must not recreate
a second logical inventory.

The artifact always represents the complete selected authority. Namespace
filtering is an inspection operation, never a partial portable-Epicenter export.

It excludes principal identity, authentication, deployment identity, replica
identity, pending work, transport grouping, receipts, cursors, checkpoints,
authority sequences, synchronization lineage, mutation history, and private
runtime indexes. Terminal tombstones from the source authority are not logical
user data and do not enter the artifact.

The portable representation must be inspectable with ordinary tools. The
leading encoding is a documented SQLite file plus blob files, carried as a
directory or archive. The exact container, seal, and physical filename encoding
remain implementation decisions until a round-trip proof chooses them. Neither
representation may become the private schema of a live store.

The portable representation supports three substrate operations:

```txt
Export current logical state
Inspect the artifact
Initialize an empty Epicenter
```

Initialization validates the complete artifact, preserves row identities and
their accepted bytes, and creates a fresh authority and synchronization
lifetime. It does not preserve a relationship with the source.

[ADR-0170](0170-one-live-epicenter-has-sealed-backups-and-restore-creates-a-fresh-authority-lifetime.md)
gives this representation a product lifecycle. A host-managed `Backup` is one
sealed portable Epicenter. `Back up` creates one, `Download` materializes it for
external custody or inspection, and `Restore` initializes a fresh authority
lifetime from a Backup or validated uploaded artifact. Restore replaces the live
authority rather than merging into it.

## Consequences

- Export from a synchronized Epicenter reports the authority's accepted state,
  not every unsynchronized edit or byte on every device.
- The same logical data can move between hosted, self-hosted, and local-only
  owners without carrying account or synchronization identity.
- A live store may change its private SQLite schema without changing the
  portable contract.
- Portability needs a stable logical schema, versioning, validation,
  failure-atomic initialization, blob integrity, and round-trip equivalence.
- Export does not require exact-checkpoint semantics for ordinary live replicas.
  The selected authority owns the stable export cut.
- A host-managed Backup and a downloaded portable artifact carry the same logical
  portable Epicenter, but container and storage layout remain implementation
  details.

## Considered alternatives

- **Use the live SQLite file as the portable Epicenter.** Rejected because it
  mixes logical data with adapter layout, pending work, indexes, identity, and
  synchronization state.
- **Coordinate every device before export.** Rejected because it creates a
  distributed settlement and backup system and cannot complete while a device
  remains offline.
- **Merge or import into a nonempty Epicenter.** Rejected because schema-opaque
  state has no generic merge law. ADR-0170 Restore replaces the authority with a
  fresh lifetime instead; application-specific imports remain application logic.
- **Preserve synchronization lineage across initialization.** Rejected because
  the artifact moves logical data, not an authority lifetime.
