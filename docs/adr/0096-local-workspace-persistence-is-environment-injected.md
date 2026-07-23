# 0096. Local workspace persistence is environment-injected

- **Status:** Superseded
- **Date:** 2026-07-02
- **Superseded by:** [ADR-0166](0166-data-document-sync-and-agent-replace-workspace.md)

## Context

ADR-0088 made sign-in an enhancement for browser apps, and ADR-0094 collapsed
the browser opener to one boot decision: `connect(connection | null)`.
`connect(null)` still hardcoded browser storage, while the only durable Node
path was `.mount()`, which is a session-backed daemon surface that fuses disk
persistence with cloud sync. Super Chat needs a signed-out Bun host to open
installed app replicas durably without constructing an auth client or using the
daemon mount shape.

## Decision

`defineWorkspace().connect(null, { persistence })` is the ungated durable local
open path for non-browser runtimes. The local preset keeps the connection as
the auth/sync boot decision and accepts storage as an injected environment
concern. Browsers use the default local persistence, which preserves today's
BroadcastChannel plus IndexedDB behavior. Bun hosts pass
`bunLocalPersistence({ dir, nodeId? })`, which stores each root and child
Y.Doc in a guid-named Yjs SQLite log and may pin a stable Y.Doc client id after
log replay.

The connected bundle exposes the neutral `storage` handle instead of `idb`, so
callers can await hydration and disposal without knowing whether the runtime is
using IndexedDB or a Bun SQLite update log.

## Consequences

Super Chat can open Honeycrisp and Todos with `connect(null, { persistence })`,
await their local storage, compose their action catalogs, and relaunch over the
same data directory without losing rows. Todos now uses `defineWorkspace`, so it
shares the same preset surface as the other first-party workspace apps.

The signed-in Bun host remains out of scope. Relay sync for these same replicas
will need a later slice that combines the injected local persistence with a
credentialed connection. `.mount()` also remains session-shaped; unfusing its
disk and cloud concerns is a follow-on, not part of this decision.

## Considered alternatives

Keep a browser-only `idb` bundle key: rejected because Bun storage made the name
false at the public boundary.

Add a separate node opener: rejected because it would create a second workspace
composition site and drift from ADR-0094's one connect call.

Hand-wire Todos persistence in Super Chat: rejected because Todos is small and
its isomorphic model should own the same preset surface as the rest of the
workspace apps.
