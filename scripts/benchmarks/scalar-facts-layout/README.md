# scalar-facts-layout

A decision instrument for one narrow question in Wave 2b: how should the scalar
state tables of the local replica and the server authority store their structured
coordinates and relation split, measured on Bun `bun:sqlite` at the conformance
envelope.

## Evidence and decision separation (read first)

Per ADR-0161 and `specs/20260720T002337-epicenter-data-clean-break.md` (424-444,
555-562), **evidence never selects, ranks, recommends, applies a tie-break, or
returns a candidate id.** Nothing in this directory produces a winner. The
human ADR process, not this code, decides. Any future classifier, absolute SLO
policy, or final-evidence readiness contract needs its own product decision and
owner; none is predicted here.

Two consequences are enforced mechanically here:

- A **measurement-method pilot** validates the method. It is never
  decision-eligible and can never make evidence ADR-ready. Its only product is
  `methodValidated` plus explicit proof refusals (`evidence-status.ts`), and
  `methodValidated` is derived from RECORDED operations, never a hardcoded
  boolean.
- Final-evidence readiness and absolute performance SLO policy are absent. Their
  thresholds and state model are unmade ADR/product choices, so this pilot emits
  no guessed readiness status or placeholder policy.

## Executable status: a BOUNDED SMOKE, not yet the frozen pilot

`pilot.ts` `--profile smoke` (default) exercises the method wiring at bounded
scale but is **not** the frozen exact-envelope pilot and can **never** be
method-validated: the `exact-envelope` gate (exactly 1,000,000 present addresses,
512 MiB proxy, four seeds, three cycles) fails, and the `checkpoint-truthful`
gate fails because there is no truthful non-perturbing autocheckpoint boundary
signal yet (WAL shrink is not one; a measurement checkpoint would perturb the
workload). `--profile pilot` measures a bounded probe, extrapolates the disk and
wall-time to the exact envelope, enforces the eight-hour cap and headroom, and
refuses to run. The frozen pilot is not implemented to contract yet.

The pilot reports method validation, named proof refusals, and identity-closed
seed estimators. It does not estimate a winner or emit candidate ranking,
contrast, feasibility, SLO, or final-readiness output.

**Open contract gaps (not done), tracked for the next passes:**

- Faithful owner operations: `foldPointRead` must be an authority-fold read,
  cleanup must delete only document-owning rows, and settlement must consume real
  sealed V1 work and update retry/parked/settlement state.
- A truthful post-commit WAL-index checkpoint observation, or the pilot stays
  BLOCKED pending a native hook.
- Closed config/seed identities for every macro, tail, boundary, warmup batch,
  and checkpoint event. Database builds, calibration trials, and phase-disjoint
  calibration/warmup/timed probe plans are closed, and exact counts are derived,
  but the remaining event identities are not yet all first-class raw fields.
- An independent in-range oracle witness for the bounded traversal statement.
  The retained trace-derived traversal pages and page digests prove the intended
  phase identity and disjointness; the full scan proves candidate correctness,
  but neither witnesses what that separate candidate-store SQL path returned.
- A separately invocable, config-frozen, headroom/time-gated exact run distinct
  from `--estimate-only`, with the extrapolation validated at two bounded sizes.
- Frozen final-run config emission with disjoint final seed ids, only from a
  valid pilot.

**Method validation is not evidence readiness.** The pilot deliberately emits no
readiness status. Browser OPFS, Cloudflare Durable Object, full-envelope final
data, and selected absolute performance policy remain external requirements for
any later ADR-ready evidence contract.

## Modular pilot architecture

The modular exact-trace pilot is a set of cohesive, independently tested modules.
Bun owns only the local runner and SQLite lifecycle; trace generation, framing,
hashing, scheduling, and method validation are portable to browser runtimes.

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
  retained actual power-of-two calibration contract. Each operation-count round
  is one exact sixteen-trial Williams design. The first all-clear round selects;
  cap exhaustion retains a named `INCOMPLETE` artifact with no fallback count.
- `estimators.ts`: reduces each owner, metric family, candidate, seed, and config
  identity independently, and accepts persisted estimators only when they exactly
  match a fresh reduction of retained raw observations.
- `checkpoint.ts`: atomically persisted, schema-validated, cross-process
  per-seed checkpointing. Identity binds the exact source, whole config,
  per-seed trace inputs, per-candidate DDL hashes, limits digest, runtime and SQLite
  versions, execution settings, and workload and auxiliary digests; resume happens
  only at a committed whole-seed boundary and fails closed on any mismatch,
  truncation, or partial seed.
- `probe-plan.ts`: the layout-independent owner of deterministic probe sources.
  It derives exact indexed ranges, 48 non-empty traversal pages, trace-derived
  page digests, phase item digests, and final probe ids from frozen trace options.
  The runner and checkpoint validation both consume these reconstructed plans.
- `raw-schema.ts`: closed raw-observation shapes, exact gap-free temporal replay,
  config/seed/owner/candidate-bound build identities, and content-addressed probe
  plans compared field-for-field with the reconstructed deterministic owner.
  Calibration, warmup, and timed traversal use distinct sequence-bounded pages;
  the pilot does not claim candidate execution of those pages is independently
  witnessed yet.
- `layouts.ts`: the four SQLite candidate stores. Coordinates are an immutable
  append-only dictionary; normalized fact tables enforce coordinate kind and
  row_id shape; install is monotonic and tombstone-dominant; storage counts every
  candidate-owned btree including autoindexes. `layouts-invariants.test.ts` proves
  each with direct hostile SQL.
- `evidence-status.ts`: method validation and named proof refusals only.

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

Seeded PRNG only; no wall clock or `Math.random` in the workload.
Paired candidates within one seed see exactly the same trace; each seed is an
independent outer unit. Same seed and config reproduce byte-identical trace
identity, schedule, estimator inputs, and method gates.

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
