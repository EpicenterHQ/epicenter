# 0367. Library erasure requires exclusive ownership of all local resources

- **Status:** Accepted
- **Date:** 2026-09-08
- **Amended by:** [ADR-0409](0409-resource-admission-protects-its-storage-owner.md) proposes removal of the unused blob-store eraser and its operation locks. Whole-library erasure remains unavailable.
- **Amended by:** [ADR-0380](0380-resource-handles-own-terminal-shutdown.md) at shutdown coordination: the App coordinates resource owners instead of the document owning every capability. Exclusive acquisition, physical release, and retention after failed release remain.
- **Related:** [ADR-0355](0355-local-and-account-sessions-share-the-application-data-api.md)
- **Unbuilt:** Exclusion for independently constructed blob producers, complete resource enumeration, native capture/media coordination, and app-factory removal.

## Context

A library belongs to one application and one captured `AccountIdentity | null`.
Its data definitions have separate generations, but share blobs and named SQL
files. Independent document owners would therefore require coordination over
those shared files. Current applications open one document per library; SQL-only
Local Mail opens several named files under one page lifetime.

The document factory already stops operation admission, drains admitted blob,
transfer, and SQL calls, and disposes its playback sources. Previously SQL connections remained cached after document close, and transport
handles could reopen a deleted name. SQL now has an explicit acquired lifetime
that serializes statements, deletion, and physical close. Transport handles name
that acquisition and its connections rather than reopening files per statement.

`eraseGenerations` now excludes competing generation and SQL owners before
enumerating one account definition. `eraseBlobStore` excludes active blob operations, but an idle
handle can recreate that store. Calling these two functions in sequence would
still leave named SQL files and sibling definitions behind.

Honeycrisp, Vocab, and Whispering leave their removal callback undefined. That
remains the correct behavior until the following contract is implemented.

## Decision

The app factory removes one selected library on this device. The selection is
`{ appId, account: AccountIdentity | null }`, captured before asynchronous work.
It includes every definition and generation, blob bytes, and named SQL files
with their sidecars. It excludes remote account data, other libraries, secrets,
and the app-scoped recorder. Sign-out alone preserves storage.

One active owner holds a library. Acquisition takes exclusive ownership before
discovery, allocation, or opening a resource. A second independent owner, even
for a sibling definition or another generation, is refused until the first
closes. Components borrow the existing document. Local and account libraries,
and different applications or accounts, remain independent. Sequential access
to historical generations remains supported.

Every storage entrypoint must obey that exclusion, including direct generation,
blob, and SQL-only consumers. The document owns a table application's lifetime.
A SQL-only application closes its Device without constructing a dummy document.
Direct generation APIs and SQL-only Device acquisition now take the same origin-wide
library claim before discovery or backend acquisition. Private generation helpers
run under their caller's claim. This replaces per-generation and allocation claims.
Independently constructed blob primitives still require producer coordination
before whole-library erasure can be offered.

The application stops consumers and closes the handles it owns. The factory
then attempts exclusive library ownership before enumerating resources. It
refuses while another owner remains active, including a sibling definition or
another window. It does not close another caller's handle implicitly. Local
and account libraries can continue independently.

The following document-wide coordination mechanism is amended by ADR-0380:
the App coordinates resource shutdown and final claim release, while each
resource retains its own admission and drain guarantees. The release and
failure guarantees below continue to apply.

Document close stops admission synchronously and waits for acquisition and
admitted operations to settle. It releases playback sources and durable backing before closing its SQL
lifetime and releasing the common library claim. A durable-close failure retains
the SQL lifetime and claim. One owner may open
several named SQL files and reuse a connection within that lifetime. It closes
its physical connections without reference counting. The document remains the single owner
of readiness, admission, draining, and close; this adds no application facade.
If capture or playback cleanup cannot confirm release, close rejects and retains
the acquired backing and reservation until context shutdown. It still attempts
other producer cleanup. A failed close cannot admit a replacement owner. Acquisition follows the same
rule: a returned operational failure releases resources first, while an unexpected
cleanup exception retains ownership. A failed IndexedDB load closes its acquired
connection before returning an error.

The platform SQL owner serializes acquisition, statements, close, and deletion
for a file. Deletion permanently invalidates every existing handle to that
file, including handles across a worker or WebSocket boundary. An explicit later
open creates a fresh handle. Closing preserves files. A browser runtime shares
one lazy OPFS worker across app owners; releasing one app cannot terminate a
worker another app uses. Native SQL uses one authenticated WebSocket per
acquired lifetime; disconnect stops admission, drains requests, and closes its
connections. Reconnecting requires a new acquisition. Secrets retain their
independent HTTP endpoint and survive SQL close.

Removal holds exclusive library ownership through the following sequence:

1. Enumerate durable generations across all definitions, the blob store, and
   named SQL files. Include unopened files from earlier processes. The SQL VFS
   owns its logical-to-physical mapping; an in-memory connection map is not an
   inventory of durable files.
2. Delete the selected resources through their platform owners. Include SQLite
   journals, WAL, and SHM files where the backend uses them. Do not remove the
   shared OPFS pool or rely on a common physical directory across backends.
3. Report success only after all deletions settle. Release exclusion last.

Platform owners must also exclude native producers and active media responses.
A Web Lock in a page cannot govern a Bun process. Disposing a stable media URL
does not prove the host finished serving it. Host request admission and release
must participate before native removal can claim this contract.

Failure reports incomplete removal and leaves affected handles closed. Retry
re-enumerates the remaining resources and is idempotent. There is no implicit
reopen or rollback across storage engines. An IndexedDB deletion cannot be
cancelled: if a blocked request reports a timeout, its exclusion must remain
held until the actual request settles. A retry must not race that pending
request. Explicit reopening after a settled failure can see partial data;
removal does not promise transactional reset or crash recovery.

The existing account action remains “Sign out and remove local data.” Its owner
must retain the captured identity through sign-out and surface failure without
claiming removal succeeded. A public local-reset action and its final factory
method names remain product decisions from ADR-0355.

## Considered alternatives

Shared library claims plus exclusive erasure would preserve concurrent sibling
documents at the cost of SQL reference counts and additional claims. Current
callers do not require that capability. We instead refuse independent owners
of the same library, while preserving several files within one owner.

An HTTP acquisition without a connection lifetime strands the host reservation
when a page reloads. A document-lived socket lets the host drain and release on
disconnect without an unload callback, heartbeat, or implicit takeover.

Calling `eraseGenerations` and `eraseBlobStore` from the account menu leaves SQL
files and sibling definitions behind. Neither helper establishes library
exclusion, so surviving handles can recreate storage during deletion.

Tracking only handles opened by one factory misses other factories, SQL-only
consumers, other windows, and durable files from earlier processes. Erasure
needs platform ownership and durable enumeration.

Terminating the browser SQL worker releases the entire pool and interrupts
other applications. Per-client SQL release must preserve the shared owner.

Reopening a deleted name through an old transport handle hides lifetime errors
and can recreate storage after removal. Explicit acquisition is the only path
to a new handle.

## Verification required before removal is exposed

Exercise refusal with an opening document, a sibling definition, a SQL-only
client, and another window or host client. Verify no deletion starts on refusal.
Race generation allocation, SQL open/delete, a download, and native media
streaming against removal. Retained handles must fail after deletion without
issuing fresh I/O.

Seed data, blobs, unopened SQL names, and sidecars in disposable storage. Close,
erase, and restart on Chromium, WebKit, and the native owner. Verify the selected
library is empty and a second local/account library, another app, and secrets
survive. Inject cleanup and partial deletion failures, including blocked
IndexedDB deletion, and verify exclusion lasts until actual settlement.
