# 0178. Proposals are source-bound artifacts that disappear after local admission

- **Status:** Accepted
- **Date:** 2026-07-22 (accepted after the bounded prototype and Home product)
- **Relates:** [ADR-0160](0160-lenses-interpret-durable-namespaces-without-creating-lifecycle-scopes.md), [ADR-0162](0162-epicenter-home-owns-relational-inspection-applications-receive-no-sql.md), [ADR-0163](0163-scalar-sync-separates-fact-reads-from-numbered-intent-submissions.md), [ADR-0168](0168-lenses-are-complete-pure-json-interpretations.md), [ADR-0170](0170-one-live-epicenter-has-sealed-backups-and-restore-creates-a-fresh-authority-lifetime.md), [ADR-0171](0171-every-durable-local-write-leaves-an-automatic-authority-obligation.md)

## Context

People and agents need to review a bulk edit in familiar relational form before
it changes the live Epicenter. That review cannot become another replica,
outbox, synchronization protocol, or application SQL surface. A bounded
`bun:sqlite` prototype proved that unconditional ordinary writes plus a lagging
artifact watermark survive concurrency, crashes, duplicate Apply, parked
overlays, source changes, creation collisions, and tampering without adding any
of those mechanisms.

## Decision

Epicenter Home owns a **Proposal** as an external editable SQLite artifact over
one exact Lens-shaped selection. A selection names existing table record keys,
named values, and the tables in which the Proposal may create records. It has no
predicate, collection scan, namespace wildcard, SQL-to-Proposal path, or general
query language. A Proposal is neither part of the live store nor a subtype of a
snapshot or portable Backup.

The artifact contains a complete raw base ledger for the selected addresses and
separate friendly tables generated from the Lens. The raw ledger preserves
unknown fields. Existing table edits compile to field patches, row deletion
compiles to a tombstone, a cleared value compiles to unset, and new table rows
compile to collision-refusing creation. A friendly table's record-key column
mints 24 lowercase hexadecimal characters at draft time, so rows can refer to
new rows before Apply and every retry uses the same key. Draft creation refuses
a selected record that the Lens cannot interpret.

One host-owned random HMAC key lives outside every artifact. The draft seal
protects the artifact identity, exact schema, Lens, selection, source fence, and
raw base ledger while leaving the friendly tables editable. Compilation first
verifies that seal and the exact SQLite schema, refusing extra tables, views,
triggers, indexes, or columns. It then writes an ordered semantic manifest and
seals that manifest. The mutable Apply watermark is authenticated separately so
manual advancement is refused; replaying an older valid watermark is harmless.

The source fence is the replica ID and authority lifetime. It deliberately omits
the feed sequence so ordinary synchronization and concurrent writes remain
legal. Apply verifies the artifact, then handles each unwatermarked manifest
entry in order. In the same live-replica transaction as each admission, it
rechecks both fence fields and emits the change through the existing ordinary
pending lane. Apply never skips an entry because visible state already matches:
the matching state may be a parked overlay that still needs a fresh ordinary
write. The artifact watermark advances only after the live transaction commits,
so a crash may replay one admitted change.

Replayed patches, replacements, unsets, and tombstones converge through the
ordinary lane. Creation inserts only when the key is absent, accepts an exact
already-admitted creation as retry convergence, treats a later tombstone as
consumed, and refuses a different live or pending payload as a collision. It
does not persist a per-change receipt or Proposal-owned recovery record.

After the final local admission is durable, Home closes and deletes the
Proposal. It does not wait for authority acceptance or for the pending lane to
empty. If deletion is interrupted, startup cleanup recognizes the complete
authenticated watermark and deletes the artifact without applying it again.

The first product is a trusted desktop Home capability. Its SQLite compiler is
portable, but browser artifact custody, HMAC-key custody, OPFS registry, and
external-file transfer wait until a browser Home product needs them. Proposal
operations do not enter the application-facing Epicenter API.

## Consequences

- Review and editing happen in a disposable familiar file while the live store
  keeps one typed write protocol.
- Concurrent disjoint edits compose. Same-field edits follow ordinary local
  admission order at Apply time; the Proposal does not introduce a rebase or
  conflict-resolution protocol.
- Unknown fields survive because compilation patches selected Lens fields over
  the current visible payload instead of replacing existing table records.
- Restore and replica remint refuse stale Proposals before Apply and between any
  two changes.
- The artifact may disappear while synchronization still owes work. The normal
  pending lane is the sole durable obligation.
- The v1 review surface is intentionally coarse: compile and inspect one sealed
  manifest, then apply all of it or none of it. Per-change accept or reject,
  live preview, sharing, synchronization, and polished inline spreadsheet or
  diff UI are deferred.
- Desktop-only orchestration avoids committing to a second browser file-custody
  product. Emitted changes remain ordinary replica writes on every adapter.

## Implementation

`@epicenter/data` owns exact selection parsing, sealed SQLite draft and
manifest compilation, source-fenced ordinary admission, authenticated
watermarks, crash recovery, and artifact cleanup. The maintained tests cover
disjoint and same-field concurrency, a crash after every individual admission
boundary, duplicate admission, the parked-overlay trap, and a source-fence
change between Proposal entries during Apply. They also cover
creation-collision, tamper, and cleanup cases without adding a Proposal
replica, receipt log, or second outbox.

Epicenter Home publishes a closed catalog of its compiled Lenses and owns the
desktop artifact lifecycle through authenticated, serialized routes. The Home
sheet exposes exact selection JSON, external artifact paths, compile counts,
authenticated resume status, explicit Apply and Delete confirmations, and
catalog invalidation when a failed incremental Apply cannot refresh its
status. Completed Apply deletes the artifact while the ordinary pending lane
keeps sole ownership of remaining synchronization work.

## Considered alternatives

- **A Proposal replica or second outbox.** Rejected because the nine-case
  prototype resumed every crash from a lagging artifact watermark and the
  existing ordinary pending lane.
- **Skip writes whose visible state already matches.** Rejected because a
  parked overlay can match visibly while still owing an ordinary local write.
- **Per-change receipts.** Rejected because semantic duplicate convergence
  handles a crash after live admission but before watermark advancement.
- **Fence on the captured feed sequence.** Rejected because it would turn
  harmless synchronization into false staleness. Restore and replica remint are
  the source changes that must invalidate Apply.
- **General filters or arbitrary SQL selection.** Rejected because exact
  Lens-shaped address selection provides reviewed bulk edits without creating a
  second live query language.
- **Proposal state that survives local admission.** Rejected because authority
  settlement belongs to the ordinary pending lane and must not create a second
  lifecycle.
- **Browser and desktop orchestration in the first release.** Rejected because
  browser file custody and external transfer are a separate product surface,
  not shared Proposal semantics.
