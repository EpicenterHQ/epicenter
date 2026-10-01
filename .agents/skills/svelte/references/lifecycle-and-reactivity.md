# Svelte Lifecycle And Reactivity Patterns

Detailed Svelte 5 guidance for keyed resources, async gates, shallow aliases, finite union mapping, SvelteMap, reactive table state, and state modules.

# Prop-Keyed Resources: Let the Tree Own the Lifecycle

When a component owns a disposable resource (subscription, socket, timer, any handle with a `dispose()`/`close()`/`unsubscribe()` method) whose identity depends on a prop, open it synchronously and let the parent control mount/unmount with `{#key}` or `{#if}`. Don't store the resource in nullable `$state` and re-open it inside an `$effect`: that reimplements component mount/unmount in user-space.

## The rule

```svelte
<!-- Parent: one lifecycle boundary, structurally visible -->
{#if resourceId}
	{#key resourceId}
		<ResourceView id={resourceId} />
	{/key}
{/if}

<!-- Child: id is stable for this instance; open sync, dispose on unmount -->
<script lang="ts">
	let { id }: { id: string } = $props();

	const resource = openResource(id);
	$effect(() => () => resource.dispose());
</script>

<SomeView data={resource.data} />
```

The child's handle is non-nullable. No `{#if handle}` guard leaks into markup. The effect has one line because its only job is cleanup.

## The anti-pattern

```svelte
<!-- Reimplements mount/unmount by hand -->
<script lang="ts">
	let { id }: { id: string } = $props();
	let handle = $state<Resource | null>(null);

	$effect(() => {
		const h = openResource(id);
		handle = h;
		return () => { h.dispose(); handle = null; };
	});
</script>

{#if handle}
	<SomeView data={handle.data} />
{/if}
```

It's easy to write a double-dispose or leak here. The version above can't: the body is the cleanup.

## Decision check

1. Is the id a prop? -> Parent keys on it with `{#key}`; child opens sync.
2. Can the id be absent? -> Parent wraps in `{#if id}<Child {id} />{/if}`; child opens sync.
3. Does the component have local UI state (selection, zoom, scroll) that must survive an id swap without persistence? -> rare exception; the nullable-state pattern is justified.

## Async-gate variant

When the resource exposes a readiness promise (`whenReady`, `whenLoaded`), gate rendering in the **template** with `{#await}`. Do NOT introduce a `$state(false)` flag + `$effect` that flips it inside `.then()`: Svelte already owns promise lifecycles, cancellation, and error branching. Rebuilding that in userland is pure ceremony.

```svelte
<script lang="ts">
	const resource = openResource(id);
	$effect(() => () => resource.dispose());
</script>

{#await resource.whenReady}
	<div class="flex h-full items-center justify-center">
		<Spinner class="size-5 text-muted-foreground" />
	</div>
{:then _}
	<Editor binding={resource.body.binding} />
{:catch error}
	<ErrorState {error} />
{/await}
```

Bare `{:then}` is valid Svelte when the resolved promise value is unused. In this repo, use `{:then _}` for readiness gates because Biome 2.4.x currently parses bare `{:then}` as `Expected an expression, instead none was found`. Treat `_` as a temporary compatibility placeholder, not a semantic value. Use `{:then value}` only when the resolved value is actually read.

### Anti-pattern: don't do this

```svelte
<!-- Bad: Re-implements {#await} with extra state and a cancellation flag -->
<script lang="ts">
	let isLoaded = $state(false);
	$effect(() => {
		let cancelled = false;
		resource.whenReady.then(() => { if (!cancelled) isLoaded = true; });
		return () => { cancelled = true; };
	});
</script>

{#if isLoaded}<Editor />{:else}<Spinner />{/if}
```

Three problems, every time:
1. **One idea, three primitives.** A state var, a subscription effect, and an if/else branch collectively say what `{#await}` says in four lines.
2. **Silent unhandled rejections.** The `.then()` chain drops errors on the floor. `{#await}`'s `{:catch}` makes failure explicit and catchable.
3. **Manual stale-result handling.** The `cancelled` flag exists because `.then()` can fire after the branch is gone. `{#await}` keeps the pending, fulfilled, and rejected render states tied to the template branch instead of scattering that state across a flag and an effect.

### When you still need `$state` flags

`{#await}` is for **one stable promise** driving one render branch. Reach for `$state` + `$effect` only when:
- You're composing multiple promises with custom logic (race, timeout, retry).
- The flag reflects an external reactive source (`$derived(query.isPending)` from TanStack Query, a Svelte store, `createSubscriber`).

## `$state.raw` for non-proxyable handles

Svelte's deep proxy can break handles whose methods rely on `this` being the original instance, or that hold internal non-reactive state. Prefer keeping handles out of `$state` entirely (the rule above). If a handle must live in state, use `$state.raw(handle)` to skip proxying.

## Project-specific application

In this codebase, the rule applies to any component calling `*Docs.open()` (Yjs doc handles from `createDisposableCache`). Search: `$state<ReturnType<typeof .*\.open>`. Every hit is a candidate for the rule above.

## Imperative Widgets: Own The Whole Runtime Boundary

For imperative widgets such as ProseMirror, CodeMirror, maps, charts, or
canvas-based tools, prefer one component that owns the whole runtime boundary:

```txt
keyed id prop
  -> open disposable resource
  -> wait for readiness in markup
  -> construct imperative widget once
  -> destroy widget and resource on component teardown
```

Avoid splitting this into a resource component plus a one-call generic widget
component that only receives a stable handle such as `Y.XmlFragment`,
`HTMLElement`, `EditorState`, `Map`, or `Chart` config. That split usually
creates a reactive prop boundary around a value that is not application state.

Use `untrack` in a widget setup effect only for values that are intentionally
not part of widget identity, such as a stable notification callback. If you need
`untrack` for the main setup object, first ask whether the component owns the
wrong boundary. Moving ownership to the keyed child often removes the need for
`untrack` and makes the lifecycle visible in the tree.

Keep a generic widget component only when there are several real callers, a
public component API, or a non-obvious widget invariant that deserves its own
file. Otherwise, collapse the wrapper into the component that owns the resource
and mount lifetime.

## Related

- The sync-construction / async-ready-property / UI-render-gate pattern (see `factory-function-composition`, `references/sync-construction-render-gate.md`) covers the service-layer equivalent for clients with async-ready properties.
- `docs/articles/svelte-5-createsubscriber-pattern.md` covers `createSubscriber` for wrapping external event sources into reactive values: a different job than component-scoped handles.
- `docs/articles/20260420T160000-state-handle-null-is-the-component-lifecycle-in-disguise.md` walks through why this rule exists and when Pattern B is still correct.

# Shallow Template Aliases: Inline Direct Reads

Svelte template expressions already track reactive property reads. Do not add a `$derived` or `{@const}` whose only job is to rename a shallow property read for markup.

```svelte
<!-- Bad: the alias does not compute anything -->
<script lang="ts">
	const current = $derived(session.current);
</script>

{#if current}
	<AccountPopover principal={current.principal} />
{/if}
```

```svelte
<!-- Good: read the source directly in markup -->
{#if session.current}
	<AccountPopover principal={session.current.principal} />
{/if}
```

The same rule applies to block-local `{@const}` passthroughs:

```svelte
<!-- Bad -->
{#await session.whenReady}
	<Loading />
{:then _}
	{@const current = session.current}
	{#if current}
		<SignedInApp principal={current.principal} />
	{/if}
{/await}
```

```svelte
<!-- Good -->
{#await session.whenReady}
	<Loading />
{:then _}
	{#if session.current}
		<SignedInApp principal={session.current.principal} />
	{/if}
{/await}
```

Keep the alias when it owns real work:

- Computed predicates or values: `const isSelected = $derived(selectedId === item.id)`.
- Values used by script logic, effects, or other derived values.
- Expensive or noisy computations that should run once per block.
- Dynamic component binding: `{@const Icon = item.icon}` before `<Icon />`.
- Discriminated union payloads inside an `{#each}` branch when the alias improves narrowing and readability: `{@const bookmark = item.bookmark}`.

Searches:

```bash
rg -n '\$derived\([^)]*\.[A-Za-z_$][A-Za-z0-9_$]*\)' --glob '*.svelte'
rg -n '\{@const\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*[^}\n]+\.[A-Za-z_$][A-Za-z0-9_$]*\s*\}' --glob '*.svelte'
```

# `$derived` Value Mapping: Use `satisfies Record`, Not Ternaries

When a `$derived` expression maps a finite union to output values, use a `satisfies Record` lookup. Never use nested ternaries. Never use `$derived.by()` with a switch just to map values.

```svelte
<!-- Bad: nested ternary in $derived -->
<script lang="ts">
	const tooltip = $derived(
		syncStatus.current === 'connected'
			? 'Connected'
			: syncStatus.current === 'connecting'
				? 'Connecting...'
				: 'Offline',
	);
</script>

<!-- Bad: $derived.by with switch for a pure value lookup -->
<script lang="ts">
	const tooltip = $derived.by(() => {
		switch (syncStatus.current) {
			case 'connected': return 'Connected';
			case 'connecting': return 'Connecting...';
			case 'offline': return 'Offline';
		}
	});
</script>

<!-- Good: $derived with satisfies Record -->
<script lang="ts">
	import type { SyncStatus } from '@epicenter/sync-client';

	const tooltip = $derived(
		({
			connected: 'Connected',
			connecting: 'Connecting...',
			offline: 'Offline',
		} satisfies Record<SyncStatus, string>)[syncStatus.current],
	);
</script>
```

Why `satisfies Record` wins:

- Compile-time exhaustiveness: add a value to the union and TypeScript errors on the missing key. Nested ternaries silently fall through.
- It's a data declaration, not control flow. The mapping is immediately visible.
- `$derived()` stays a single expression: no need for `$derived.by()`.

Reserve `$derived.by()` for multi-statement logic where you genuinely need a function body. For value lookups, keep it as `$derived()` with a record.

`as const` is unnecessary when using `satisfies`. `satisfies Record<T, string>` already validates shape and value types.

See `docs/articles/record-lookup-over-nested-ternaries.md` for rationale.

# When to Use SvelteMap vs $state

Use `SvelteMap` when items have stable IDs and you need keyed lookup. Reads of
`get`, `has`, `size`, and iteration participate in Svelte reactivity when they
happen inside a template, `$derived`, or `$effect`. Use `$state` for primitives,
local UI booleans, and sequential data without identity.

`SvelteMap` does not deep-proxy its values. If nested fields must update
reactively, store row objects that are already reactive, or replace the map
value with `set(id, next)`.

| Data Shape | Use | Example |
|---|---|---|
| Epicenter store table rows | `fromData` reactive tables | notes, folders |
| Browser API keyed data | `new SvelteMap()` + listeners | media devices, windows |
| Primitive value | `$state(value)` | `$state(false)`, `$state('')`, `$state(0)` |
| Replace-only sequential data without IDs | `$state.raw<T[]>([])` | terminal history, command history |
| Replace-only ordered list where position matters | `$state.raw<T[]>([])` | open file tab order |

For an id-keyed collection you own and mutate in place, `SvelteMap` still beats
`$state<T[]>`: `.find()` scans, a whole-array write re-triggers every reader, and
sorting inside a getter returns a fresh array on every access, which sends
TanStack Table into an infinite loop. See
`docs/articles/sveltemap-over-state-for-keyed-collections.md`.

# Reactive Table State Pattern

Store reads are synchronous and return plain JSON, so the source of truth is a
re-read, not a long-lived reactive collection. `fromData` from
`@epicenter/svelte` packages that re-read once: it mirrors an opened
workspace's declared `tables`/`kv` and makes every read verb reactive
(`rows`, `nonconforming`, `list`, `get`, `ids`, `document`), while `create`,
`update`, and `delete` pass through unchanged. The signal it rides names the
rows a commit touched (ADR-0221) and fires for a local write and for bytes that
arrived from another device alike. Text typed inside a row's content node is
not a table commit; `watch(node, listener)` is its signal.

```typescript
// Adapt the supplied store; repeated calls reuse its projection.
const app = fromData(data);
const table = app.tables.notes;

// Derived views: filtering and sorting are cached here, not in the getter.
const all = $derived(table.rows.filter((note) => note.deletedAt === null));

return {
	get all() {
		return all;
	},
	get(id: NoteId) {
		return table.rows.find((note) => note.id === id);
	},
};
```

There is no `refresh`, no generation counter, no `await` on a read, and no
`Symbol.dispose`. A table is HELD: `fromData` seeds a `SvelteMap` projection
keyed by row id on the first call for a raw store, patches it with the ids each commit names,
and never tears it down, so the projection and its subscription die with the
document. Repeated calls with the same raw store return that same projection
without adding subscriptions. The cache keys by object identity, so another
opened store receives its own projection. That is not ref-counting, and the difference matters: a projection
detached from its source stays alive and stops being true. `kv` and
`persistence` are read-through on `createSubscriber` instead, because ten keys
and one enum are not worth holding.

A read inside `$derived` or a template tracks; a read in an event handler is
fresh and untracked. Do not hand-roll `db.<table>.subscribe(listener)` feeding
`$state.raw` for table reads; that pattern is what the adapter replaced. For
one value off a source that is not a table, use `fromSubscription(subscribe,
read)`.

Adapter: `packages/svelte/src/from-data.svelte.ts`. Full app exemplar:
`apps/honeycrisp/src/lib/app.svelte.ts`.

See the `typescript` skill for iterator helpers (`.toArray()`, `.filter()`, `.find()` on `IteratorObject`).

### Template Props

For component props expecting `T[]`, derive in the script block: never materialize in the template:

```svelte
<!-- Bad: re-creates array on every render -->
<FujiSidebar entries={entries.values().toArray()} />

<!-- Good: cached via $derived -->
<script>
	const entriesArray = $derived(entries.values().toArray());
</script>
<FujiSidebar entries={entriesArray} />
```

### Why `$derived`, Not a Plain Getter

Put reactive computations in `$derived`, not inside public getters.

A getter may still be reactive if it reads reactive state, but it recomputes on every access. `$derived` computes reactively and caches until dependencies change.

Use `$derived` for the computation. Use the getter only as a pass-through to expose that derived value.

See `docs/articles/derived-vs-getter-caching-matters.md` for rationale.

# Reactive State Module Conventions

State modules use a factory function that returns a flat object with getters and methods, exported as a singleton.

```typescript
function createBookmarkState(db: AppData) {
	let rows = $state.raw<Bookmark[]>([]);
	function read() {
		rows = db.tables.bookmarks.rows;
	}
	read();
	const stop = db.tables.bookmarks.subscribe(read);

	const bookmarks = $derived(rows.filter((b) => b.deletedAt === null));

	return {
		[Symbol.dispose]: stop,
		get bookmarks() { return bookmarks; },
		add(fields: BookmarkFields) { db.tables.bookmarks.create(fields); },
		remove(id: BookmarkId) { db.tables.bookmarks.delete(id); },
	};
}

export const bookmarkState = createBookmarkState(db);
```

## Naming

| Concern | Convention | Example |
|---|---|---|
| **Export name** | `xState` for domain state; descriptive noun for utilities | `bookmarkState`, `notesState`, `deviceConfig`, `vadRecorder` |
| **Factory function** | `createX()` matching the export name | `createBookmarkState()` |
| **File name** | Domain name, optionally with `-state` suffix | `bookmark-state.svelte.ts`, `auth.svelte.ts` |

Use the `State` suffix when the export name would collide with a key property (`bookmarkState.bookmarks`, not `bookmarks.bookmarks`).

## Accessor Patterns

| Data Shape | Accessor | Example |
|---|---|---|
| **Collection** | Named getter | `bookmarkState.bookmarks`, `notesState.notes` |
| **Single reactive value** | `.current` (Svelte 5 convention) | `selectedFolderId.current`, `serverUrl.current` |
| **Keyed lookup** | `.get(key)` | `toolTrustState.get(name)`, `deviceConfig.get(key)` |

The `.current` convention comes from [runed](https://github.com/svecosystem/runed) (the standard Svelte 5 utility library). All 34+ runed utilities use `.current`. Never use `.value` (Vue convention).

## Persisted State Utilities

For localStorage/sessionStorage persistence, use `createPersistedState` (single value) or `createPersistedMap` (typed multi-key config) from `@epicenter/svelte`.

```typescript
// Single value: .current accessor
import { createPersistedState } from '@epicenter/svelte';
const theme = createPersistedState({
	key: 'app-theme',
	schema: type("'light' | 'dark'"),
	defaultValue: 'dark',
});
theme.current; // read
theme.current = 'light'; // write + persist

// Multi-key config: .get()/.set() with SvelteMap (per-key reactivity)
import { createPersistedMap, defineEntry } from '@epicenter/svelte';
const config = createPersistedMap({
	prefix: 'myapp.config.',
	definitions: {
		'theme': defineEntry(type("'light' | 'dark'"), 'dark'),
		'fontSize': defineEntry(type('number'), 14),
	},
});
config.get('theme'); // typed read
config.set('theme', 'light'); // typed write + persist
```

Both accept `storage?: Storage` (defaults to `window.localStorage`) for dependency injection.
