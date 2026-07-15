# 0145. External systems of record keep local mirrors outside Epicenter sync

- **Status:** Accepted
- **Date:** 2026-07-14
- **Relates:** [ADR-0061](0061-local-books-reads-facts-from-the-mirror-reports-live-and-writes-through-one-approved-verb.md), [ADR-0072](0072-local-books-ships-as-a-standalone-cli-the-daemon-surface-is-deferred.md), [ADR-0081](0081-per-upstream-oauth-concurrency-decides-mirror-topology.md), [ADR-0082](0082-local-mail-mirror-is-push-free-polling-collapsing-hosted-vs-self-host-to-one-oauth-client-id.md), [ADR-0116](0116-local-mail-is-desktop-first-one-bun-engine-no-background-mail-service.md)

## Context

Not every local SQLite database is an Epicenter workspace. Gmail and QuickBooks
already provide durable authority, synchronization, identity, and recovery.
Replicating their disposable local mirrors through Epicenter would create a
second authority and new conflict rules without preserving any additional
user-owned fact.

## Decision

When an external system is the source of truth and every human-meaningful state
round-trips through it, the application keeps a local disposable mirror outside
Epicenter workspace synchronization. The application synchronizes directly
with its authority while open or during an explicit one-shot command. Reads use
the local mirror; approved writes go to the authority first and then fold into
the mirror.

Local Mail follows this rule with Gmail. Local Books follows it with
QuickBooks. Matter follows the same ownership test with the filesystem as
authority and SQLite as a projection. None needs Epicenter record replication,
Yjs document rooms, a generic mount, or a generic daemon merely because it uses
SQLite locally.

If an application introduces durable user-owned state that cannot round-trip
through its external authority, it must choose that field's authority
explicitly: local-only, an Epicenter workspace, or another named store. It may
not hide durable state inside a cache and call the whole database disposable.

## Consequences

External-authority applications keep smaller failure domains and can rebuild
their mirrors from upstream. Epicenter Cloud does not store duplicate Gmail or
QuickBooks records, and local engines do not join the Epicenter room or records
protocols.

Cross-application use happens through explicit reads, commands, or local tool
facades, not by importing every upstream record into a universal workspace.
The cost is that app-owned metadata without an upstream representation does not
automatically synchronize; the product must earn and name an authority for it.
