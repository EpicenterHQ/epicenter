# 0048. A conversation's loop is chosen by whether its transcript syncs across peers

- **Status:** Superseded
- **Superseded by:** [ADR-0051](0051-one-agent-loop-its-store-seam-chooses-persistence.md) (there is one agent loop; its store seam, not a second loop, chooses persistence, so tab-manager converges and the AG-UI stack is deleted). The shared finished-message record this ADR protected is what makes the convergence cheap.
- **Date:** 2026-06-21
- **Relates:** [ADR-0047](0047-the-agent-loop-runs-in-the-client-and-tools-are-dispatched-actions.md) (the client loop and its LWW-records persistence), [ADR-0046](0046-a-capability-free-agent-persists-finished-messages-not-live-doc-streams.md) (the persisted-record shape both loops share), [ADR-0033](0033-a-conversation-has-one-transport-and-two-triggers.md) (the blind cloud that rules out a server tool loop)

## Context

<!-- doc-path-check: ignore-next-line (historical source deleted by ADR-0166) -->
The monorepo runs two agent chat loops, and a new chat surface has to pick one. The workspace loop (`createConversation`, `packages/workspace/src/agent/loop.ts`) runs the multi-step loop in the client, persists each finished message into a synced Yjs child doc keyed by id, and reaches tools by dispatching actions to peers (ADR-0047), so the loop never runs on a server. tab-manager runs a separate loop on TanStack's `createChat` over device-local IndexedDB, for plain-text streaming. Without a stated rule the split looks accidental, and the next surface either rebuilds one loop on the other's substrate or forks a third. The two are not redundant: they differ on whether the transcript is shared across a person's devices and whether tools must be orchestrated client-side against a blind cloud.

## Decision

**Choose the loop by transcript reach. A conversation whose transcript must sync across a person's peers, or that needs client-orchestrated tools against a blind cloud, uses the workspace client loop (`createConversation`); a conversation that is deliberately device-local and text-only uses TanStack `createChat`.**

The workspace loop's render state is a snapshot: the persisted transcript re-read from the Yjs store plus the live in-memory turn, so a remote message that syncs in from another device merges on the next read. TanStack's `ChatClient` is not ruled out by message syncing as such, it can be driven from an external store (`setMessagesManually`, `onMessagesChange`). It is ruled out as our synced-conversation host by its tool loop, which runs on a `chat()` server that sees tool names, arguments, and results, where ADR-0033 keeps the cloud a blind token pipe. A synced, tool-capable conversation therefore cannot use it. When a transcript is meant to stay on one device and needs no client-orchestrated tools (tab-manager's per-browser history), `createChat` over IndexedDB is the lighter fit and carries no CRDT cost. Both loops persist the same finished-message record shape (ADR-0046), so a surface can move between them without reshaping its messages.

## Consequences

- A new chat surface has one question to answer, not an open design space: does this transcript follow the person across devices, or carry client tools? Either picks the workspace loop; a device-local, text-only surface picks `createChat`.
- The two loops stay deliberately separate; neither is the "real" one to converge on. tab-manager keeps `createChat` rather than adopting the synced loop it does not need.
- The shared record shape is load-bearing: it is what lets a device-local surface graduate to a synced one later without a migration of message bodies. Diverging the two part schemas would forfeit that and is a cost, not a convenience.
- This says nothing about where reasoning runs or where tools live; ADR-0047 owns that. This is only about transcript persistence and reach.

## Considered alternatives

- **Adopt TanStack `ChatClient` for both loops (its client tools, `needsApproval`, and external-store sync).** Rejected: `ChatClient`'s client-tool flow runs the agent loop on a `chat()` server, which emits `tool-input-available` to the browser and receives the tool result back, so the server sees every tool and its data. That reverses ADR-0033's blind cloud and re-creates the server answering vertical ADR-0047 deleted. `ChatClient` can still front the blind cloud for plain-text streaming, which is exactly what tab-manager uses.
- **Converge tab-manager onto the workspace loop.** Rejected: a device-local, text-only history needs neither a synced Yjs child doc nor dispatched tools, and `createChat` carries no CRDT cost. The shared record shape leaves the door open if that changes.
