# 0380. Resource handles own terminal shutdown

- **Status:** Proposed
- **Date:** 2026-09-09
- **Amends:** [ADR-0367](0367-library-erasure-requires-exclusive-ownership-of-all-local-resources.md) at the document as the single shutdown coordinator; exclusive acquisition, physical release, and unsafe-release refusal remain.
- **Unbuilt:** Independent capability shutdown, recorder-to-blob dependency retirement, and product composition migration.

## Context

The App coordinates resources with different shutdown requirements. A pending
SQL statement, active microphone, response body, and product workflow are not
the same kind of pending operation. Removing App must give each resource its
own terminal boundary without moving physical cleanup into product code.

## Decision

**A resource handle closes what it acquired; its product owner coordinates use.**

The resource API in [ADR-0423](0423-app-resources-open-as-independent-handles.md)
returns usable handles with `signal` and terminal, idempotent `close()`. Borrowing
a handle does not transfer ownership. A component closes its own acquisitions;
it does not close shared resources on behalf of unrelated consumers.

| Resource | Close responsibility |
| --- | --- |
| Recorder | Fence new capture, settle pending acquisition and admitted Stop, discard unresolved capture, and release exact owned sessions |
| Inference | Cancel interruptible requests and drain response bodies and noninterruptible native work |
| Local blobs | Fence public operations, retire dependent recorders, settle admitted publication and transfers, and release display sources |
| Remote blobs | Cancel and settle requests and transfers, and release display sources |
| Store | Stop sync and callbacks, settle document work, attempt its final persistence flush, and release backing storage |
| SQLite | Drain statements, retire borrowed connections, close physical connections, and release the namespace only when safe |
| Secrets | Retire access and settle admitted operations without deleting saved credentials |
| Connection catalog | End observation and retire owned clients while preserving saved records and keys |

Closing a producer does not close its borrowed destination. Closing LocalBlobs
retires its recorders and waits for admitted publication. A transfer is tracked
by both blob handles; either close cancels it and waits for settlement. These
concrete dependencies need no public cleanup registry or generic lease graph.

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

A product opening several resources unwinds every successful acquisition if a
later one fails. Unmount during opening closes the eventual handle. Failure to
close one independent resource does not skip cleanup of the others. Cleanup
failure preserves its cause and any exclusion still needed to prevent racing
writes. Repeated close returns the same terminal outcome; there is no force
release or close-retry facade.

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
