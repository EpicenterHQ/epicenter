# 0367. Library erasure requires exclusive ownership of all local resources

- **Status:** Proposed
- **Date:** 2026-09-08
- **Related:** [ADR-0355](0355-local-and-account-sessions-share-the-application-data-api.md)
- **Unbuilt:** Scope-wide exclusion, physical SQL release, SQL handle invalidation and deletion ordering, complete resource enumeration, and app-factory removal.

## Context

A library belongs to one application and one captured `AccountIdentity | null`.
Its data definitions have separate generations, but share blobs and named SQL
files. Closing one document cannot prove that nobody else uses those files.

The document factory already stops operation admission, drains admitted blob,
transfer, and SQL calls, and disposes its playback sources. SQL connections
remain cached in the platform owner: `DeviceSqliteOwner` has only `open` and
`delete`. Transport handles retained after deletion can reopen a deleted name.
The browser and Bun owners also permit open/delete races on that name.

`eraseGenerations` enumerates one account definition before claiming the
generations it found. It cannot exclude a concurrent allocation or a new
generation. `eraseBlobStore` excludes active blob operations, but an idle
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

Every storage user must participate in the library's lifetime exclusion,
including direct blob and SQL-only consumers. Acquisition takes shared library
ownership before discovery, allocation, or opening a resource. The exact
document address retains its separate exclusive claim against duplicate opens.
These claims protect different invariants; a definition claim cannot stand in
for library exclusion.

The application stops consumers and closes the handles it owns. The factory
then attempts exclusive library ownership before enumerating resources. It
refuses while another owner remains active, including a sibling definition or
another window. It does not close another caller's handle implicitly. Local
and account libraries can continue independently.

Document close stops admission synchronously and waits for acquisition and
admitted operations to settle. It releases playback sources, its SQL connection
ownership, and its durable backing before releasing claims. Multiple documents
can share a SQL file, so releasing one document's ownership cannot close a
connection another document still holds. The document remains the single owner
of readiness, admission, draining, and close; this adds no application facade.

The platform SQL owner serializes acquisition, statements, close, and deletion
for a file. Deletion permanently invalidates every existing handle to that
file, including handles across a worker or HTTP boundary. An explicit later
open creates a fresh handle. Closing preserves files. A browser runtime shares
one lazy OPFS worker across app owners; releasing one app cannot terminate a
worker another app uses.

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
