# 0165. Browser origins contain independent Epicenter replicas

- **Status:** Proposed
- **Date:** 2026-07-20
- **Relates:** [ADR-0161](0161-each-person-has-one-epicenter-replicated-on-each-adapter-boundary.md)

## Context

The product says a person has one Epicenter, but browser storage is isolated by
origin and shared among tabs with platform-specific locking and worker limits.
Pretending that every application can open one literal device file would make a
false portability promise.

## Decision

Each browser origin stores its own complete local Epicenter replica. Tabs under
that origin coordinate access through the narrowest primitives the SQLite
adapter requires. Correctness rests on SQLite durability and adapter locks, not
on BroadcastChannel delivery or one immortal owner tab.

An origin cannot enumerate, open, migrate, or delete another origin's replica.
Signed-in origins converge through the same principal authority. Origin never
enters a namespace key, table key, value key, row ID, document address, or
public Lens.

The adapter may evolve among a dedicated worker, shared worker, Web Locks, or a
native browser SQLite primitive without changing the Epicenter API. No tab,
application, workspace, or database becomes the durable storage owner.

## Consequences

- "One replica per device" may mean several physical replicas in one browser
  profile. This is an honest adapter constraint, not a second product concept.
- Cross-origin local-only data cannot be discovered centrally. Signing in is
  the only general convergence path.
- Multi-tab behavior needs adapter conformance tests for concurrent writes,
  crash recovery, lock release, and wake-up loss.

## Acceptance evidence

The ADR-0161 physical mobile floor completes on a clean physical iOS Safari
origin and a clean physical Android Chrome origin. The conditional normal
profile runs only where measured storage availability admits it. A quota denial
does not prove capacity. It supplies honest refusal evidence only when the
previously committed prefix and durable progress survive restart unchanged.
Private or incognito storage is a negative refusal environment, never a durable
qualification environment. The maintained benchmark contract owns exact
footprint measurement and outcome classification.

Qualification must also cover concurrent tabs, Worker termination, lock
release, backgrounding, restart, and clean ownership handoff. Playwright WebKit
does not replace physical Safari evidence.

The current adapter requires cooperative page disconnect and does not infer
death from silence. Browser suspension makes silence ambiguous, while a
`MessagePort` supplies no durable peer-lifetime signal. Worker termination and
vanished-page recovery therefore remain unresolved qualification work, not
evidence supplied by the in-process lifecycle tests.

## Considered alternatives

- **One elected owner tab.** Rejected because suspension and crash handoff turn
  tab lifetime into a storage protocol.
- **BroadcastChannel as the state source.** Rejected because delivery is not
  durable or guaranteed.
- **Expose origin as a data owner.** Rejected because it leaks an adapter
  constraint into every application address.
