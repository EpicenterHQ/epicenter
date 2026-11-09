# Sync Construction, Async Property

> The initialization of the client is synchronous. The async work is stored as a property you can await, while passing the reference around.

## When to Apply This Pattern

Use this when you have:

- Async client initialization (IndexedDB, server connection, file system)
- Module exports that need to be importable without `await`
- UI components that want sync access to the client
- SvelteKit apps where you want to gate rendering on readiness

Signals you're fighting async construction:

- `await getX()` patterns everywhere
- Top-level await complaints from bundlers
- Getter functions wrapping singleton access
- Components that can't import a client directly

## The Problem

Async constructors can't be exported:

```typescript
// This doesn't work
export const client = await createClient(); // Top-level await breaks bundlers
```

So you end up with getter patterns:

```typescript
let client: Client | null = null;

export async function getClient() {
	if (!client) {
		client = await createClient();
	}
	return client;
}

// Every consumer must await
const client = await getClient();
```

Every call site needs `await`. You're passing promises around instead of objects.

## The Pattern

Make construction synchronous. Attach async work to the object:

```typescript
// client.ts
export const client = createClient();

// Sync access works immediately
client.save(data);
client.load(id);

// Await the async work when you need to
await client.whenSynced;
```

Construction returns immediately. The async initialization (loading from disk, connecting to servers) happens in the background and is tracked via `whenSynced`.

## The UI Render Gate

In Svelte, gate once at the root using `@epicenter/ui/spinner` for the loading state and `@epicenter/ui/empty` for error recovery:

```svelte
<!-- +layout.svelte -->
<script>
	import * as Empty from '@epicenter/ui/empty';
	import { Spinner } from '@epicenter/ui/spinner';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { client } from '$lib/client';
</script>

{#await client.whenSynced}
	<Empty.Root class="flex-1">
		<Empty.Media>
			<Spinner class="size-5 text-muted-foreground" />
		</Empty.Media>
		<Empty.Title>Loading…</Empty.Title>
	</Empty.Root>
{:then}
	{@render children?.()}
{:catch}
	<Empty.Root class="flex-1">
		<Empty.Media>
			<TriangleAlertIcon class="size-8 text-muted-foreground" />
		</Empty.Media>
		<Empty.Title>Failed to load</Empty.Title>
		<Empty.Description>
			Something went wrong during initialization. Try reloading.
		</Empty.Description>
	</Empty.Root>
```

The gate guarantees: by the time any child component's script runs, the async work is complete. Children use sync access without checking readiness.

**Always include `{:catch}`** : if the async seed fails (e.g. `browser.windows.getAll` throws), the user sees an actionable error instead of an infinite spinner.

## Implementation

The `withCapabilities()` fluent builder attaches async work to a sync-constructed object:

```typescript
function createClient() {
	const state = initializeSyncState();

	return {
		save(data) {
			/* sync method */
		},
		load(id) {
			/* sync method */
		},

		withCapabilities({ persistence }) {
			const whenSynced = persistence(state);
			return Object.assign(this, { whenSynced });
		},
	};
}

// Usage
export const client = createClient().withCapabilities({
	persistence: (state) => loadFromIndexedDB(state),
});
```

## Before and After

| Aspect         | Async Construction        | Sync + whenSynced       |
| -------------- | ------------------------- | ----------------------- |
| Module export  | Can't export directly     | Export the object       |
| Consumer code  | `await getX()` everywhere | Direct import, sync use |
| UI integration | Awkward promise handling  | Single `{#await}` gate  |
| Type signature | `Promise<X>`              | `X` with `.whenSynced`  |

## Real-World Example: y-indexeddb

The Yjs ecosystem uses this pattern everywhere:

```typescript
const provider = new IndexeddbPersistence('my-db', doc);
// Constructor returns immediately

provider.on('update', handleUpdate); // Sync access works

await provider.whenSynced; // Wait when you need to
```

They never block construction. The async work is always deferred to a property you can await.

## Alternate Pattern: Await in Every Method

Alternatively, you can skip the `whenReady` property entirely and hide the initialization await inside each method. The canonical example is [idb](https://github.com/jakearchibald/idb):

```typescript
const dbPromise = openDB('keyval-store', 1, { upgrade(db) { db.createObjectStore('keyval') } });

export async function get(key) { return (await dbPromise).get('keyval', key); }
export async function set(key, val) { return (await dbPromise).put('keyval', val, key); }
```

Use `whenReady` when your client has sync methods that depend on initialized state. Use await-in-every-method when every method is async anyway (like database access). See the [idb await-in-every-method article](/docs/articles/idb-await-every-method-pattern.md) for a deeper comparison.

## Epicenter capabilities

An Epicenter capability that takes time to open, such as `openFolder(contract, place)`
or this computer's `settings` from `@epicenter/local`, takes neither shape
whole
([ADR-0767](../../../../docs/adr/0767-an-async-lifecycle-is-modeled-as-synchronous-state-actions-wait-on-their-own.md),
[ADR-0777](../../../../docs/adr/0777-a-capability-has-no-ready-promise.md),
[ADR-0778](../../../../docs/adr/0778-a-page-connects-once-and-then-reads-synchronously.md)).
It has no public ready promise and no `loading()`. Its lifecycle is
synchronous state (`state()` and `subscribe`, with `retry()` on the failed
state), and its async methods wait for the connection, as in idb. Its reads
of stored data are synchronous once the page has connected and throw
(`FolderNotOpen`, `SettingsNotOpen`) before, so they never answer a
stand-in. The page connects to every store once, and the one root gate,
`<WhenOpen>`, reads `state()` and renders nothing that reads a store before.
A `whenReady` property fits only something with no actions to wait, as
`document.fonts.ready` does.

## Related Patterns

- [Lazy Singleton](../../../../docs/articles/lazy-singleton-pattern.md) : when you need race-condition-safe lazy initialization
- [Don't Use Parallel Maps](../../../../docs/articles/instance-state-attachment-pattern.md) : attach state to instances instead of tracking separately

## References

- [Full article](/docs/articles/sync-construction-async-property-ui-render-gate-pattern.md) : detailed explanation with diagrams
- [Comprehensive guide](/docs/articles/sync-client-initialization.md) : 480-line deep dive with idb example
- [idb await-in-every-method](/docs/articles/idb-await-every-method-pattern.md) : the sibling pattern for purely async APIs
