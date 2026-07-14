# 0140. Portable ownership has no generic whole-workspace import

- **Status:** Accepted
- **Date:** 2026-07-14
- **Amends:** [ADR-0121](0121-background-sync-is-automatic-and-database-boundary-merges-are-reviewable.md), [ADR-0132](0132-an-obsolete-replica-exports-one-read-only-recovery-checkpoint.md), [ADR-0137](0137-applications-declare-one-live-workspace-per-contract-version.md), [ADR-0139](0139-portable-workspaces-are-schema-directed-folders-applied-as-forward-mutations.md)

## Context

A complete portable workspace proves ownership only if a person can inspect and
carry every declared durable plane. That does not require Epicenter to provide
the inverse operation.

One principal, application ID, and version already resolves one deterministic
workspace ID. Importing a second copy would require another identity plus a
catalog or pointer that says which copy is current. Reusing the original
identity would instead require a whole-workspace incarnation protocol that
fences stale records replicas, KV clients, and child-document sessions together.
The private records epoch cannot fence the Yjs planes.

## Decision

A portable workspace folder is a one-way ownership export. Epicenter guarantees
complete logical files for inspection, external tooling, and deliberate
application-specific re-ingestion. It provides no generic whole-folder import,
restore, or workspace replacement operation.

`epicenter tables apply` remains the one generic path from an edited export into
a live workspace. It translates only `tables.sqlite3` into reviewed forward
mutations against the latest authority head. It does not apply `kv.json`, child
documents, or blob bytes.

An application or a new contract version may read an export and write new state
through its ordinary APIs. That code owns semantic conversion, identity choices,
and partial failure. Epicenter does not coordinate the storage planes or claim
that the resulting workspace reproduces the exported one.

Hosted catastrophe recovery remains private operator infrastructure. It does
not create an application-facing restore contract or grant a client authority
over server history.

Current documentation calls the folder a complete export, archive, or ownership
artifact. It does not call it a restorable backup.

## Consequences

- No import workspace ID, incarnation, current-workspace pointer, fork catalog,
  succession protocol, or cross-plane restore transaction is needed.
- Standard files preserve ownership even though Epicenter does not promise a
  one-command inverse.
- Application-specific importers may exist without becoming platform protocol.
- The portable export implementation is complete without an import round-trip
  proof.
- A user who wants to reconstruct application state must use an app-specific
  workflow or ordinary forward APIs.

## Considered alternatives

- **Import into the deterministic workspace ID.** Rejected because stale
  records and Yjs clients could rejoin different histories under the same
  addresses.
- **Mint a fresh workspace identity for every import.** Rejected because it
  requires a catalog or pointer to select the live copy and breaks the one
  app/version identity model.
- **Add a workspace incarnation across every storage plane.** Rejected because
  it creates permanent succession and fencing machinery for a hypothetical
  recovery flow.
- **Sequentially restore tables, KV, documents, and blobs.** Rejected because
  partial completion has no generic semantic meaning and cannot be atomic across
  the independent authorities.
