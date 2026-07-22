# 0177. Each store owner persists records in one wide interned crash-state relation

- **Status:** Proposed
- **Date:** 2026-07-21
- **Amends:** [ADR-0161](0161-each-person-has-one-epicenter-replicated-on-each-adapter-boundary.md) by
  superseding its schema-wide coordinate-layout evidence enumeration with this
  decision's named acceptance charters
- **Relates:** [ADR-0160](0160-lenses-interpret-durable-namespaces-without-creating-lifecycle-scopes.md), [ADR-0163](0163-scalar-sync-separates-fact-reads-from-numbered-intent-submissions.md), [ADR-0164](0164-scalar-facts-converge-independently-epicenter-refuses-distributed-transactions.md), [ADR-0172](0172-sqlite-stores-convergent-facts-and-documents-raw-files-store-blob-bytes.md), [ADR-0174](0174-row-documents-project-as-nullable-compact-cells-and-persist-as-bounded-live-chains.md)

## Context

The durable semantic model is frozen: one record per address triple, four wire
operations, and a replica crash machine of confirmed, sealed, and pending lanes
plus a parked overlay (ADR-0160, ADR-0163). That model does not choose a
physical SQLite representation. ADR-0161 previously required schema-wide
coordinate-layout evidence across a four-combination benchmark matrix without
selecting a layout. Later evidence dissolved that matrix: the historical ~20%
normalization win decomposed into roughly two coordinate prefix copies (about
12% on its fixture), and a hostile fault-injection probe executed every lane
transition on a wide single-relation layout, restoring a legal persistent state
from every injected mid-transaction crash. The physical selection now needs one
durable owner that states the chosen candidate, its runner-up, and the exact
evidence that could still reverse it.

## Decision

Each store owner, replica and authority, persists every durable record in one
`records` relation. There is no per-kind relation family and no durable
collection-kind column: storage cannot tell a table record from a values
record, because that distinction exists only in Lens collection definitions.

The replica row is the whole per-address crash-state machine. One row holds the
identity triple, the confirmed lane (state, payload, sequence), the sealed lane
(operation, arguments), the pending lane (operation, arguments), the parked
overlay (the retained refused operation plus its refusal code and
measurements), and the small document and blob obligation columns. The
authority row holds the identity triple, the one current fact lane, and the
accepted blob digest. Every per-address protocol transition is one transaction
touching one `records` row plus at most one `meta` write; a transaction that
covers a whole submission (seal, fold, settle) touches one row per distinct
address plus its metadata, still atomically.

`record_id INTEGER PRIMARY KEY` is a real rowid that interns the triple. The
address triple is a UNIQUE secondary index. Byte-heavy sibling relations, the
bounded document chains and the frozen in-flight publication image, reference
the eight-byte `record_id`, never a repeated triple. `record_id` is private
physical state: it never appears in an API, a wire shape, or an artifact.

Lane-shape invariants are row-local CHECK disjunctions. SQLite CHECK
constraints pass on NULL, so every occupied branch carries explicit
`IS NOT NULL` guards; a branch is definitively false, never NULL. Patch
arguments carry coarse JSON shape checks. Full admission validation is owned by
the pure write-path functions: with inspection an inert artifact (ADR-0162), no
supported surface writes SQL at the live file, so CHECK constraints are defense
in depth, not the invariant owner.

There are no foreign-key cascades. A tombstone is an UPDATE of the record row,
and cascades fire only on DELETE, so the tombstone transaction explicitly
deletes the record's document chain and in-flight rows and clears its blob
evidence; the whole-replica erase transaction explicitly deletes every sibling
relation. Cleanup is owned visibly by the two transactions that need it.

Each owner's `meta` is one explicit single-row table with named columns
(`PRAGMA user_version` is unavailable on Durable Object SQLite). The replica
`meta` row also persists the sealed submission's exact canonical request bytes
and hash required by ADR-0163.

One refusal is recorded so it stays refused: no materialized visible-payload
column. Its only consumer was live SQL inspection; visible state remains a
JavaScript fold over the lanes at read time and at capture time. A derived
column maintained by every lane transition is a standing corruption class with
no remaining buyer.

### Selection posture

Epicenter implements the wide record row as its selected physical candidate.
The durable semantic and public contracts do not depend on that representation,
and this ADR becomes Accepted only after its named reversal charters pass.

The sole physical runner-up is the split layout: separate semantic relations
for confirmed facts and local intents under the identical semantic model. A
late reversal is a schema swap inside the store owner, not a protocol, API, or
artifact change. The discriminated address-kind rival is not preserved; it
loses on semantic grounds independent of any measurement.

### Acceptance charters

Three bounded evidence charters decide this ADR, and only these three:

1. **Wide-versus-split hot paths.** One focused fixture at the ADR-0161
   representative envelope, run on Bun, browser OPFS, and Durable Object
   SQLite, measuring point read, traversal, lane write, feed install, and
   reopen. Stop when either direction differs by more than 20% on any hot
   metric, or all differ by less than 10%.
2. **Durable Object billing and write amplification.** Rows read and written
   per settled submission, wide versus split.
3. **Physical browser OPFS capacity and reopen.** The ADR-0161 mobile floors on
   physical iOS Safari and physical Android Chrome, including honest quota
   refusal that preserves the committed prefix.

The maintained lane-machine conformance harness (every transition executed with
statement-boundary fault injection, plus the composition property tests) is a
shipping gate for whichever layout ships. It is not a selector between them.
Inspection snapshot capture is likewise a product charter owned by ADR-0162,
not a physical-layout selector.

## Consequences

- One `SELECT` by triple answers what the authority said, what is in flight,
  what is wanted, what was refused, and what is still owed.
- Lane coherence is provable per row, and the cross-row invariant set (sealed
  rows match `meta`, feed prefixes are complete, no chain row outlives its
  record's terminal death) is smaller than any split layout's
  facts-versus-intents orphan class, though not empty; the conformance harness
  owns it.
- The address triple is stored twice per record (the row and its unique
  index). The wide layout measured about 3% more total bytes than the leanest
  split layout on the probe fixture; that cost buys single-relation
  transitions and the deleted orphan class.
- The four-combination relation-and-coordinate benchmark matrix is retired.
  Historical benchmark artifacts remain honest evidence about their own
  fixture; they do not select this layout and are not rerun as a gate.
- Sibling relations stay small: interning bounds the byte cost of document
  chains and publication images to an integer key.
- If a charter reverses the selection, the replacement lands as a store-owner
  schema swap while every caller-facing surface is unchanged.

## Considered alternatives

- **Split semantic relations (facts and intents tables).** The retained
  runner-up. Each relation states one meaning, but every cross-lane transition
  becomes a cross-relation invariant with an orphan class, and hot reads probe
  up to three indexes.
- **Interned coordinate directory beside split relations.** Rejected because a
  directory row plus its unique index costs nearly one inline triple copy, and
  every hot read pays a join; fusing the directory into the record row keeps
  the interning win without the join.
- **Wide row without interning (triple as primary key, WITHOUT ROWID).**
  Rejected because WITHOUT ROWID tables misbehave for payload-sized rows and
  duplicate the triple into every secondary index.
- **Append-only journal with materialized current state.** Rejected because
  pending growth is unbounded between synchronizations, desire must be
  compacted before sealing anyway, and durable sealing still needs solving on
  top.
- **Per-field register store with state-based synchronization.** Rejected
  because per-field version metadata multiplies storage at the representative
  envelope, multi-field patches tear on the wire, and the authority stops
  being an adjudicator, leaving parked admission with no home.
- **One physical SQLite table per collection.** Rejected because it requires
  the canonical schema owner Epicenter refuses: Lenses are partial,
  overlapping, and noncanonical, and unknown fields from a newer Lens would
  have nowhere to live.
- **One JSON document per collection or namespace.** Rejected because every
  write rewrites the whole document, and per-record sequences, tombstones, and
  subscription granularity disappear.
