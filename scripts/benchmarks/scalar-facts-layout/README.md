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

Every correctness-critical grammar and payload-shape invariant (row-id grammar,
per-kind present/absent payload, `present in {0,1}`, sequence range, coordinate
kind and non-empty namespace/local-key) is enforced by BEFORE INSERT/UPDATE
triggers, not only by CHECK. So with `PRAGMA ignore_check_constraints` ON, a raw
short row id, scalar/absent-shaped payload, or invalid coordinate is still
refused. The `coordinate_id` positivity is enforced by an AFTER INSERT trigger
(the rowid alias is NULL in a BEFORE INSERT until auto-allocated), so a raw
negative or zero id is refused even with checks ignored. The CHECKs remain as
defense-in-depth; the triggers own closure.

The store installs through an atomic page seam: `installPage(facts,
commitProgress?)` opens exactly one transaction and applies every fact through a
non-transaction-opening inner op. If ANY fact is a corruption, the WHOLE page
rolls back (via a sentinel thrown inside the transaction, caught outside) and
progress is NOT written; otherwise it writes the optional durable progress (an
`afterSequence` watermark) in that same transaction and commits. It returns a
discriminated result (committed with per-fact outcomes, or corruption with the
index). `install(fact)` is a one-fact page keeping its ignored/installed/
corruption contract. The runner drives the page seam, never wraps a transaction
around calls that each open their own, and treats a corruption page as a failed
cell.

An **attack matrix** (`attackMatrixProof`) runs every reproduced corruption and
grammar vector as raw SQL that bypasses the store, across all four candidates
with `recursive_triggers` and `ignore_check_constraints` OFF and ON, and the
normalized candidates additionally with `foreign_keys` OFF and ON: INSERT OR
REPLACE onto a tombstone PK, a distinct PK reusing a tombstone sequence, or a live
PK; UPDATE OR REPLACE moving a live row onto a tombstone address or sequence;
UPSERT onto an existing identity; UPDATE OR IGNORE address/sequence conflicts;
direct DELETE; row absent-then-present; split cross-table sequence collisions; the
coordinate replace/update/delete and orphan-insert attacks; and the grammar
refusals (short row id, invalid row/value payload, absent-with-payload, invalid
coordinate kind/namespace/local-key, zero/negative coordinate id, and an
invalid-payload update). After each rejected attack it retains the exact observed
after-attack witness (count/byte/SHA-256), the `PRAGMA integrity_check` string,
AND the structured thrown-error identity (message, SQLite `code`, `errno`, name).
The refusal class is bound to that REAL identity, not to substrings: a genuine
trigger refusal has `code = SQLITE_CONSTRAINT_TRIGGER` and an exact known RAISE
message; any other `SQLITE_CONSTRAINT_*` code is a genuine constraint. A SQL typo,
missing table, or syntax error (no constraint code, `errno` 1) is class `other`
and fails the attack, so it cannot masquerade as an invariant even when its
message contains `CHECK` or `UNIQUE`. The same genuine-refusal classification
guards the shape proofs, and every proof database is closed in a finally. The
legal transitions it must still allow (row absent-then-higher-absent; value
absent-then-higher-present) are proven to succeed.

The pragma matrix is self-verifying at the run level: the CLI reads back each
record's observed pragma tuple, requires it to equal the requested tuple, and
requires the exact requested set to occur once per candidate, so an ignored,
missing, or duplicated setting fails closed (`verifyPragmaCoverage`).

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

`classifyEvidence` does not trust the cell's summary booleans. It **recomputes**
the plan proof from the raw structured per-branch `EXPLAIN QUERY PLAN` against the
CANDIDATE's contract (`evaluatePlanProof(result.candidateId, plans)`). The contract
is per operation, not candidate-wide: each operation declares its branches; each
branch declares the exact set of indexed accesses; and each access binds a
SPECIFIC base table, a specific access kind (index range, primary key, covering
index, integer primary key), and the predicate fragments that must appear ON THAT
access's own EXPLAIN row. Accesses are matched to the branch's real SEARCH rows as
a bijection, and branches are matched to the operation's branch specs as a
bijection (order-independent), so a split feed must cover row_facts once and
value_facts once, a duplicated branch fails, and a point/traverse bound to the
wrong table fails. Structural rows (SCALAR SUBQUERY and friends) are allowed for
planner shape but contribute ZERO predicate evidence, so a predicate smuggled into
a structural row does not satisfy a missing predicate on an indexed SEARCH. The
benchmark SQL uses no single-letter table aliases, so every EXPLAIN row names its
real base table; index names are deliberately not bound (version-specific). An
unrelated table, wrong access kind, missing/smuggled predicate, unknown detail,
full scan, temp b-tree, wrong candidate, or unknown candidate id all fail closed.
The classifier also checks the constraint proof's `ok` against its own failure
list, requires the expected runtime/profile identity, requires the outcome enum to
be coherent with `correct`/`reason` and the recomputed proofs, and validates the
whole configuration up front (integer `requiredRepetitions >= 1`; nonempty
duplicate-free owners/candidates drawn from the frozen sets; nonempty runtime and
profile) and the exact storage shape (the seven required fields by name, no
missing and no extra).

It also binds every cell to the **declared per-repetition oracle**: for each
repetition, the same seed (`hash32(baseSeed, rep)`) the cells measured against is
replayed by the independent trace into an exact
`{count, currentProtocolFactBytes, digestHex, presentCount,
presentLogicalStateBytes, totalFacts, finalAbsent}`. Every cell's `dataSeed`, both
witnesses, and the four storage quantities must equal its repetition's oracle
exactly. This binds paired cells to one agreed current state and catches a forged
count, a wrong digest, wrong bytes, mixed digests within one repetition, and a
wrong seed. The declared oracles must be an EXACT closed set: exactly one per
repetition `0..requiredReps-1`, no extras, all fields finite non-negative
integers, internally consistent (`count == totalFacts`; `presentCount +
finalAbsent == totalFacts`), with distinct seeds. Lifecycle cardinalities are NOT
part of the classifier oracle (the classifier does not recompute them against a
frozen trace, so it would be dishonest to claim it validates them); they are
retained only as descriptive `repetitionTraceMetadata`. The oracles are retained
in the artifact; the corpus shape reported at the top level is seed-invariant and
carries no seed-dependent witness. It returns one run-level status and **never a
candidate id**:

- **invalid** (fail closed): any `failed` cell; an outcome that is unknown or
  `unsupported`/`not-admitted`; a spoofed runtime/profile; an incoherent `passed`
  cell; a plan proof that disagrees with the per-branch recomputation from the raw
  plans (including a split feed with one good and one broken branch); a constraint
  proof whose `ok` disagrees with its failures, or that failed; a malformed or
  changed witness; a witness or storage quantity that disagrees with the
  repetition oracle or with each other; a storage relationship violation
  (non-freelist over allocated, present over current, max fact over total); an
  internally inconsistent oracle declaration; a non-ok integrity check; a
  non-finite storage field; an empty/negative/non-finite timing sample; a
  duplicate/unexpected/out-of-range cell; an inconsistent-or-non-distinct seed; or
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

The Bun 1M install gate is a provisional expectation (<= 5m, same local-latency
class as the conditional browser gates), NOT a measured result: this branch runs
only a gated exact-corpus precondition and has no correct-corpus full-install
artifact, so nothing here retains that number.

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

The `full` profile contract is exact: **1,000,000 final-present addresses**, a
**512 MiB (536,870,912 byte)** aggregate present proxy, and **1,048,805 current
facts** for the intended trace (present rows/values plus terminal tombstones and
absences). This is an aggregate proxy over the corpus, never 512 KiB per row. The
corpus precondition fails the run closed unless the live-address count and byte
target are hit exactly.

## Seeds are a pilot decision, not settled here

The active spec requires **four fresh paired outer seeds** for the future
measurement-method pilot, which then freezes the real seed and block counts. The
"five" that appears elsewhere is legacy checkpoint text, not qualification policy.
This pre-pilot tool therefore picks an arbitrary LOCAL repetition default
(`PREPILOT_DEFAULT_REPETITIONS`, currently 4) purely as an internal completeness
bar; it never describes any count as qualification policy or as the spec's strict
reading. The pilot owns that decision.

## Runtime scope (this is not a universal runner)

The runner drives desktop file SQLite (Bun now). It imports no `bun:sqlite` or
`node:*` and takes its lifecycle through an injected factory, but that factory
abstracts the desktop file-SQLite lifecycle only. A browser Worker/OPFS harness
and a Durable Object authority harness each need their **own** lifecycle runner:
atomic page-plus-`afterSequence` progress, restart-prefix proof, crash and quota
handling, and OPFS or DO storage measurements. What they reuse is only the
portable vocabulary: the trace and byte oracle, the candidate DDL and store, the
query-plan operations, and the proof vocabulary, plus the atomic `installPage`
seam. **Durable Object SQLite is explicitly out of scope** for this runner: its
storage is not page and freelist addressable the same way, and this harness never
fabricates page metrics for it.

## Artifact

`--output <path>` writes one versioned JSON artifact (`artifactVersion` 3,
`schema.version` 3) with reproduction metadata: the runtime identity (Bun and
SQLite versions, OS platform/release/arch, and pragmas including
`ignoreCheckConstraints`), the parsed args, install batch, per-repetition candidate
order, the command line, and a DDL/schema digest and version.

Provenance is **observed, not trusted from an environment string**. The artifact
records a validated 40-hex git `HEAD` (or `null` when git is unavailable), a
scoped dirty flag over exactly the evidence-producing sources, a deterministic
SHA-256 source-manifest digest over those exact source contents, the list of files
covered, and a `sourceProvenanceAdmissible` flag that is true only with a known
HEAD and a clean relevant tree. The scoped source set is the non-test benchmark
modules, the V1 protocol file the trace/store import at runtime (`canonical.ts`),
the SQLite adapter the runtime imports (`packages/sqlite/src/bun.ts`) AND the
workspace manifest that owns its `"./bun"` export map
(`packages/sqlite/package.json`, so an export redirect cannot escape the list),
and the dependency-identity files (`package.json`, `bun.lock`) so third-party
(Noble, adapter) resolution is honest rather than assumed complete. A `null` HEAD
or a
dirty relevant tree is honest but not source-admissible; unrelated app dirt never
poisons the scoped digest or the scoped dirty check, because both range over
exactly the listed sources. The helpers are pure and unit-tested.

It carries the full raw per-cell results (timing sample arrays, storage,
structured per-branch plans, plan and constraint proofs, before/after witnesses,
integrity, outcome), the per-repetition oracles, and the classifier report.

It also retains the real **constraint evidence**: for every candidate, one typed
proof record per pragma combination (recursive_triggers and
ignore_check_constraints OFF/ON, and for the normalized candidates foreign_keys
OFF/ON), each carrying that combo's pragmas, baseline witness and integrity, and
every attack's structured result (rejected, the exact observed after-attack
witness, integrity string, and thrown-error message with its refusal class, with
stable/ok derived from them). The retained coverage is the coverage the README
claims; no proof coverage is asserted by a bare boolean. The classifier
summarizes; the raw arrays are the evidence, and medians are never the artifact.

## Determinism

Seeded PRNG only; no wall clock or `Math.random`. Namespace and table are chosen
by two independently salted hashes. Paired candidates within one repetition see
exactly the same trace; each repetition draws an independent data seed.

## Files

- `scalar-facts-layout.ts` (parent): CLI, profiles, argument parsing, report,
  artifact.
- `trace.ts`: deterministic corpus, aging events, and the independent oracle.
- `layouts.ts`: the four DDL candidates, their stores (atomic `installPage`
  seam, structured query plans), the uniform invariant and grammar triggers, the
  shape and attack-matrix proofs with per-attack refusal-class verification, and
  the pragma-coverage verifier.
- `plan-proof.ts`: the candidate- and operation-specific, fail-closed query-plan
  contract and its per-branch recomputation.
- `runner.ts`: the desktop file-SQLite runner: owner-specific workloads, timing,
  reopen, storage, structured query plans, the per-cell outcome and per-branch
  plan proof. Not a universal runner; browser and DO harnesses are separate.
- `decision.ts`: the fail-closed evidence-status classifier (invalid / incomplete
  / provisional; never a winner), including the exact-set per-repetition oracle
  binding and the candidate-specific plan recomputation.
- `bun-runtime.ts`: Bun/node-only DB lifecycle, page metrics, in-memory proof DB,
  and the runtime-identity descriptor.
- `provenance.ts`: pure, unit-tested provenance helpers (git HEAD, scoped dirty
  check, deterministic source-manifest digest).
