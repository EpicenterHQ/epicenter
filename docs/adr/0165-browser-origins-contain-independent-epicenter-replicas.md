# 0165. Browser origins contain independent single-owner Epicenter replicas

- **Status:** Proposed
- **Date:** 2026-07-20 (revised 2026-07-24: one fail-fast dedicated-worker owner)
- **Amends:** [ADR-0159](0159-row-documents-persist-in-one-owner-side-sqlite-update-log.md) by assigning browser SQLite ownership to one page-bound worker
- **Relates:** [ADR-0161](0161-each-person-has-one-epicenter-replicated-on-each-adapter-boundary.md), [ADR-0162](0162-epicenter-home-owns-relational-inspection-applications-receive-no-sql.md)

## Context

The product says a person has one Epicenter, but browser storage is isolated by
origin and shared by same-origin tabs. The OPFS SAH-pool SQLite adapter requires
one exclusive opener. Chromium exposes the required synchronous access handle
inside a dedicated worker, but not inside the SharedWorker that previously
served as the origin-wide owner.

Supporting several same-origin tabs would therefore require an elected owner,
cross-tab request routing, owner-session fencing, failure detection, handoff,
and mutation ambiguity after lost replies. That is a distributed runtime
inside one browser profile. Current products do not require that promise.

## Decision

Each browser origin stores one complete local Epicenter replica and admits one
live application owner at a time.

```txt
one page
  -> one DedicatedWorker
    -> one fail-fast exclusive Web Lock
      -> one OPFS SAH pool
        -> one SQLite replica
```

The page creates one dedicated worker. The worker attempts to acquire the
origin-scoped Web Lock with `ifAvailable: true`. Only the lock holder opens the
SAH pool and SQLite replica. If another owner already holds the lock, startup
fails immediately with a named "already open in another tab" error. The
refused page does not queue, poll, retry on focus, or participate as a follower.

The dedicated worker owns the Web Lock, SQLite connection, replica runtime,
document handles, synchronization supervisor, and orderly shutdown. Terminating
the worker ends that live ownership. OPFS SQLite remains the durable source;
worker memory never decides whether a write committed.

There is no SharedWorker owner, BroadcastChannel request mesh, candidate
election, follower cache, owner-session protocol, heartbeat, or ownership
handoff. A person closes the current same-origin application before opening
another. Different origins remain independent replicas and converge through
the principal authority.

An origin cannot enumerate, open, migrate, or delete another origin's replica.
Origin never enters a namespace key, collection key, record key, document
address, or public Lens. A future native browser SQLite primitive may replace
the worker and OPFS mechanics without changing the Epicenter API.

## Consequences

- "One replica per device" may mean several physical replicas in one browser
  profile because origin is an adapter boundary.
- Two independently hosted browser applications can run concurrently because
  they own different origins and storage.
- A second same-origin tab is an explicit product refusal, not a degraded
  synchronization mode.
- Closing the active page releases its worker and lock; a later page can open
  the same durable replica normally.
- There is no automatic focus retry. A refused page may ask the person to close
  the active tab and reload.
- Cross-origin local-only data cannot be discovered centrally. Signing in is
  the general convergence path.

## Acceptance evidence

Before this ADR becomes Accepted, maintained browser evidence must prove:

- the feature probe runs inside the actual dedicated worker;
- a first page opens, writes, closes, and reopens the same OPFS replica;
- a second same-origin page is refused immediately while the first owns it;
- the refused page opens successfully after the first owner closes;
- worker termination closes SQLite and pauses the VFS before releasing the
  lock;
- a committed write survives worker termination and profile restart;
- `PRAGMA integrity_check` passes after restart; and
- Chromium and WebKit either pass the mandatory cells or report a precise
  unsupported platform capability.

Physical iOS Safari and Android Chrome qualification still owns durability,
quota, suspension, and memory-pressure claims that desktop automation cannot
prove.

## Considered alternatives

- **Elect one dedicated-worker owner and route follower requests over
  BroadcastChannel.** Rejected because current products do not require
  concurrent same-origin tabs, while the design adds election, replay,
  heartbeat, handoff, and ambiguous-mutation machinery.
- **Open the SAH pool in a SharedWorker or Service Worker.** Rejected because
  tested Chromium does not expose the required synchronous access handle there.
- **Open one OPFS SQLite connection per tab.** Rejected because the adapter
  requires one exclusive owner and concurrent connections would weaken storage
  safety.
- **Let a second tab wait for the lock.** Rejected because startup would appear
  hung for the lifetime of another page and would still require takeover
  behavior.
- **Expose origin as a data owner.** Rejected because it leaks an adapter
  constraint into application addresses.
