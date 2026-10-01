# 0379. Storage maintenance preserves document lineage

- **Status:** Proposed
- **Date:** 2026-09-09
- **Amends:** [ADR-0276](0276-an-authority-holds-a-numbered-succession-of-generations-and-nothing-is-ever-overwritten.md) at maintenance and recovery: folding preserves lineage and readable-content recovery uses ordinary edits.
- **Relates:** [ADR-0394](0394-materialization-contains-documents-and-blob-references.md) describes document materialization; [ADR-0395](0395-restore-is-one-request-that-carries-its-own-safety-copy.md) describes recovery through Push; [ADR-0417](0417-a-data-address-holds-one-document.md) defines coordinated replacement without generations.

## Context

An earlier proposal coupled storage maintenance to a backup catalog and
replacement of a live document. The selected recovery workflow instead brings
old readable content into the current working copy and applies ordinary edits.
Neither folding nor content recovery needs a remote restore product.

The earlier cleanup retained activation and retirement pending a caller audit.
The [2026-09-21 review](../reports/20260921-generation-removal.md) found no
production replacement caller. Their presence in tests does not require them
as a maintenance capability. Generation removal is specified in ADR-0417 and
remains unimplemented.

## Decision

Ordinary storage maintenance preserves the live Yjs lineage. Folding combines
persisted updates from that lineage. It does not rebuild rows under new
operation identities or replace the document that other devices hold.

The acknowledged-log fold replays updates into a temporary `gc: true` document,
then encodes a complete update. Unsynchronized outgoing updates are handled
separately. Replaying into a temporary document preserves operation identities;
it is not whole-document reconstruction.

Measure folded bytes, tail bytes, and cold-open costs before adding destructive
maintenance. A future requirement to rebuild a whole document belongs to the
manual replacement boundary, not an automatic maintenance callback.

Recover readable content through ordinary Push. Push applies row and setting
changes, keeps other devices' pending edits, and uses the current working-copy
baseline. Recovering a deleted record creates a new row rather than reviving a
deleted CRDT identity. Changing row state does not delete independent blobs.

## Consequences

No generation allocation, activation, retirement, backup catalog, or exact-state
archive is required for maintenance. Preserve ordinary snapshot folding and
outbox handling when removing the generation machinery. A storage or transport
failure cannot authorize discarding the local document.

The unmounted backup coordinator and structural JSON archive were removed in
an earlier cleanup. Their evidence remains in Git at `16f8d418f4`. The remaining
activation code is implementation inventory for removal, not a recovery API.

## Considered alternatives

- Replace document identities during automatic maintenance: requires a
  cross-device loss boundary for a routine storage operation.
- Build server backups and destructive restore first: makes folding depend on
  retention and replacement that content recovery does not need.
- Remove folding together with generations: discards the mechanism that keeps
  ordinary log replay bounded while preserving offline edits.
