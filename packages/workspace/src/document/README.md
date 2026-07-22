# Workspace Document API

> Transition note: this page describes the current production Yjs-record path.
> The greenfield model is `@epicenter/workspace/sqlite`, where SQLite owns
> rows and every ordinary row owns one lazy document with application-owned
> roots (ADR-0130, ADR-0135); tables declare fields only.

A typed interface over Y.js for apps that need to evolve their data schema over time.

## The Idea

This is a wrapper around Y.js that handles schema versioning. Local-first apps can't run migration scripts, so data has to evolve gracefully. Old data coexists with new. The Workspace API bakes that into the design: define your schemas once with versions, write a migration function, and everything else is typed.

The pattern: `defineWorkspace({ id, tables, kv, actions })` declares the shared isomorphic model. `definition.create()` builds the unconnected root doc for daemon composition. `definition.connect(connection | null)` creates the runtime with local storage, optional sync, wipe, and table child-doc openers. `definition.connect(connection, compose)` lets a runtime add extras and expose its final action registry on the workspace bundle; `definition.connect(null, { persistence, compose })` additionally injects a non-browser local persistence environment (the options object is only accepted on the local arm). `createWorkspace({ id, tables, kv })` and `satisfiesWorkspace(...)` remain lower-level primitives for internals, tests, and ports that have not moved to definitions yet.

```
+----------------------------------------------------------------+
| Your App                                                       |
+----------------------------------------------------------------+
| defineWorkspace(...): shared definition                        |
| open<App>Browser/Daemon/Tauri(): runtime attachments              |
+----------------------------------------------------------------+
| defineWorkspace({ id, tables, kv, actions }).connect(...)         |
|   -> { ydoc, tables, kv, actions, child-doc openers, ... }     |
| attachIndexedDb / attachYjsLog / attachBroadcastChannel        |
| attachLocalStorage(ydoc, { server, principalId })  // scoped IDB + scoped BC |
| wipeLocalStorage({ server, principalId })           // delete local data      |
| openCollaboration (sync + presence)                            |
| attachBunSqliteMaterializer / attachMarkdownExport             |
+----------------------------------------------------------------+
| Y.Doc (raw CRDT)                                               |
+----------------------------------------------------------------+
```

## The Pattern: define vs create vs open vs attach

Three prefixes, each with a consistent meaning:

- **`define*`** is pure: no Y.Doc, no side effects. Schemas, KV definitions, action factories, and app workspace definitions.
- **`create*`** constructs a model, registry, or cache. `createWorkspace` creates the low-level Y.Doc bundle for internals and tests.
- **`open*`** constructs or receives a model and attaches runtime lifecycle: browser storage, daemon sync, SQLite readers, or Tauri services.
- **`attach*`** binds a capability to an existing `Y.Doc` (or, in one documented cross-package case, to a sibling attachment). Side-effectful: registers observers or destroy listeners at call time. Returns a typed handle.

See `.agents/skills/attach-primitive/SKILL.md` for the full contract (shape, invariants, barrier naming).

```typescript
import { field } from '@epicenter/field';
import { defineTable, defineWorkspace } from '@epicenter/workspace';

// Pure schema. `_v` is library-managed: never declare it as a column.
const postsTable = defineTable({
  id: field.string(),
  title: field.string(),
});

const blogWorkspace = defineWorkspace({
  id: 'blog',
  name: 'Blog',
  tables: { posts: postsTable },
  kv: {},
});

using workspace = blogWorkspace.connect(null);
workspace.tables.posts.set({ id: '1', title: 'Hello' });
```

## Composing More

The definition owns schema and isomorphic actions. Runtime openers decide whether
to open only the root doc or attach browser storage, sync, and runtime extras.

### Persistence + collaboration

Auth belongs to the app. The browser opener reads the persisted auth state
once through `toConnection`, which projects signed-out to `null` and signed-in
to the owner's connection plus `nodeId`:

```typescript
import type { SyncAuthClient } from '@epicenter/auth';
import { toConnection } from '@epicenter/svelte/auth';
import type { NodeId } from '@epicenter/workspace';

function openBlog({
  auth,
  nodeId,
}: {
  auth: SyncAuthClient;
  nodeId: NodeId;
}) {
  return blogWorkspace.connect(toConnection(auth, nodeId));
}
```

`connect(null)` derives bare browser storage and BroadcastChannel keys from each
doc guid, unless the caller injects another local persistence environment with
`connect(null, { persistence })`. `connect(connection)` derives principal-scoped
keys from `baseURL`, `principalId`, and each doc guid. `wipe()` deletes the
databases or local log files for the active arm in one call: no explicit guid
list to maintain.

Actions live on the workspace bundle. Collaboration is sync and presence only,
so content documents (rich-text bodies, attachments) use the same collaboration
primitive without an empty `actions: {}` registry.

### Per-row content documents

Tables stay lean (ids, titles, metadata). Rich content lives in table-declared
child docs: `.docs({ body: attachRichText })`. The opener derives each doc
guid from the workspace id, table name, row id, and field; rows do not store
those guids. Browser runtimes use `tables.notes.docs.body.open(noteId)` when a
surface needs the content doc. Daemon projections can derive the same guid,
read one doc for one row, and destroy it.
See `apps/honeycrisp/src/lib/workspace/browser.ts` for the current browser-side
child doc pattern. No shipped daemon currently projects rich-text child docs.

## Design Decisions

**Row-level atomicity.** `set()` replaces the entire row. No field-level updates. Every write is a complete row in the latest schema.

**Migration on read, not on write.** Old data transforms when loaded, not when written. Old rows stay old in storage until explicitly rewritten.

**No write validation.** Writes aren't validated at runtime. TypeScript ensures shape; reads validate and return invalid on corruption.

**No field-level observation.** Observe entire tables or KV keys. Let your UI framework handle field reactivity.

**One classified read, no valid-only default.** Tables expose a single bulk read, `scan()`, that resolves every stored entry into one of three buckets (`rows`, `nonconforming`, `newerWriter`) and returns them grouped. There is no `getAllValid()` that hands back only the conforming rows: a valid-only default is the silent-drop footgun, since the default call path then hides the issue states. `scan().rows` keeps the conforming payload one property access away while putting the dropped buckets at the same call site, where a caller can log, surface, or deliberately ignore them. `findValid(p)` survives the cut because it short-circuits; point reads (`get`, `has`) stay separate as O(1) probes. See `docs/adr/0001-classified-scan-read-surface.md`.

**Stored entries reconcile to three visible states.** Every stored entry is exactly one of conforming, nonconforming, or newer-writer, and `storedCount()` equals the sum of the three `scan()` buckets. The store exposes one iterator, `entries()`, that yields every stored entry as `{ key, val }`, so `scan()` partitions the store in one walk and no row can sit in storage invisible to every read. A write over a newer-writer row is refused because a stale binary must not clobber a row it cannot read. See `docs/adr/0003-three-read-states-after-encryption-removal.md`.

**Why `_v` instead of `v`.** The library-managed version field uses a framework metadata prefix, the same convention as `_id` in MongoDB. Users never declare or read `_v`; the library stamps it on every write and strips it on every read. The underscore makes the reserved key visually distinct in storage dumps.

## Testing

Tests live in `*.test.ts` next to the implementation. Use `createWorkspace({ id: 'test', tables, kv: {} })` for in-memory tests; `using workspace = ...` cascades disposal of every store. Migrations are validated by reading old data and checking the result.

## Canonical references

- `apps/whispering/src/lib/whispering/whispering.tauri.ts`: IndexedDB + BroadcastChannel + recording markdown export
- `apps/honeycrisp/src/lib/workspace/browser.ts`: IndexedDB + sync + per-row child docs
- `packages/workspace/README.md`: quick start
- `packages/workspace/SYNC_ARCHITECTURE.md`: multi-node sync design
