# Synchronized data and open-runtime clean break

**Date**: 2026-07-14
**Status**: In Progress
**Owner**: Epicenter workspace, server, CLI, and application owners
**Branch**: `codex/records-epoch-clean-break`

## One Sentence

Collapse Epicenter around synchronized data by giving each workspace app one
connection, deleting generic installation identity and resident execution,
keeping external-source mirrors standalone, and rebuilding Tab Manager as one
synchronized web-capture inbox.

## Destination

Users see applications and synchronized data. They do not see a device mesh,
choose a sync engine, keep an Epicenter daemon alive, or address an installation.

```text
workspace-backed app
|
|-- one WorkspaceConnection selected at boot
|   |-- local
|   `-- server(baseURL, principalId, authenticated transports)
|
|-- records
|   |-- local OPFS SQLite
|   `-- HTTP mutation log, cursor, and snapshots
|
|-- KV and child documents
|   |-- local IndexedDB Y.Doc
|   `-- authenticated room WebSocket per active document
|
`-- execution
    |-- catch-up and projections while the app is open
    |-- app-owned sync, status, and foreground watch commands when needed
    |-- human-approved actions in the active app
    `-- explicit cloud job only if a future feature promises unattended work
```

Records and documents share authority, local-first behavior, reconnect signals,
and workspace lifetime. They do not share a made-up universal replication
protocol. HTTP remains the honest records transport. WebSockets remain the
honest Yjs transport.

The destination has five durable decisions:

- [ADR-0142](../docs/adr/0142-workspace-apps-receive-one-connection-while-storage-planes-keep-their-own-protocols.md): one application connection, two private protocols.
- [ADR-0143](../docs/adr/0143-document-synchronization-addresses-rooms-not-installations.md): rooms are addressed; installations are not.
- [ADR-0144](../docs/adr/0144-open-applications-own-local-execution.md): local work has an open process owner, not a generic daemon.
- [ADR-0145](../docs/adr/0145-external-systems-of-record-keep-local-mirrors-outside-epicenter-sync.md): external authorities keep their own disposable mirrors.
- [ADR-0146](../docs/adr/0146-tab-manager-is-a-synchronized-web-capture-inbox.md): Tab Manager owns one synchronized inbox.

## Explicit refusals

- No `NodeId`, installation registry, device presence, peer list, or same-device
  tab deduplication.
- No generic watcher, daemon, mount runtime, process discovery, or background
  automation host.
- No process-oriented status, PID registry, CLI-owned log store, or generic
  stop command. App status describes durable data; the invoking process manager
  owns process lifecycle.
- No universal sync socket and no record CRUD protocol disguised as Yjs.
- No Epicenter replica of Gmail or QuickBooks caches.
- No Tab Manager devices, permanent bookmark twin, tool-trust store, or chat
  history in its first rebuilt version.
- No generic cross-workspace move or atomic promotion claim.
- No compatibility layer for the abandoned data shapes. Each changed durable
  contract starts a new application data version.

## Current contradiction ledger

| Destination | Current evidence | Remaining change |
| --- | --- | --- |
| One app connection | SQLite openers pass `authority`, `fetch`, and `documentSync` separately | Per-app transport assembly and storage-name knowledge |
| Room identity only | `NodeId` crosses workspace, auth projection, server rooms, Bun and Cloudflare backends, CLI, and Tab Manager | Node storage, query parameters, attachment fields, presence protocol, peer APIs, stable Yjs seeding |
| Open-process execution | The generic daemon, mount runtime, root discovery, and CLI process lifecycle are deleted; Local Mail and Local Books own explicit execution | Verify repository-wide imports and docs, then keep the boundary closed |
| External authority | Local Mail and Local Books own standalone SQLite mirrors of Gmail and QuickBooks | Keep future mirror work out of Epicenter replication |
| Web-capture inbox | Tab Manager has devices, saved tabs, bookmarks, tool trust, conversations, and source node fields | Four tables, device registration, device prompts, duplicate saved/bookmark state |

## Target application API

The application-facing boot call is intentionally smaller than the private
runtime implementation:

```ts
const workspace = await openBrowserWorkspace(definition, {
	worker: () => new WorkspaceWorker(),
	connection: toWorkspaceConnection(auth),
});
```

`toWorkspaceConnection(auth)` returns a discriminated local or server value.
The server arm carries the normalized authority plus authenticated fetch,
WebSocket creation, and reconnect notification. The app neither sees nor
constructs `documentSync`, a replica port, room URLs, database names, or a node
identifier.

The runtime may open several physical Yjs WebSockets because each lazy child
document is an independent room. A single physical socket would require a new
multiplexing protocol, reconnection scheduler, and room authorization layer. It
does not simplify the app API further, so it is refused until measurements show
that socket count is a real problem.

## Automation model

The word automation currently hides three different promises:

| Work | Owner | Closed-app behavior |
| --- | --- | --- |
| Deterministic catch-up, projection, or cache refresh | The app, `sync`, or foreground `watch` | Runs on next open, explicit invocation, or an OS-managed schedule |
| Human-approved side effect | The active app | Does not run without the approving session |
| Guaranteed unattended side effect | A future feature-specific cloud job runtime | Not built until a product promises it |

Duplicate execution is solved at the owner that actually needs it. Catch-up is
idempotent or cursor-based. Human-approved work has one active interaction.
A future cloud job would need a durable job ID, atomic claim, lease, idempotency
key, retry policy, and terminal result. A generic local daemon cannot provide a
credible exactly-once promise across crashes and multiple devices, so no such
promise is inferred from keeping a process alive.

For an app that needs command-line monitoring, the contract is explicit:

```text
<app> sync     one pass, then exit
<app> status   durable freshness, cursor, pending work, upstream health
<app> watch    foreground catch-up loop, terminated by Ctrl-C or its supervisor
```

`launchd`, cron, systemd, or another scheduler may invoke `sync` periodically.
A service manager may supervise `watch`. Epicenter does not wrap either choice
in a second process manager.

## Work-back plan

### Wave 1: Rebuild Tab Manager on the destination data shape

Build:

- Declare a new SQLite workspace version with only `webCaptures`.
- Compose browser-owned live-tab actions beside the opened workspace.
- Implement capture, open, and discard against async table handles.

Stop importing:

- Stop booting device profiles and stop reading device constraints.
- Stop using saved-tab, bookmark, tool-trust, and conversation state in the new
  extension surface while the old implementation remains on disk.

Prove:

- Capture offline, reload, reconnect, and observe the capture on another signed-in
  browser.
- Open and discard are explicit, repeatable UI flows.
- The extension starts signed out with a local standalone inbox.

Remove:

- Delete device registration, `sourceNodeId`, the devices table, bookmarks,
  tool trust, conversations, their migrations, prompts, state modules, and dead
  UI.
- Do not migrate old rows. The new data version begins empty; old data remains
  recoverable through its old build or explicit export.

### Wave 2: Rehome useful work and delete the generic resident runtime

Build:

- Move each useful materializer to the app process that owns its source and
  destination, or expose one explicit export command when continuous projection
  is not a product promise.
- Standardize app-owned monitoring as `sync`, `status`, and foreground `watch`.
  `status` reports durable data state, while locks and idempotent cursors handle
  overlapping app, one-shot, and watched sync attempts.
- Keep Local Mail and Local Books on their existing application-specific Bun
  engines. Promote their existing polling loops to explicit `watch` commands
  and confirm no shared workspace package is imported solely for sync or
  mounting.
- Delete the Opensidian mount because it owns no headless action or projection.
  Delete the Tab Manager mount because the extension owns its synchronized
  capture inbox. Whispering remains app-open unless a concrete projection later
  earns an app-owned command.

Stop importing:

- Remove application mount exports and CLI watcher composition while the daemon
  implementation remains on disk.
- Make package and app tests open their concrete runtime directly.

Prove:

- Every surviving projection catches up after its owning app reopens.
- `sync`, `status`, and foreground `watch` work with no generic resident
  process. A second sync attempt yields safely through the app's writer lock.
- Local Mail reads, Gmail-first writes, and one-shot sync work app-closed.
- Local Books reads, live reports, and approved QuickBooks-first writes work
  without Epicenter runtime state.

Remove:

- Delete `packages/workspace/src/daemon`, mount primitives used only by the
  watcher, CLI `up`/`down`/`status`/`logs`, root leases, metadata, logs, daemon
  persistence, and daemon architecture prose.
- Delete `epicenter init` and `epicenter.config.ts` discovery if no non-watcher
  owner remains. Keep generic data and auth commands only when their contracts
  stand independently of a mounted root.
- Delete configuration and skills whose only purpose was generic mount or
  watcher composition.

### Wave 3: Introduce one connection and remove installation identity

Build:

- Add `WorkspaceConnection` and `toWorkspaceConnection(auth)`.
- Make `openBrowserWorkspace` derive `WorkspaceAuthority`, record replication,
  and Yjs room sync internally.
- Change room upgrade and both server backends to identify only principal and
  document guid.
- Keep scoped Super Chat host and attach identifiers inside that product.

Stop importing:

- Move every browser, extension, Tauri, Bun, smoke, example, and test caller to
  the node-less room URL and one connection projection.
- Remove all reads of `collaboration.peers` before deleting the presence
  implementation.

Prove:

- Two browser contexts concurrently edit the same Yjs document and converge.
- A newly opened context catches up after all prior contexts close.
- Records still pass offline mutation, reconnect, push, pull, and snapshot
  recovery through HTTP.
- Hosted and self-host room auth still reject the wrong principal or bearer.
- Super Chat attach still reaches one explicitly selected open host without a
  framework `NodeId`.

Remove:

- Delete `NodeId`, creation and persistence helpers, `?nodeId=`, room attachment
  fields, peer and presence protocols, same-node socket counting, join and leave
  logs, stable client-ID hashing, documentation, and fixtures.
- Delete the split `authority`, `fetch`, and `documentSync` application options
  after all openers use `connection`.

This is a coordinated client and server protocol cutover. Do not carry an
optional `nodeId` compatibility branch. Build the new path and tests first,
switch every in-repo caller in one wave, then delete the old protocol before the
wave lands.

### Wave 4: Finish SQLite application adoption without regrowing old owners

Continue the active
[SQLite workspace application adoption spec](20260714T131232-sqlite-workspace-app-adoption.md),
with these constraints:

- Shared filesystem and skills schemas may migrate, but no new daemon or mount
  adapter is built for them.
- Opensidian and Whispering open through app-owned browser or desktop runtimes.
- The Epicenter host composes application surfaces in process.
- Local Mail, Local Books, and Matter remain outside the workspace migration.
- Legacy Yjs record tables are deleted after all remaining workspace-backed
  apps stop importing them.

## Verification gates

Each wave must be independently reviewable and leave the repository in one
coherent state. Run the narrow package and app checks first, then the repository
gates relevant to the touched wave:

```sh
bun test
bun run typecheck
bun run check:workspace-version-locks
bun run check:doc-paths
bun run check:doc-hygiene
bun run check:licenses
```

The room protocol wave additionally needs hosted and self-host integration
smokes plus an import sweep for `NodeId`, peers, and presence. The Tab Manager
wave needs a real extension smoke in two browser profiles. The resident-runtime
deletion needs an import sweep proving no app or package still references the
generic daemon, mount runtime, or watcher lifecycle.

## Completion criteria

- [ ] Every workspace-backed app passes exactly one `WorkspaceConnection` at
  boot.
- [ ] Records use HTTP replication and Yjs documents use authenticated room
  WebSockets behind that connection.
- [ ] No production or documentation path uses `NodeId`, generic peers, or
  device presence.
- [x] No generic Epicenter process remains meaningful after every app and
  explicit command closes.
- [x] External-authority mirrors do not join Epicenter synchronization.
- [ ] Tab Manager owns one synchronized `webCaptures` collection and no device
  model.
- [ ] All old imports are stopped and verified before their implementations are
  deleted.
- [ ] The five ADRs are accepted as their corresponding code lands,
  and this spec is then deleted.
