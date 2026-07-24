# 0177. Replica and authority owners use role-specific wide record relations

- **Status:** Proposed
- **Date:** 2026-07-21 (revised 2026-07-22: complete replica evidence selects
  wide for both semantic roles)
- **Amends:** [ADR-0161](0161-each-person-has-one-epicenter-replicated-on-each-adapter-boundary.md) by
  replacing its schema-wide coordinate-layout evidence enumeration with one
  measured physical strategy per semantic role
- **Relates:** [ADR-0160](0160-lenses-interpret-durable-namespaces-without-creating-lifecycle-scopes.md), [ADR-0163](0163-scalar-sync-separates-fact-reads-from-numbered-intent-submissions.md), [ADR-0164](0164-scalar-facts-converge-independently-epicenter-refuses-distributed-transactions.md), [ADR-0172](0172-sqlite-stores-convergent-facts-and-documents-raw-files-store-blob-bytes.md), [ADR-0174](0174-row-documents-project-as-nullable-compact-cells-and-persist-as-bounded-live-chains.md)

## Context

The durable semantic model is shared: one record per address triple, four wire
operations, and one conformance contract. Replica and authority stores do
different jobs. A replica persists confirmed facts beside sealed, pending, and
parked local work plus document and blob obligations. An authority persists
accepted facts and retry witnesses. Those different state machines do not
require identical DDL, but both benefit from keeping one address's hot state in
one row.

The original scalar-shaped replica benchmark favored split relations for
traversal and sparse lane writes. Browser evidence repeated that direction.
Those candidates omitted the later document and blob foundations, so they could
not select the production layout. A complete split candidate was therefore
implemented behind the unchanged semantic store contract and measured against
the production-shaped wide candidate.

## Decision

Physical DDL belongs to the semantic role, not the runtime adapter. Browser OPFS
and Bun replicas implement one replica schema. Durable Object SQLite and Bun
authorities implement one authority schema. Every role uses a wide interned
record relation, but replica and authority rows have role-specific columns,
constraints, indexes, and transactions.

The replica wide row owns the address triple, confirmed scalar fact, sealed and
pending scalar work, parked scalar refusal, document publication revisions,
internal not-live publication suppression, the terminal document sync issue,
and blob publication watermarks. Bounded document-chain bytes remain in their
sibling relation keyed by the interned record ID. Raw blob bytes remain outside
SQLite. Covering partial indexes make owed document and blob drains sparse
without splitting the record state machine across relations.

The authority wide row owns the address triple, current accepted fact, and
accepted blob digest. Authority retry witnesses and document chains remain in
their bounded role-owned relations. The authority and replica schemas share a
physical strategy, not a table definition.

Neither role stores collection kind. Storage cannot tell a table record from a
values record because that distinction exists only in Lens interpretations.
Private row IDs, relation names, and joins never appear in APIs, wire shapes, or
portable artifacts.

Admission functions own full protocol validation. SQLite constraints remain
defense in depth. Tombstone and whole-owner erase transactions explicitly clean
every role-owned sibling relation; no foreign-key cascade hides lifecycle
ownership. Each role keeps one explicit single-row replica or authority table
because platform SQLite has no portable PRAGMA vocabulary for this state.

### Replica evidence

The 2026-07-22 complete Bun charter ran both candidate orders with 1,000,000
records, the exact 536,870,912-byte V1 proxy, scalar lanes, document state, blob
state, integrity checks, and reopen checks. Compared with split, wide materially
won point reads by 2.3 to 2.5 times and fact installation by about 1.2 times.
Complete traversal favored wide slightly, lane writes were at parity, and seal
favored wide from parity to 2.2 times depending on candidate order. Split's
earlier scalar traversal advantage collapsed to 7 to 17 percent, while split
used 588 MB versus wide's 759 MB.

The initial complete run showed large split wins for document and blob drain
scans. A controlled probe proved those losses belonged to the production wide
indexes, which covered only `record_id`, rather than to the wide relation. Wide
address-covering partial indexes reduced the document scan from about 1,143 ms
to 2.4 ms and the blob scan from about 1,149 ms to 26 ms.

A clean-source watermark probe at commit `68845f5a9d` then gave both candidates
the target local-versus-authority-accepted document revisions and blob digests,
plus covering partial drain indexes. Wide and split document scans were both
about 0.3 ms. Wide blob scan was 2.0 ms versus split's 7.4 ms. Split settled 64
document or blob receipts about 0.04 to 0.07 ms faster, an absolute difference
too small to offset wide's critical-path wins and simpler invariant ownership.
The stripped split probe remained smaller, 107 MB versus wide's 174 MB.

The complete split store passed the unchanged Bun conformance suite and direct
browser OPFS conformance in Chromium and WebKit. That proves split is viable; it
does not make it preferable. Split introduces eight additional cross-relation
invariants, materially regresses point reads, and no longer retains a material
everyday traversal or local-write advantage. Its storage saving does not repay
that cost. The evidence branch remains reproducible rejected-candidate history;
the split store is not exported or integrated into production.

### Authority evidence

The 2026-07-22 workerd charter ran the production authority DDL and split
runner-up in both candidate orders. Each run held 1,000,000 records at the exact
536,870,912-byte V1 proxy and measured 128 batches of 64 addresses. Wide used
602,787,840 bytes versus split's 644,837,376 and materially won feed, fact-write,
and settlement timings. Split won only the isolated accepted-blob write. Both
averaged 130.008 written rows per submission. Current Cloudflare allowances and
rates make that shared write count the governing billing term, so split's read
advantage does not reverse the authority result.

### Remaining qualification

The physical iOS Safari and Android Chrome capacity, reopen, quota, suspension,
and eviction charter remains open. It qualifies the selected production browser
owner; it is no longer a wide-versus-split selection gate. ADR-0177 remains
Proposed until the target watermark schema, covering drain indexes, and physical
owner qualification land together.

## Consequences

- Both semantic roles use one wide interned row per address, but do not share
  identical DDL.
- Every adapter within one role shares its role schema and conformance binding.
- Replica point reads, sealing, and fact installation avoid cross-relation
  assembly.
- Covering partial indexes provide sparse document and blob drains without
  independently mutable dirty flags.
- Split's storage advantage is consciously exchanged for fewer joins,
  statements, and cross-table invariants.
- The complete split implementation and raw reports remain evidence, not a
  production compatibility path or maintained second adapter.
- Historical scalar and browser reports remain honest evidence for their own
  fixtures; later complete evidence supersedes their layout recommendation.

## Considered alternatives

- **Split confirmed facts, local intents, documents, and blobs.** Rejected after
  the complete charter. Its early scalar wins largely disappeared, point reads
  materially regressed, corrected wide indexes removed the drain justification,
  and eight cross-relation invariants accompanied the storage saving.
- **One identical wide schema for replicas and authorities.** Rejected because
  the roles persist different state machines. A shared strategy does not justify
  fake column-level uniformity.
- **One custom layout per adapter.** Rejected because browser versus Bun and
  hosted versus self-host runtime mechanics do not justify four schemas. The
  semantic role is the stable physical-layout owner.
- **Wide row without interning.** Rejected because payload-sized WITHOUT ROWID
  tables perform poorly and repeat structured address text in secondary indexes.
- **Append-only journal with materialized current state.** Rejected because
  pending growth is unbounded between synchronizations and sealing still needs a
  compact durable desire.
- **Per-field register store.** Rejected because per-field metadata multiplies
  storage, multi-field patches tear on the wire, and parked authority admission
  loses its owner.
- **One SQLite table per Lens collection.** Rejected because Lenses are partial,
  overlapping, and noncanonical.
