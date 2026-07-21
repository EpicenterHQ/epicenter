# scalar-facts-layout

A diagnostic instrument for one narrow question in Wave 2b: how might the
**confirmed scalar-facts table(s)** of the local replica and the server
authority store their structured coordinates and relation split, measured on
Bun `bun:sqlite` at a provisional stress profile (a labeled logical-state proxy,
never a frozen conformance run; see the qualification note below).

It records conformance, storage, and workload observations. It never selects,
ranks, recommends, or freezes a layout.

Implementation status: only the exact analytical trace and its tests are
modular today. The parent `scalar-facts-layout.ts` still owns the older corpus
and runner. The parent remains a legacy conformance and storage diagnostic until
the exact trace, owner-specific auxiliary states, layouts, and measurement
method are connected behind one CLI.

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

## Incomplete by construction

Bun can decide native schema and query-plan evidence but cannot qualify OPFS,
storage quota, WebKit, worker locks, mobile memory, backgrounding, or Durable
Object SQLite. Per ADR-0161 (65-68) and ADR-0163 (305-307), the exact V1
constants and the physical layout must be chosen by the browser, Bun, and
Cloudflare scale proof before ADR-0163 is Accepted. This tool therefore reports
an overall `incomplete` evidence status and names the missing platform evidence.

### The 512 MiB / 1,000,000-live-address target is not a portability guarantee

No fixed 512 MiB portability guarantee is defensible. Treat it as a
**conditional normal-profile qualification** where runtime quota admits, with
peak headroom and quota-refusal atomic recovery measured. The tiers are:

- Legacy smoke diagnostic: 5,000 current facts / 1 MiB payload.
- physical mobile floor: 250k / 128 MiB (physical iOS Safari and Android).
- conditional normal profile: 1,000,000 live addresses / 512 MiB where quota
  admits.
- informational desktop stress: 2M / 1 GiB.
- private/incognito is a **negative** compatibility/refusal test (persistence
  denied), never a durable qualification cell.

### Why the 512 MiB *logical* target cannot be claimed here

ADR-0161 states the target as 1,000,000 live scalar addresses and 512 MiB of
canonical encoded **logical state**. ADR-0167 defines logical state as present
rows and values only, explicitly excluding authority sequences and terminal
tombstones, but it leaves the exact canonical logical-state encoding an unfrozen
implementation decision ("the exact container, seal, and physical filename
encoding remain implementation decisions until a round-trip proof chooses
them"). So this instrument **cannot claim the 512 MiB logical qualification**: it
reports present-logical-state bytes under a clearly labeled proxy (canonical JSON
of the ADR-0167 logical columns) as a stress target, and separately reports the
current protocol-fact bytes. Do not miscite the ADR by calling total current
facts the live-address count.

## Measurement honesty (four distinct quantities)

The report never conflates these and prints an amplification ratio only when
both its numerator and denominator are measured:

1. **present logical-state bytes** (the ADR-0167 proxy, the target quantity):
   the sum of the exact canonical bytes of the logical content of every
   final-**present** row and value, excluding sequences and terminal tombstones.
   Row filler is calibrated so this hits the profile's byte target exactly, over
   exactly the profile's live-address count, or the run is marked non-qualifying.
2. **current protocol-fact bytes** (a storage/workload diagnostic): the sum of
   the exact V1 fact record (structured address, `presence`, sequence, payload)
   over **every** current fact, including terminal absences. Framing and
   absences push this above (1); the two are never assumed to order and both are
   reported.
3. **steady physical DB footprint**: on-disk page bytes after checkpoint/settle.
4. **peak filesystem footprint / WAL amplification**: the high-water disk use
   during the bulk build.

Physical amplification is reported against the logical-state denominator: steady
= (3) / (1) and peak = (4) / (1). The (2) / (1) ratio is reported as a separate
protocol-overhead diagnostic. No ratio is printed unless both its numerator and
denominator were measured.

## Evidence status only

The parent runner retains each owner, candidate, repetition, metric, and storage
observation. It checks matrix completeness and correctness, then reports one
overall evidence status. Missing cells and failed conformance remain visible.
No materiality band, Pareto filter, candidate ordering, or fallback tie-break is
part of this runner.

## Independent oracle

Correctness never trusts a layout's own read path. The oracle is **analytical
and streaming**: the final current fact at any address is a closed-form function
of its index (each event lands in a disjoint, strictly-increasing sequence band,
and the highest band wins), and every emitted change gets a dense unique
sequence, so at full scale it retains neither the payload corpus nor a per-fact
map. Every candidate's post-aging state is checked against the oracle's
**three-part witness**: exact current-fact count, exact current-protocol-fact
bytes, and **one ordered SHA-256** over the current facts in ascending sequence
(length-prefixed framing; a 32-bit hash would be too collision-prone for a
million rows, and peer hashes alone are not trusted). A candidate reproduces all
three by scanning `ORDER BY sequence`. A small map-backed fold survives only for
the self-test.

The lifecycles are real events, not counted assumptions: initially-absent values
that later become present, value unset-then-present, and row tombstones. Row
tombstone non-resurrection is proven in the **trace-oracle self-test** by an
attempted higher-sequence present that the fold refuses, not by counting final
tombstones. The legacy parent additionally exercises each confirmed-facts
candidate's physical constraint refusals. Those proofs remain narrower than the
schema-wide owner workload required by the measurement-method pilot. The
observed namespace, table, value, and lifecycle cardinalities are asserted and
reported.

## Determinism

Seeded PRNG only; no wall-clock or `Math.random`. Namespace and table are chosen
by two independently salted hashes (never one correlated modulo). Paired
candidates within one repetition see exactly the same trace; each repetition
draws an independent data seed. The legacy full diagnostic uses five builds, but
it is not the four-seed measurement-method pilot. Short operations retain raw
samples.

## Files

- `scalar-facts-layout.ts` (legacy parent): CLI, profiles, argument parsing,
  conformance/storage report, and an overall incomplete evidence status.
- `trace.ts`: deterministic corpus, aging events, and the independent oracle.
- `trace.test.ts`: analytical-oracle, portability, and exact-byte tests.
