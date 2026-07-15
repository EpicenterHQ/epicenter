# Primitive API (`@epicenter/workspace`)

## When To Read This

Read when a change drops below the app-facing workspace definition into raw
document composition: package internals, tests, older ports, custom runtimes,
materializers, or standalone Y.Docs that are not declared as table child docs.

For normal app work, start with:

```txt
defineTable() / defineKv()
  -> table.docs(...) when a row owns rich/plain/collaborative content
  -> defineWorkspace({ id, name, tables, kv, actions })
  -> workspaceDefinition.connect(connection | null)
```

Use `createWorkspace(...)`, manual `new Y.Doc(...)`, and `createDisposableCache`
only when that higher-level path is not the owner.

## App-Facing Shape

The current app-facing API is `defineWorkspace(...)`. It is pure: no Y.Doc, no
IndexedDB, no socket, no daemon. It declares the durable sync contract.

```typescript
import { field } from '@epicenter/field';
import {
	attachPlainText,
	defineTable,
	defineWorkspace,
} from '@epicenter/workspace';

const filesTable = defineTable({
	id: field.string<FileId>(),
	name: field.string(),
	updatedAt: field.instant(),
}).docs({
	content: {
		layout: attachPlainText,
		touch: 'updatedAt',
	},
});

export const filesWorkspace = defineWorkspace({
	id: 'epicenter-files',
	name: 'files',
	tables: { files: filesTable },
	kv: {},
});
```

`workspaceDefinition.connect(connection | null)` creates the live browser/local
runtime. Connected tables expose row child-doc handles through the table path:

```typescript
using workspace = filesWorkspace.connect(connection);
using handle = workspace.tables.files.docs.content.open(fileId);

await handle.whenLoaded;
handle.write('hello');
```

The workspace owns child-doc guid derivation. If you need the guid for a
one-shot Node reader or a wipe/migration path, use the public table accessor:

```typescript
const guid = workspace.tables.files.docs.content.guid(fileId);
```

Do not import or compute `docGuid` in app code. It is an internal derivation
detail.

## Low-Level Root: `createWorkspace`

`createWorkspace({ id, tables, kv })` constructs the root Y.Doc bundle directly:
`{ ydoc, tables, kv, actions, [Symbol.dispose] }`. Use it for package internals,
tests, and older ports that have not moved to `defineWorkspace(...)`.

```typescript
import { createWorkspace } from '@epicenter/workspace';

using workspace = createWorkspace({
	id: 'test',
	tables: { files: filesTable },
	kv: {},
});

workspace.tables.files.set({
	id: fileId,
	name: 'notes.md',
	updatedAt: InstantString.now(),
});
```

The bundle owns the root Y.Doc and cascades disposal through every table/KV
store when `workspace[Symbol.dispose]()` calls `ydoc.destroy()`.

Materializers take the workspace bundle because they need table/KV metadata.
Persistence, broadcast, IndexedDB, Yjs-log, and collaboration primitives take
`workspace.ydoc`.

## Attach Helpers

Each `attach*` helper takes a `Y.Doc`, mutates it by binding a slot or listener,
and registers cleanup through the doc lifecycle. Hold the returned handle; do
not call the same attachment twice for the same slot.

| Helper | Returns |
|---|---|
| `attachIndexedDb(ydoc)` | `{ whenLoaded, clearLocal, whenDisposed }` |
| `attachLocalStorage(ydoc, scope)` | principal or guid scoped local storage attachment |
| `openCollaboration(ydoc, config)` | `{ whenConnected, status, onStatusChange, reconnect, whenDisposed, peers }` |
| `attachRichText(ydoc)` | `{ read, write, binding: Y.XmlFragment }` |
| `attachPlainText(ydoc)` | `{ read, write, binding: Y.Text }` |
| `attachRecords<T>(ydoc)` | keyed record store over `YKeyValueLww` |

`openCollaboration`'s `waitFor` gates the first connection attempt on another
promise, usually local storage's `whenLoaded`, so the first sync handshake
exchanges only the missing delta.

```typescript
const root = createWorkspace({ id: 'test', tables, kv: {} });
const storage = attachIndexedDb(root.ydoc);
const collaboration = openCollaboration(root.ydoc, {
	url: roomWsUrl({ baseURL, guid: root.ydoc.guid }),
	openWebSocket,
	onReconnectSignal,
	waitFor: storage.whenLoaded,
});
```

`attach*` is not idempotent. Calling an attachment twice against the same
Y.Doc/slot installs duplicate observers or duplicate persistence. One attach
site, one handle, one owner.

## Readiness Signals

Expose what the subsystem actually knows.

```txt
storage.whenLoaded          local persisted state is in memory
collaboration.whenConnected first relay sync handshake finished
handle.whenLoaded           child doc local storage is in memory
whenReady                   optional aggregate when a bundle composes 2+ signals
```

Do not create a flat `whenReady: storage.whenLoaded` alias. A bundle-level
`whenReady` earns its place only when it composes multiple barriers:

```typescript
return {
	workspace,
	browserState,
	whenReady: Promise.all([
		workspace.storage.whenLoaded,
		browserState.whenReady,
	]),
};
```

If a caller needs teardown certainty, await the specific attachment barrier:

```typescript
workspace[Symbol.dispose]();
await workspace.storage.whenDisposed;
```

## Standalone Or Fan-Out Docs

Most row-owned content should use `table.docs(...)`. Reach for a manual
`new Y.Doc(...)` plus `createDisposableCache(...)` only when the doc is not a
table child doc or the package is implementing the workspace machinery itself.

```typescript
import { attachPlainText, createDisposableCache } from '@epicenter/workspace';
import * as Y from 'yjs';

export const scratchDocs = createDisposableCache((id: string) => {
	const ydoc = new Y.Doc({ guid: `scratch.${id}`, gc: true });
	const text = attachPlainText(ydoc);

	return {
		ydoc,
		text,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
});
```

For table-owned content, the correct shape is shorter and keeps identity inside
the workspace:

```typescript
using handle = workspace.tables.files.docs.content.open(fileId);
await handle.whenLoaded;
handle.write('hello');
```

## Anti-Patterns

```typescript
// Bad: app code re-derives child-doc identity.
const ydoc = new Y.Doc({
	guid: `${workspace.ydoc.guid}.files.${fileId}.content`,
});

// Good: the table child-doc accessor owns identity.
using handle = workspace.tables.files.docs.content.open(fileId);
```

```typescript
// Bad: reach through the doc to grab a raw shared type.
const text = handle.ydoc.getText('content');

// Good: use the attachment API.
handle.write('hello');
handle.binding; // editor binding when the attachment exposes one
```

```typescript
// Bad: leave runtime docs on implicit Yjs defaults.
new Y.Doc({ guid });

// Good: runtime docs collect deleted structs unless an exception is explicit.
new Y.Doc({ guid, gc: true });
```

## Code References

- `packages/workspace/src/document/workspace.ts`: `defineWorkspace`,
  `connect(...)`, and low-level `createWorkspace`.
- `packages/workspace/src/document/table.ts`: `defineTable`, `_v`, migrations,
  and `table.docs(...)`.
- `packages/workspace/src/document/connect-doc.ts`: storage plus collaboration
  wiring for a connected Y.Doc.
- `packages/workspace/src/cache/disposable-cache.ts`: refcounted cache
  primitive.
- `packages/workspace/src/document/attach-indexed-db.ts`: browser persistence
  attachment.
- `packages/workspace/src/document/open-collaboration.ts`: sync, presence, and
  peers.
- `docs/adr/0005-child-docs-are-bound-through-the-workspace.md`: why child-doc
  identity lives on the workspace path.
