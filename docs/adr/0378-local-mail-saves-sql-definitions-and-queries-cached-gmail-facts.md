# 0378. Local Mail saves SQL definitions and queries cached Gmail facts

- **Status:** Proposed
- **Date:** 2026-09-08
- **Unbuilt:** Complete desktop computer-use, live keychain reopening, and live Gmail integration verification.

## Context

Local Mail downloads a mailbox progressively and maintains it through Gmail
history. Each Google subject has a separate local SQLite cache. Durable pending
label intentions remain separate from that cache and are overlaid explicitly
by the triage reads.

A named query is authored by the person. It is a new Epicenter-owned artifact,
not a provider command or a copy of email. The earlier absence of Epicenter Data
described the artifacts Local Mail held then, not a prohibition on preferences.

## Decision

Local Mail stores named query definitions in `savedQueries` through Epicenter
Data. Each row uses the existing row identity and the fields `name` and `sql`.
The target destination is the person's Personal library. The current opener is
`openAccount(account)`; the library-ownership proposal renames it
`openPersonal(account)`. SQL results, provider
credentials, mailbox caches, and pending intentions never synchronize with it.

An explicit Run action captures SQL text and a selected Google subject and
executes against that account's downloaded cache. A saved query has no account
binding. Unsaved SQL can use the same execution operation. Saving, selection,
remote edits, and mailbox refresh do not automatically execute SQL.

Results are tabular SQLite values, not actionable message lists. Queries see
cached Gmail facts, including cached label IDs. They do not inherit the triage
overlay. A pending archive immediately changes the triage inbox, while a query
over cached labels changes after the cache does. The UI states this distinction
and shows existing cache availability/freshness without inventing a range tracker.

Local Mail's product operation fixes `tables: ['messages', 'labels']` on the
selected cache connection and invokes `AppSqliteDatabase.query`. The SQL editor
cannot change this allowlist. These names refer to physical SQLite tables;
`app.tables.savedQueries` is the separate synchronized collection of definitions.
The restricted-operation contract is described in
[ADR-0381](0381-user-authored-sql-runs-through-a-bounded-read-only-operation.md).

The account owner admits each run and prevents removal until it settles.
Execution needs neither Gmail credentials nor durable intentions. SQL must not
receive those capabilities. Late results cannot be published under a newly
selected account. Result cells render as text.

## Consequences

One query can report counts, grouped senders, JSON-derived facts, or custom
columns across separately selected Gmail accounts. User-label IDs embedded in
SQL may have account-specific meaning. This does not justify an account-binding
field before a concrete use case requires one.

Browser execution uses the OPFS worker and desktop execution uses the native
Rust owner. Their engine and transport checks do not replace complete UI
verification: account switching, saving without running, dirty remote edits,
and departure still need to be exercised together.

The first slice excludes actionable result rows, effective-mailbox SQL,
cross-account joins, persistent results, automatic execution, parameter-editor
configuration, and a generic query framework. It preserves existing triage,
Undo, outbox, and progressive whole-mailbox behavior. Historical cache and
durable-schema migrations are omitted in the authorized fresh namespace;
subsequent saves still require persistence and offline reopening.

## Considered alternatives

- Save predicates producing mail lists: useful for saved filters, but cannot
  express the reporting capabilities requested here.
- Overlay arbitrary SQL implicitly: creates new relation semantics and exposes
  pending-intent machinery that ordinary cache SQL does not possess.
- Save queries in application SQLite: bypasses the requested Epicenter Data
  ownership and synchronization of authored definitions.
- Treat every result with an `id` column as mail: invents message identity,
  ordering, and triage behavior for arbitrary output.
