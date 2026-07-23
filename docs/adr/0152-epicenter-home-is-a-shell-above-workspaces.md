# 0152. Epicenter Home is a shell above workspaces

- **Status:** Accepted
- **Date:** 2026-07-19
- **Amends:** [ADR-0055](0055-conversation-storage-is-one-canonical-table-every-surface-syncs.md), [ADR-0080](0080-the-super-app-is-a-desktop-host-cross-device-is-remote-access-to-the-session-not-a-per-app-capability-plane.md), [ADR-0118](0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md)
- **Amended by:** [ADR-0166](0166-data-document-sync-and-agent-replace-workspace.md) (Home remains the shell and live-interface owner; one record Epicenter replaces workspace management, Device-owned history, registered Workspace IDs, and Workspace handles)
- **Relates:** [ADR-0055](0055-conversation-storage-is-one-canonical-table-every-surface-syncs.md), [ADR-0111](0111-super-chat-v1-exposes-built-in-epicenter-apps-and-defers-extension-surfaces.md)

## Context

Epicenter currently names its orchestration surface and Bun service Query, and
that service owns a separate data directory containing conversation history,
transitional Yjs workspaces, a node id, and canonical SQLite stores. This turns
a user interface into a persistence owner and leaves two storage lanes inside
one trusted desktop host.

The accepted product shape is broader than Query. The home surface manages
workspaces, chats across them, and runs commands, while trusted application
surfaces may open the same registered workspace through the host.

## Decision

Epicenter Home is the shell above the workspace plane. It owns navigation,
workspace management, the assistant session, command execution, approvals, and
other live interface state. It does not own a storage directory or define a
second persistence architecture.

Durable Home data lives in ordinary registered workspaces. Conversation
history uses the Device-owned Workspace ID `epicenter-conversations`. Replacing
the Home interface does not replace that history. Other trusted SPAs access a
registered workspace through the authenticated same-origin workspace API; no
SPA opens its SQLite file or chooses a physical path.

Device ownership is deliberate: a transcript may contain content read from an
Account-owned workspace, and signing out of that Account does not delete the
Device-owned transcript. Account lifecycle and Home history lifecycle remain
separate unless a later product decision changes the conversation owner.

`@epicenter/chat` owns one canonical conversation schema and the adapter from a
row-owned document to the agent loop's message-store seam. Products instantiate
that schema in owner-scoped workspaces. Home's Device-owned history and an
Account-owned app history are separate aggregates with different sync reach;
they are not rows in one universal physical table. This amends ADR-0055's
requirement that every chat surface share one synced table while preserving its
single domain schema and finished-message model.

Apps that still use the root-Yjs runtime import an explicitly named
`@epicenter/chat/legacy-root-yjs` definition. That export is a frozen migration
boundary, not a second canonical schema. New consumers use the package root.

The host statically reserves the `epicenter-*` Workspace ID namespace for
built-in definitions and refuses duplicate registrations. Third-party
installation, publisher namespaces, permissions, and downloaded source
placement remain deferred until an installation product exists. Arbitrary SPAs
cannot mint unscoped workspace directories in the interim.

The Query product and storage names are deleted as the transitional root-Yjs
workspaces migrate to the canonical workspace runtime. There is no `query/`,
`host/`, `apps/`, or persisted `node-id` directory in the greenfield app-data
tree.

## Consequences

- Epicenter has one product shell and one workspace persistence plane.
- Conversation history can outlive and be shared independently from the Home
  interface.
- Conversation schema is shared, while ownership and synchronization remain
  explicit per aggregate.
- Built-in apps can share a workspace by stable Workspace ID without sharing
  filesystem access.
- The host, not a SPA, remains the single owner of live workspace handles and
  storage lifecycle.
- Query-specific API and code names become migration work rather than durable
  vocabulary.
- Third-party installation does not earn an `apps/` data directory or namespace
  allocation system yet.

## Considered alternatives

- **Keep Query as an application with its own storage root.** Rejected because
  a shell above workspaces is not itself a storage owner.
- **Keep conversation history as private shell state.** Rejected because the
  history is durable product data that should survive a replacement interface.
- **Let trusted SPAs choose Workspace IDs and paths directly.** Rejected because
  shared origin trust does not transfer host storage ownership to each surface.
