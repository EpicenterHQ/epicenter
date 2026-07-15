# 0143. Document synchronization addresses rooms, not installations

- **Status:** Accepted
- **Date:** 2026-07-14
- **Amends:** [ADR-0092](0092-identity-is-the-partition.md), [ADR-0094](0094-the-connection-is-the-boot-decision-one-connect-call.md), [ADR-0095](0095-websocket-room-auth-uses-route-owned-subprotocol-bearers.md)
- **Relates:** [ADR-0115](0115-super-chat-remote-attach-rides-an-endpoint-addressed-trusted-relay.md) (scoped live-session endpoints are not installation identity)

## Context

`NodeId` was introduced to show online installations, deduplicate tabs, route
peer calls, and give a daemon a stable Yjs client ID. The peer-call and device
mesh products are gone, users do not need an online-device model, and no
remaining durable object is addressed by installation. Yjs itself needs a
document identity and update origins, not a product-level device identity.

## Decision

Document synchronization addresses principal-owned rooms, never installations.
The authenticated principal selects the server partition and the room path
selects the Yjs document:

```text
/api/rooms/<document-guid>
```

The route has no `nodeId` query parameter. The room stores and broadcasts Yjs
updates to its open sockets, but publishes no generic peer list or installation
presence. The framework deletes `NodeId`, its storage helpers, room attachment
fields, same-node socket deduplication, peer APIs, presence frames, and stable
Yjs client-ID seeding. A `Y.Doc` uses its normal runtime client ID.

Identifiers that belong to a concrete live product may still exist. For
example, a Super Chat attach session can address one currently open host and
one attach attempt. Such identifiers are scoped to that product and lifetime;
they do not become a reusable machine identity or document-sync participant.

## Consequences

Opening a document needs only the workspace connection and document guid. Tabs,
windows, browser profiles, desktop apps, and one-shot processes all synchronize
the same way without registering a device.

The system loses generic online-device UI, join and leave logs, per-install
labels, and deterministic Yjs client IDs across process restarts. That is the
intended refusal. If a future collaborative editor needs cursors or selections,
it may add document-scoped ephemeral awareness without restoring `NodeId`.
