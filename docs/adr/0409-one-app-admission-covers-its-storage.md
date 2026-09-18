# 0409. One App admission covers its storage

- **Status:** Proposed
- **Date:** 2026-09-18
- **Amends:** [ADR-0367](0367-library-erasure-requires-exclusive-ownership-of-all-local-resources.md) at the unused blob-store eraser and its operation locks. Whole-library erasure remains unavailable.
- **Amends:** [ADR-0408](0408-one-app-opener-uses-a-complete-runtime.md) at ownership and runtime resource selection: replace per-library claims and a simulated general lock manager with one App admission; scope pre-admission restrictions to owned storage and account-library acquisition.
- **Implementation:** One App admission, complete runtimes, and constructor-independent memory storage.

## Context

The App always claims its local namespace before opening its personal and
shared libraries. Named SQL opens beneath that same App lifetime. Separate
claims at each layer repeat admission without enabling another supported
application behavior. Two windows still share storage, so a cross-context
admission mechanism remains necessary.

## Decision

**Admit one App per application/account storage namespace; release admission
only after its resources have safely closed.**

Keep the exact existing local-library claim key so old and new windows exclude
each other. A duplicate receives `AlreadyOpen` through `ready`. It does not
wait, take over, or share the incumbent's handle. Different namespaces remain
independent. Retrying creates a fresh App.

The App owns readiness, retirement, draining, and release policy. Its runtime
supplies admission and resources. Browser admission uses a Web Lock; a memory
runtime reserves a key synchronously in an instance-owned Set. Callers see
neither mechanism. Pending opens count as owners for runtime disposal.

Protected storage and account-library acquisition await admission. Capability
methods retain their readiness and closed-handle fences. The account-wide AI
catalog is a separate shared resource: reading or subscribing before admission
is permitted, and App closure must clean up that subscription. This replaces
0408's broader promise of no network or storage acquisition before admission;
it does not require lazy proxies around every capability.

Failed `ready` means unusable, not necessarily released. Callers still close
the App. Cleanup failure retains exclusion whenever release would be unsafe;
a replacement cannot bypass that claim. Memory-runtime disposal refuses while
an App is opening, active, or retaining ownership after failed cleanup.

Remove subordinate personal/shared/SQL claims only after every protected
acquisition path has an owner, including standalone evidence callers. Keep
the host SQL connection registry and operation drains: independent clients and
physical-resource lifetimes still require them.

Remove unused whole-blob-store erasure and its per-operation Web Locks after
verifying ordinary transactional blob behavior. Per-blob deletion remains. The unused standalone App blob openers are removed;
application blob access belongs to the admitted App lifetime.
Browser account-wide AI mutations retain their own cross-context coordination.
Memory AI mutations use synchronous storage operations and notifications.
There is no general memory implementation of shared, exclusive, or queued locks.

Ambient platform resources are selected at the default runtime binding. Shared
IndexedDB services receive a factory and its matching key-range constructor;
they await native requests and transaction completion without consulting global
constructor identity. Memory runtime construction never installs browser globals
or rejects coexistence with native storage. This replaces the wrapper-dependent
global-constructor requirement in 0408. Missing custom inference transports are
unavailable; they do not fall back to ambient fetch.

## Consequences

The runtime owns storage; an App owns access to it. Memory SQL uses a named
SQLite `memdb` database with a runtime-owned anchor connection and a separate
physical connection for each App lifetime. App closure rolls back unfinished
transactions and removes connection-local state while preserving committed
data. Runtime disposal closes the anchors. Names include a unique runtime
prefix to isolate runtimes sharing one SQLite module.

This keeps the single `openApp` API from 0408. It removes repeated admission,
unused erasure coordination, and a proposed lock simulator. It preserves
failure handling, transaction boundaries, and browser/host integration tests.
The product compromise is explicit: a second window for the same namespace
shows the existing already-open failure until the owner closes successfully.

## Considered alternatives

- Installing fake IndexedDB constructors globally and rejecting native ones.
  This compensates for the general `idb` wrapper's ambient `instanceof` checks.
  Native request handling removes the cause while preserving one persistence
  implementation. The matching factory/key-range pair is a resource input,
  not a browser emulator.


- Private storage per tab breaks the expectation that another window opens
  the same local workspace.
- Shared handles, queued opens, and takeover introduce another lifetime policy.
- Moving App ownership into a shared worker or host adds transport and failure
  handling to avoid one admission lock.
- Keeping one App SQL connection alive across reopen leaks unfinished
  transactions, temporary tables, and connection settings into the next App.
- Removing all synchronization would also remove account-wide AI coordination
  and backend protections whose domains extend beyond one App.
