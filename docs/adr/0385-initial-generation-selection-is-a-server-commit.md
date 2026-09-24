# 0385. Initial data creation is a server commit

- **Status:** Proposed
- **Date:** 2026-09-09
- **Unbuilt:** Expressing canonical initialization through snapshot existence without a generation row.
- **Relates:** [ADR-0407](0407-app-owns-the-declaration-and-data-engine.md) preserves historical-data refusal; [ADR-0417](0417-a-data-address-holds-one-document.md) removes generation identity and remote replacement.

## Context

A browser lock coordinates local owners, not independent devices. Two devices
can both see an empty cache and submit initialization candidates. The authority
must return one canonical state, even when a caller retries after losing the
response. The existing current-authority transaction provides this guarantee;
the generation number is not what makes the transaction atomic.

Today's ordinary opener submits an empty Yjs seed. Keeping explicit
initialization establishes a complete baseline and confirms durable server
storage before publishing a usable personal cache.

## Decision

The stable data authority initializes one snapshot and log atomically. If the
log is empty, initialization installs the submitted baseline. Later and
concurrent callers receive the existing canonical capture. A snapshot proves
initialization; no generation number, allocation ledger, or publication marker
is needed.

The capture contains a snapshot, every following update through its captured
head, and that head. The socket supplies subsequent entries. A client applies
and validates the capture, then atomically installs the complete baseline with
its position. It installs the returned bytes, never an independently retained
candidate. Nonempty input and the existing streamed 16 MiB ingress limit are
checked before the authority transaction.

A production socket accepts writes only after initialization. A nonempty log
without a usable snapshot is a failure, not permission to replace it with an
empty seed. Generic raw-log use by sync-lab does not require a second authority
implementation or change production bootstrap ordering.

An established replica opens its local cache without network access. A missing
cache calls initialization directly. A failed request does not prove that the
remote document is empty, authorize a different history, or select device data
instead. A complete nonempty update chain establishes local cache readiness.

The data address names the application, personal scope, and data domain. The
server derives the owner from the authenticated actor. Local replicas also
retain the authority and actor, so an account change cannot submit another
person's queue.

Historical numbered data remains untouched. Personal initialization refuses
admitted historical data rather than choosing its largest number or hiding it
behind a fresh document. Historical `instance` data is not assigned to a named
person. Rollout and historical-data disposition remain separate decisions.

## Consequences

Initialization keeps one transaction owner and one readiness fact. It no longer
requires generation-bound sockets, retirement, or replacement receipts. An
operator restoring a backup to empty storage must install the intended baseline
before admitting ordinary clients with empty initialization candidates.

The historical ledger remains solely for the refusal from ADR-0407. It is not
another initialization protocol. Canonical bootstrap, offline cache opening,
and pending-edit preservation remain required after generation removal.

## Considered alternatives

- Client-side locks: cannot coordinate independent browser profiles or devices.
- Select the largest historical number: silently chooses a migration policy.
- Reserve, seed, and admit through separate owners: distributes one creation
  transaction across a protocol that current startup does not need.
- Keep the submitted candidate instead of the returned capture: a losing
  initializer can publish bytes the authority did not select.
- Remove initialization because current seeds are empty: changes bootstrap and
  cache completeness to avoid a small existing transaction.
