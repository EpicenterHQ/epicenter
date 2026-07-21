# 0166. Data, document sync, and agent replace Workspace

- **Status:** Proposed
- **Date:** 2026-07-20

## Context

`@epicenter/workspace` combines root-Yjs storage, SQLite experiments,
row-document transport, an agent loop, daemon mounts, materializers, and general
utilities. Neither Workspace nor Database remains a product concept. Renaming
the package would preserve a miscellaneous dependency owner under another noun.

## Decision

Three concrete capability packages replace the surviving Workspace families:

```txt
@epicenter/data           Lenses, typed access, local owner, scalar sync, row blobs
@epicenter/document-sync row-document protocol and realtime collaboration
@epicenter/agent          UI-free agent loop over an explicit data interface
```

`@epicenter/sqlite` remains a domain-free adapter leaf. `@epicenter/row-sync`
may remain as the portable scalar wire and convergence leaf only if both Data
and Server have substantial direct use for it; otherwise its implementation is
owned by Data and Server without a public package. `@epicenter/server` owns the
authority schema and depends on portable protocols, never on application typed
lenses.

Data owns the one runtime lifecycle for attachment, credentials, wakeups,
automatic scalar, document, and blob obligations, status, and disposal.
Document Sync owns Yjs wire and realtime mechanics without becoming a second
runtime owner. Row blob storage and publication stay in Data because their
lifecycle is the owning row and the local Epicenter storage root.

No `database-address`, `database-control`, or `database-migration` package
survives. There are no database addresses, controls, or migrations to own.
Structured namespace, table, value, and row addresses live at the narrowest
shared protocol boundary that actually consumes them.

The root-Yjs Workspace API, workspace daemon and mount families, application SQL
escape hatches, database experiments, compatibility barrels, aliases, and
migration bridges are deleted after retained callers stop importing them and the replacement verifies.
`packages/workspace` is then deleted. Git, not a legacy runtime package,
preserves removed source.

Maintained applications migrate in the replacement wave. Deferred applications
may be temporarily broken or removed from the active graph under this explicit
greenfield cut; they do not force compatibility into Data. Browser-origin data
cannot be centrally migrated, so any real retained user data would require a
separate product decision before deletion. The current decision relies on the
stated zero-legacy-data premise.

## Consequences

- `packages/workspace` is obsolete and has no destination API.
- The package graph names capabilities rather than the historical aggregate.
- Server and clients share protocol definitions, not client runtime ownership.
- The cut may break unmaintained applications. It does not ship a compatibility
  package to keep them compiling.

## Considered alternatives

- **Rename Workspace to Database or Epicenter.** Rejected because the package
  still contains several unrelated lifecycles and would claim the top-level
  product noun for a toolkit implementation.
- **Keep Workspace as a compatibility barrel.** Rejected because it prevents
  proving that the old graph is unreachable.
- **Pre-split every possible leaf package.** Rejected because packages must earn
  themselves through real independent consumers and dependency direction.
