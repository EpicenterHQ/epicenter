# SQLite workspace application adoption

**Date**: 2026-07-14
**Status**: In Progress
**Owner**: Epicenter workspace and application owners
**Branch**: `codex/records-epoch-clean-break`

## One Sentence

Each application declares one version-locked SQLite workspace, selects one local
or server authority at boot, and opens it through one runtime composition that
owns the records Worker, KV document, child documents, and synchronization.

## Current State

The SQLite workspace kernel is implemented under
`@epicenter/workspace/sqlite`. It owns version-qualified identity, exact table
schemas, local SQLite replicas, server-ordered synchronization, portable
exports, and reviewed tables apply. The HTTP apply path is covered through the
shared authenticated route and a persistent records authority; the Cloudflare
Durable Object adapter has matching apply coverage.

The first application-shaped browser runtime is now proven:

- Todos imports `@epicenter/workspace/sqlite`, owns one Worker, and commits a
  `workspace-version-lock.json`.
- Browser apps open through one authority-selected runtime. Local and server
  authorities own independent OPFS databases.
- The page owns authenticated HTTP and the Worker receives only a semantic
  record-sync port.
- Shared table owners in `@epicenter/chat`, `@epicenter/filesystem`, and
  `@epicenter/skills` still expose legacy table definitions and child-document
  layouts. The remaining applications still use the legacy Yjs record path.

The old application shape is:

```ts
const model = defineWorkspace({ id, tables, kv, actions });
const workspace = model.connect(connection);

workspace.tables.notes.set(row);
workspace.tables.notes.scan().rows;
```

The new storage shape is:

```ts
const candidate = defineWorkspace({ appId, version, tables, kv });
const definition = lockWorkspace(candidate, versionLock);
const workspace = await openBrowserWorkspace(definition, {
	authority: toWorkspaceAuthority(auth),
	worker: () => new Worker(new URL('./workspace.worker.ts', import.meta.url)),
	fetch: auth.fetch,
});

await workspace.tables.notes.create(cells);
await workspace.tables.notes.list();
```

This is a code and ownership migration, not a storage-engine rename. Records
move from the root Yjs document to an app-owned SQLite worker. KV and child
documents remain Yjs planes composed beside it.

## Target Shape

```text
app definition
|-- appId + version
|-- one fields map per table
|-- KV declarations
`-- committed workspace-version-lock.json
        |
        v
app runtime opener
|-- authority: local | server(baseURL, principalId)
|-- records: app-owned SQLite Worker
|-- sync: semantic ReplicaSyncPort bridge when server-owned
|-- KV: eager version-qualified Y.Doc
|-- documents: lazy version-qualified Y.Doc sessions
`-- app actions and reactive state over async handles
```

Actions remain executable application behavior. They close over the opened
workspace and do not enter the durable version lock. A software release may
change actions without publishing a new workspace version, as long as the
durable table, KV, document, and blob contracts stay unchanged.

Each migrated app has one obvious path. It does not keep a Yjs-record fallback,
dual-write records, read old and new stores at boot, or alias its old workspace
ID to the generated `<appId>-vN` namespace.

## Research Findings

### Kernel adoption gaps

| Gap | Evidence | Consequence |
| --- | --- | --- |
| Remaining composition | The browser records runtime is proven, but no migrated app yet mounts synchronized KV or child documents | The next wave must prove those planes before shared schema owners migrate |
| Nullable export | SQLite definitions use the existing `nullable(...)`, but the SQLite entry point does not export it | A clean app import still needs the legacy root package for schema construction |
| Async records | SQLite tables expose `get`, `list`, `create`, `patch`, `remove`, and `transact` as asynchronous operations | Actions, Svelte state, tests, and event handlers must stop assuming immediate reads after writes |
| Framework-owned IDs | Public `create` allocates a UUID and forbids caller-supplied IDs | Natural-key tables must add a separate field or move to a different plane |
| Shared table owners | Chat, filesystem, and skills definitions are imported by several apps | These packages must migrate before their consumers can migrate cleanly |
| Existing user data | Current app data lives under unversioned Yjs workspace IDs | Historical inspection and export is the default; any forward import is app-owned product work |

### Application inventory

| Owner | Durable shape and runtime | Dependencies or redesign pressure | Recommended wave |
| --- | --- | --- | --- |
| Todos | One table, no KV or documents, browser-only | Async actions and Svelte state | First pilot |
| Wiki | Two tables, app actions, Markdown and SQLite projections | `types.id` is a user-authored slug, so add a separate slug field or justify a lower-level identity door | Second pilot |
| Chat package | Conversation metadata plus keyed-message child documents | Shared by Epicenter, Vocab, and Tab Manager | Shared definition wave |
| Filesystem package | File metadata plus plain-text child documents | Shared by Opensidian; path operations assume synchronous table reads | Shared definition wave |
| Skills package and app | Two tables plus plain-text child documents in browser and Bun runtimes | Dual-runtime serialization and actions assume synchronous tables | Shared definition wave |
| Vocab | Entries, one KV preference, shared conversations and message documents | Needs KV and document composition | Browser composition proof |
| Honeycrisp | Folders, notes, rich-text documents, app action, sign-in migration | `touch: updatedAt` must become an app-owned document observer | Document lifecycle proof |
| Tab Manager | Five tables, shared conversations, extension boot, browser-only actions | Device and tool-trust rows currently use caller-authored IDs | Extension composition proof |
| Whispering | Two tables, roughly forty KV preferences, browser and Tauri runtimes | Largest KV surface; existing recordings make cutover policy high stakes | Late product migration |
| Opensidian | Shared filesystem table, child documents, browser and daemon mounts, materializers | Broadest composition surface and strongest shared-package dependency | Final browser and daemon proof |
| Epicenter host | Shared conversations with Bun-local persistence | Host lifecycle and chat package must already be migrated | Final host adoption |

API, self-host, landing, Local Books, Local Mail, Matter, Reddit, and the
PostHog proxy do not currently own a legacy workspace definition. They are not
part of this migration unless the caller audit finds an indirect dependency.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Identity | 2 coherence | Every app starts from `appId`, `version`, and a committed lock | ADR-0137 owns the deterministic workspace namespace |
| Records API | 1 evidence | App code adopts the async SQLite handles directly | `packages/workspace/src/sqlite/client.ts` is the implemented public runtime contract |
| Actions | 2 coherence | Compose actions after opening the runtime workspace | Executable behavior is not part of a workspace version and the SQLite definition intentionally excludes it |
| Migration order | 1 evidence | Pilot, shared table owners, product apps, old-path deletion | Callers show that chat, filesystem, and skills block several apps |
| Compatibility | 2 coherence | No dual reader, writer, ID alias, or fallback | The accepted clean break and ADR-0137 refuse mixed namespaces |
| Authority | 2 coherence | Select `local` or one `(baseURL, principalId)` server authority once at boot | ADR-0141 makes standalone and replica derived roles and gives each authority one local database |
| Existing data | 2 coherence | Keep historical data inspectable and exportable by default; add no platform importer | ADR-0140 and ADR-0141 keep live-target import application-specific |

## Real Call-Site Translations

### Todos: synchronous action to async action

Before, `todos_create` generates an ID and calls `tables.todos.set(row)`.
After, the opened SQLite workspace owns ID allocation:

```ts
const row = await workspace.tables.todos.create({
	title,
	body,
	dueDate,
	contexts,
	completedAt: null,
	deletedAt: null,
	createdAt: InstantString.now(),
});
return row.id;
```

The action registry must accept asynchronous handlers, and tests must await the
action and all following reads.

### Honeycrisp: child document in the fields map

```ts
const notes = defineTable({
	fields: {
		id: field.string<NoteId>(),
		title: field.string(),
		updatedAt: field.instant(),
		body: field.doc(document.richText),
	},
});
```

The old declaration-level `touch: 'updatedAt'` policy does not move into the
durable format. The Honeycrisp runtime observes local body edits and patches the
row because the application owns the meaning of `updatedAt`.

### Tab Manager: natural key becomes an ordinary field

The `devices` table currently uses the framework node ID as its row ID. Under
framework-owned row IDs, it stores that value separately and queries it:

```ts
const devices = defineTable({
	fields: {
		id: field.string<DeviceRowId>(),
		nodeId: field.string<NodeId>(),
		name: field.string(),
		lastSeen: field.instant(),
		browser: field.string(),
	},
});
```

The same review applies to Wiki type slugs and Tab Manager tool-trust keys.

## Implementation Plan

### Phase 1: Prove one application-shaped runtime

- [x] Export every schema primitive an app needs from the SQLite entry point,
  starting with `nullable`.
- [x] Add `WorkspaceAuthority` and deterministic authority-qualified OPFS
  identity. Use the same identity for cross-tab invalidation.
- [x] Replace the experimental generic fetch bridge with a semantic
  `ReplicaSyncPort` MessagePort bridge. Authenticated fetch stays page-owned.
- [x] Replace the separate browser standalone and replica openers with one
  `openBrowserWorkspace(definition, { authority, ... })` composition and one
  `serveBrowserWorkspaceWorker(...)` app Worker entry point.
- [x] Migrate Todos as the records-only browser pilot with an app-owned Worker,
  one version lock, async actions, reactive state, and end-to-end browser smoke.
- [x] Use the pilot to identify the smallest reusable runtime composition. Do
  not preserve `connect(...)` merely to make the call site look unchanged.
- [x] Prove local reload, synchronized reload, offline mutation, reconnect, and
  workspace-version identity before another app adopts the path.

### Phase 2: Compose the remaining storage planes

- [ ] Add one production KV mount over the version-qualified eager Y.Doc and
  prove hydration precedes default reads.
- [ ] Add one child-document runtime that owns persistence, sync, refcounting,
  and disposal for derived document guids.
- [ ] Move `@epicenter/chat` to SQLite fields and document formats, then update
  its async table and message-store types.
- [ ] Migrate Vocab after Chat to prove tables, KV, and shared conversation
  documents in a browser app.
- [ ] Migrate Honeycrisp to prove rich-text documents and app-owned touch policy.

### Phase 3: Migrate shared schema owners

- [ ] Move `@epicenter/filesystem` to SQLite tables and plain-text documents,
  then make filesystem operations honestly asynchronous.
- [ ] Move `@epicenter/skills` to SQLite tables and document formats across its
  browser and Bun runtimes.
- [ ] Stop exporting legacy table definitions from those packages once all
  package tests and direct consumers use the new definitions.

### Phase 4: Migrate product-specific runtimes

- [ ] Migrate Wiki and resolve its user-authored type slug as an ordinary field.
- [ ] Migrate Tab Manager and resolve device and tool-trust natural keys before
  changing extension boot.
- [ ] Migrate Whispering only after the KV runtime is proven; inventory whether
  recording audio earns `field.blob()` or remains outside workspace ownership.
- [ ] Migrate Opensidian after the filesystem package, covering browser, daemon,
  Markdown export, SQLite projection, and document cleanup.
- [ ] Migrate the Epicenter host after the chat package and Bun composition are
  stable.

### Phase 5: Stop importing and delete the old records path

- [ ] Make every app and shared package stop importing legacy record tables
  while the old implementation remains on disk as a rollback point.
- [ ] Run all app builds, typechecks, tests, browser smokes, extension smoke,
  Tauri smoke, daemon smoke, and hosted or self-host synchronization proof.
- [ ] Delete legacy Yjs record tables, synchronous table adapters, `connect`
  paths that exist only for them, sign-in copy machinery that no surviving flow
  uses, fixtures, examples, and documentation.
- [ ] Run a final import and stale-vocabulary sweep before deleting this spec.

## Existing Data Cutover

Code migration and user-data migration are different decisions. The accepted
platform architecture provides no generic whole-workspace importer and no
mixed-history compatibility path.

Before each shipped app cuts over, apply this default policy:

1. Start the new workspace version empty and keep historical data available for
   inspection and export.
2. Add no generic platform copy into either an absent or live target.
3. If product evidence later requires it, build an app-specific forward import
   through ordinary APIs. That application owns selection, identity collisions,
   review, retry, and partial failure.
4. Delay an app instead of adding a compatibility reader when inspection and
   export do not satisfy its ownership promise.

The migration must not silently read the old Yjs workspace and dual-write into
SQLite. That would recreate the compatibility system this clean break removed.

## Verification Matrix

Every migrated app proves the rows relevant to its runtime:

| Capability | Required proof |
| --- | --- |
| Version lock | Source matches the append-only lock and published entries do not drift |
| Records | Create, patch, remove, SQL query, reload, offline write, and reconnect |
| KV | Hydration before default read, local update, sync, and reload |
| Documents | Derived guid, persistence, sync, concurrent edit, and disposal |
| Blobs | Upload before reference, exact metadata HEAD, export bytes, and unreachable preview |
| Actions | Async success and failure through direct calls and any tool adapter |
| UI | First paint waits for data and reactive views settle after async commits |
| Portability | Complete export opens independently and tables apply reaches exact reviewed state |

Repository completion requires:

```sh
bun test
bun run typecheck
bun run check:workspace-version-locks
bun run check:doc-paths
bun run check:licenses
```

## Open Questions

1. **Which runtime composition becomes shared after the Todos pilot?**
   - Recommendation: share ownership of records Worker creation, KV hydration,
     child-document sessions, and teardown. Keep auth and platform-specific
     resources injected. Do not recreate a legacy-shaped `connect` facade.

2. **Does any product require caller-authored row IDs?**
   - Recommendation: first model natural keys as unique ordinary fields. Reopen
     the framework-owned UUID rule only if a real app cannot express its
     identity or atomicity honestly that way.

3. **Where should application actions be constructed?**
   - Recommendation: a runtime-neutral factory takes the opened async workspace
     and returns the action registry. Environment actions compose beside it in
     the browser, extension, Tauri, or Bun opener.

## Success Criteria

- [ ] Every workspace-backed app has a committed lock and imports only the
  SQLite workspace records path.
- [ ] Shared table packages expose one SQLite definition, not legacy and new
  variants.
- [ ] Every runtime plane has one owner and one tested composition path.
- [ ] Existing-data behavior is explicit for every shipped app.
- [ ] No app uses synchronous Yjs record tables, dual writes, compatibility
  aliases, or fallback readers.
- [ ] The legacy records path is deleted only after the unimported new path
  passes the full verification matrix.

## References

- `docs/adr/0137-applications-declare-one-live-workspace-per-contract-version.md`
- `docs/adr/0138-tables-declare-cells-documents-and-blobs-in-one-field-map.md`
- `docs/adr/0139-portable-workspaces-are-schema-directed-folders-applied-as-forward-mutations.md`
- `docs/adr/0140-portable-ownership-has-no-generic-whole-workspace-import.md`
- `docs/adr/0141-workspace-authority-is-selected-once-and-owns-one-local-database.md`
- `packages/workspace/src/sqlite/definition.ts`
- `packages/workspace/src/sqlite/browser.ts`
- `packages/workspace/src/sqlite/browser-worker.ts`
- `packages/workspace/src/sqlite/open.ts`
- `packages/workspace/src/sqlite/client.ts`
- `packages/svelte-utils/src/sqlite-adapters.test-d.ts`
