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

For contract apps, `src/lib/app.ts` exports the capabilities as module
values ([ADR-0766](../../../../docs/adr/0766-an-apps-capabilities-are-module-values-opened-synchronously.md)).
`openFolder(contract)` returns at once; where it is in its life is
`folder.state()` (opening, open, failed with a typed error and the failure's
`retry()`, or closed), and the root layout renders `<WhenOpen {folder}>`.
Editing `app.ts`, or anything it imports, reloads the page in development, so
it closes nothing by hand. Any code imports
`folder`; none passes it through context. Only `<WhenOpen>` and Recovery read
`state()`: a collection's reads answer while the folder opens (`items()`
empty, `loading()` true), and its async methods wait for the open
([ADR-0767](../../../../docs/adr/0767-an-async-lifecycle-is-modeled-as-synchronous-state-actions-wait-on-their-own.md)),
so no other code checks or awaits readiness. Every app is on this shape; do
not add a `Startup` root or a per-collection context. Key editors by note identity so each mounted editor owns one edit. See
[Contract reads and editing](#contract-reads-and-editing).

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

# Template locals: narrow reactive values before use

Svelte template expressions already track reactive property reads. Introduce
`{@const}` or `$derived` when a repeated optional property access loses its
narrowing inside a deferred callback, or when a useful computation needs a
name. An already-narrowed local needs no extra alias. A reactive local is not
a second draft or a mount-time snapshot.

Place `{@const}` in the nearest supported template scope containing the controls that
need it. Capture the optional value, narrow that local, then create the binding
callbacks. Several controls in that scope share one local; nested property
access alone does not justify another alias.

```svelte
{#each items as item (item.id)}
	{@const details = item.details}
	{#if details}
		<Input bind:value={() => details.title, (title) => item.update({ title })} />
		<Textarea bind:value={() => details.notes, (notes) => item.update({ notes })} />
	{/if}
{/each}
```

Read the value once, then check its presence with the source's actual sentinel.
The [function binding guidance](component-ui-patterns.md#function-bindings-for-transformed-values)
explains event-time composition through the current owner.

Use `const details = $derived(item.details)` if script code also needs it or no
existing template scope supports `{@const}` before the guard. Do not add a
block solely to host the local. Do not replace either reactive form with a
component-level `const details = item.details`: that captures only the initial
value. A simple display that needs no shared narrowing may read
`session.current` directly:

```svelte
<!-- Bad: the alias does not compute or narrow anything -->
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

Do not add an alias just to rename a read, and do not remove a useful local
merely because its initializer is a shallow property read. Other reasons to
keep a local include a computed predicate, an expensive projection shared by
several consumers, a change filter that skips downstream work when its value
stays identical, or a dynamic component such as `{@const Icon = item.icon}`.
Inspect the consumers before inlining.

An operation-local snapshot can keep a read-modify-write operation coherent.
Capture it when the handler runs, and re-read or check the operation's
validity after an `await` before writing.

Searches for candidate passthroughs:

```bash
rg -n '\$derived\([^)]*\.[A-Za-z_$][A-Za-z0-9_$]*\)' --glob '*.svelte'
rg -n '\{@const\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*[^}\n]+\.[A-Za-z_$][A-Za-z0-9_$]*\s*\}' --glob '*.svelte'
```

# Stable adapters and reactive reads

Separate the adapter's identity from the values it exposes. For a read-through
adapter whose getters participate in Svelte reactivity, construct it once when
the source owner is fixed for the component instance:

```svelte
<!-- Parent: a new open item recreates the child. -->
{#key item}
	<RowView session={item.session} />
{/key}
```

```svelte
<!-- RowView.svelte -->
<script lang="ts">
	let { session } = $props();
</script>

<p>{session.draft.title}</p>
```

The session's getters are reactive, so changes to the draft or save state need
no reconstruction. If the owner can be replaced while this component stays
mounted, key the component on the owner, or derive from the prop. For an
adapter that owns a disposable resource, use an explicit lifecycle boundary
instead; `$derived` does not supply cleanup.

Confirm owner stability at the caller before removing the wrapper. A keyed
child can establish that stability when the key tracks the owner identity.
The caller now owns that guarantee; removing its key can leave the child stale.
Use `untrack` for this intentional initial prop capture to avoid Svelte's
[state_referenced_locally warning](https://svelte.dev/docs/svelte/compiler-warnings#state_referenced_locally). It documents the capture, not a substitute
for the caller's lifetime guarantee. Prefer deriving from the prop when the
component must remain correct independently of its caller's mount policy.
Svelte executes component initialization once, and a `{#key}` block recreates
its contents when the key changes. See the official
[`$derived`](https://svelte.dev/docs/svelte/$derived),
[`$props`](https://svelte.dev/docs/svelte/$props), and
[`{#key}`](https://svelte.dev/docs/svelte/key) documentation.

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
	type SyncStatus = 'connected' | 'connecting' | 'offline';

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
| Contract listings | `files.notes.items`, `files.notes.invalid` | notes and notes that do not read |
| An open note | `notes.edit({ id })` | `todo.fields` (typed until saved), `todo.exists`, and inline save feedback |
| Browser API keyed data | `new SvelteMap()` + listeners | media devices, windows |
| Primitive value | `$state(value)` | `$state(false)`, `$state('')`, `$state(0)` |
| Replace-only sequential data without IDs | `$state.raw<T[]>([])` | terminal history, command history |
| Replace-only ordered list where position matters | `$state.raw<T[]>([])` | open file tab order |

For an id-keyed collection you own and mutate in place, `SvelteMap` still beats
`$state<T[]>`: `.find()` scans, a whole-array write re-triggers every reader, and
sorting inside a getter returns a fresh array on every access, which sends
TanStack Table into an infinite loop. See
`docs/articles/sveltemap-over-state-for-keyed-collections.md`.

# Contract reads and editing

A folder read through `reactive` gives each collection tracking reads:
`items()`, `invalid()`, `loading()`, `error()` and `get(args)` (ADR-0769).
Collections come straight off the module-level `folder` in
`src/lib/app.ts` (ADR-0766):

```ts
// src/lib/app.ts
export const folder = reactive(openFolder(todos, { site, account }));

// any component
import { folder } from '$lib/app.js';
const { todos } = folder;
```

The component that shows a note makes one editor of it during setup. The
editor is that view's read of the note too: `todo.fields` holds one accessor
per declared field and `body`, each showing typed input until its save
answers and the note as shown after, and `todo.exists()` says whether a note
that reads is listed at its path (false while missing, deleted or not
reading):

```svelte
<script lang="ts">
  import { folder } from '$lib/app.js';

  const { todos } = folder;
  const todo = todos.edit({ id });
  const open = $derived(todos.items().filter((todo) => !todo.done));
</script>

{#if todo.exists()}
  <Input bind:value={todo.fields.title} />
  <Textarea bind:value={todo.fields.body} />
  <Checkbox bind:checked={todo.fields.done} />
  <UnsavedEdit edit={todo} />
{:else}
  <p>This todo is no longer here.</p>
{/if}
```

Do not read the open note a second time with `todos.get({ id })` or take it
as a prop; `get` is for lists, code that is not the note's view, and the
rare view that needs the saved note beside what is typed (Capture's export
waits for the save, then reads the file's text from `get`). `fields` stays
live, so `const { fields } = todo` is fine. Keep
derived filters in `$derived`. The editor's saves go one at a time; the
newest carries every field typed since the last that landed, made over the
note as the person saw it when each field's typing began. Another writer's
change to a field not typed is carried over; their change to a typed field
is a `Conflict`, after which the collection shows theirs, the typing stays,
and a second save applies over it. Code that is not typing, such as a list
row's toggle, writes with `update`, and its returned result belongs to that
action. Keep an app-level context only for state that is not a collection
(selection, a recorder), named for what it holds.

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
		const { data, error } = db.bookmarks.list();
		if (error !== null) return reportBackgroundError(error);
		rows = data.rows;
	}
	read();
	const stop = db.bookmarks.subscribe(read);

	const bookmarks = $derived(rows.filter((b) => b.deletedAt === null));

	return {
		[Symbol.dispose]: stop,
		get bookmarks() { return bookmarks; },
		add(fields: BookmarkFields) { /* ... */ },
		remove(id: BookmarkId) { /* ... */ },
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
