# 0380. The caller owns when to close and the App owns resource shutdown

- **Status:** Proposed
- **Date:** 2026-09-09
- **Amends:** [ADR-0367](0367-library-erasure-requires-exclusive-ownership-of-all-local-resources.md) at the document as the single coordinator of application resource shutdown. Exclusive acquisition, physical release, and retention of ownership after failed release remain required.
- **Implementation:** App construction coordinates resource owners; data owns document shutdown. Capability factories were removed from the data engine.

## Context

An opened App is a vanilla TypeScript handle. Its caller may be a SPA, a script,
or a test. The caller knows when its work is finished; the App knows which
resources it acquired. Requiring the caller to close each capability separately
makes adding a capability a cleanup change in every consumer.

Before this change, `openAppData` exposed the data engine's close function as
`app.close()`. The engine also returned factories that wrapped recording,
secrets, SQLite, and blobs. Application shutdown lived inside the data store
and required a second representation of capability methods. Sharing one operation tracker
removes duplicate bookkeeping but does not establish that the data engine is
the right owner.

The fixed-page rule in [ADR-0369](0369-an-application-page-owns-one-library-and-changing-it-ends-the-page.md)
remains: a page opens one primary App and never replaces it in place. Orderly
departure still needs resource release. Native capture can outlive a WebView.

## Decision

**Whoever opens an App owns the responsibility to await `app.close()` when they
deliberately finish using it. The App closes the resources it acquired.**

Defining an application describes its construction. Opening acquires its concrete
resources and establishes their cleanup responsibility. The opened handle is
independent of a UI framework. A SPA integration may make the close call once
on behalf of its pages; individual screens borrow the App and do not close it.

Built-in capabilities participate in shutdown automatically through application
construction. Application authors do not register recorder or database cleanup.
The App explicitly coordinates its known resources; no general cleanup registry
is needed for this fixed set.

Each resource implements its own lifecycle where it has one. The App exposes
the actual operation object directly and retains the owner controls for cleanup.
A borrowed capability cannot release the App's library claim.
The data engine owns document operations, persistence, and sync. It does not
reconstruct the recorder or secret-store interface to enforce app ownership.
Adding a recorder method does not require adding a forwarding method in data.

Moving ownership preserves the current public readiness and terminal-use
contracts, including retained methods and clients. Resource implementations
enforce those contracts at their actual operations. Secrets retain readiness
checks, rejection after close, and draining of accepted writes in this change;
direct exposure does not silently withdraw those guarantees.

### Before close: finish product work

The caller stops new product work and asks active workflows to finish or cancel
before closing the App. A workflow owns its full sequence across awaited calls:
reading a credential, fetching mail, then saving messages is one piece of work.
Tracking the credential read and SQL write separately misses the request between
them. Editors also release borrowed document references before store shutdown.

Finishing a recording and saving its result is product work. Departure may ask
the person to finish or discard it, or refuse departure while recording remains
active. Those choices happen while the App is usable. `app.close()` performs
resource cleanup and does not invent a recording row or save a transcript.

### Inside close: release acquired resources

The App begins terminal shutdown, prevents new resource work, and coordinates
cleanup according to dependencies. Resource implementations own the checks,
pending work, and physical release needed to honor that transition.

| Resource | Shutdown responsibility |
| --- | --- |
| Recording | Refuse new starts, settle pending acquisition, cancel remaining capture, and release capture listeners and devices. A stop already in progress settles before its storage is released. |
| AI and network producers | Cancel owned requests and response streams where supported, and await their cleanup. Receiving response headers is not completion. |
| Blobs and playback | Settle accepted transfers and attachment work, release playback sources, and keep destinations available while a producer can still write. |
| Data store | Stop sync and callbacks, settle document-owned work, attempt the final local persistence flush, and release the document and its backing. |
| Named SQLite | Drain accepted database work even when another resource fails to close. Close app-owned connections and release the library claim only after dependent cleanup succeeds. |
| Secrets | Preserve the captured application and owner scope. Settle resource-owned work where required; closing never deletes durable credentials. Synchronous in-memory operations need no synthetic drain; their owner still retires borrowed access. |

Producers finish or cancel before their dependencies are released. Independent
cleanup may run together. No resource waits on work whose required dependency
has already been closed. Closing this App never shuts down a shared host service
or worker merely because the App used it.

The recorder owns a close operation as part of its constructed capability. Its
implementation handles a microphone request completing during shutdown and
native capture recovery. Only an opener that acquired the library may adopt
leftover capture for cleanup; a refused duplicate opener owns nothing to cancel.

### Completion and failure

`app.close()` is idempotent: repeated calls return the same completion promise.
Once close starts, the handle never becomes usable again. Closing during opening
settles acquisition and releases anything acquired before it finishes. Failed
opening retains its original failure even if cleanup also fails.

Cleanup attempts all independent releases and reports failures. A failed producer
release keeps the resources and ownership claim needed to prevent a replacement
from racing that producer. A timeout cannot justify releasing storage while work
may still write to it. Resources without cancellation can keep close pending.

Close preserves the store's existing final-flush policy and persistence failure
reporting. Successful resource release is not proof that every edit was saved
locally or delivered remotely. It does not erase data, delete credentials, sign
out, change identity, or navigate. The caller performs a deliberate departure
action only after the close outcome permits it.

Browser refresh, tab termination, and process crashes cannot reliably await this
contract. Persistence and recovery handle abrupt termination. An unload listener
is not a substitute for an awaited close path.

## Consequences

The consumer remembers one close call. The App owns shutdown order. Each
resource owns how it stops. UI frameworks decide when to invoke the contract
without becoming resource managers.

Capability construction no longer takes a round trip through `parts.create*`.
The reusable data engine remains available to data-only callers. Platform
selection and captured storage identities remain unchanged; this decision
changes lifecycle ownership, not resource destinations.

Implementation must preserve pending recording acquisition, in-progress stop and
SQL writes, response-stream cancellation, partial opening cleanup, repeated
close, and failed release retaining ownership. These behaviors determine whether
the direct capabilities can replace the wrappers.


The implementation also includes the prerequisite application/account scoping of
secrets. Desktop credentials use `app-secret:` with a structured application,
account, and label address. Earlier `app:<appId>:<label>` entries are neither
adopted nor deleted, including for local openings. This namespace change belongs
to resource construction; closing an App preserves credentials in its captured
scope.

## Considered alternatives

- Have the SPA register each capability's cleanup: callers must know the App's
  internal resources and can omit newly added capabilities.
- Make the data engine own all capability methods: couples capture and network
  cleanup to the document and duplicates otherwise complete interfaces.
- Wrap every capability with one generic operation tracker: a pending method
  call does not describe a recording session, response body, or multi-step
  product workflow.
- Rely on page destruction: cannot await persistence and does not reliably
  release native capture.
- Give every service a close method for symmetry: introduces lifecycle machinery
  without a resource dependency that requires it.
