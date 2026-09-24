# idb's README Is the Canonical "Await in Every Method" Example

The most prominent example I can think of for the "store a promise, await it in every method" pattern is [idb](https://github.com/jakearchibald/idb), Jake Archibald's IndexedDB wrapper. It's the very first usage example in the README:

```typescript
import { openDB } from 'idb';

const dbPromise = openDB('keyval-store', 1, {
	upgrade(db) {
		db.createObjectStore('keyval');
	},
});

export async function get(key) {
	return (await dbPromise).get('keyval', key);
}
export async function set(key, val) {
	return (await dbPromise).put('keyval', val, key);
}
export async function del(key) {
	return (await dbPromise).delete('keyval', key);
}
```

`openDB` calls `indexedDB.open()` immediately. The connection starts in the background the moment this module loads. Every exported function awaits the same promise, so the first caller waits for the connection and every subsequent caller gets the already-resolved value for the cost of one microtick.

## Why this works so well for IndexedDB

IndexedDB has two properties that make this pattern natural. First, opening a database is async: it might trigger schema upgrades, wait for other tabs to close old connections, or simply take time to read from disk. You can't make `openDB` synchronous. Second, every operation on the database is also async. So every method already returns a promise; awaiting the shared connection does not change the asynchronous public contract.

```typescript
// Without the pattern: getter function ceremony at every call site
const db = await getDb();
const result = await db.get('store', key);

// With the pattern: one-liner, db access is internal
const result = await get(key);
```

The consumer never touches the database connection. They call `get(key)` and get a value back. The connection management is an implementation detail that the promise encapsulates completely.

## A blob store can hide its connection promise

This simplified historical example shows the connection pattern, not the current Epicenter blob contract. Construction is synchronous; every method awaits the connection promise internally:

```typescript
export function createIndexedDbBlobStore({ dbName, storeName }): BlobStore {
	const dbPromise = openDB(dbName, 1, {
		upgrade(db) {
			if (!db.objectStoreNames.contains(storeName)) {
				db.createObjectStore(storeName, { keyPath: 'id' });
			}
		},
	});

	return {
		async get(id) {
			const db = await dbPromise;
			const record = await db.get(storeName, id);
			if (!record) return null;
			return { blob: new Blob([record.arrayBuffer], { type: record.mimeType }), mimeType: record.mimeType };
		},
		async put(id, blob, mimeType) {
			const db = await dbPromise;
			const arrayBuffer = await blob.arrayBuffer();
			await db.put(storeName, { id, arrayBuffer, mimeType });
		},
		// ...
	};
}
```

The returned object is synchronously constructed and can be passed around, stored in a variable, even exported from a module. The async database connection is invisible to consumers.

## The relationship to sync construction with `whenReady`

This is a sibling of the [sync construction, async property pattern](./sync-construction-async-property-ui-render-gate-pattern.md). Both solve the same problem: async initialization that you don't want to leak into every consumer. The difference is where you wait.

| Pattern | Where you wait | Good for |
|---|---|---|
| `whenReady` at root | Once, in the UI layout | Clients with mix of sync and async methods |
| Await in every method | Implicitly, in each method | Purely async APIs like database access |

idb's pattern works because every IndexedDB operation is already async. There's no sync method that would need the connection to be ready before it runs. If your client has sync methods that depend on initialized state, the `whenReady` pattern is the better fit. If every method is async anyway, hiding the `await` inside each method is simpler and means consumers don't need to think about readiness at all.

## Export the app now and render its consumers after readiness

The three files make the ordering visible. `createLocalApp` below is a
hypothetical synchronous factory: it returns one stable object, starts loading,
and exposes `ready`, a promise that fulfills only after initialization succeeds.
The example assumes a client-only application with one app instance; component
imports for `Loading`, `OpenFailure`, and `Recordings` are omitted.

```ts
// app.ts: hypothetical API
export const app = createLocalApp();
```

```svelte
<!-- Parent.svelte -->
<script>
  import { app } from './app';
</script>

{#await app.ready}
  <Loading />
{:then}
  <Recordings />
{:catch error}
  <OpenFailure {error} />
{/await}
```

```svelte
<!-- Recordings.svelte -->
<script>
  import { app } from './app';

  // Runs when this component is instantiated, after app.ready resolves.
  const recordings = app.tables.recordings;
</script>
```

The parent can render while loading continues. The child does not exist until
success, so its ordinary instance `<script>` cannot read the tables prematurely.
It runs before the child's DOM is mounted, but after readiness. No queue or
repeated readiness check is needed for calls made through this gated subtree.
The gate guarantees initial readiness, not that every later read or write succeeds.

## Top-level await works, but puts the wait in the module graph

An async factory can export a singleton in an environment that supports
top-level await. The difference is where its consumers wait:

```ts
// Alternative app.ts: hypothetical async factory
export const app = await openLocalApp();
```

A module that statically imports this `app` waits for the dependency to finish
evaluating. If the parent statically imports it, that parent cannot render its
own pending branch during the wait. Another already-running shell could still
show loading, or dynamically import the module. Top-level await does not block
all JavaScript or make singletons impossible. [JavaScript await](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/await)

Exporting the promise is another valid choice. It preserves module-level
singleton construction without blocking the importing parent's evaluation:

```ts
// Alternative app.ts: hypothetical async factory
export const opening = openLocalApp();
```

The parent can use `{#await opening}` and pass the resolved app to its children.
An async factory does not force every child to await. Choose the synchronous
object plus `ready` when gated children should import that same object directly;
choose a promise of a ready value when the parent should select and distribute
an instance. Both can wait once at the UI boundary. [Svelte await blocks](https://svelte.dev/docs/svelte/await)

## The gate delays component initialization, not imported modules

A top-level statement in an ordinary component `<script>` runs when that
component is instantiated. A top-level statement in an imported `.ts` module,
or in `<script module>`, has a different lifetime. Those modules can evaluate
before the gate opens. [Svelte component scripts](https://svelte.dev/docs/svelte/svelte-files)

```ts
// recording-actions.ts: premature module-level read
import { app } from './app';
const recordings = app.tables.recordings;
```

Move the read into the call if this module serves gated components:

```ts
// recording-actions.ts
import { app } from './app';

export function createRecording(input) {
  // Safe with respect to readiness when called by the gated subtree.
  return app.tables.recordings.create(input);
}
```

Every component that requires initialized data must enter through the gate.
Background tasks and other module-level callers need their own ordering. A
promise that resolves a `Result` must be checked for success in `{:then}`;
fulfillment alone can carry an error Result. The example above instead uses a
promise that rejects on initialization failure.

Imports and props preserve object identity; neither copies nor dereferences
away the app. A property captured too early is a different matter:

```ts
const tables = app.tables; // Captures this property's current value.
// If initialization later replaces app.tables, `tables` does not follow it.
```

Capturing the property inside the gated child's instance script avoids that
initialization race. Readiness also does not make snapshots reactive or replace
old references when the user selects another app instance. Remount the owning
subtree or use explicit reactive access for that transition. Keep account-specific
singletons out of shared server module state; these examples describe client-side
ownership.

See [the session and context comparison](sync-construction-async-property-ui-render-gate-pattern.md#pass-a-ready-app-once-then-use-context-in-descendants) for passing a resolved app without prop drilling.
