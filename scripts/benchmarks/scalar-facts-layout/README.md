# scalar-facts-layout

A decision instrument for one narrow question in Wave 2b: how should the
**confirmed scalar-facts table(s)** of the local replica and the server
authority store their structured coordinates and relation split, measured on
Bun `bun:sqlite` at the conformance envelope.

It is a decision instrument, not a reusable benchmark framework, and not a
layout freeze.

## Scope (deliberately narrow)

This tool compares four candidate layouts of the **confirmed-facts table only**,
across two axes:

- relation layout: one unified `facts` table, or separate `row_facts` /
  `value_facts` tables;
- coordinate layout: inline structured coordinates, or a normalized
  `coordinates` dictionary keyed by `(kind, namespace, local_key)`.

It compares those four candidates against two owners with distinct workloads:
the **replica** (monotonic install, point reads, traversal, overlay,
tombstone-driven document cleanup) and the **authority** (ordered feed,
submission settlement, exact-retry, fold reads).

### What this instrument does NOT decide

The spec's physical-format break carries structured identity through confirmed
facts, pending intents, sealed submission state, parked diagnostics, and
document-liveness joins (spec Wave 2b, lines 847-864). Whether the
inline-vs-normalized coordinate *encoding* is a schema-wide choice binding every
address-bearing table is **source-silent**, and the non-facts stores
(sealed-submission ledger, document publication, blob publication, blob bytes,
metadata) are not yet designed in detail.

Therefore this instrument:

- measures **only** the confirmed-facts table layout;
- scopes its storage metric to the **candidate-varying tables** (`facts`, plus
  `coordinates` for the normalized candidates), so the normalized-vs-inline
  delta is not diluted or biased by fixture tables hard-wired to one encoding;
- **refuses to freeze** the schema-wide coordinate encoding or the layout of any
  non-facts store, and says so in its own report.

If Wave 2b intends a single schema-wide coordinate representation across every
address-bearing table, this instrument is the wrong shape and must be extended
(candidates, workloads, and constraint proofs) across those tables before any
freeze. That is an open ownership fork returned to Codex.

## Provisional by construction

Bun can decide native schema and query-plan evidence but cannot qualify OPFS,
storage quota, WebKit, worker locks, mobile memory, backgrounding, or Durable
Object SQLite. Per ADR-0161 (65-68) and ADR-0163 (305-307), the exact V1
constants and the physical layout must be chosen by the browser, Bun, and
Cloudflare scale proof before ADR-0163 is Accepted. **Every recommendation this
tool emits is provisional** and names the platform evidence it still requires.
1,000,000 facts / 512 MiB is a conformance envelope, not a hard cap.

## Measurement honesty (four distinct quantities)

The report never conflates these and prints an amplification ratio only when
both its numerator and denominator are measured:

1. **initial state canonical bytes**: the same canonical-fact-record measure as
   (2), but over the initial present build (before aging). Because (1) and (2)
   are one measure on two states, their ratio is meaningful; neither is assumed
   to order the other.
2. **exact final canonical logical bytes**: from the independent oracle, the sum
   of the exact canonical UTF-8 bytes of the current fact at **every address that
   has one, including terminal row tombstones and absent/unset value facts**
   *after* aging. Absent facts still carry a sequence and preserve convergence
   state, so they are counted; "live address" would wrongly omit them. This is
   the canonical *fact record* (address, presence, sequence, and payload), not
   the bare payload, so per-fact framing can push it above (1) even as tombstones
   drop payload. The two are never assumed to order; both are reported, and the
   full envelope target (512 MiB) is this quantity, calibrated to within one
   fact's bytes or the run is marked non-qualifying.
3. **steady physical DB footprint**: on-disk page bytes after checkpoint/settle.
4. **peak filesystem footprint / WAL amplification**: the high-water disk use
   during the bulk build.

Amplification is reported as physical / **final canonical logical** (quantity 2),
never physical / initial payload (quantity 1).

## No-winner policy

- Every owner-critical metric is compared **independently**; no geomean or
  latency-plus-storage sum can average away a material regression in one metric.
- Materiality thresholds are **fixed, predeclared, and owner-metric-specific**.
  They are never derived or widened from observed variance. Widening a band by
  observed noise is backwards for a noninferiority test: a noisier metric would
  let a *larger* real regression pass as equivalent, which is the opposite of
  what safety requires.
- Comparisons are **paired per seed**: two candidates are differenced on the same
  trace, and the decision reasons about an interval on the mean paired
  difference against the fixed threshold.
- A metric is **inconclusive** when its paired-difference interval crosses a
  materiality boundary, or when its variance is too high to place the difference
  on one side of the threshold. Any inconclusive owner-critical metric returns
  **no winner**; noise never resolves in favor of a winner.
- A **real tradeoff** (more than one non-dominated candidate that are not all
  materially equivalent) returns **no winner**.
- A **missing or failed** owner x candidate x repetition cell returns **no
  recommendation**: partial evidence cannot recommend, and failed repetitions
  are never dropped.
- The declared tie-break (unified before split, inline before normalized) is
  applied **only** when the candidates are materially equivalent on every metric,
  and the report states that it was a tie, not a measured win.

## Independent oracle

Correctness never trusts a layout's own read path. The oracle is **analytical
and streaming**: the final current fact at any address is a closed-form function
of its index (each event lands in a disjoint, strictly-increasing sequence band,
and the highest band wins), so at full scale it retains neither the payload
corpus nor a per-fact map. Every candidate's post-aging state is checked against
the oracle's **three-part witness**: exact fact count, exact final canonical
bytes, and a SHA-256 order-independent set digest (a 32-bit hash would be too
collision-prone for a million rows, and peer hashes alone are not trusted). A
small map-backed fold survives only for the self-test.

The lifecycles are real events, not counted assumptions: initially-absent values
that later become present, value unset-then-present, and row tombstones. Row
tombstone non-resurrection is proven by an **attempted** higher-sequence present
that the fold refuses, not by counting final tombstones. The observed
namespace/table/value/lifecycle cardinalities are asserted and reported.

## Determinism

Seeded PRNG only; no wall-clock or `Math.random`. Namespace and table are chosen
by two independently salted hashes (never one correlated modulo). Paired
candidates within one repetition see exactly the same trace; each repetition
draws an independent data seed. Full evidence requires at least five independent
builds; short operations retain raw samples.

## Files

- `scalar-facts-layout.ts` (parent): CLI, profiles, argument parsing, report.
- `trace.ts`: deterministic corpus, aging events, and the independent oracle.
- `layouts.ts`: the four DDL candidates, their stores, and negative constraint
  proofs.
- `runner.ts`: owner-specific workloads, timing, reopen, storage, query plans.
- `decision.ts`: completeness, per-metric materiality, and the no-winner policy.
