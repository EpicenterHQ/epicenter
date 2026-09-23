# 0380. Resource handles own terminal shutdown

- **Status:** Proposed
- **Date:** 2026-09-09
- **Amends:** [ADR-0367](0367-library-erasure-requires-exclusive-ownership-of-all-local-resources.md) at the document as the single shutdown coordinator; exclusive acquisition, physical release, and unsafe-release refusal remain.
- **Unbuilt:** Joint document/blob acquisition and shutdown, page-root ownership migration, and removal of redundant product teardown; retain existing resource-local close and admitted-work guarantees.

## Context

The App coordinates resources with different shutdown requirements. A pending
SQL statement, active microphone, response body, and product workflow are not
the same kind of pending operation. Removing App must give each resource its
own terminal boundary without moving physical cleanup into product code.

## Decision

**A resource handle closes what it acquired; its product owner coordinates use.**

The resource API in [ADR-0423](0423-app-resources-open-as-independent-handles.md)
returns usable handles with `signal` and terminal, idempotent `close()`. Borrowing
a handle does not transfer ownership. A shorter-lived component closes its own
acquisitions; it does not close page roots or shared resources on behalf of
unrelated consumers.

| Resource | Close responsibility |
| --- | --- |
| Recorder | Fence new capture, settle pending acquisition and admitted Stop, discard unresolved capture, and release exact owned sessions |
| Network inference | Cancel interruptible requests and drain response bodies |
| Runtime transcriber | Retire caller access and settle admitted host compute without owning the shared engine |
| Local store | Fence document and blobs together; retire recorders, settle admitted Stop and transfers, release display sources, flush persistence, and release ownership only when safe |
| Personal store | Fence document and blobs together; settle requests and transfers, release display sources, flush the cached replica, and release ownership only when safe |
| SQLite | Drain statements, retire borrowed connections, close physical connections, and release the namespace only when safe |
| Secrets | Retire access and settle admitted operations without deleting saved credentials |
| Connection catalog | End observation and retire access acquired through it while preserving saved records and keys |

Closing a producer does not close its borrowed destination. Closing Local
retires its recorders and waits for admitted publication. A transfer is tracked
by both owning stores; either close cancels it and waits for settlement. These
concrete dependencies need no public cleanup registry or generic lease graph.

In the current API, Local and remote blob access are borrowed `store.blobs`
capabilities. Their cleanup responsibilities above belong to `store.close()`;
there is no independent public child closer. ADR-0438 proposes hosted object
identity independent of the store definition, while Personal and Shared stores
still lend owner-bound `.blobs` capabilities fenced by `store.close()`. Closing
Local also retires its dependent recorders. Closing Personal leaves Local usable. Failed store opening
unwinds both its document and blob acquisitions. Retained child methods refuse
after the store fences admission, while admitted Stop publication can settle.

Opening failure settles every started acquisition, including late successes.
Preserve the original failure and cleanup failures. Unknown release retains
the namespace claim. Child capabilities expose no second public close or
admission signal. Account retirement fences network authority; the product
working-lifetime owner still owns closing Personal and preserving its cache.

Native teardown retains exact session identity. A late microphone acquisition
is released by its original owner, and an old callback cannot affect a successor.
A refused opener cannot cancel another owner's capture. Host document/window
loss releases native resources even when a WebView cannot run cleanup. Releasing
one input must not block unrelated inputs behind a long-held registry lock.

**Product workflows retain cancellation across resource calls.**

For explicit closure, stop producers before releasing resources. A workflow that
reads credentials, performs a request, and writes SQL remains product-owned
between those operations. Recording close never invents a history row. A copy
can commit before row creation fails. Resource close cannot make either sequence
atomic or promise that every edit was saved.

Root resources can belong to the entire page. Required startup failure then
requires document replacement before retry; earlier successful acquisitions may
remain until replacement. Individual failed openers still unwind their own
partial acquisition without releasing unsafe exclusion. A shorter-lived owner
still closes its acquisitions, including a result arriving after that owner ends.
These are different scopes, not two product startup modes.

Cleanup failure preserves its cause and any exclusion still needed to prevent
racing writes. Repeated close returns the same terminal outcome; there is no
force release or close-retry facade. A page need not build an aggregate close
coordinator merely because its individual handles expose close.

Explicit close is awaitable. Runtime replacement follows its interruption policy
and introduces no aggregate departure drain. Navigation, reload, and process
loss are not proof of successful saving. A retired product cannot resume its old
work while replacement is pending.

## Consequences

Products own only the composition they create. Resource implementations own
physical release, so adding a recorder method does not add forwarding methods to
the store engine. Tests must cover streams and sessions, not just promises that
resolved after request headers or capture startup.

## Considered alternatives

- Keep App as the only close owner: preserves mandatory aggregate acquisition.
- Track every resource with one pending-promise helper: misses streaming bodies,
  active sessions, and gaps between product workflow calls.
- Rely on unload callbacks: cannot establish awaited persistence or native
  capture teardown.
- Release ownership on cleanup timeout: permits a replacement to race unfinished
  work.
