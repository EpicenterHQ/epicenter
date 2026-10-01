# 0125. Record definitions are release-local lenses and never migrate user data

- **Status:** Accepted, amended 2026-08-30 at where a nonconforming row surfaces
- **Date:** 2026-07-15
- **Amended by:** [ADR-0420](0420-epicenter-working-copies-use-the-matter-file-contract.md) at runtime write admission: ordinary JSON assignments, including owner-permitted working-copy edits, do not require conformance. Static patch types do not imply runtime schema validation.
- **Supersedes:** [ADR-0006](0006-schema-evolution-keeps-the-version-tuple-and-refuses-repair-apis.md)
- **Relates:** [ADR-0119](0119-complete-record-maps-sync-through-schema-blind-server-ordered-patches.md), [ADR-0120](0120-fields-validate-present-values-and-table-lenses-own-presence.md), [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md)

## Context

Per-row versions and successor databases both treat a developer's current
interpretation as the durable identity of user data. They require historical
schemas, executable transforms, candidate construction, activation, fencing,
old-client policy, stranded outbox recovery, and rollback rules. The canonical
record map can instead preserve honest JSON independently of any release.

## Decision

Application record definitions are release-local read and write lenses over one
stable schema-opaque canonical record map. They do not enter canonical identity,
the record wire, snapshots, server admission, or synchronization compatibility.
Changing a definition never migrates, copies, heals, activates, fences, or
replaces canonical user data. Developers may change a lens arbitrarily,
including adding required keys or narrowing validation. Required means required
for successful interpretation by that lens, never required for canonical
storage admission.

Table and field names are exact permanent storage keys. A definition may add or
remove a projected field without touching stored payloads. Renaming a key means
the release now addresses a different key. Epicenter provides no alias,
`fallbackFrom`, automatic rename, schema version, historical descriptor,
migration chain, compatibility classifier, or successor database.

A release validates values it understands and preserves everything else. Typed
reads surface nonconforming rows without modifying them. Typed patches modify
only explicit keys, validate only supplied values, and may modify a row whose
complete payload does not pass the current lens. Extra and future keys therefore
survive older writers, while a patch can repair one invalid or missing key.

Developers who want to populate, copy, normalize, or remove data write ordinary
bounded application code over current records. They may keep an old TypeBox
schema in application code, match a nonconforming raw payload against it, and
then issue an ordinary typed patch. Historical schemas are never registered
with Epicenter and do not enter workspace identity, synchronization, opening,
or release negotiation.

Repair code is application code, not a platform lifecycle. A repair should be
idempotent, bounded, observable, and safe to interrupt, but Epicenter gives it
no privileged authority, automatic execution, checkpoint, ordering, completion
marker, or promise of eventual global conformance. An old release may create
another nonconforming row after a repair finishes. Every release must therefore
handle nonconforming rows as an ordinary state rather than assuming a one-time
cutover removed them forever.

Physical runtime tables may evolve through internal SQLite storage migrations
because they do not reinterpret canonical payload meaning. Connection-local SQL
views change with the release and need no migration. Row-body root identity is
fixed by ADR-0135. Yjs binary update compatibility evolves through the
workspace protocol and storage major, not record lenses.

## Amendment, 2026-08-30: nonconformance is a fact about the table

"Typed reads surface nonconforming rows without modifying them" is unchanged
and is still the whole point. What moved is which read surfaces them.

`get(rowId)` used to return `Result<Row | undefined, NonconformingRow>`, so a
row this release cannot read arrived as that one row's failure. It answers
`Row | undefined` now, and a nonconforming row is `undefined`, alongside a row
that is simply not there.

**The evidence for collapsing them is that nobody had ever told them apart.**
Across every application and package, no call site branched on `get`'s error
arm. Honeycrisp had gone further and written `table.rows.find((f) => f.id ===
id)` by hand rather than pay an unwrap for a variant it did not read. What three
applications DO consume is the list-level report: Honeycrisp shows a count of
unreadable notes, and Whispering exposes one for recordings and one for recipes.
Conformance was already being handled as a fact about the table; the API was the
only thing insisting it was a fact about a row.

**Nothing is hidden by the collapse**, which is the clause of this record that
matters:

- `table.nonconforming` reports every unreadable row with its raw payload, its
  conforming half, and the fields that failed. Same `NonconformingRow`, same
  diagnostic, same guarantee that nothing was modified to produce it.
- The recovery composition this record describes still fits on one line:
  `row ?? { id, ...reported?.conforming }`.
- `update` still modifies a row whose complete payload does not pass the current
  lens, which is how a repair lands. Honeycrisp depends on this: deleting a
  folder walks `nonconforming` as well as `rows` so a note it cannot read is not
  a note it can orphan.
- An export still carries the row. The exporter reads `store.rowFile`, which
  runs no conformance at all, so a row the lens refuses still gets its file and
  can be repaired by editing the folder. That path would have been the one
  casualty of routing the export through `get`, and it is why the export does
  not.

## Consequences

- There is one stable workspace and one stable canonical record map, not a chain
  of schema-selected databases.
- Old and new releases may interpret the same bytes differently without being
  blocked at open. Patch semantics prevent them from erasing keys they do not
  know.
- Adding an optional field requires no backfill. Adding a required field may
  classify old rows as nonconforming until explicit application writes populate
  it. Both changes are permitted without platform classification.
- Removing a field from a lens preserves its bytes. Reintroducing the exact key
  sees the retained value again.
- Semantic key changes are visible application operations, not hidden read
  behavior.
- Historical TypeBox schemas and repair loops are removable application
  dependencies, not retained platform history.
- The migration runner, generated historical schemas, candidate protocol,
  source freeze, compare-and-switch activation, database fencing, and old
  outbox translation leave the destination architecture.
- A buggy or dishonest release can write values invalid under another release;
  this is retained honest data, not corruption of a typed physical table.

## Considered alternatives

- **Migrate rows lazily on read.** Rejected because observation would gain write
  authority and every release would retain executable history.
- **Build a fresh successor database.** Rejected because schema-opaque canonical
  JSON does not need replacement when only a lens changes.
- **Support aliases or fallback reads for renames.** Rejected because permanent
  fallback chains become an implicit migration language with ambiguous writes.
- **Automatically backfill defaults.** Rejected because a release-local fallback
  is not canonical user intent.
- **Fence incompatible releases.** Rejected because no release owns canonical
  schema identity.
- **Register historical schemas or repair jobs.** Rejected because registration
  recreates migration discovery, ordering, progress, crash recovery, and
  completion policy. Ordinary application code already has the required read
  diagnostics and typed patch authority.
