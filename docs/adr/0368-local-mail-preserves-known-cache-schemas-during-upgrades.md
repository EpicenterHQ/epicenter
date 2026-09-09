# 0368. Local Mail preserves known cache schemas during upgrades

- **Status:** Accepted
- **Date:** 2026-09-08
- **Amended by:** [ADR-0370](0370-local-mail-downloads-the-mailbox-and-maintains-it-through-history.md), cursor preservation when adopting whole-mailbox scope.
- **Amends:** [ADR-0319](0319-local-mail-is-device-local-and-its-storage-splits-by-lifetime.md), only the rule that every cache schema mismatch triggers deletion.

## Context

Local Mail can rebuild its mail cache from Gmail, but that download consumes
quota and requires a working sign-in. During a synchronization failure, deleting
a readable cache also removes the mail a person could still use offline.
The SQLite simplification has a known v1 source schema and a transactional path
to v2. Rebuilding it would create network work for a local schema change.

## Decision

**A known cache schema is migrated in place.** `storage.ts` preserves message
resources, retained projections, labels, and all three sync-state values when
opening v1 as v2. The migration and `user_version` update share one transaction.
Failure leaves the old file intact and fails the open.

**An unrecognized cache schema retains the rebuild policy.** Gmail remains its
authority. This decision does not add a general repair engine or promise a
migration for every historical cache shape.

**Durable intentions retain their separate lifetime.** `local.sqlite` migrates
transactionally, refuses a newer schema, and is never unlinked by a cache
upgrade. Revision allocation preserves its high-water counter even when the
outbox is empty, so an old response cannot retire a newer choice.

## Consequences

The v1-to-v2 upgrade preserves offline mail and spends no Gmail API quota.
Local Mail maintains one explicit cache migration and frozen-v1 regression
fixtures. The migration tests cover populated and incomplete caches, pending
intentions, empty-outbox counters, and durable migration rollback.

Rebuilding every mismatch would delete the migration code but force another
full pull. Combining cache and intentions would remove a file while giving
irreplaceable pending work the cache's deletion policy. Both were rejected in
the implementation's independent design review.
