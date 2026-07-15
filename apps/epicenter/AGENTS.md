# Epicenter

One desktop application host. Bun serves the trusted SPAs, APIs, WebSockets,
and Query session; Rust owns native application mechanisms.

Design authority: [ADR-0118](../../docs/adr/0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md) (the accepted application-host decision), [ADR-0080](../../docs/adr/0080-the-super-app-is-a-desktop-host-cross-device-is-remote-access-to-the-session-not-a-per-app-capability-plane.md) (desktop host; remote devices attach to the session, never to per-app endpoints), [ADR-0111](../../docs/adr/0111-super-chat-v1-exposes-built-in-epicenter-apps-and-defers-extension-surfaces.md) (v1 exposes built-in Epicenter apps and defers extension surfaces), [ADR-0084](../../docs/adr/0084-super-chat-shell-is-a-bun-hosted-local-server-not-a-bundled-spa.md) (historical Bun-hosted shell decision, superseded by ADR-0118), and [ADR-0113](../../docs/adr/0113-super-chat-session-commands-are-host-owned-transports-only-frame-them.md) (the Query session owns command semantics; transports only frame and deliver them).

## Shape

- `src/host.ts` composes the static built-in list: in-process Yjs apps (arm A) as durable local `connect({ kind: 'local' }, { persistence })` replicas over their action registries, boxed apps (arm B, Local Books) as a local stdio MCP subprocess via `src/stdio-mcp-catalog.ts`, and an optional read-only local source (arm A-like, `src/local-source-catalog.ts`, iMessage in the memo) as one `query` verb over an injected reader. Every source is namespaced (`todos__`, `localbooks__`, `imessage__`) and merged with `composeToolCatalogs` into the one `ToolCatalog` the agent loop consumes. A local source stays host-owned and is never reachable as a relay route or capability (ADR-0080 decision 2, ADR-0115); a remote client only sends session commands and the tool result rides back in the host-owned session.
- The in-process apps use `bunLocalPersistence({ dir })` under the host data directory. This is signed-out local durability only; sign-in and room sync for the host are a later enhancement.
- Transcripts are durable locally: the host's own workspace (`src/workspace.ts`) holds the canonical conversations table (ADR-0055), connected locally under the same persistence directory, so finished messages survive restarts without touching a relay. Boot resumes the most recent row by `updatedAt`; a row is minted lazily on the first send; `clear` starts a fresh conversation. A phone reads this finished transcript while the desktop is offline from a synced replica of it, never from the live relay (the AttachRelay stores nothing and needs both ends online, so offline history is a sync-plane property, not a relay one). ADR-0115 establishes offline read at the durable-replica layer. Carrying the transcript over a network sync wire is a later enhancement that rides host sign-in and the normal trusted sync posture; privacy-sensitive deployments self-host.
- Command semantics belong to the host session, not the WebSocket adapter. Chat sends, direct invocations, approval answers, and later palette or voice commands must route through one host-owned session command surface.

## Refusals (do not reopen without a new ADR)

- No daemon `mount.ts` as the composition model; the mount path is CLI/projection for one app.
- No MCP for first-party in-process apps; MCP stays the boxed-app airlock (ADR-0081).
- No loose in-process TypeScript tool modules in v1; future scripting starts from an out-of-process runner unless a new ADR explicitly accepts unsafe developer-mode host imports.
- No bundled Tauri SPA plus side IPC; Bun serves the SPA and the API from one loopback origin.
- No jsrepo production path until trust, pinning, and installed-state tracking are designed.
- The loopback server always binds `127.0.0.1` and rejects every request without the per-launch token; this ships with the first server version, not later (ADR-0084).
- No HTTP command route, Tauri IPC command path, stdio command protocol for the browser UI, generic synced command table, or transport-adapter framework until a real second consumer earns it. The current WebSocket is a session adapter, not the architecture.
