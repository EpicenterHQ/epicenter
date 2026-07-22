# 0165. Browser origins contain independent Epicenter replicas

- **Status:** Proposed
- **Date:** 2026-07-20 (revised 2026-07-22: dedicated-worker ownership)
- **Relates:** [ADR-0161](0161-each-person-has-one-epicenter-replicated-on-each-adapter-boundary.md), [ADR-0162](0162-epicenter-home-owns-relational-inspection-applications-receive-no-sql.md) (browser snapshot capture transfers inert bytes; no second OPFS connection)

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

Each live page starts one dedicated-worker candidate. The candidates queue for
one origin-scoped exclusive Web Lock. Only the lock holder opens the OPFS SAH
pool and SQLite replica; waiting candidates open no database and keep no
semantic cache. The worker, rather than its page, holds the lock so the lock
lifetime and SQLite lifetime cannot diverge.

A versioned BroadcastChannel carries addressed commands, replies, and
invalidations between candidates. It carries no durable state. Every elected
worker publishes a random owner-session identifier. When ownership changes,
followers reject requests still addressed to the previous session with one
named owner-lost error. In particular, a mutating request is never replayed
automatically: the previous owner may have committed before its reply was
lost. The replacement reopens SQLite, and durable state answers what happened.

An origin cannot enumerate, open, migrate, or delete another origin's replica.
Signed-in origins converge through the same principal authority. Origin never
enters a namespace key, collection key, record key, document address, or
public Lens.

The selected adapter uses a dedicated worker, a Web Lock, and OPFS. A future
native browser SQLite primitive may replace those mechanics without changing
the Epicenter API. No tab, application, workspace, or database becomes the
durable storage owner.

## Consequences

- "One replica per device" may mean several physical replicas in one browser
  profile. This is an honest adapter constraint, not a second product concept.
- Cross-origin local-only data cannot be discovered centrally. Signing in is
  the only general convergence path.
- Multi-tab behavior needs adapter conformance tests for concurrent writes,
  crash recovery, lock release, and wake-up loss.
- A dedicated worker still shares the lifecycle and scheduling hazards of its
  page. Correct takeover is required, but physical mobile qualification must
  also measure a visible follower while a hidden owner is suspended.

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

Before the browser layout charter begins, the production owner topology must
pass one maintained admission checkpoint in Chromium and WebKit. It proves
that the feature probe runs in the actual dedicated owner context; two tabs use
at most one live SQLite owner and one SAH-pool directory; either tab can write;
owner-page close and forced owner-worker termination promote an already waiting
candidate; reopen passes `PRAGMA integrity_check`; a profile relaunch preserves
the semantic witness; and a mutating request pending across owner death fails
explicitly instead of being replayed. The unchanged replica conformance cases
then bind to that owner.

Browser suspension makes silence ambiguous. Playwright can prove controlled
termination and ordinary handoff, but not operating-system suspension, memory
pressure, or mobile background eviction. Those remain physical qualification
work. The retained direct-SharedWorker adapter is not W1C evidence: Chromium
exposes `createSyncAccessHandle()` in a dedicated worker but not in a shared or
service worker, so its successful page-level feature probe tests the wrong
execution context.

## Considered alternatives

- **The page or a page-held in-memory replica is the owner.** Rejected because
  suspension and crash handoff would turn tab memory into the storage protocol.
  The selected dedicated worker is only the current execution owner: the Web
  Lock fences SQLite, every committed fact remains in OPFS, and takeover always
  reopens that durable state.
- **Open the SAH pool directly in a SharedWorker or Service Worker.** Rejected
  because Chromium does not expose `createSyncAccessHandle()` in either
  context. Retrying the same missing runtime capability cannot recover.
- **Open one regular OPFS SQLite connection per tab.** Rejected because it
  requires cross-origin isolation and duplicates the replica, synchronization,
  and document runtimes. The SAH pool instead requires one elected opener.
- **BroadcastChannel as the state source.** Rejected because delivery is not
  durable or guaranteed.
- **Expose origin as a data owner.** Rejected because it leaks an adapter
  constraint into every application address.
