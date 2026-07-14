---
name: workspace-app-composition
description: 'Compose or migrate an Epicenter workspace-backed app around a version-locked SQLite contract, one authority-selected browser opener, an app-owned Worker, hydrated KV, lazy child documents, async actions, and first-paint readiness. Use when creating or changing apps/* workspace definitions, browser or Tauri openers, workspace-version-lock.json, workspace.worker.ts, app singletons, or legacy connect(toConnection(...)) and sign-in migration paths.'
metadata:
  author: epicenter
  version: '7.0'
---

# Workspace App Composition

New application work uses the versioned SQLite workspace path. Some unmigrated
apps still call `connect(toConnection(...))`; treat that as a deletion target,
not a template.

## One Runtime Shape

```text
pure table and KV vocabulary
        |
        v
defineWorkspace({ appId, version, tables, kv })
        |
        v
lockWorkspace(candidate, workspace-version-lock.json)
        |
        v
openBrowserWorkspace(definition, { authority, worker, ...auth transport })
        |
        +-- SQLite records in the app-owned Worker
        +-- eager authority-qualified KV document
        `-- lazy authority-qualified child-document sessions
```

The app selects `local` or `server(baseURL, principalId)` once at boot. A
principal change reloads the app. Never swap storage in place, dual-read an old
workspace, or add a generic sign-in copy.

## Files

Flat apps such as Vocab use:

```text
apps/<app>/
|-- <app>.ts                         pure tables, row types, KV definitions
|-- <app>.browser.ts                 async browser factory
|-- workspace-version-lock.json     append-only durable contract
|-- src/versions/v1/
|   |-- workspace.ts                exports only workspaceCandidate
|   |-- definition.ts               lockWorkspace(...)
|   `-- workspace.worker.ts         serveBrowserWorkspaceWorker(...)
`-- src/lib/<app>.ts                one side-effectful singleton
```

Nested multi-platform apps keep the same ownership under
`src/lib/workspace/`. `#platform/*` remains the build-time seam for auth and
native resources. Do not fork the durable definition by platform.

## Definition Rules

- Import schema builders from `@epicenter/workspace/sqlite`.
- Put cells, `field.doc(format)`, and `field.blob()` in one `fields` map.
- Let `table.create()` allocate row IDs. Natural keys are ordinary fields.
- Keep actions out of `defineWorkspace`; build them over the opened async
  workspace.
- The candidate module must export only `workspaceCandidate` so the lock checker
  can load it.
- Add `check:workspace-version-lock` and `workspace-version-lock` package scripts.

## Browser Factory

`open<App>Browser` is async. It projects auth once with
`toWorkspaceAuthority(auth)` and calls `openBrowserWorkspace` in one of two
branches:

```ts
const authority = toWorkspaceAuthority(auth);
const common = {
	worker: () => new WorkspaceWorker(),
	onObserverError: reportError,
};

if (authority.kind === 'server') {
	return openBrowserWorkspace(definition, {
		...common,
		authority,
		fetch: auth.fetch,
		documentSync: {
			nodeId,
			openWebSocket: auth.openWebSocket,
			onReconnectSignal: auth.onStateChange,
		},
	});
}
return openBrowserWorkspace(definition, { ...common, authority });
```

The opener owns KV hydration, IndexedDB, BroadcastChannel, document
refcounting, room sync, and teardown. Do not pass caller-built KV mounts or
document caches.

## Application State

- Use `fromTable(asyncTable)` and await its `whenReady` before first paint.
- Treat table reads and writes as async. Handle rejected event-driven writes
  with the app's error sink.
- Use `fromKv` only after the browser opener resolves; the first read is then
  hydrated.
- Open child documents through `table.docs.<field>.open(rowId)`, await
  `whenReady`, and dispose the returned lease.
- Product metadata derived from document edits is application policy. Observe
  local updates and patch the row; do not add `touch` to the durable format.
- Compose the app singleton once with top-level `await open<App>Browser(...)`.

## Existing Data

The new workspace version starts independently. Historical data remains an
inspection and export concern. Do not wire `createSignInMigration`, whole-store
copy, dual writes, or fallback reads into the platform runtime. A future
product-specific importer must use ordinary forward APIs and own review,
identity collisions, retry, and partial failure.

## Verification

For each migrated browser app, run:

```sh
bun run check:workspace-version-lock
bun test
bun run typecheck
bun run build
bun run smoke
```

The smoke should reload real browser storage and prove each plane the app uses:
OPFS records, KV IndexedDB, and derived child-document IndexedDB.
