# 0161. Local database files carry their logical identity

- **Status:** Proposed
- **Date:** 2026-07-20
- **Relates:** [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md), [ADR-0151](0151-local-workspace-stores-use-owner-first-directories.md)

## Context

The normal runtime chooses a local SQLite path from a database ID, but native
readers and copied files can be opened by an explicit path. Path-only identity
would allow a renamed or incorrectly selected file to be interpreted through an
unrelated definition without a clear failure.

## Decision

Every local database file contains a one-row private
`__epicenter_meta(database_id)` table. Opening a file through a definition
compares this value with `definition.id` and fails before exposing data when
they differ. The file path locates the store; the metadata row witnesses which
logical database the bytes belong to.

`PRAGMA application_id` may identify the Epicenter file format and
`PRAGMA user_version` remains the single physical schema-version authority.
Neither can replace the string database ID, and the metadata table does not
duplicate the storage version.

All runtime-owned relations use the already reserved `__epicenter_` prefix.
The durable visible scalar relation is `__epicenter_rows`; synchronized stores
may additionally own `__epicenter_confirmed_rows`,
`__epicenter_row_intents`, replica metadata, acquisition scratch state, and
document update-log relations. `__epicenter_kv` remains the reserved logical
table key for KV; it is not a second physical KV table. Application definitions
cannot use the reserved prefix.

## Consequences

- A copied, renamed, or wrongly selected database fails loudly instead of being
  reinterpreted under another ID.
- `database_id` is not repeated on each row in a one-database local file. The
  account authority still stores it explicitly because one physical database
  contains many logical databases.
- Private relation names describe storage mechanics. Application-facing SQL
  uses definition-derived views and never depends on those names.

## Considered alternatives

- **Trust the path.** Rejected because explicit-path readers make mistakes both
  easy and silent.
- **Store the ID in `application_id`.** Rejected because that pragma is a
  32-bit file-format marker, not a stable arbitrary string identity.
- **Store `storage_version` in metadata.** Rejected because `user_version`
  already owns that fact.

