# @epicenter/workspace

> Status: the two-plane design below is the Proposed destination in ADRs
> 0144-0147. The current implementation still uses a root Yjs 13 document for
> tables and KV, with per-row room providers. Sections explicitly marked
> "current implementation" describe that transition code, not the final API.

## Proposed destination: one row, two client planes

The workspace keeps one public row identity while giving scalar data and rich
content different storage and synchronization owners:

```txt
workspace.tables.notes
  row(id)                    JSON fields in runtime-native SQLite
  document.open(id)          lazy Yjs 14 document

Browser
  storage owner              OPFS SQLite Worker (scalar rows + document log)
  live documents             page Y.Doc over a load/append seam

Native
  storage owner              native SQLite (scalar rows + document log)
  live documents             Y.Doc over the same load/append seam
```

`RowIntent` carries scalar row and KV changes only. Scalar rows remain bounded,
fully queryable, and available without hydrating any Yjs document. The scalar
replica owns optimistic edits, exact retry, current-state pull, acquisition,
tombstones, and `workspace.sync.settle()`.

Each live row may also own one restricted, lazy `RowDocument`:

```ts
using document = await workspace.tables.notes.document.open(rowId);
await document.whenDurable();
```

The handle exposes application-owned Yjs roots, local durability, reactive
connection status, and disposal. It does not expose provider ownership or a
free-standing room id. The workspace constructs the Yjs 14 document, persists
its update log through the runtime-native provider, and opens one authenticated
connection while that row document is live. Closing the last handle releases
the connection without deleting persisted content.

The two planes are deliberately eventual rather than remotely atomic. A row may
arrive before its document. `workspace.sync` covers scalar work only;
`document.whenDurable()` covers local document persistence only. Export,
Device Add, and recovery coordinate logical scalar and document copies without
claiming one cross-plane snapshot or copying private SQLite state.

Read-only SQL is a first-class scalar surface, not a projection of one giant
in-memory Yjs document. Browser and native runtimes may use different physical
stores while implementing the same workspace contract. Sharing one native
SQLite file is allowed, but it does not imply a cross-plane transaction.

See [ADR-0144](../../docs/adr/0144-scalar-rows-and-row-documents-synchronize-through-independent-client-planes.md),
[ADR-0145](../../docs/adr/0145-one-workspace-authority-owns-scalar-state-and-one-socket-per-open-row-document.md),
[ADR-0146](../../docs/adr/0146-row-documents-use-one-yjs-14-major-and-runtime-native-update-logs.md),
and [ADR-0147](../../docs/adr/0147-cross-plane-transfer-and-recovery-use-logical-coordination-not-atomic-snapshots.md).

## Current implementation during the clean break

A local-first workspace engine for TypeScript apps: Yjs is the source of truth; SQLite and Markdown are read-only materialized projections.

The hard problem with local-first apps is synchronization. If each device has its own SQLite file, how do you keep them in sync? If each device has its own Markdown folder, same question.

`@epicenter/workspace` solves that by making Yjs the source of truth for app-owned state. Tables, KV entries, and document content all live in a `Y.Doc`; persistence, sync, validated actions, and materializers hang off that core as attachment primitives. Write to the workspace, and everything else reacts.

Materializers are for reading. SQLite gives scripts, apps, and agents a fast SQL view. Markdown gives people a file-shaped export for review, git, publishing, or static output. Neither one is the app's mutation API.

```txt
Read path:
  person / script / agent
    -> SQL against the read-only SQLite mirror
    -> Markdown files generated from the workspace

Write path:
  app UI / TanStack AI tool / Bun script
    -> in-process workspace action
    -> live Y.Doc tables, KV, or child content docs
    -> sync peers
    -> SQLite mirror and Markdown export refresh
```

Agents can still edit ordinary project files. They should not patch generated `.md` files to mutate app data. Give them actions instead through an in-process tool catalog or app-specific script. The action writes the Yjs datastore; the materializers write the files back out.

The current center is small:

```txt
defineWorkspace()
  app's shared isomorphic definition: id, tables, kv, actions, child-doc layouts

open<App>Browser()
open<App>Daemon()
open<App>Tauri()
  runtime-specific wiring: storage, sync, materializers, platform services

createWorkspace()
createChildDocs()
satisfiesWorkspace()
  lower-level primitives for package internals, tests, and older ports
```

The app-facing path is `defineWorkspace({ id, tables, kv, actions }).connect(...)`.
`create()` returns only the root document for daemon and test composition. The connection
is the boot decision: `connect(null)` adds bare browser storage, wipe, and
table child-doc openers with no relay; `connect(connection)` adds principal-scoped
browser storage, root sync, wipe, and table child-doc openers.
`connect(connection, compose)` lets a runtime add extras and expose its final
action registry on the workspace bundle.

## Quick Start: local-only workspace

The recipe below ships a workspace with no auth, no cloud
sync. It is the right shape for a single-user desktop notes app, an
offline CLI, a test fixture, or any consumer whose data stays on the
device. Cloud-synced workspaces swap `attachIndexedDb` + `attachBroadcastChannel`
for the principal-scoped `attachLocalStorage` composite; see
[Local-only vs cloud-synced](#local-only-vs-cloud-synced).

```bash
bun add @epicenter/workspace @epicenter/field
```

```typescript
import { field } from '@epicenter/field';
import {
	defineTable,
	defineWorkspace,
} from '@epicenter/workspace';

const posts = defineTable({
	id: field.string(),
	title: field.string(),
	body: field.string(),
	published: field.boolean(),
});

const blogWorkspace = defineWorkspace({
	id: 'epicenter-blog',
	name: 'Blog',
	tables: { posts },
	kv: {},
});

// Singleton style: connect once at module scope, use everywhere.
export const blog = blogWorkspace.connect(null);

async function quickStart() {
	await blog.storage.whenLoaded;

	blog.tables.posts.set({
		id: 'welcome',
		title: 'Hello World',
		body: 'This row lives in the Y.Doc.',
		published: false,
	});

	const { data: row, error } = blog.tables.posts.get('welcome');
	if (!error && row) {
		blog.tables.posts.update(row.id, { published: true });
	}
}

void quickStart;
```

That example uses the current public API end to end:

- `defineTable(...)` with a real schema
- `defineWorkspace(...)` for the shared contract and `connect(null)` for the live local bundle
- a module-scope singleton: `export const blog = blogWorkspace.connect(null)`
- direct property access via `blog.tables.posts`
- `set`, `get`, `update`, `delete`, `scan`, and `observe`

The quick start is local-first: it persists to browser storage and works
offline. Sync is the credentialed arm of the same call. See [Sync](#sync).

Singleton apps (one workspace per app) call `connect(...)` once at module
scope. Browser child documents are declared on tables and opened through
the connected table handle. One-shot Node scripts and daemon projections can
derive the same child-doc guid for one row, read it, and destroy it. See
[Per-row content documents](#per-row-content-documents) below.

## Prefix vocabulary

Every exported function in this package falls into one of three verbs. The prefix tells you what the function *does to state*:

| Verb | Side effect | Input | Output | Examples |
|---|---|---|---|---|
| `define*` | **None**: pure data or type contract | Schemas, defaults, typed bundle values | Plain config object or same value back | `defineTable`, `defineKv`, `defineMutation`, `defineQuery`, `defineWorkspace` |
| `create*` | **Constructs**: bundles, models, registries, or pure definitions | Definitions, options | Disposable bundle or pure value | `createWorkspace` (root bundle: ydoc + tables + kv + empty actions + dispose), `createDisposableCache` (refcounted per-row cache) |
| `attach*` | **Mutates a Y.Doc**: binds a slot, registers `ydoc.on('destroy')` | An existing `Y.Doc` + config (workspace materializers take the bundle from `createWorkspace`) | Typed handle, non-idempotent, hold the reference | `attachRichText`, `attachPlainText`, `attachRecords`, `attachIndexedDb`, `attachLocalStorage`, `attachYjsLog`, `attachBroadcastChannel`, `attachMarkdownExport`, `attachBunSqliteMaterializer` |
| `open*` | **Opens a runtime over a Y.Doc or a local resource**: returns a typed handle with its own teardown. The Y.Doc-bound case (`openCollaboration`) registers `ydoc.on('destroy')` like `attach*` does; the resource case (`openSqliteReader`) takes no Y.Doc and returns a `[Symbol.dispose]()` handle. | Y.Doc + config, or resource config | Typed runtime handle | `openCollaboration`, `openSqliteReader`, `openWorkspaceSqlite` |

`createDisposableCache(build, opts?)` is the refcounted cache primitive. The
user owns construction; the cache owns identity keyed by id,
refcounting, and the `gcTime` grace period between last dispose and teardown.
`.open(id)` returns a disposable handle.

### Local-only vs cloud-synced

Both shapes ship from this package, and the workspace factory is the same for each.

`createWorkspace({ id, tables, kv })` constructs the root Y.Doc, materializes the table and KV stores onto it, and registers cascade disposal. Local-only docs attach `attachIndexedDb`; cloud-synced docs attach the principal-scoped `attachLocalStorage` composite and `openCollaboration`. The relay is trusted and reads plaintext, so there is no client-side encryption to configure.

Apps usually export one pure definition next to their schema. That definition is
the durable contract: workspace id, tables, KV defaults, action registry, and any
per-row child-doc layouts.

```ts
// apps/my-app/workspace.ts
import { field } from '@epicenter/field';
import {
	attachPlainText,
	defineActions,
	defineMutation,
	defineTable,
	defineWorkspace,
} from '@epicenter/workspace';
import { Type } from 'typebox';

const items = defineTable({
	id: field.string(),
	title: field.string(),
	archived: field.boolean(),
}).docs({ body: attachPlainText });

export const myAppWorkspace = defineWorkspace({
	id: 'epicenter.my-app',
	name: 'My App',
	tables: { items },
	kv: {},
	actions: ({ tables }) =>
		defineActions({
			items_archive: defineMutation({
				input: Type.Object({ id: Type.String() }),
				handler: ({ id }) => tables.items.update(id, { archived: true }),
			}),
		}),
});
```

Minimal browser workspace: pick the local or signed-in preset once at boot.

```typescript
import {
	createNodeId,
	type NodeId,
} from '@epicenter/workspace';
import type { SyncAuthClient } from '@epicenter/auth';
import { toConnection } from '@epicenter/svelte/auth';
import { auth } from '$lib/auth';
import { myAppWorkspace } from '$lib/workspace';

export function openMyAppBrowser({
	auth,
	nodeId,
}: {
	auth: SyncAuthClient;
	nodeId: NodeId;
}) {
	return myAppWorkspace.connect(toConnection(auth, nodeId));
}

export const myApp = openMyAppBrowser({
	auth,
	nodeId: createNodeId({ storage: localStorage }),
});
```

`connect(null)` uses bare IndexedDB storage under the doc guid and does not
open relay sync. `connect(connection)` pairs principal-scoped IndexedDB with a
BroadcastChannel, opens root collaboration, wires `wipe()`, and gives each
table handle a `.docs` namespace of row child-doc openers such as
`workspace.tables.items.docs.body.open(itemId)`. Two tabs of the same principal share
both persisted state and live updates, while two different principals on the same
browser profile never see each other's data.

`openCollaboration` remains the lower-level sync primitive behind this opener.
It wraps the sync supervisor, mirrors the relay's server-owned presence channel
as `collaboration.peers`. See [SYNC_ARCHITECTURE.md](./SYNC_ARCHITECTURE.md)
for the full model.

The `id` you pass to `defineWorkspace(...)` becomes `workspace.ydoc.guid` when
you call `.connect(...)`. Namespace it to your app (e.g. `epicenter.my-app`) to
avoid collisions when multiple apps share the same IndexedDB origin. Cloud sync
targets the single uniform shape `/api/rooms/:roomId` in hosted Cloud and
self-hosted instance deployments: build the URL with
`roomWsUrl({ baseURL, guid: workspace.ydoc.guid, nodeId })`. A cloud doc is
partitioned by the authenticated `PrincipalId`, so the server resolves the Durable
Object name `principals/${principalId}/rooms/${room}` from the auth token, with
no workspace lookup.

For production-shaped browser wiring, see
`apps/honeycrisp/src/lib/workspace/browser.ts`. For the boot-time doc selection, see
`apps/honeycrisp/src/lib/application.ts`.

## Core Philosophy

### Yjs is the source of truth

Epicenter keeps the write path brutally simple: the `Y.Doc` is authoritative. Tables and KV are just typed helpers over Yjs collections, and document content is a Yjs timeline. Sync providers, SQLite mirrors, and markdown files are all derived from that core.

That matters because conflict resolution only has to happen once. Yjs handles merge semantics; extensions react to the merged state.

### Definitions are pure; builders are live

`defineTable` and `defineKv` are pure. They do not create a `Y.Doc`, open a
socket, or touch IndexedDB. The opener you call, whether root-only for a daemon
or connected for a browser session, is the boundary where the live bundle
appears.

That split is not cosmetic. It lets you share definitions across modules, infer types once, and instantiate different bundles in different runtimes without rewriting the schema layer.

### Inline composition is the extension system

There is no builder chain. Runtime-specific extras are composed inline in
`connect(connection, compose)`, after principal-scoped local storage and before
collaboration starts:

```typescript
function openBlog(connection: ConnectionConfig) {
	return blogWorkspace.connect(connection, (workspace) => {
		const search = createBlogSearch(workspace.tables.posts);
		const actions = defineActions({
			...workspace.actions,
			posts_search: defineQuery({
				input: Type.Object({ query: Type.String() }),
				handler: ({ query }) => search.query(query),
			}),
		});

		return {
			search,
			actions,
			[Symbol.dispose]() {
				search[Symbol.dispose]();
			},
		};
	});
}
```

Daemon and test paths can use `create()` to compose root-only infrastructure:

```typescript
function openBlogDaemon() {
	const workspace = blogWorkspace.create();
	const collaboration = openCollaboration(workspace.ydoc, {
		url,
		openWebSocket,
		onReconnectSignal,
	});
	return { ...workspace, collaboration };
}
```

Ordering is explicit: root-only `create()` callers choose every attachment, while
browser `connect(connection, compose)` callers receive the base runtime and return
named extras. There is no magic `client.extensions` namespace; each attachment
is whatever you named it in the returned bundle.

### Read-time validation beats write-time ceremony

Tables validate and migrate on read, not on write. `set(...)` writes the row shape TypeScript already approved. `get(...)` returns a wellcrafted `Result<TRow | null, TableParseError>`: parse failures surface as `error`, missing rows as `data: null`, and old versions are migrated to the latest schema before being returned.

That trade-off is deliberate. It keeps the write path cheap and pushes schema evolution into one place: the table definition.

### Storage scales with active data, not edit history

With Yjs garbage collection enabled, storage tracks the live document much more closely than the number of operations that happened over time. Deleted rows, overwritten values, and old content states collapse down to compact metadata. The workspace grows because you keep more data, not because you clicked save a thousand times.

## Architecture Overview

### The Y.Doc: Heart of Every Workspace

Every piece of data lives in a `Y.Doc`, which provides conflict-free merging, real-time collaboration, and offline-first operation:

```
┌─────────────────────────────────────────────────────────────┐
│                      Y.Doc (CRDT)                            │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Y.Array('table:posts')  <- LWW entries per table      │  │
│  │   └── { key: id, val: { fields... }, ts: number }     │  │
│  │                                                        │  │
│  │ Y.Array('table:users')  <- Another table              │  │
│  │   └── { key: id, val: { fields... }, ts: number }     │  │
│  │                                                        │  │
│  │ Y.Array('kv')  <- Settings as LWW entries             │  │
│  │   └── { key: name, val: value, ts: number }           │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘

Note: Schema definitions are stored in static TypeScript modules, not in the Y.Doc.
The Y.Doc carries data. Your definition files carry meaning.
```

### Read and write flow

The main split is source of truth versus projection. Anything that changes app data enters through the workspace. Anything that only needs a fast or human-readable view can read a materialized output.

```txt
Writes:
  UI component
  TanStack AI tool
  Bun script
    -> in-process defineMutation action
      -> Y.Doc tables, KV, or child content docs
        -> sync peers
        -> persistence
        -> SQLite materializer
        -> Markdown materializer

Reads:
  table / KV helpers
    -> Y.Doc

  openSqliteReader
    -> read-only SQLite mirror

  editor, reviewer, publisher, agent
    -> generated Markdown files
```

### Multi-Device Sync Topology

Epicenter supports distributed sync where Y.Doc instances replicate across devices over WebSocket through the relay:

```
   PHONE                   LAPTOP                    DESKTOP
   ┌──────────┐           ┌──────────┐              ┌──────────┐
   │ Browser  │           │ Browser  │              │ Browser  │
   │ Y.Doc    │           │ Y.Doc    │              │ Y.Doc    │
   └────┬─────┘           └────┬─────┘              └────┬─────┘
        │                      │                         │
   (no server)            ┌────▼─────┐              ┌────▼─────┐
        │                 │ Hono     │◄────────────►│ Hono     │
        │                 │ relay    │  server-to-  │ relay    │
        │                 └────┬─────┘    server    └────┬─────┘
        │                      │                         │
        └──────────────────────┴─────────────────────────┘
                           Connect to multiple nodes
```

Yjs supports multiple providers simultaneously. A phone can connect to desktop, laptop, and cloud at the same time; CRDT merge semantics do the rest.

### How It All Fits Together

1. Define tables and KV entries with `defineTable` and `defineKv`.
2. Export a `defineWorkspace({ id, tables, kv, actions })` value beside the schema.
3. For singleton apps: call `definition.connect(null)` once at module scope. For cloud
   browser apps: call `definition.connect(connection)`. For browser child documents:
   declare them with `table.docs(...)` and call `tables.<table>.docs.<field>.open(rowId)`.
   For one-shot Node operations: derive the same child-doc guid and read the room directly.
4. Await the right readiness signal before reading persisted state. The rule is scoped by what kind of bundle you are building:
   - **Opener and runtime bundles expose subsystem readiness.** Expose the subsystem (`storage`, `persistence`, ...) on the bundle root and let consumers reach through: `await bundle.storage.whenLoaded`. Inside this layer, do not alias `whenLoaded`/`whenReady` flat at the bundle root just to save `.storage`.
   - **Two or more subsystems to compose into one barrier.** Then `whenReady` earns its place: `whenReady: Promise.all([persistence.whenLoaded, unlock.whenChecked, sync.whenConnected])`. Because the field is typed `Promise<unknown>`, `Promise.all([...])` is assignable directly. Consumers `await bundle.whenReady`. Migrations, `@epicenter/filesystem` ops, the sqlite-index materializer, and `{#await}` gates in editors all consume this aggregate.
   - **App singletons may expose an app-level `whenReady`.** When one promise is the product-level readiness contract (the load gate, the sign-in migration), an app singleton aliasing `whenReady: storage.whenLoaded` is legitimate: the app owns that contract and its consumers should not care which subsystem backs it.

5. Read and write through `bundle.tables`, `bundle.kv`, and `bundle.collaboration.peers`, and (for per-row content docs) whatever you exposed in the returned bundle.
6. Iterate `Object.entries(bundle.actions)` and read each action's metadata (`type`, `title`, `description`, `input`) if you want to build adapters such as HTTP, CLI, or MCP.
7. Dispose with `bundle[Symbol.dispose]()` for singletons or `handle[Symbol.dispose]()` for cache handles when you're done. Use `cache[Symbol.dispose]()` to flush every live entry.

The architecture stays local-first: the workspace works offline, synchronizes opportunistically, and treats external systems as helpers around the document, not the other way around.

## Shared Workspace ID Convention

Epicenter uses stable, shared workspace IDs so multiple apps can collaborate on the same data.

- Format: `epicenter.<app>`
- Purpose: stable routing, persistence keys, sync room names, and workspace discovery
- Stability: once published, an ID should not change
- Scope: two apps with the same ID are intentionally pointing at the same workspace

The ID becomes `ydoc.guid` for the workspace doc, so it is not a throwaway string. Pick one and keep it.

## Core Concepts

### Workspaces

A workspace is a `Y.Doc` plus whatever `attach*` handles you bound to it,
packaged as a bundle with `{ id, ydoc, [Symbol.dispose], ... }`. A browser
workspace also exposes `wipe()`. A singleton app assigns the bundle to a
module-scope `const`. A document cache returns disposable
handles over child documents keyed by row id.

### Yjs document

The raw `Y.Doc` is available at `bundle.ydoc`. That is the escape hatch, not the primary API. Most consumers should stay at the typed-helper layer unless they are writing a new attachment or debugging storage internals.

### Tables

Tables are versioned row collections. Each row must declare:

- `id: string`

`_v` is library-managed: never declare it as a column, never include it in
write calls, never expect it on returned rows. The library stamps the
current version on write and strips it before handing the row back.

At runtime, each table becomes a `Table` exposed as a direct property:

- `bundle.tables.posts.set(row)`
- `bundle.tables.posts.get(id)`
- `bundle.tables.posts.update(id, partial)`
- `bundle.tables.posts.delete(id)`

Table access is direct property access in the current API.

### KV

KV entries are for settings and scalar preferences. They are keyed by string and always return a valid value because invalid or missing data falls back to the definition's default.

- `bundle.kv.get('theme.mode')`
- `bundle.kv.set('theme.mode', 'dark')`
- `bundle.kv.observe('theme.mode', ...)`

### Attachments (the extension system)

"Extensions" in Epicenter are just `attach*` calls inside your builder or runtime composer. There is no `.withExtension` chain, no extension registry, no priority flag: just lexical scope.

- Call the relevant `attach*` or `open*` function inside `create()` daemon composition or `connect(connection, compose)` browser composition, then include the handle in the returned bundle.
- Order matters only through lexical scope: later `attach*` calls see earlier handles directly.
- For browser per-row content docs, declare a child-doc layout on the table and open it from the connected table handle. Daemon projections can use the same guid grammar to read one doc snapshot.

### Actions

Actions are callable functions with metadata.

- `defineQuery(...)` creates a read action
- `defineMutation(...)` creates a write action
- Include isomorphic actions in `defineWorkspace({ actions })`. Runtime-specific actions belong in `connect(connection, compose)`, where the final registry is exposed on the workspace bundle. `defineActions` enforces snake_case ASCII keys at compile time and runtime; consumers index by string or iterate with `Object.entries`.

Handlers close over `tables`, `kv`, and anything else the builder has in scope through normal JavaScript closure. They do not receive a framework context object.

### Per-row content documents

For browser apps where each row has its own rich-text, plain-text, or timeline
content (files, notes, skills, entries), declare that content on the table:
`.docs({ body: attachPlainText })`. The root workspace holds metadata rows;
`definition.connect(connection)` owns live per-row content identity, refcounting,
storage, sync, and wipe.

Each `.open(rowId)` returns a handle. Multiple consumers (editor, actions,
route transitions) can share one underlying Y.Doc safely; the cache owns
construction, refcounting, and `gcTime`-delayed teardown through the lower-level
cache primitive.

```svelte
<script lang="ts">
  import { workspace } from '$lib/session';

  let { fileId }: { fileId: string } = $props();

  const handle = workspace.tables.files.docs.content.open(fileId);
  $effect(() => () => handle[Symbol.dispose]());
</script>

{#await handle.whenLoaded}
  <Loading />
{:then}
  <Editor ytext={handle.binding} />
{/await}
```

Each `.open(rowId)` returns a disposable handle. Multiple consumers can open the
same row and share one underlying Y.Doc safely; the workspace-owned cache handles
construction, refcounting, and `gcTime`-delayed teardown.

Reference implementations: `apps/opensidian/opensidian.browser.ts` and
`apps/honeycrisp/src/lib/workspace/browser.ts`.

## Schema definition

### Required table fields

Every table row schema must declare an `id` column. Version metadata (`_v`)
is library-managed: never declare it as a column, never pass it to `set` or
`update`, never expect it on returned rows. The library stamps the current
version on write, routes by it on read, and strips it before handing the row
back.

Columns are TypeBox-native. Use the `field.*` builders from
`@epicenter/field` (`field.string`, `field.number`, `field.boolean`,
`field.datetime`, `field.select`, `field.json`, ...) plus the standalone
`nullable(...)` wrapper from `@epicenter/workspace` for intentional emptiness,
or pass raw `Type.*` schemas if you need a shape the helpers don't cover. The
library enforces 1:1 SQLite-column mapping at the type level either way.

### Single-version tables

```typescript
import { field } from '@epicenter/field';
import { defineTable } from '@epicenter/workspace';

const users = defineTable({
	id: field.string(),
	email: field.string(),
	name: field.string(),
});

void users;
```

Use the single-schema form when the table has only one version today.

### Versioned tables

```typescript
import { field } from '@epicenter/field';
import { defineTable } from '@epicenter/workspace';

const posts = defineTable(
	{
		id: field.string(),
		title: field.string(),
	},
	{
		id: field.string(),
		title: field.string(),
		slug: field.string(),
	},
).migrate(({ value, version }) => {
	switch (version) {
		case 1:
			return {
				...value,
				slug: value.title.toLowerCase().replaceAll(' ', '-'),
			};
		case 2:
			return value;
	}
});

void posts;
```

Migration runs on read. The migrate function receives `{ value, version }`
where `value` is the user-facing row for that version (no `_v`); `version`
is the 1-indexed position in the variadic argument list. Old rows stay old
in storage until you rewrite them.

### KV entries

```typescript
import { field } from '@epicenter/field';
import { defineKv } from '@epicenter/workspace';

const themeMode = defineKv(
	field.select(['light', 'dark', 'system']),
	() => 'light' as const,
);
const sidebarWidth = defineKv(field.number(), () => 280);
const sidebarCollapsed = defineKv(field.boolean(), () => false);

void themeMode;
void sidebarWidth;
void sidebarCollapsed;
```

KV is validate-or-default. The default argument is a factory (`() => value`),
not a bare value, so each consumer gets a fresh instance. There is no
migration function.

### Presence

Presence (which installs are connected right now) is not a client-defined
schema. The relay owns it: it tracks live WebSocket connections and, on every
connection change, pushes one `presence` text frame carrying the full list of
connected installs. `openCollaboration` stores the latest list and exposes it
as `collaboration.peers`:

```typescript
const online = workspace.collaboration.peers.list();
// -> [{ nodeId: 'phone' }, { nodeId: 'laptop' }]

const unsubscribe = workspace.collaboration.peers.subscribe((peers) => {
	console.log('online:', peers.map((peer) => peer.nodeId));
});
```

Each entry is a `Peer` (`{ nodeId, connectedAt, agentId? }`);
the local install is excluded. Product-level data (display name, cursor, capability list)
lives in app-owned tables, not on the presence wire. See
[SYNC_ARCHITECTURE.md](./SYNC_ARCHITECTURE.md) for the full model.

Cursor and selection sync (genuine ephemeral peer-to-peer state) is future
work; when it lands it will use a dedicated awareness primitive, kept
separate from this server-owned presence channel.

### Document-backed tables

Per-row content (one Y.Doc per file/note/entry) is declared on the table and
opened from the connected table handle. The root workspace holds the metadata
row; `connect(connection)` owns live content Y.Docs, local storage, sync, and wipe.
The workspace owns guid derivation: every `.docs.<field>` exposes
`guid(rowId)`, available on the unconnected root too, so a daemon one-shot
reader derives the same guid with `workspace.tables.files.docs.content.guid(id)`
when it needs an HTTP snapshot.

```typescript
import { field } from '@epicenter/field';
import {
	attachPlainText,
	type ConnectionConfig,
	defineTable,
	defineWorkspace,
	onLocalUpdate,
} from '@epicenter/workspace';

const files = defineTable({
	id: field.string(),
	name: field.string(),
	updatedAt: field.number(),
}).docs({ content: attachPlainText });

export const filesWorkspace = defineWorkspace({
	id: 'epicenter.files',
	name: 'Files',
	tables: { files },
	kv: {},
});

export function openFilesBrowser(connection: ConnectionConfig) {
	return filesWorkspace.connect(connection);
}

async function documentExample(connection: ConnectionConfig) {
	using workspace = openFilesBrowser(connection);
	workspace.tables.files.set({
		id: 'file-1',
		name: 'hello.md',
		updatedAt: Date.now(),
	});

	// Load a content handle for the row. Dispose when done.
	using handle = workspace.tables.files.docs.content.open('file-1');
	await handle.whenLoaded;
	const offLocalUpdate = onLocalUpdate(handle.ydoc, () => {
		workspace.tables.files.update('file-1', { updatedAt: Date.now() });
	});

	try {
		handle.write('# Hello from a document');
		console.log(handle.read());
	} finally {
		offLocalUpdate();
	}
}

void documentExample;
```

Opens are refcounted: multiple browser callers (editor, filesystem actions,
previews) can `.open(fileId)` concurrently and share one Y.Doc. The workspace
cache tears the child doc down `gcTime` after the last handle disposes. The
default is `5_000` ms.

## Table Operations

All table operations live on direct properties such as `bundle.tables.posts`.

### Write operations

`set(row)` inserts or replaces a whole row.

```typescript
workspace.tables.posts.set({
	id: 'post-1',
	title: 'First post',
	published: false,
});

workspace.tables.posts.set({
	id: 'post-1',
	title: 'First post, replaced',
	published: true,
});
```

### Update operations

`update(id, partial)` reads the row, merges the partial fields, validates the merged result, and writes it back.

Returns a wellcrafted `Result<TRow | null, TableParseError>`:

- `{ data: TRow, error: null }` on success
- `{ data: null, error: null }` when no row exists for `id`
- `{ data: null, error: TableParseError }` if the stored row failed schema validation, or if the merged result fails validation

```typescript
const { data: row, error } = workspace.tables.posts.update('post-1', {
	published: true,
	views: 1,
});

if (error) {
	console.error(error.message);
} else if (row) {
	console.log(row.views);
}
```

### Read operations

| Method | Return type | Notes |
| --- | --- | --- |
| `get(id)` | `Result<TRow \| null, TableReadError>` | `data: null` for "not found"; `error` for a parse failure or a newer-writer row |
| `scan()` | `TableScan<TRow>` | Classified read: `{ rows, nonconforming, newerWriter }`; the three buckets sum to `storedCount()` |
| `findValid(predicate)` | `TRow \| undefined` | First valid match |
| `has(id)` | `boolean` | Existence only |
| `storedCount()` | `number` | Counts every stored row |

```typescript
const { data: row, error } = workspace.tables.posts.get('1');
if (error) {
	console.error('parse failed:', error.message);
} else if (row) {
	console.log(row.title);
}

const { rows, nonconforming, newerWriter } = workspace.tables.posts.scan();
const published = rows.filter((row) => row.published);
const firstPublished = workspace.tables.posts.findValid((row) => row.published);
const hasPostTwo = workspace.tables.posts.has('2');
const count = workspace.tables.posts.storedCount();
```

### Delete operations

| Method | Behavior |
| --- | --- |
| `delete(id)` | Deletes one row; missing IDs are a silent no-op |
| `clear()` | Deletes all rows in the table |

```typescript
workspace.tables.tags.set({ id: 'tag-1', name: 'important' });
workspace.tables.tags.delete('tag-1');
workspace.tables.tags.clear();
```

### Reactive updates

`observe(callback)` reports a set of changed IDs and the optional Yjs transaction origin. Use `table.get(id)` inside the callback to see whether the row now exists.

```typescript
const unsubscribe = workspace.tables.files.observe((changedIds, origin) => {
	for (const id of changedIds) {
		const { data: row, error } = workspace.tables.files.get(id);
		if (error) {
			console.error('parse failed:', id, error.message);
			continue;
		}
		if (row === null) {
			console.log('deleted:', id);
			continue;
		}
		console.log('present:', row.name);
	}
});

workspace.tables.files.set({ id: 'file-1', name: 'notes.md' });
workspace.tables.files.delete('file-1');
unsubscribe();
```

The `origin` argument is whatever the caller passed to `ydoc.transact(fn, origin)`: or `null` for a direct mutation. Treat it as an opt-in channel for callers that want to tag their own writes:

```typescript
const APP_ORIGIN = Symbol('my-app');

ydoc.transact(() => {
	workspace.tables.posts.set({ id: 'p1', title: 'Tagged' });
}, APP_ORIGIN);

workspace.tables.posts.observe((_ids, origin) => {
	if (origin === APP_ORIGIN) return; // ignore my own echoes
});
```

For the common case of "react only to local edits, not to sync/IDB replays," use `onLocalUpdate(ydoc, fn)`: it filters on Yjs's own `transaction.local` invariant and doesn't depend on origin conventions.

## Attachments

Attachments are the opt-in capabilities you compose inside a builder. Browser-safe attachments ship from the package root. Node and Bun-only attachments use explicit subpaths.

```typescript
import {
	attachBroadcastChannel,
	attachIndexedDb,
	createWorkspace,
	openCollaboration,
	roomWsUrl,
} from '@epicenter/workspace';
import { attachYjsLog } from '@epicenter/workspace/node';
```

### Persistence

Browser apps use `attachIndexedDb(ydoc)` for unauthenticated docs, or `attachLocalStorage(ydoc, { server, principalId })` for an authenticated workspace that needs principal-scoped persistence plus cross-tab pairing. Bun/Node daemons use `attachYjsLog(ydoc, { filePath })`. All bind to the Y.Doc and tear down on `ydoc.destroy()`.

| Primitive | Runtime | Barrier | Other | Purpose |
|---|---|---|---|---|
| `attachIndexedDb(ydoc)` | browser | `whenLoaded`, `whenDisposed` | `clearLocal()` | Local Yjs persistence via `y-indexeddb` |
| `attachLocalStorage(ydoc, { server, principalId })` | browser | `whenLoaded`, `whenDisposed` | paired BroadcastChannel | Principal-scoped IDB plus cross-tab pairing |
| `attachYjsLog(ydoc, { filePath })` | Bun/Node | `whenDisposed` (sync replay; no `whenLoaded` needed) | `clearLocal()` | Append-log SQLite file the daemon writes |

For authenticated apps, call `await wipeLocalStorage({ server, principalId })` after disposing the bundle to delete every principal-scoped IDB database on the current browser profile (sign-out, "delete my local data", account switch).

`attachBunSqliteMaterializer` and `attachMarkdownExport` are not persistence: they project workspace rows into queryable SQLite tables or `.md` files. They are read surfaces, not write surfaces. Maintenance methods such as `rebuild()` and `search()` maintain or query the projection; app data mutations stay in app-defined actions. See the materializer subsections below.

```typescript
import { field } from '@epicenter/field';
import {
	createWorkspace,
	defineTable,
} from '@epicenter/workspace';
import { attachYjsLog } from '@epicenter/workspace/node';

const notes = defineTable({
	id: field.string(),
	title: field.string(),
});

function openNotes() {
	const workspace = createWorkspace({
		id: 'epicenter.notes',
		tables: { notes },
		kv: {},
	});
	const yjsLog = attachYjsLog(workspace.ydoc, {
		filePath: '/tmp/epicenter/notes.db',
	});

	return { ...workspace, yjsLog };
}

void openNotes;
```

### Sync

One primitive wraps the WebSocket transport: `openCollaboration`. Actions live on the workspace bundle; collaboration is sync and presence only. Compose it with `attachBroadcastChannel(ydoc)` for unauthenticated local-only documents. Authenticated browser workspaces use `attachLocalStorage(ydoc, { server, principalId })`, which pairs principal-scoped IDB with a principal-scoped BroadcastChannel in one call.

```typescript
import { field } from '@epicenter/field';
import {
	attachLocalStorage,
	createNodeId,
	createWorkspace,
	defineTable,
	openCollaboration,
	roomWsUrl,
} from '@epicenter/workspace';
import type { AuthClient } from '@epicenter/auth';
import type { PrincipalId } from '@epicenter/identity';

const tabs = defineTable({
	id: field.string(),
	url: field.string(),
});

function openTabs({
	principalId,
	openWebSocket,
	onReconnectSignal,
}: {
	principalId: PrincipalId;
	openWebSocket: AuthClient['openWebSocket'];
	onReconnectSignal: AuthClient['onStateChange'];
}) {
	const workspace = createWorkspace({
		id: 'epicenter.tabs',
		tables: { tabs },
		kv: {},
	});
	const baseURL = 'https://api.epicenter.so';
	const idb = attachLocalStorage(workspace.ydoc, {
		server: new URL(baseURL).host,
		principalId,
	});
	const nodeId = createNodeId({ storage: localStorage });
	const collaboration = openCollaboration(workspace.ydoc, {
		url: roomWsUrl({
			baseURL,
			guid: workspace.ydoc.guid,
			nodeId,
		}),
		waitFor: idb.whenLoaded,
		openWebSocket,
		onReconnectSignal,
	});

	return { ...workspace, idb, collaboration };
}

void openTabs;
```

Ordering is just lexical: `collaboration` reads `idb.whenLoaded` as `waitFor` because `idb` is defined first. No builder chain, no priority flag.

### Markdown seam: read-only export

Markdown comes from one seam, `attachMarkdownExport` (in `@epicenter/workspace/document/materializer/markdown`): a continuous, one-way Yjs to disk projection with free serialization (custom `filename`, `toMarkdown`, per-table `dir`). It exposes a single `rebuild()` method for a destructive full re-export (orphan cleanup after a filename or layout change); there is no import path.

The projection is read-only on purpose. The materialized `.md` is never read back into Yjs, so it carries no round-trip obligation and can shape the output however a human-readable export or a published site wants. App data mutates through validated in-process actions, never by editing the materialized files. If an app needs Markdown as the authoring format, that parser/editor belongs in an app action or UI surface that writes Yjs. This export is not that path. The SQLite materializer is the read-only sibling for a relational projection.

```typescript
import { field } from '@epicenter/field';
import {
	createWorkspace,
	defineTable,
} from '@epicenter/workspace';
import { attachYjsLog } from '@epicenter/workspace/node';
import { attachMarkdownExport } from '@epicenter/workspace/document/materializer/markdown';

const notes = defineTable({
	id: field.string(),
	title: field.string(),
	body: field.string(),
});

function openNotes() {
	const workspace = createWorkspace({
		id: 'epicenter.notes',
		tables: { notes },
		kv: {},
	});
	const yjsLog = attachYjsLog(workspace.ydoc, {
		filePath: '/tmp/epicenter/notes-workspace.db',
	});
	const markdown = attachMarkdownExport(workspace, {
		dir: '/tmp/epicenter/markdown',
		tables: { notes: {} },
	});

	return { ...workspace, yjsLog, markdown };
}

void openNotes;
```

### SQLite materializer

The SQLite materializer is exported from `@epicenter/workspace/document/materializer/sqlite`. It mirrors every table in the workspace bundle into queryable SQLite tables with optional FTS5 full-text search. Pass the workspace directly; use the keyed `fts` slot to opt specific columns into FTS5.

Treat the mirror as a read-only SQL projection. Scripts open it with `openSqliteReader`, which sets `PRAGMA query_only = ON`; app writes go through an in-process action or app-specific command so the live Y.Doc stays authoritative and the mirror catches up from the same source as every other projection.

```typescript
import { field } from '@epicenter/field';
import {
	createWorkspace,
	defineTable,
} from '@epicenter/workspace';
import { attachBunSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';

const posts = defineTable({
	id: field.string(),
	title: field.string(),
	body: field.string(),
	published: field.boolean(),
});

function openBlog() {
	const workspace = createWorkspace({
		id: 'epicenter-blog',
		tables: { posts },
		kv: {},
	});
	const mirror = attachBunSqliteMaterializer(workspace, {
		filePath: '/tmp/epicenter/blog.db',
		fts: { posts: ['title', 'body'] },
	});

	return { ...workspace, mirror };
}

// After mirror.whenFlushed:
// blog.mirror.search('posts', 'hello');
// blog.mirror.rebuild('posts');
void openBlog;
```

The Bun SQLite materializer owns the daemon's queryable SQLite mirror file. When you pass `fts: {...}`, the result exposes `search(...)`; omit `fts` and `search` is undefined.

## Workspace Dependencies

Workspaces depend on each other the normal way: regular imports.

There is no special dependency graph inside the workspace package. If one action needs another workspace, import the other workspace bundle or factory and call it directly.

```typescript
import Type from 'typebox';
import { defineMutation } from '@epicenter/workspace';

declare const authWorkspace: {
	actions: {
		users_get_by_id: (input: { id: string }) => { id: string; name: string } | null;
	};
};

declare const blogWorkspace: {
	tables: {
		posts: {
			set: (row: {
				id: string;
				title: string;
				authorId: string;
			}) => void;
		};
	};
};

const createPost = defineMutation({
	title: 'Create Post',
	description: 'Create a post for an existing author.',
	input: Type.Object({
		id: Type.String(),
		title: Type.String(),
		authorId: Type.String(),
	}),
	handler: ({ id, title, authorId }) => {
		const author = authWorkspace.actions.users_get_by_id({ id: authorId });
		if (!author) return null;

		blogWorkspace.tables.posts.set({
			id,
			title,
			authorId,
		});

		return { id };
	},
});

void createPost;
```

That example uses `declare` stubs so the snippet compiles on its own, but the real pattern is just plain module composition.

## Actions

Actions are the current abstraction for developer-facing operations.

They have four important properties:

1. They are callable functions.
2. They carry metadata (`type`, `title`, `description`, `input`).
3. They close over `tables`, `kv`, and friends by normal JavaScript closure.
4. They are exposed on the bundle returned from your builder (typically as `actions: defineActions({ ... })`, a flat registry keyed by snake_case ASCII strings).

### Query actions

Use `defineQuery(...)` for reads.

```typescript
import { field } from '@epicenter/field';
import Type from 'typebox';
import {
	createWorkspace,
	defineActions,
	defineQuery,
	defineTable,
	defineWorkspace,
} from '@epicenter/workspace';

const posts = defineTable({
	id: field.string(),
	title: field.string(),
	published: field.boolean(),
});

function openPosts() {
	const workspace = createWorkspace({
		id: 'epicenter.actions.queries',
		tables: { posts },
		kv: {},
	});

	return defineWorkspace({
		...workspace,
		actions: defineActions({
			posts_list: defineQuery({
				title: 'List Posts',
				description: 'List all posts.',
				handler: () => workspace.tables.posts.scan().rows,
			}),
			posts_get_by_id: defineQuery({
				title: 'Get Post',
				description: 'Get one post by ID.',
				input: Type.Object({ id: workspace.tables.posts.schema.properties.id }),
				handler: ({ id }) => workspace.tables.posts.get(id),
			}),
		}),
		[Symbol.dispose]() {
			workspace[Symbol.dispose]();
		},
	});
}

const workspace = openPosts();
const actionType = workspace.actions.posts_list.type;
void actionType;
```

### Mutation actions

Use `defineMutation(...)` for writes or side effects.

```typescript
import { field } from '@epicenter/field';
import Type from 'typebox';
import {
	createWorkspace,
	defineActions,
	defineMutation,
	defineTable,
	defineWorkspace,
	generateId,
} from '@epicenter/workspace';

const posts = defineTable({
	id: field.string(),
	title: field.string(),
	published: field.boolean(),
});

function openPosts() {
	const workspace = createWorkspace({
		id: 'epicenter.actions.mutations',
		tables: { posts },
		kv: {},
	});

	return defineWorkspace({
		...workspace,
		actions: defineActions({
			posts_create: defineMutation({
				title: 'Create Post',
				description: 'Create a new post row.',
				input: Type.Object({
					title: workspace.tables.posts.schema.properties.title,
				}),
				handler: ({ title }) => {
					const id = generateId();
					workspace.tables.posts.set({ id, title, published: false });
					return { id };
				},
			}),
			posts_publish: defineMutation({
				title: 'Publish Post',
				description: 'Mark a post as published.',
				input: Type.Object({ id: Type.String() }),
				handler: ({ id }) =>
					workspace.tables.posts.update(id, { published: true }),
			}),
		}),
		[Symbol.dispose]() {
			workspace[Symbol.dispose]();
		},
	});
}

void openPosts;
```

### Input validation

Action inputs are TypeBox. `defineQuery` and `defineMutation` are typed around `typebox` `TSchema` inputs:

```typescript
import Type from 'typebox';
import { defineQuery } from '@epicenter/workspace';

const searchPosts = defineQuery({
	title: 'Search Posts',
	description: 'Search posts by query string.',
	input: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) }),
	handler: ({ query, limit }) => ({ query, limit: limit ?? 10 }),
});

void searchPosts;
```

No-input actions are just as valid:

```typescript
import { defineMutation } from '@epicenter/workspace';

const clearCache = defineMutation({
	title: 'Clear Cache',
	description: 'Clear a local cache.',
	handler: () => {
		return { cleared: true };
	},
});

void clearCache;
```

### Action properties

Every action exposes:

- `action.type`: `'query'` or `'mutation'`
- `action.title`: optional UI-facing label
- `action.description`: optional adapter-facing description
- `action.input`: optional TypeBox schema

And the action itself is callable. There is no separate `.handler` property on the returned object.

### Action iteration

```typescript
import Type from 'typebox';
import {
	defineActions,
	defineMutation,
	defineQuery,
} from '@epicenter/workspace';

const actions = defineActions({
	posts_list: defineQuery({ handler: () => [] as string[] }),
	posts_create: defineMutation({
		input: Type.Object({ title: Type.String() }),
		handler: ({ title }) => ({ title }),
	}),
});

for (const [key, action] of Object.entries(actions)) {
	console.log(key, action.type);
}

const listAction = actions.posts_list;
if (listAction.type === 'query') {
	console.log(listAction.type);
}

const createAction = actions.posts_create;
if (createAction.type === 'mutation') {
	console.log(createAction.type);
}
```

## Package entry points

All attachments, schema definitions, and the `createDisposableCache` primitive
live at the package root. The only
subpath exports keep runtime-specific and heavier surfaces out of the root
browser-safe entry point.

| Import path | What it exports | Public today |
| --- | --- | --- |
| `@epicenter/workspace` | `createDisposableCache`, `defineTable`, `defineKv`, browser-safe `attach*` (tables, kv, indexeddb, broadcast-channel, rich-text, plain-text, timeline), `openCollaboration`, `roomWsUrl`, action helpers, `onLocalUpdate`, `docGuid`, ids, dates, types | Yes |
| `@epicenter/workspace/node` | Bun/Node `attach*` and `open*` (`attachYjsLog`, `attachYjsLogReader`, `openSqliteReader`, `openWorkspaceSqlite`), Epicenter root discovery (`findEpicenterRoot`), workspace paths | Yes |
| `@epicenter/workspace/document/materializer/markdown` | `attachMarkdownExport`, `attachGitAutosave`, `MarkdownShape` | Yes |
| `@epicenter/workspace/document/materializer/sqlite` | `attachBunSqliteMaterializer`, `generateDdl`, types | Yes |

## Architecture & Lifecycle

### Singleton vs factory

Two composition shapes, one builder contract.

**Singleton**: one workspace per app, instantiated at module scope:

```
┌──────────────────────────────────────────────────────────┐
│ const appWorkspace = defineWorkspace({                    │
│     id: 'epicenter.my-app',                               │
│     tables: { ... },                                      │
│     kv: {},                                               │
│     actions: ({ tables }) => defineActions({ ... }),      │
│ });                                                       │
│ export const workspace = appWorkspace.connect(null);         │
└──────────────────────────────────────────────────────────┘
```

**Browser child docs**: table-declared child documents, keyed by row id:

```typescript
const files = defineTable({
	id: field.string(),
	name: field.string(),
}).docs({ content: attachPlainText });

const filesWorkspace = defineWorkspace({
	id: 'epicenter.files',
	tables: { files },
	kv: {},
});

declare const connection: ConnectionConfig | null;
const workspace = filesWorkspace.connect(connection);

using handle = workspace.tables.files.docs.content.open('file-1');
await handle.whenLoaded;
```

The table declaration names the child-doc shape. The connected preset owns the
live cache, local storage, optional sync, and wipe.

### `batch(fn)`

A `batch(fn)` helper groups mutations into a single Yjs transaction. The framework doesn't inject it: include it in your bundle (`batch: (fn) => ydoc.transact(fn)`), which is what every app in this repo does.

```typescript
workspace.batch(() => {
	workspace.tables.posts.set({ id: 'p1', title: 'One transaction' });
	workspace.tables.tags.set({ id: 't1', name: 'docs' });
});
```

Yjs transactions do not roll back on throw. They batch notifications; they are not SQL transactions.

### Readiness, `clearLocal`, and teardown

| API | What it means |
| --- | --- |
| `bundle.storage.whenLoaded` (or `bundle.sqlite.whenLoaded`) | Direct subsystem readiness; the default form |
| `bundle.whenReady` | Optional: an aggregate of 2+ subsystem signals via `Promise.all([...])`, or an app singleton's product-level readiness contract |
| `bundle.storage.clearLocal()` (or `bundle.sqlite.clearLocal()`) | Wipes persisted local state for that attachment |
| `bundle[Symbol.dispose]()` | Singleton teardown: your builder calls `ydoc.destroy()` |
| `handle[Symbol.dispose]()` | Cache handle: decrements refcount; last dispose arms `gcTime` |
| `cache[Symbol.dispose]()` | Flushes every cached entry immediately |

Disposal preserves data: it releases the handle. To wipe persisted local state, call `clearLocal()` on the persistence attachment (`bundle.storage` or `bundle.sqlite`) directly.

### Cleanup lifecycle (cache)

```
┌─────────────────────────────────────────────────────────────┐
│ handle[Symbol.dispose]() called (or `using` block exits)   │
│    refcount--                                              │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ refcount === 0: arm gcTime timer                           │
│    • fresh open() during grace window cancels teardown     │
│    • gcTime: 0 tears down immediately                      │
│    • gcTime: Infinity never auto-evicts                    │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ bundle[Symbol.dispose]() fires                             │
│    • your builder's teardown (ydoc.destroy())              │
│    • ydoc.destroy() cascades to every attachment via       │
│      ydoc.on('destroy'): providers close, observers       │
│      stop, sockets shut down                               │
└─────────────────────────────────────────────────────────────┘
```

`cache[Symbol.dispose]()` is synchronous and does **not** wait for async attachment cleanup (IDB `db.close()`, WebSocket onclose) to settle. If a caller needs a real teardown barrier (close-then-reopen in tests, process exit), await a specific attachment-level field:

```ts
cache[Symbol.dispose]();
await handle.storage.whenDisposed;
```

## Client vs Server

`@epicenter/workspace` is the core client/workspace library. The public root export does not currently ship a built-in server helper.

What the package does give you is the raw material a server adapter needs:

- `bundle.actions` (the typed `ActionRegistry` owned by the workspace bundle)
- `defineActions(actions)` to author a flat snake_case registry
- action metadata fields (`type`, `title`, `description`, and `input`) for
  adapters that need a discovery surface
- iterate with `Object.entries(actions)`
- direct access to `bundle.tables`, `bundle.kv`, `bundle.collaboration.peers`, and per-row content factories

If you want HTTP, CLI, or MCP on top, build or import an adapter around those primitives.

## API Reference

### Schema definition

```typescript
import { defineKv, defineTable } from '@epicenter/workspace';
```

- `defineTable(schema)`
- `defineTable(v1, v2, ...).migrate(fn)`
- `defineKv(schema, defaultValue)`

### Document creation

```typescript
import { createDisposableCache } from '@epicenter/workspace';
```

`createDisposableCache(build, { gcTime? })` returns a refcounted id cache.
`.open(id)` mints a live handle by shallow-spreading the bundle your builder
returned, so `ydoc`, `content`, `idb`, and any composed `whenReady` are all
things you explicitly put in the bundle.

For singleton apps, connect once at module scope. For Node
one-shot operations and daemon row projections, call the child builder directly
inside `using`. Use the cache when browser components have a real same-process
reuse invariant.

### Typical bundle properties

Everything below is a *convention*: the builder is free to expose more or less. Most epicenter apps return at least:

- `id` (as `get id() { return ydoc.guid; }`)
- `ydoc`
- `tables`
- `kv`
- `storage` (or `sqlite`)
- `collaboration` (from `openCollaboration`)
- `actions`
- `batch(fn)`
- `whenReady` (an aggregate of 2+ subsystem signals, or an app singleton's product-level readiness contract; runtime bundles otherwise leave consumers on `storage.whenLoaded`)
- `[Symbol.dispose]()`

### Document content attachments

Per-row content is just another `attach*` call inside a child document builder.
Pick the attachment that matches the content shape:

- `attachPlainText(ydoc, name)`: binds a `Y.Text` at `getText(name)`. Returns `{ binding, read, write, appendText }`: feed `binding` to a CodeMirror/Monaco Yjs extension, `read()`/`write()`/`appendText()` for programmatic access. This is the file-body layout (opensidian's Markdown source lives here; ADR-0107).
- `attachRecords(ydoc, name)`: binds a keyed last-write-wins store of whole JSON records, one per id (the shape an agent transcript uses). Bundle field is a `RecordsHandle<T>` with `get / set / delete / entries / observe`.
- `attachRichText(ydoc, name)`: binds a `Y.XmlFragment` for prosemirror / tiptap / yrs-xml editors.

The connected table child opener stores these by `rowId`, so multiple browser
consumers share one Y.Doc. Use `workspace.tables.<table>.docs.<field>.open(id)` and
`handle[Symbol.dispose]()` to manage lifecycle.

### Local-update filter

`onLocalUpdate(ydoc, fn)` registers an `afterTransaction` listener filtered on Yjs's `transaction.local` invariant: `true` for direct mutations, `false` for updates applied via `Y.applyUpdate` (sync transports, IndexedDB replay, broadcast channel). Empty transactions are skipped. Use this to bump a parent row's `updatedAt` when its content doc is edited locally:

```typescript
onLocalUpdate(ydoc, () => {
	workspace.tables.files.update(fileId, { updatedAt: Date.now() });
});
```

### Actions

```typescript
import {
	defineActions,
	defineMutation,
	defineQuery,
	type Action,
	type ActionRegistry,
} from '@epicenter/workspace';
```

### Table operations

```typescript
import {
	type BaseRow,
	type InferTableRow,
	type Table,
	type TableDefinition,
	TableParseError,
	type TableScan,
	type Tables,
} from '@epicenter/workspace';
```

Public table methods:

- `parse(id, input)`
- `set(row)`
- `update(id, partial)`
- `get(id)`
- `scan()` (returns the three classified buckets)
- `findValid(predicate)`
- `delete(id)`
- `clear()`
- `observe(callback)`
- `storedCount()`
- `has(id)`

### KV operations

```typescript
import {
	type InferKvValue,
	type Kv,
	type KvChange,
	type KvDefinition,
} from '@epicenter/workspace';
```

Public KV methods:

- `get(key)`
- `set(key, value)`
- `delete(key)`
- `observe(key, callback)`
- `observeAll(callback)`

### Presence

```typescript
import {
	type Collaboration,
	type Peer,
} from '@epicenter/workspace';
```

`openCollaboration` returns a `Collaboration`. Online peers are relay-owned presence rows with each peer's `nodeId`, `connectedAt`, and optional `agentId`. Actions live on the workspace bundle, not the collaboration handle:

- `collaboration.peers.list()`: `Peer[]`, the local install excluded
- `collaboration.peers.subscribe(fn)`: returns an unsubscribe function

### Introspection

`Object.entries(actions)` lets you iterate the flat registry. Combined with each action's `type`, `title`, `description`, and `input` schema, that is enough to build HTTP, CLI, or MCP adapters without coupling the core package to a transport.

### IDs and dates

```typescript
import {
	DateTimeString,
	generateGuid,
	generateId,
	type DateIsoString,
	type Guid,
	type Id,
	type TimezoneId,
} from '@epicenter/workspace';
```

### Storage keys

```typescript
import {
	KV_KEY,
	TableKey,
	type KvKey,
} from '@epicenter/workspace';
```

These matter when you are writing low-level tooling against raw Yjs structures.

## AI, CLI, and MCP Integration

The core package does not export an MCP server or own every adapter. What it does export is the action surface those adapters need:

- actions with `type`, `title`, `description`, and `input`
- `Object.entries(actions)` to iterate the flat registry
- `@epicenter/workspace/agent`: `createLocalToolCatalog(...)` for local action tools

That is enough to expose workspace actions over HTTP, CLI, TanStack AI, or MCP without coupling the core package to one transport.

For AI editing, expose workspace mutations as tools. `createLocalToolCatalog(...)` does not teach the model to patch the materialized Markdown folder. It wires tool calls to the same action handlers the UI uses. Query tools can read data; mutation tools write Yjs. The agent loop runs queries unattended by default, asks before mutations, and denies gated mutations when no approval prompt is wired.

### Setup

```typescript
import Type from 'typebox';
import {
	defineActions,
	defineMutation,
	defineQuery,
} from '@epicenter/workspace';

const actions = defineActions({
	posts_list: defineQuery({
		title: 'List Posts',
		description: 'List all posts.',
		handler: () => [] as Array<{ id: string; title: string }>,
	}),
	posts_create: defineMutation({
		title: 'Create Post',
		description: 'Create a post.',
		input: Type.Object({ title: Type.String() }),
		handler: ({ title }) => ({ id: title.toLowerCase() }),
	}),
});

for (const [key, action] of Object.entries(actions)) {
	console.log({
		name: key,
		type: action.type,
		title: action.title,
		description: action.description,
		hasInput: action.input !== undefined,
	});
}
```

That is the public adapter surface today.

## Contributing

### Local development

From the repo root:

```bash
bun install
```

Type-check the workspace package itself:

```bash
bun run typecheck
```

### Running tests

From the repo root:

```bash
bun test packages/workspace
```

## Related Packages

If your app's data model is inherently files and folders: a code editor, a note vault with nested directories, anything where users expect `mkdir` and path resolution: [`@epicenter/filesystem`](../filesystem) builds that abstraction on top of this package. It imports `defineTable` to create a `filesTable`, wraps workspace tables and documents into POSIX-style operations (`writeFile`, `mv`, `rm`, `stat`), and plugs into the same extension system.

Most apps won't need it. If you know the shape of every record upfront, workspace tables are the right default. See [Your Data Is Probably a Table, Not a File](../../docs/articles/your-data-is-probably-a-table-not-a-file.md) for the full decision matrix.

## License

MIT
