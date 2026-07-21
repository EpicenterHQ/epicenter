# scalar-facts-layout

**Pre-pilot confirmed-facts correctness/storage evidence** for one narrow Wave 2b
question: how should the confirmed scalar-facts table(s) of the local replica and
the server authority store their structured coordinates and relation split,
measured on Bun `bun:sqlite` at a labeled stress proxy.

It is a decision instrument, not a reusable benchmark framework, and not a layout
freeze.

## This is not admissible full evidence

The spec's acceptance evidence requires exercising the real replica and authority
workflows on their supported production runtimes. This instrument does neither:
it drives only the actual confirmed-facts operations listed below, on Bun, which
cannot qualify OPFS, quota, WebKit, mobile, worker locks, or Durable Object
SQLite. Treat every result as **pre-pilot**: correctness and storage evidence
that a real pilot and then a qualification run must supersede. It never names,
ranks, or tie-breaks a layout; the ADR owns that choice.

## Scope (deliberately narrow)

This tool compares four candidate layouts of the **confirmed-facts table only**,
across two axes:

- relation layout: one unified `facts` table, or separate `row_facts` /
  `value_facts` tables;
- coordinate layout: inline structured coordinates, or a normalized
  `coordinates` dictionary keyed by `(kind, namespace, local_key)`.

It exercises those four candidates under two owners, measuring **only the actual
current-facts operations each performs**:

- replica: monotonic install (acquiring settled current facts in sequence
  order), row and value point reads, table traversal, ordered feed scan, and
  close/reopen;
- authority: full event-log replay install, ordered feed (fresh and resumed),
  fold point reads, and close/reopen.

### What this instrument does NOT measure or decide

It does **not** measure the real workflows the spec ultimately requires:
authority submission settlement, exact-retry, and parked-result handling; replica
pending-intent overlay reads and tombstone-driven document cleanup. It reports
those as unsupported rather than pretending to cover them.

The spec's physical-format break carries structured identity through confirmed
facts, pending intents, sealed submission state, parked diagnostics, and
document-liveness joins. Whether the inline-vs-normalized coordinate *encoding*
is a schema-wide choice binding every address-bearing table is source-silent, and
the non-facts stores are not yet designed in detail. Therefore this instrument:

- measures **only** the confirmed-facts table layout;
- scopes its storage metric to the **candidate-varying tables** (`facts`, plus
  `coordinates` for the normalized candidates), so the normalized-vs-inline delta
  is not diluted by fixture tables hard-wired to one encoding;
- **refuses to freeze** the schema-wide coordinate encoding or the layout of any
  non-facts store, and says so in its own report.

If Wave 2b intends a single schema-wide coordinate representation across every
address-bearing table, this instrument is the wrong shape and must be extended
before any freeze. That is an open ownership fork returned to Codex.

## Correctness: uniform invariants proven under attack

Every candidate keeps the same closed current-fact state under raw SQL, not just
through its store, via three uniform per-table invariants enforced by BEFORE
triggers (so `RAISE(ABORT)` defeats OR REPLACE / OR IGNORE / UPSERT regardless of
`recursive_triggers`):

1. every fact INSERT is a genuinely new primary address and a new global
   sequence (including the split cross-table sequence space);
2. every fact UPDATE keeps its address, strictly raises its sequence, never
   collides with another row's sequence, and never resurrects a row tombstone;
3. every fact DELETE is refused; an owner reset drops and recreates the store.

Coordinates are write-once (unconditional no-update, no-delete, and no-replace
insert), so `foreign_keys` OFF cannot orphan a fact and no conflict path can move
a live coordinate onto a referenced id or identity.

An **attack matrix** (`attackMatrixProofs`) runs every reproduced corruption
vector as raw SQL that bypasses the store, across all four candidates with
`recursive_triggers` OFF and ON, and the normalized candidates additionally with
`foreign_keys` OFF and ON: INSERT OR REPLACE onto a tombstone PK, a distinct PK
reusing a tombstone sequence, or a live PK; UPDATE OR REPLACE moving a live row
onto a tombstone address or sequence; UPSERT onto an existing identity; UPDATE OR
IGNORE address/sequence conflicts; direct DELETE; row absent-then-present; split
cross-table sequence collisions; and the coordinate replace/update/delete and
orphan-insert attacks. After each rejected attack it asserts the exact
count/byte/SHA-256 witness and `PRAGMA integrity_check` are unchanged, not merely
that the statement threw. The legal transitions it must still allow (row
absent-then-higher-absent; value absent-then-higher-present) are proven to
succeed.

## Independent oracle and reopen witness

Correctness never trusts a layout's own read path. The oracle is analytical and
streaming: the final current fact at any address is a closed-form function of its
index, and every emitted change gets a dense unique sequence, so at full scale it
retains neither the payload corpus nor a per-fact map. Every candidate's
post-aging state is checked against the oracle's three-part witness: exact
current-fact count, exact current-protocol-fact bytes, and one ordered SHA-256
over the current facts in ascending sequence. The same witness is recomputed after
a close/reopen and required identical; a durable state that silently changed is a
failed cell.

The corpus is also bound to the real private V1 kernel: a representative sample of
generated facts is admitted through `parseFact`, and the trace's protocol-fact
byte accounting is checked equal to the kernel's `encodedFactBytes`.

## Per-cell outcome vs run-level status

Each cell carries a settled **outcome**, distinct from the run-level evidence
status:

- `passed`: reconstruction, durability, plan proof, and constraint proof all held;
- `failed`: any of those failed (throw, reconstruction divergence, witness change
  across reopen, non-ok integrity, cleanup failure, plan-semantics failure, or a
  constraint-proof failure);
- `unsupported` / `not-admitted`: reserved for a future harness (a runtime that
  cannot run the cell, or a quota/precondition that refused admission). This Bun
  instrument emits only `passed` / `failed`; it never fabricates the other two.

`classifyEvidence` returns one run-level status and **never a candidate id**:

- **invalid** (fail closed): any `failed` cell, a plan-semantics or constraint
  proof failure, a malformed or changed witness, a non-ok integrity check, a
  non-finite storage field, an empty/negative/non-finite timing sample, a
  duplicate/unexpected/out-of-range cell, an inconsistent-or-non-distinct seed, or
  a globally required metric missing.
- **incomplete**: the expected owner x candidate x repetition matrix is not fully
  populated and passing.
- **provisional**: the matrix is complete and passing, but unsupported real
  workflows and qualifying runtimes remain.
- **ready-for-ADR-review**: reserved for a future harness. This Bun instrument
  **can never emit it**.

The report is `qualifyingRuntime: false`, an instrument-level fact independent of
the status.

## Provisional benchmark gates (not ADR or product promises)

These thresholds are provisional gates the pilot and qualification runs evaluate;
they are benchmark expectations, **not ADR decisions or product promises**, and a
real run may disprove them. `L` is present-proxy bytes; `C` is current-fact count.

Latency (per profile):

| gate | physical mobile | conditional 1M browser |
| --- | --- | --- |
| install | <= 5m | <= 15m |
| open + first point | <= 3s | <= 2s |
| point read | p95 <= 50ms | <= 25ms |
| write | <= 250ms | <= 100ms |
| 512-fact private prefix | <= 500ms | <= 250ms |
| ~1000-row traversal | <= 750ms | <= 300ms |
| restart | <= 5s | <= 3s |

Bun at 1M install is <= 5m and holds the same local-latency class as the
conditional browser gates.

Storage: `steady <= 1.75*L + 128*C + 16MiB`; `peak <= steady + L + max(16MiB,
L/8)`; freelist-to-page ratio `<= 10%`. These bound bytes on disk. The structural
requirement is that steady-state memory stays constant in the corpus size (paged
scans, no whole-corpus buffering); it is described structurally, not as an
invented portable RAM byte budget.

## Measurement honesty (four distinct byte quantities)

The report never conflates these and prints an amplification ratio only when both
its numerator and denominator are measured:

1. **present logical-state bytes** (the target quantity): the sum of the exact
   canonical bytes of the logical content of every final-**present** row and
   value, excluding sequences and terminal tombstones. This is a **labeled proxy**
   for ADR-0161's final-present scalar-fields-and-values benchmark proxy (which at
   1,000,000 final-present addresses totals exactly 536,870,912 bytes, about 536.9
   bytes per address on average). It is **not** canonical encoded logical state,
   is **not** 512 KiB per address, and is **not** a portability guarantee; the
   canonical container encoding stays unfrozen. Row filler is calibrated so this
   hits the profile's byte target exactly over exactly the profile's live-address
   count, or the run is marked non-qualifying.
2. **current protocol-fact bytes** (a storage/workload diagnostic): the exact V1
   fact record over every current fact, including terminal absences.
3. **allocated page bytes**: `page_count * page_size` after checkpoint.
4. **non-freelist page bytes**: `(page_count - freelist_count) * page_size` after
   checkpoint.

Physical amplification is reported against the logical-state denominator for both
page measures. No ratio is printed unless both its numerator and denominator were
measured.

## Pilot before qualification

The spec is internally inconsistent about seed counts (a four-outer-seed
measurement pilot versus at least five maintained-evidence repetitions). The
strict reading, adopted here, is: a **4-seed measurement pilot first**, then
**at least five qualification repetitions** later, on supported runtimes. This
Bun instrument is pre-pilot; its `full` profile requires at least five paired,
distinct seeds (`max(5, requested)`) purely as an internal completeness bar, and
never claims qualification.

## Runtime scope (page-addressable SQLite)

The runner is runtime-neutral over page-addressable file SQLite: it imports no
`bun:sqlite` or `node:*` and receives its lifecycle through an injected
async-capable factory, so a browser OPFS SQLite runtime reuses it unchanged.
**Durable Object SQLite is explicitly out of scope**: its storage is not page and
freelist addressable the same way, so it needs a separate runner with its own
storage accounting. This harness never fabricates page metrics for it.

## Artifact

`--output <path>` writes one versioned JSON artifact (`artifactVersion` 2) with
complete reproduction metadata: the runtime identity (Bun and SQLite versions, OS
platform/release/arch, and pragmas), the parsed args, install batch, per-repetition
candidate order, the command line, the source commit (honestly null when not
provided via `SOURCE_COMMIT` / `GITHUB_SHA`), and a DDL/schema digest and version.
It carries the full raw per-cell results (timing sample arrays, storage, plans,
plan and constraint proofs, before/after witnesses, integrity, outcome) plus the
classifier report. The classifier summarizes; the raw arrays are the evidence, and
medians are never the artifact.

## Determinism

Seeded PRNG only; no wall clock or `Math.random`. Namespace and table are chosen
by two independently salted hashes. Paired candidates within one repetition see
exactly the same trace; each repetition draws an independent data seed.

## Files

- `scalar-facts-layout.ts` (parent): CLI, profiles, argument parsing, report,
  artifact.
- `trace.ts`: deterministic corpus, aging events, and the independent oracle.
- `layouts.ts`: the four DDL candidates, their stores, the uniform invariant
  triggers, and the shape and attack-matrix proofs.
- `runner.ts`: owner-specific workloads, timing, reopen, storage, query plans, the
  per-cell outcome and plan proof. Runtime-neutral over page-addressable SQLite.
- `decision.ts`: the fail-closed evidence-status classifier (invalid / incomplete
  / provisional; never a winner).
- `bun-runtime.ts`: Bun/node-only DB lifecycle, page metrics, in-memory proof DB,
  and the runtime-identity descriptor.
