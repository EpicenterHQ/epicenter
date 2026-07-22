# Epicenter

One desktop application host. Bun serves the trusted SPAs, APIs, WebSockets,
and Home session; Rust owns native application mechanisms.

Design authority: [ADR-0153](../../docs/adr/0153-trusted-apps-are-source-built-static-catalog-members.md) (trusted source builds one static app catalog), [ADR-0160](../../docs/adr/0160-lenses-interpret-durable-namespaces-without-creating-lifecycle-scopes.md) (Lenses are pure interpretations), [ADR-0161](../../docs/adr/0161-each-person-has-one-epicenter-replicated-on-each-adapter-boundary.md) (one person, one Epicenter), [ADR-0166](../../docs/adr/0166-data-document-sync-and-agent-replace-workspace.md) (Data, document-sync, and agent replace Workspace), [ADR-0118](../../docs/adr/0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md) (one trusted application origin), [ADR-0080](../../docs/adr/0080-the-super-app-is-a-desktop-host-cross-device-is-remote-access-to-the-session-not-a-per-app-capability-plane.md) (remote devices attach to the session, never to per-app endpoints), and [ADR-0113](../../docs/adr/0113-super-chat-session-commands-are-host-owned-transports-only-frame-them.md) (Home owns command semantics; transports only frame and deliver them).

## Shape

- `src/main.ts` owns one desktop record owner at `<app-data>/data`. It binds the pure Chat, Honeycrisp, and Whispering Lenses once, then gives Home typed handles and trusted SPAs the narrow same-origin record carrier. Neither receives a SQLite path.
- `src/host.ts` composes canonical in-process app catalogs, optional boxed stdio MCP tools, and optional read-only local sources into one namespaced `ToolCatalog`. The host does not open root-Yjs persistence or own a second data directory.
- The Chat Lens owns conversation records. Boot resumes the latest durable row or creates one `New Chat` row before opening its record document. `clear` creates another row. Home releases and flushes record documents before the record owner disposes.
- Whole-replica attachment is host-global. Every command transport pauses while Home settles active tools and documents; discard rebuilds Home over the newly empty attached replica before commands resume.
- Local sources remain host-owned and are never relay routes or capabilities. A remote client sends Home commands; finished history belongs to the durable record plane, not the live AttachRelay.
- Command semantics belong to the host session, not the WebSocket adapter. Chat sends, direct invocations, approval answers, and later palette or voice commands must route through one host-owned session command surface.

## Refusals (do not reopen without a new ADR)

- No daemon `mount.ts` as the composition model; the mount path is CLI/projection for one app.
- No MCP for first-party in-process apps; MCP stays the boxed-app airlock (ADR-0081).
- No loose in-process TypeScript tool modules in v1; future scripting starts from an out-of-process runner unless a new ADR explicitly accepts unsafe developer-mode host imports.
- No bundled Tauri SPA plus side IPC; Bun serves the SPA and the API from one loopback origin.
- Source acquisition stays outside the desktop runtime and Epicenter CLI for the first source-built catalog. Git, JSRepo, archives, or file copies may populate a user-owned composition tree; Epicenter starts at explicit build admission (ADR-0153).
- The loopback server always binds `127.0.0.1` and rejects every request without the per-launch token; this ships with the first server version, not later (ADR-0084).
- No HTTP command route, Tauri IPC command path, stdio command protocol for the browser UI, generic synced command table, or transport-adapter framework until a real second consumer earns it. The current WebSocket is a session adapter, not the architecture.
