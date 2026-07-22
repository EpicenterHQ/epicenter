# 0167. A portable Epicenter is an identity-free export of one authority cut

- **Status:** Accepted
- **Date:** 2026-07-20 (revised 2026-07-21: one kindless `_epicenter_records`
  relation and the `_epicenter_artifact` self-declaration every inert artifact
  carries; accepted 2026-07-22 after Bun and Cloudflare portable Backup and
  Restore implementation)
- **Amends:** [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md)
- **Amended by:** [ADR-0170](0170-one-live-epicenter-has-sealed-backups-and-restore-creates-a-fresh-authority-lifetime.md) (Backup lifecycle and the capture pin manifest)
- **Relates:** [ADR-0162](0162-epicenter-home-owns-relational-inspection-applications-receive-no-sql.md), [ADR-0177](0177-replica-and-authority-owners-use-role-specific-wide-record-relations.md)

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
The artifact contains every record's scalar state, accepted compact document
state, and remotely owned blob byte present at the authority cut. It does not
contain pending changes or local-only blobs that another offline device has
never uploaded. For a local-only Epicenter, the selected local store is the
authority and exports its own durable cut.

The logical artifact contains:

```txt
portable Epicenter
├── logical SQLite
│   ├── records with scalar payloads, compact documents, and blob digests
│   └── the _epicenter_artifact self-declaration
└── one raw blob file for every record whose blob digest is present
```

Its one relation exposes the stable structured logical addresses:

```sql
_epicenter_records(
  namespace,
  collection,
  record_key,
  payload_json,
  document_update_v2 BLOB NULL,
  blob_sha256 TEXT NULL
)
```

One kindless relation is forced, not chosen: durable storage carries no
collection kind (ADR-0160), so a capture cannot split unknown records into row
and value relations without a Lens, and the artifact must remain complete with
no Lens installed.

Every inert Epicenter artifact also carries one `_epicenter_artifact` metadata
row declaring its `kind`, format version, source authority lifetime, and
capture watermark. This ADR owns that self-declaration vocabulary. The
portable artifact declares `kind = 'portable'`. Inspection snapshots
(ADR-0162, `kind = 'snapshot'`) and the prototype-gated Proposal artifact
(`kind = 'proposal'`) are non-portable kinds with their own contracts and
column sets. No artifact is ever accepted as another kind; the refusal is
structural, not conventional.

ADR-0161's representative 512 MiB quantity is a versioned benchmark proxy over
structured addresses and record payloads. It excludes
`document_update_v2`, `blob_sha256`, raw blob bytes, container framing, and
private synchronization state. It is neither a maximum record size, a maximum
portable-Epicenter size, nor a claim that the portable artifact has canonical
bytes. The maintained benchmark contract owns the proxy encoding.

`document_update_v2` is one self-contained compact Yjs V2 update for the whole
document, never a state vector or copied live update log. `NULL` means no
document state has ever been persisted for the record. `blob_sha256` records
the accepted bytes in the record's zero-or-one blob slot. The records relation
is therefore the complete document and blob membership inventory.

Export requires one matching raw file for every non-null `blob_sha256` and
verifies its digest. It carries no separate blob relation, document inventory,
blob metadata file, or membership `manifest.json`. A generic container seal may
still protect artifact completeness and format integrity; it must not recreate
a second logical inventory. ADR-0170's durable capture pin manifest is
authority-side operational state that protects the copy phase; it is not part
of the artifact and is not a second logical inventory.

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

Initialization validates the complete artifact, preserves record identities and
their accepted bytes, and creates a fresh authority and synchronization
lifetime. It does not preserve a relationship with the source.

[ADR-0170](0170-one-live-epicenter-has-sealed-backups-and-restore-creates-a-fresh-authority-lifetime.md)
gives this representation a product lifecycle. A host-managed `Backup` is one
sealed portable Epicenter. `Back up` creates one, `Download` materializes it for
external custody or inspection, and `Restore` initializes a fresh authority
lifetime from a Backup or validated uploaded artifact. Restore replaces the live
authority rather than merging into it.

## Implementation

The authority capture path pages one complete accepted cut into the portable
record relation, including compact documents and verified blob bytes. Bun
publishes directory and tar artifacts; Cloudflare publishes sealed registry
artifacts through bounded materialization. Both validate artifact identity and
structure before Restore constructs a successor authority.

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
