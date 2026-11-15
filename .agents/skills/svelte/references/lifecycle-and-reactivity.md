# Svelte Lifecycle And Reactivity Patterns

Detailed Svelte 5 guidance for keyed resources, async gates, stable owners, finite union mapping, reactive collections, contract editors, and state modules.

# Prop-Keyed Resources: Let the Tree Own the Lifecycle

When a view and a disposable resource share an identity and lifetime, prefer
letting `{#key}` or `{#if}` own their creation and destruction. The child can
hold one resource instead of mirroring the view's mount state in a nullable
handle and setup effect.

Choose a setup phase that can actually create the resource. The example below
assumes a client-rendered component with synchronous construction. Browser-only
resources in an SSR app need client-side setup, such as an effect, `onMount`,
or an element attachment, with cleanup in that owner's lifetime.

## The rule

```svelte
<!-- Parent: resourceId is string | undefined; an empty id is still present. -->
{#if resourceId !== undefined}
	{#key resourceId}
		<ResourceView id={resourceId} />
	{/key}
{/if}

<!-- Child: id is stable for this instance; open sync, dispose on unmount -->
<script lang="ts">
	import { untrack } from 'svelte';
	let { id }: { id: string } = $props();

	const resource = untrack(() => openResource(id));
	$effect(() => () => resource.dispose());
</script>

<SomeView data={resource.data} />
```

The child's handle is non-nullable. No `{#if handle}` guard leaks into markup. The effect has one line because its only job is cleanup.

## When an effect duplicates mount state

```svelte
<!-- This handle only mirrors the view's mounted lifetime. -->
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

When mount and resource lifetimes coincide, the keyed version removes this
nullable render gate and leaves cleanup with the resource owner.

That nullable handle and setup effect reimplement component mount/unmount in
user-space when their only job is to follow the view. Keeping one resource
and its cleanup together removes competing setup and disposal paths; the
cleanup body is the teardown. This does not make arbitrary resource code
incapable of leaking: the owner must still acquire and dispose it correctly.

## Decision check

Key the view when changing the id should replace both its resource and local
state. If selection, a draft, zoom, or scroll must survive, keep that state
outside the keyed resource boundary, or use an effect that replaces only the
resource. Handle an absent id with the API's actual sentinel, rather than a
truthiness check when empty strings or zero are valid ids.

`untrack` documents the intentional setup-time capture; the caller's key makes
that capture valid. It does not make a changing prop safe to ignore.

## Async-gate variant

When an owner exposes a stable readiness promise and the view only needs its
pending, fulfilled, and rejected branches, use `{#await}` instead of copying
those states into a flag. The block follows the current promise for rendering;
it does not cancel the underlying operation or dispose its resource. Keep
cancellation and cleanup with the operation's owner. Contract editors use the
[connection boundary](#contract-reads-and-editing), not per-editor promises.

```svelte
<!-- Same keyed resource owner as above. -->
{#await resource.whenReady}
	<div class="flex h-full items-center justify-center">
		<Spinner class="size-5 text-muted-foreground" />
	</div>
{:then}
	<Editor binding={resource.body.binding} />
{:catch error}
	<ErrorState {error} />
{/await}
```

Use `{:then}` when the fulfilled value is unused, and `{:then value}` when
markup needs it. Add `{:catch}` when this block owns a possible failure;
otherwise identify the existing failure owner or the promise's infallibility.

### Avoid mirroring readiness-only render state

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

For a readiness-only gate, `{#await}` keeps rendering tied to the current
promise and gives rejection its own branch. The flag and cancellation boolean
above duplicate that render state and omit rejection handling. They do not
cancel the operation itself.

The readiness-only flag pattern has three separate costs:

1. **One idea, three primitives.** A state variable, subscription effect, and
   conditional branch collectively express the render decision `{#await}` owns.
2. **Silent unhandled rejections.** A fulfillment-only `.then()` drops rejection
   handling. Use `{:catch}` when this block owns its presentation.
3. **Manual stale-result handling.** The flag must ignore an older result after
   its branch leaves. `{#await}` follows the current promise for rendering;
   cancellation and resource disposal still belong to the operation's owner.

### When you still need `$state` flags

`{#await}` follows one stable promise. A workflow with independent race,
timeout, or retry decisions may need its own state. When another owner already
exposes pending state, read it directly; use a store or `createSubscriber` for an
external event source rather than copying its answer through an effect.

## State for replaceable handles

Keep a stable imperative handle in a plain `const`. If a reactive reader needs
to observe replacement, choose state for that handle's actual mutation model.
`$state.raw` supports explicit replacement without deep proxying. Ordinary
`$state` does not proxy class instances; raw state is not required merely
because a value is an imperative handle. See
[Svelte's proxy boundary](https://svelte.dev/docs/svelte/$state#Deep-state).

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

- The sync-construction / UI-render-gate pattern (see `factory-function-composition`, `references/sync-construction-render-gate.md`) covers the service-layer equivalent: synchronous construction, one render gate, actions that wait.
- `docs/articles/svelte-5-createsubscriber-pattern.md` covers `createSubscriber` for wrapping external event sources into reactive values: a different job than component-scoped handles.
- `docs/articles/20260420T160000-state-handle-null-is-the-component-lifecycle-in-disguise.md` walks through why this rule exists and when Pattern B is still correct.

# Stable adapters and reactive reads

Separate the adapter's identity from the values it exposes. For an existing owner
whose getters participate in Svelte reactivity, keep it stable when the source
is fixed for the component instance. Capabilities already use `reactive`; this
is not a reason to build a per-capability wrapper.

A reactive local is not a second draft or a mount-time snapshot. Keep one when
several reads must narrow one answer, such as
`const signIn = $derived(auth.state())`. For the contrasting direct-property
example, see [deriving from the owner](component-ui-patterns.md#derive-from-the-owner-of-the-fact).

Search a bounded area for candidate passthroughs, then inspect the consumers:

```sh
rg -n '\$derived\([^)]*\.[A-Za-z_$][A-Za-z0-9_$]*\)' --glob '*.svelte'
rg -n '\{@const\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*[^}\n]+\.[A-Za-z_$][A-Za-z0-9_$]*\s*\}' --glob '*.svelte'
```

These match useful computations and narrowing too; a match is not an instruction
to inline it.

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
When setup intentionally captures a prop once, use `untrack` as in the
[keyed-resource example](#the-rule) to document the capture and avoid Svelte's
[state_referenced_locally warning](https://svelte.dev/docs/svelte/compiler-warnings#state_referenced_locally).
The markup read above does not capture the prop and needs no `untrack`.
An initial capture still requires the caller's lifetime guarantee. Prefer
deriving from the prop when the component must remain correct independently
of its caller's mount policy.
Svelte executes component initialization once, and a `{#key}` block recreates
its contents when the key changes. See the official
[`$derived`](https://svelte.dev/docs/svelte/$derived),
[`$props`](https://svelte.dev/docs/svelte/$props), and
[`{#key}`](https://svelte.dev/docs/svelte/key) documentation.

# Finite value mappings

For a finite union mapped to constant labels, icons, or values, prefer a
`satisfies Record` lookup: it declares the mapping and checks its keys.
Use branching when cases require conditions or computation. Use template
branches for different markup or variant-specific fields.

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

`satisfies Record<T, string>` checks the mapping. Add `as const` when preserving
literal value types is part of the contract.

See `docs/articles/record-lookup-over-nested-ternaries.md` for rationale.

# Reactive collections

Use `SvelteMap` when items have stable IDs and you need keyed lookup. Reads of
`get`, `has`, `size`, and iteration participate in Svelte reactivity when they
happen inside a template, `$derived`, or `$effect`. Use `$state` for primitives,
local UI booleans, and sequential data without identity.

`SvelteMap` does not deep-proxy its values. If nested fields must update
reactively, store row objects that are already reactive, or replace the map
value with `set(id, next)`.

For an ID-keyed collection you own, `.find()` scans an array while `get(id)`
expresses keyed lookup directly. Replacing a whole array invalidates readers
of that array; a map can track reads of individual keys. Keep the array when
order or sequence is the information it owns. Derive a sorted array when a
consumer needs that projection, rather than repeatedly sort inside a read.

Use `SvelteSet` for reactive membership read by a template, derived value, or
effect. When membership needs associated data, such as a timestamp or error,
use `SvelteMap`. Plain maps and sets suit imperative-only consumers such as a
listener bag; reactivity without a reader adds no behavior.

| Data Shape | Use | Example |
|---|---|---|
| Contract listings | `notes.items()`, `notes.invalid()` | notes and notes that do not read |
| An open note | `notes.edit({ id })` | `todo.fields` (typed until saved), `todo.exists()`, and `todo.saving()` |
| Browser API keyed data | `new SvelteMap()` + listeners | media devices, windows |
| Reactive membership | `new SvelteSet()` | expanded row IDs when only membership matters |
| Primitive value | `$state(value)` | `$state(false)`, `$state('')`, `$state(0)` |
| Replace-only ordered data | `$state.raw<T[]>([])` | command history, open file tab order |

Project collections to arrays with `$derived` when consumers depend on stable
identity. Follow [referential stability](component-ui-patterns.md#referential-stability-for-reactive-data-sources)
to check whether a consumer observes reference identity.

# Contract reads and editing

For contract apps, `src/lib/app.ts` exports the capabilities as module
values ([ADR-0766](../../../../docs/adr/0766-an-apps-capabilities-are-module-values-opened-synchronously.md)).
`openFolder(contract, home({ site, account }))` returns at once; where it is in its life is
`folder.state()` (opening, open, failed with a typed error and the failure's
`retry()`, or closed), and the root layout renders `<WhenOpen {folder}
{settings}>`, which waits for the folder and this computer's settings
(`@epicenter/local`). Editing `app.ts`, or anything it imports, reloads the
page in development, so it closes nothing by hand. Any code imports
`folder`; none passes it through context. Only `<WhenOpen>` and Recovery read
`state()`. The page connects once, and nothing that reads a store renders
before: inside `<WhenOpen>` every read is synchronous and answers what is
stored; a read before the connection throws `FolderNotOpen` (or
`SettingsNotOpen`), a bug in the code that made it
([ADR-0778](../../../../docs/adr/0778-a-page-connects-once-and-then-reads-synchronously.md)).
Code outside a page calls an action, such as `list()`, which waits. No
capability exposes `ready` or `loading()`, so no code checks or awaits
readiness. Keep contract apps on this shape; do not add a `Startup` root, a
per-collection context, or a gate of its own. Key editors by note identity so
each mounted editor owns one edit.

Read capabilities through `reactive(capability)` once where they are made.
It keeps their methods: reads track in markup, `$derived`, or effects; a read
in setup or a handler is a snapshot. Actions pass through untracked and return
promises, so an effect may call one without subscribing to that call. Keep
shared narrowed reads in `$derived` when script consumers need them.

A folder read through `reactive` gives each collection tracking reads:
`items()`, `invalid()` (notes) and `get(args)` (ADR-0769), each answering at
once inside `<WhenOpen>` (ADR-0778).
Collections come straight off the module-level `folder` in
`src/lib/app.ts` (ADR-0766):

```ts
// src/lib/app.ts
export const folder = reactive(openFolder(todos, home({ site, account })));

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

Bind structured content through `todo.fields` and the whole note through
`todo.text`. The editor keeps each typed value until its save lands.

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
{:else}
  <p>This todo is no longer here.</p>
{/if}
```

Do not read the open note a second time with `todos.get({ id })` or take it
as a prop; `get` is for lists, code that is not the note's view, and the
rare view that needs the saved note beside what is typed (Capture's export
waits for the save, then reads the file's text from `get`). `fields` stays
live, so `const { fields } = todo` is fine. Keep
derived filters in `$derived`. The editor's saves go through the folder's
queue one at a time; the newest carries everything typed since the last that
landed. A typed field takes this write, another writer's change to a field
not typed stays, and a body changed elsewhere since the typing began merges
by lines. A save never fails: while the store cannot be reached it waits,
the typing stays shown, and `<WhenOpen>` says the store is out of reach
(`folder.unavailable()`), so a view shows no save error of its own. Code
that is not typing, such as a list row's toggle, writes with
`set(args, changes)`, which answers once it has landed. Keep an app-level context only for state that is not a collection
(selection, a recorder), named for what it holds.

### Derived computations and read APIs

Use `$derived` when a reactive computation needs caching or stable output
identity. A plain method or getter recomputes its body on each access; either
can return an already derived value. Keep simple reads direct.

For new APIs, expose live reads through explicit methods, following
[typescript](../../typescript/SKILL.md). Keep existing getters and upstream
protocols as their current contracts; avoid adding a facade solely to change
access syntax.

A getter may still be reactive if it reads reactive state, but it recomputes
its body on every access. `$derived` computes reactively and caches until its
dependencies change. Use it for a computation that benefits from caching;
a method or existing getter can return the cached value. See
[the projection example](component-ui-patterns.md#referential-stability-for-reactive-data-sources).

# Product state modules

A state module can own independent product information shared by components,
such as a selection or recording workflow. Choose its instance lifetime where
that information belongs: per view, per attachment, or across app navigation.
A singleton is appropriate only for state with that shared lifetime.

```typescript
// selection.svelte.ts
export function createSelection() {
  let selected = $state<string>();

  return {
    selectedId: () => selected,
    select(id: string) { selected = id; },
    clear() { selected = undefined; },
  };
}
```

Read an existing capability through `reactive(capability)` instead of copying
its reads into this module with a subscription and another cache. Use queries
for request state; keep this module for information neither owner provides.
If it acquires subscriptions or other disposable resources, its creator owns
cleanup for the chosen lifetime.

Name the factory and instance for the information they own. New read methods
can be `selectedId()`, `items()`, or `state()`; existing getters, `.current`, or
`.value` remain valid where their owning API defines them. Svelte does not
require one universal property name for reactive values.

## A module that owns a snapshot and subscription

The small selection example does not show source acquisition or cleanup.
This fuller factory illustrates those responsibilities. It assumes a
synchronous, nonreactive `AppData` source whose changes must be followed for
the factory's whole lifetime, including while no view is mounted. Imperative
consumers need the latest successful snapshot too. `reportBackgroundError`
is the app's error boundary; on a failed read this owner keeps its last good
snapshot. It is not a wrapper to add around an already-reactive capability.

```ts
// bookmark-state.svelte.ts
function createBookmarkState(db: AppData) {
  let rows = $state.raw<Bookmark[]>([]);

  function read() {
    const { data, error } = db.bookmarks.list();
    if (error !== null) return reportBackgroundError(error);
    rows = data.rows;
  }

  read();
  const stop = db.bookmarks.subscribe(read);
  const bookmarks = $derived(rows.filter((bookmark) => bookmark.deletedAt === null));

  return {
    [Symbol.dispose]: stop,
    bookmarks: () => bookmarks,
  };
}
```

Its creator disposes the module when that chosen lifetime ends. Add domain
operations alongside the read when this owner actually owns those rules.
For a source whose subscription should exist only while reactive readers use
it, prefer `createSubscriber` instead of introducing this retained snapshot
and explicit subscription lifetime. Read an existing capability through
`reactive` rather than create either bridge again.

Names can make those responsibilities easier to see:

| Concern | Convention | Example |
|---|---|---|
| Factory | `createX()` names the owner being made | `createBookmarkState()` |
| Instance | A noun for the information it owns | `bookmarkState`, `deviceConfig`, `vadRecorder` |
| File | Domain name, optionally with `-state` | `bookmark-state.svelte.ts`, `selection.svelte.ts` |

Use the `State` suffix when the instance name would collide with a read:
`bookmarkState.bookmarks()`, rather than `bookmarks.bookmarks()`. This names the
owner without prescribing a singleton. Existing single-value wrappers may use
`.current`; a new read can be `selectedId()` or `state()`. Preserve an owning
API's `.current`, `.value`, or getter contract instead of renaming it by habit.
