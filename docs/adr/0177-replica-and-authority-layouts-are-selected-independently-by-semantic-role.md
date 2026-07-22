# 0177. Replica and authority layouts are selected independently by semantic role

- **Status:** Proposed
- **Date:** 2026-07-21 (revised 2026-07-22: replica and authority physical
  layouts are selected independently by semantic role)
- **Amends:** [ADR-0161](0161-each-person-has-one-epicenter-replicated-on-each-adapter-boundary.md) by
  superseding its schema-wide coordinate-layout evidence enumeration with this
  decision's named acceptance charters
- **Relates:** [ADR-0160](0160-lenses-interpret-durable-namespaces-without-creating-lifecycle-scopes.md), [ADR-0163](0163-scalar-sync-separates-fact-reads-from-numbered-intent-submissions.md), [ADR-0164](0164-scalar-facts-converge-independently-epicenter-refuses-distributed-transactions.md), [ADR-0172](0172-sqlite-stores-convergent-facts-and-documents-raw-files-store-blob-bytes.md), [ADR-0174](0174-row-documents-project-as-nullable-compact-cells-and-persist-as-bounded-live-chains.md)

## Context

The durable semantic model is shared: one record per address triple, four wire
operations, and one conformance contract. Replica and authority stores do
different jobs. A replica persists confirmed facts beside sealed, pending, and
parked local work plus document and blob obligations; an authority persists
current accepted facts and retry witnesses. Requiring both roles to use one
physical SQLite layout creates uniformity where their measured hot paths and
invariants differ.

## Decision

Physical layout belongs to the semantic role, not the adapter. Browser OPFS and
Bun replicas implement one replica schema. Durable Object SQLite and Bun
authorities implement one authority schema. Adapters may differ in connection,
filesystem, and lifecycle mechanics; they do not invent independent schemas.

Authority stores use the wide interned layout. One `records` row holds the
address triple, current fact, and accepted blob digest. Authority measurements
favor that shape for feed, fact-write, settlement, and storage paths.

Replica stores target a split layout: confirmed facts and sparse local intents
occupy separate semantic relations under the same replica API. The complete
production split schema must also own document revision watermarks, blob digest
watermarks, refusal evidence, interned document-chain ownership, tombstone
cleanup, sealing, erase, and reacquisition. This target remains evidence-gated;
the current production-shaped implementation is wide until the complete split
candidate passes the acceptance charter below.

Neither role stores collection kind. Storage cannot tell a table record from a
values record because that distinction exists only in Lens interpretations.
Private row IDs, relation names, and joins never appear in APIs, wire shapes, or
portable artifacts.

Admission functions own full protocol validation. SQLite constraints remain
defense in depth. Tombstone and whole-owner erase transactions explicitly clean
every role-owned sibling relation; no foreign-key cascade hides lifecycle
ownership. Each role keeps one explicit single-row replica or authority table
because platform SQLite does not offer one portable PRAGMA vocabulary for this
state.

### Selection posture

Authority wide is selected. Replica split is the selected target but remains
provisional until its complete production-shaped proof lands. Wide remains the
replica runner-up and current implementation. A reversal affects only the
replica store owner; semantic, wire, API, and portable contracts remain fixed.

### Acceptance charters

The complete split replica must:

1. Bind the unchanged replica conformance and statement-boundary fault suite on
   Bun SQLite and production browser OPFS owners.
2. Cover scalar lanes, document and blob watermarks, refusal evidence,
   tombstone cleanup, sealing, erase, reopen, and reacquisition.
3. Re-run point read, traversal, local intent write, fact installation,
   document append and drain scan, blob drain scan, reopen, storage, statement
   count, and invariant complexity against the complete wide runner-up.
4. Qualify capacity, reopen, quota refusal, suspension, and eviction on physical
   iOS Safari and Android Chrome. Simulated engines never satisfy this cell.

Choose split only if its material replica wins survive the complete schema,
critical paths show no material regression, and added cross-relation invariants
remain bounded by the shared conformance suite. Otherwise retain wide.

### Evidence checkpoint: Durable Object authority

The 2026-07-22 workerd charter ran the selected production authority DDL and
the split runner-up in both candidate orders. Each run held 1,000,000 records
at the exact 536,870,912-byte V1 proxy and measured 128 batches of 64
addresses. Wide used 602,787,840 bytes versus split's 644,837,376 and
materially won feed, fact write, and settlement timings. Split won
only the isolated accepted-blob write. Both averaged 130.008 written rows per
submission; wide read one extra row per touched address because its UPSERT
probed the secondary address index. Current Cloudflare allowances and rates
make the shared write count the governing billing term, so the read delta does
not reverse the authority result. Both layouts reopened with complete semantic
row counts. The reports, pricing calculation, and measurement limits live under
`docs/benchmarks/authority-layout/`.

This closes the Durable Object authority hot-path and billing slices in favor
of wide. Desktop browser evidence favors split for traversal and local intent
writes; Bun replica evidence is mixed. The measured split candidate remains
scalar-only, so it cannot select the production replica layout yet. Physical
mobile capacity evidence also remains open.

## Consequences

- Replica and authority roles may choose different physical layouts without
  creating different semantic models.
- Every adapter within one role shares its role schema and conformance binding.
- Authority wide keeps current facts, retry witnesses, and accepted blob state
  in the measured shape that favors its hot paths.
- Replica split may improve sparse-intent and traversal paths, but it earns the
  extra facts-versus-intents invariant only through the complete proof.
- Wide measured 3.46% larger than split in the Bun replica fixture and 6.52%
  smaller in the Durable Object authority fixture. Layout cost depends on role.
- The four-combination relation-and-coordinate benchmark matrix is retired.
  Historical benchmark artifacts remain honest evidence about their own
  fixture; they do not select this layout and are not rerun as a gate.
- If the replica charter reverses its target, the replacement remains a
  store-owner schema decision while every caller-facing surface stays unchanged.

## Considered alternatives

- **One wide layout for both roles.** Rejected because replica and authority
  state machines have different hot paths, measured storage costs, and
  invariants. Shared semantics do not require shared tables.
- **One custom layout per adapter.** Rejected because browser versus Bun and
  hosted versus self-host runtime mechanics do not justify four schemas. The
  semantic role is the stable physical-layout owner.
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
