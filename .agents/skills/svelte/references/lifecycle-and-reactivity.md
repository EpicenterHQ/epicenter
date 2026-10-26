# Svelte Lifecycle And Reactivity Patterns

Detailed Svelte 5 guidance for keyed resources, async gates, shallow aliases, finite union mapping, SvelteMap, Folder reads and editing, and state modules.

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

For Folder-backed apps, `<OpenFolder open={...}>{#snippet children(folder)}...{/snippet}</OpenFolder>`
owns asynchronous opening and close, including a folder whose opening finishes
after unmount. The mounted product root receives the `SvelteFolder` value and
installs it in its app-owned context. Key editors by file identity so each
mounted editor owns one draft. See [Folder reads and editing](#folder-reads-and-editing).

Use `SvelteMap` when items have stable IDs and you need keyed lookup. Reads of
`get`, `has`, `size`, and iteration participate in Svelte reactivity when they
happen inside a template, `$derived`, or `$effect`. Use `$state` for primitives,
local UI booleans, and sequential data without identity.

`SvelteMap` does not deep-proxy its values. If nested fields must update
reactively, store row objects that are already reactive, or replace the map
value with `set(id, next)`.

| Data Shape | Use | Example |
|---|---|---|
| Folder listings | `folder.files`, `table.rows` | landed notes and files |
| Editable text | `draft(source, save)` | typed text and inline save feedback |
| Browser API keyed data | `new SvelteMap()` + listeners | media devices, windows |
| Primitive value | `$state(value)` | `$state(false)`, `$state('')`, `$state(0)` |
| Replace-only sequential data without IDs | `$state.raw<T[]>([])` | terminal history, command history |
| Replace-only ordered list where position matters | `$state.raw<T[]>([])` | open file tab order |

For an id-keyed collection you own and mutate in place, `SvelteMap` still beats
`$state<T[]>`: `.find()` scans, a whole-array write re-triggers every reader, and
sorting inside a getter returns a fresh array on every access, which sends
TanStack Table into an infinite loop. See
`docs/articles/sveltemap-over-state-for-keyed-collections.md`.

# Folder reads and editing

`<OpenFolder>` passes a reactive `SvelteFolder` to the product root. The root
installs it in an app-owned `createContext` pair. The Folder mirror shows only
what storage last returned or accepted. A text editor owns typed input until
its save answers.

```svelte
<script lang="ts">
  import { getFolder } from '$lib/folder.js';

  const folder = getFolder();
  const validNotes = $derived(
    folder.tables.notes.rows.filter((row) => row.issues === null),
  );
</script>
```

`folder.files` and table `rows` are tracked getters; `file(path)` and
`row(id)` track when called in reactive code. Keep derived filters in
`$derived`. Each text input bound to folder data uses its own
`draft(source, save)` from `@epicenter/svelte/folder`, including titles. Show
failed saves beside that editor with `<UnsavedEdit>`. A checkbox, select, or
button writes directly, and its returned result belongs to that action.

Writes answer after storage and the mirror agree. `folder.refresh()` reconciles
outside changes and retries a failed read. Mounted drafts flush on teardown
and page departure. `<OpenFolder>` closes the Folder after drafts flush and
queued writes drain. Keep product cleanup idempotent.

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

Export a factory for state tied to an opened Folder or mounted app. The app
root creates one instance and supplies it through props or typed context.
A module-level singleton would retain the first app's state across replacement
or share it between separate opened folders. Global preference state can have a
separate deliberate lifetime.

Keep local view state separate from the Folder's document and query owners.
For example, a `.svelte.ts` module can own a selection:

```typescript
export function createNoteSelection() {
	let path = $state<string>();
	return {
		get current() { return path; },
		select(next: string | undefined) { path = next; },
	};
}
```

Create that selection in its owning component, rather than exporting an
initialized instance from the module. File content still belongs to its editor.

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
