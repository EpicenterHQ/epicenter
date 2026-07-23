# 0166. Data, document sync, and agent replace Workspace

- **Status:** Accepted
- **Date:** 2026-07-20 (accepted 2026-07-22 after caller migration and deletion)
- **Supersedes:** [ADR-0094](0094-the-connection-is-the-boot-decision-one-connect-call.md), [ADR-0096](0096-local-workspace-persistence-is-environment-injected.md), [ADR-0143](0143-account-open-never-consumes-device-data.md), and [ADR-0151](0151-local-workspace-stores-use-owner-first-directories.md) (the Workspace connection, Device and Account lifecycle, and per-Workspace storage surfaces are deleted)
- **Amends:** [ADR-0010](0010-whispering-exports-recordings-as-a-zip-continuous-markdown-is-the-mounts-job.md), [ADR-0021](0021-actions-are-the-only-surface-that-crosses-a-process-boundary.md), [ADR-0049](0049-inference-is-its-own-box-the-daemon-never-infers.md), [ADR-0050](0050-the-inference-contract-is-openai-compatible.md), [ADR-0055](0055-conversation-storage-is-one-canonical-table-every-surface-syncs.md), [ADR-0066](0066-runtime-portability-is-per-concern-injection-not-a-runtime-object.md), [ADR-0073](0073-tools-speak-mcp-natively-epicenter-owns-only-the-transport-mcp-lacks.md), [ADR-0088](0088-sign-in-is-an-enhancement-never-a-door.md), [ADR-0092](0092-identity-is-the-partition.md), [ADR-0095](0095-websocket-room-auth-uses-route-owned-subprotocol-bearers.md), [ADR-0128](0128-tables-do-not-declare-document-edit-touch-policy-without-a-runtime-owner.md), [ADR-0135](0135-row-documents-have-application-owned-roots.md), and [ADR-0152](0152-epicenter-home-is-a-shell-above-workspaces.md) only where their durable product rule survives but their Workspace, room, daemon, mount, or materializer mechanism was deleted

## Context

`@epicenter/workspace` combines root-Yjs storage, SQLite experiments,
row-document transport, an agent loop, daemon mounts, materializers, and general
utilities. Neither Workspace nor Database remains a product concept. Renaming
the package would preserve a miscellaneous dependency owner under another noun.

## Decision

Three concrete capability packages replace the surviving Workspace families:

```txt
@epicenter/data           Lenses, typed access, local owner, scalar sync, record blobs
@epicenter/document-sync  record-document protocol and realtime collaboration
@epicenter/agent          UI-free agent loop over an explicit data interface
```

`@epicenter/sqlite` remains a domain-free adapter leaf. Data and Server had no
substantial direct use for `@epicenter/row-sync`, so the public package is
deleted. Data owns the replica protocol and convergence implementation;
`@epicenter/server` owns the authority protocol and schema without depending on
application typed lenses.

Data owns the one runtime lifecycle for attachment, credentials, wakeups,
automatic scalar, document, and blob obligations, status, and disposal.
Document Sync owns Yjs wire and realtime mechanics without becoming a second
runtime owner. Record blob storage and publication stay in Data because their
lifecycle is the owning record and the local Epicenter storage root.

No `database-address`, `database-control`, or `database-migration` package
survives. There are no database addresses, controls, or migrations to own.
Structured record addresses (namespace, collection, record key) live at the
narrowest shared protocol boundary that actually consumes them.

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

## Implementation

The retained Epicenter, Honeycrisp, and Whispering callers now bind record
Lenses through `@epicenter/data/record`. The replacement owns scalar records,
record documents, blobs, attachment, status, and disposal. After the retained
applications and package graph verified without the old import, the repository
deleted `packages/workspace`, its orphaned dependencies, obsolete examples,
and its agent skills. Git preserves the removed implementation; no compatibility
package or migration bridge remains.

## Considered alternatives

- **Rename Workspace to Database or Epicenter.** Rejected because the package
  still contains several unrelated lifecycles and would claim the top-level
  product noun for a toolkit implementation.
- **Keep Workspace as a compatibility barrel.** Rejected because it prevents
  proving that the old graph is unreachable.
- **Pre-split every possible leaf package.** Rejected because packages must earn
  themselves through real independent consumers and dependency direction.
