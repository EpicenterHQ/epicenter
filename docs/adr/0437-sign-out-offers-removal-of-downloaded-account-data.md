# 0437. Sign-out offers removal of downloaded account data

- **Status:** Proposed
- **Date:** 2026-09-23
- **Scope note:** The store-owned SQLite implementation does not implement this cleanup decision. Pending Local Mail triage and unknown SQL remain retained.
- **Unbuilt:** Cleanup inventory, safe-removal evidence, erasure ownership, confirmation UI, and interruption recovery.
- **Relates:** [ADR-0367](0367-library-erasure-requires-exclusive-ownership-of-all-local-resources.md) requires safe exclusive erasure; [ADR-0436](0436-stores-own-local-sqlite-namespaces.md) scopes local SQL to its containing store.

## Context

Account-scoped local storage prevents accidentally selecting another account's
namespace. It does not erase cached information or provide encryption against
someone with access to the device. Closing a handle, revoking credentials, and
removing persisted bytes are different operations.

Local SQL can contain downloaded mail and search indexes, but also queued
operations or locally authored data. A Personal document can contain unsent
edits. Neither an account partition nor a disconnected socket proves that data
can be downloaded again.

## Decision

**Explicit sign-out offers an unchecked choice to remove downloaded account
data from the current storage surface.** The intended checkbox is:

> Remove this account's downloaded data from this device

The dialog identifies the account and the actual scope. Desktop copy can name
this Epicenter installation only when the host can enumerate and coordinate its
participating applications. A browser page can promise removal only from the
site/profile storage it can access. If only one app participates, name that app
in the checkbox. Do not imply deletion from other origins, OS profiles, devices,
backups, or remote account storage.

Unchecked sign-out preserves persisted data. It retains the existing account
retirement and departure behavior, without introducing a general shutdown drain.
No checkbox runs on token refresh, transient authentication failure, unexpected
revocation, or an ordinary account switch unless that switch explicitly presents
and obtains the same removal choice.

Checked sign-out removes only enumerated account-owned downloads and rebuildable
caches whose removal has been proven safe. It does not clear device-owned Local
stores or SQL, delete remote blobs or rows, or erase independent provider secrets.
Auth still clears the credentials its sign-out contract owns.

The storage owner maintains enough inventory to include previously opened but
currently closed databases. Classifying data as a cache is an explicit product
contract; a database name, its SQL format, or its account scope is not evidence.
Unknown or mixed durable/cache databases are retained unless the product can
remove the safe subset without losing pending operations. An unopened resource
must not be acquired as a live syncing store just to delete its cache.

Preflight identifies unsent edits, queued operations, and unknown durability.
If those prevent the requested removal, explain what will remain and offer
sign-out with data retained or cancellation. The downloaded-data checkbox grants
no permission to discard the only copy. A destructive discard workflow requires
a separate explicit decision and is outside this feature.

On confirmation, capture the exact authority, principal, namespace inventory,
and intended removal scope before credentials retire. Fence producers and prevent
new opens in that scope, then recheck eligibility under exclusive ownership.
A preflight snapshot alone cannot authorize deletion after intervening writes.
Close/drain protected handles before removing their backing; hold exclusion
through deletion. Uncertain cleanup does not permit erasure or a competing writer.

Local removal must remain possible after network credentials retire, without
using the next account's identity or storing credentials in recovery metadata.
Credential revocation and local cleanup have separate outcomes. A removal failure
must neither reactivate old access nor prevent the person from signing out.
Report retained data honestly, preserve a retryable scope, and never claim
completion merely because navigation or restart occurred. The implementation
must demonstrate which host or recovery surface finishes or retries removal
across document replacement before enabling the option.

## Consequences

The product gives control over local retention without treating every SQL file
as disposable. A complete cleanup scope needs inventory and coordination beyond
one currently open store. Implement and label one demonstrable scope first;
expand the wording only when removal coverage expands.

Removing a whole Personal replica requires evidence that no unique pending work
is lost and that the replica can be reconstructed. The exact evidence belongs
to its persistence/sync implementation. A generic `isOnline` or current account
session is insufficient. Missing evidence means retained data, not presumed safety.

## Considered alternatives

- Automatically erase on every logout: can destroy local-only or unsent work.
- Never offer removal: leaves downloaded account data without a product cleanup path.
- Call `store.close()` and report removal: close retains committed bytes.
- Clear all browser storage or the device SQL root: crosses account and Local boundaries.
- Delete remote data through Personal blob methods: changes account data everywhere,
  while this choice concerns only local copies.
