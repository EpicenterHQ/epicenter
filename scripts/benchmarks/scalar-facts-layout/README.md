# scalar-facts-layout

A decision instrument for one narrow question in Wave 2b: how should the scalar
state tables of the local replica and the server authority store their structured
coordinates and relation split, measured on Bun `bun:sqlite` at the conformance
envelope.

## Classifier-only policy (read first)

Per ADR-0161 and `specs/20260720T002337-epicenter-data-clean-break.md` (424-444,
555-562), **evidence never selects, ranks, recommends, applies a tie-break, or
returns a candidate id.** Nothing in this directory produces a winner. The
future evidence classifier only classifies each candidate-pair contrast against
fixed equivalence margins and against absolute performance SLOs; a human ADR
process, not this code, decides.

Two consequences are enforced mechanically here:

- A **measurement-method pilot** validates the method. It is never
  decision-eligible and can never make evidence ADR-ready. Its only product is
  `methodValidated` plus explicit proof refusals (`evidence-status.ts`), and
  `methodValidated` is derived from RECORDED operations, never a hardcoded
  boolean.
- Evidence readiness is **fail-closed** with four states: `invalid`,
  `incomplete`, `provisional`, `ready-for-adr-review`. Readiness requires a
  configured SLO policy with a positive finite ceiling for every required metric
  AND an observed within-ceiling per-cell measurement for every metric; a
  configured flag with an empty or partial ceiling set is `invalid`. The absolute
  install, open, read, write, feed, traversal, and restart ceilings are unmade
  ADR/product choices, so this code ships only the unconfigured SLO shape and
  invents no numeric ceilings; a pilot is always at most `provisional`.

## Executable status: a smoke, not a validated pilot

`pilot.ts` is deliberately a **smoke**. Its gates are derived from recorded
operations (calibration checks every recorded block against the 20 ms floor;
each block records its own immediate warmup; the balanced Williams order is
executed and its balance recomputed from the recorded blocks; reopen retains
witnesses; a real 400-transaction mutating tail runs after a true byte-equivalent
reset verified by pre-state witness equality; the headroom preflight runs before
retaining databases and fails closed; the checkpoint is persisted atomically and
resumed cross-process). Because the full declared owner workload matrix is not
yet implemented, the `owner-workloads` gate fails by construction and
`methodValidated` is **unreachable**: the executable never claims to be a
validated pilot. Implemented owner metrics are a subset of the declared set
(`acquisitionInstall`, `confirmedPointRead`, `monotonicInstallTail`,
`warmReopen` for the replica; `orderedFreshFeed`, `foldPointRead`,
`submissionSettlementTail`, `warmReopen` for the authority); overlay,
resume-feed, exact-retry, tombstone-document-cleanup, and the remaining mutating
tails are declared-but-pending and returned to Codex.

## Modular pilot architecture

The modular exact-trace pilot is a set of cohesive, independently tested modules.
Bun owns only the local runner and SQLite lifecycle; trace generation, framing,
hashing, scheduling, statistics, and status are portable to browser runtimes.

- `portable-hash.ts`: a streaming SHA-256, byte-identical to the V1 kernel's
  `sha256Hex`, plus `utf8ByteLength`. Removes the Bun `CryptoHasher`/`Buffer`
  dependence so the workload hashes reproduce in a browser.
- `trace.ts`: the deterministic corpus, aging events, and the analytical oracle.
  Its `Fact`/`Address` types ARE the private V1 kernel types, and its byte oracle
  is the kernel encoder, so it cannot emit a fact the protocol would reject.
- `v1-binding.ts`: proves, against the real kernel `parseFact`/`encodedFactBytes`,
  that representative generated facts admit and that the trace byte oracle equals
  the kernel's. This binding is the **independent correctness proof**.
- `auxiliary-traces.ts`: owner-specific pending, sealed, parked, document, and
  retry traces, each deterministic, hashed, and bound to the V1 intent/submission/
  parked shapes. The coordinate-layout decision applies to every address-bearing
  owner table, so no universal owner claim is admissible without these.
- `schedule.ts`: the balanced Williams read schedule (three cycles, self-transition
  pairs, seed-rotated letter mapping, recorded idle+reopen boundaries) and the
  power-of-two calibration sizing to reach a minimum timed-block duration.
- `statistics.ts`: the declared estimator. Its input is structurally seed-level,
  so it cannot bootstrap below the whole seed. It runs a deterministic studentized
  paired bootstrap over whole seeds, builds 95% familywise simultaneous max-t
  intervals, and classifies each contrast against fixed log-ratio margins.
- `checkpoint.ts`: atomically persisted, schema-validated, cross-process
  per-seed checkpointing. Identity binds the exact source, whole config,
  per-candidate DDL hashes, limits digest, runtime and SQLite versions, execution
  settings, and workload and auxiliary digests; resume happens only at a committed
  whole-seed boundary and fails closed on any mismatch, truncation, or partial seed.
- `layouts.ts`: the four SQLite candidate stores. Coordinates are an immutable
  append-only dictionary; normalized fact tables enforce coordinate kind and
  row_id shape; install is monotonic and tombstone-dominant; storage counts every
  candidate-owned btree including autoindexes. `layouts-invariants.test.ts` proves
  each with direct hostile SQL.
- `evidence-status.ts`: the classifier-only method validation and four-state
  fail-closed evidence-readiness contract described above.

## Correctness vs consistency

- **Independent correctness**: a candidate store reproduces the analytical,
  V1-bound oracle witness (exact current-fact count, exact current-protocol-fact
  bytes, and one ordered SHA-256 over the current facts). The oracle is a
  closed-form function of the trace, not a peer read path.
- **Consistency, not correctness**: candidates agreeing with one another, or a
  reopened database agreeing with itself, is cross-candidate / reopen consistency.
  It is a separate proof gate and never stands in for the oracle correctness proof.

## Two distinct byte measures (ADR-0161, ADR-0167)

The trace keeps present-logical-state bytes (the ADR-0167 proxy, the 512 MiB /
1,000,000-live-address target quantity) separate from current-protocol-fact bytes
(a storage and workload diagnostic over every current fact, including terminal
absences). `trace.calibration.traceAdmissible` is a narrow trace-construction
flag (the corpus hit its byte target and no fact exceeds the ceiling); it is not
an ADR/evidence-cell qualification and never implies a cell is decision-eligible.

## Determinism

Seeded PRNG only; no wall clock or `Math.random` in the workload or statistics.
Paired candidates within one seed see exactly the same trace; each seed is an
independent outer unit. Same seed and config reproduce byte-identical trace
identity, schedule, estimator inputs, bootstrap draws, and status.

## Historical monolith (`scalar-facts-layout.ts`): decision-disabled

The parent `scalar-facts-layout.ts` retains the first benchmark implementation and
its 2026-07-21 Bun/native full run. It is retained as **provisional evidence
only** and is **decision-disabled**: it issues no recommendation and its latency
estimator was found inadequate by two independent reviews. It predates and does
not use the modular exact trace.

Its storage numbers are **whole-database, post-phase-WAL page evidence**, not
candidate-table-only true filesystem peaks: they measure the entire database file
(including fixture tables and WAL state after a phase) rather than the isolated
candidate-varying tables' peak filesystem bytes. Treat the roughly 20% normalized
storage finding as directional whole-database evidence at this envelope, not a
frozen candidate-table peak.
