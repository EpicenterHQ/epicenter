# Svelte Lifecycle And Reactivity Patterns

Detailed Svelte 5 guidance for keyed resources, async gates, stable owners, finite union mapping, reactive collections, and state modules.

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
cancellation and cleanup with the operation's owner.

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

## A caller can own the initial wait

The [dashboard auth module](../../../../apps/api/ui/src/lib/platform/auth.ts) constructs its client synchronously and exports `authReady = client.refresh()` for the first cookie-session read. The [layout](../../../../apps/api/ui/src/routes/dashboard/+layout.svelte) waits on that promise once with `{#await authReady}`. Later sign-ins are changes to `auth.state()`. In the signed-in branch, `{#key signIn.account}` gives each account its own dashboard session.

The promise answers “has the first read finished?” The live state answers “who is signed in now?” A later refresh can change that answer after the promise has settled.

## Related

- `docs/articles/svelte-5-createsubscriber-pattern.md` covers `createSubscriber` for wrapping external event sources into reactive values: a different job than component-scoped handles.
- `docs/articles/20260420T160000-state-handle-null-is-the-component-lifecycle-in-disguise.md` walks through why this rule exists and when Pattern B is still correct.

# Stable adapters and reactive reads

An adapted capability keeps its methods. Reading `auth.state()` in markup,
`$derived`, or an effect tracks the capability. Reading it in component setup
or an event handler takes a snapshot. Actions pass through untracked, so an
effect can call `void ai.refresh()` without subscribing to that action.
See [the adapter contract](../../../../packages/svelte/README.md#one-adapter-for-every-capability).

A check on one call to `auth.state()` cannot narrow the answer to a second
call. Read it once when several expressions need the same answer. The
dashboard uses `const signIn = $derived(auth.state())` in both script and
markup. Within a template block, [a single `{@const}`](component-ui-patterns.md#template-locals-narrow-reactive-values-before-use)
can do the same job. Both locals follow later changes.

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

## Derived computations and read APIs

Use a direct read for a cheap computation. Use `$derived` when a computation
benefits from caching or a consumer depends on stable output identity. A method
or getter that reads reactive state can track changes, but each call recomputes
its body unless it returns an already derived value. See
[the projection example](component-ui-patterns.md#referential-stability-for-reactive-data-sources).

For new APIs, expose live reads through explicit methods, following
[typescript](../../typescript/SKILL.md). Keep existing getters and upstream
protocols when callers rely on them.

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
| Browser API keyed data | `new SvelteMap()` + listeners | media devices, windows |
| Reactive membership | `new SvelteSet()` | expanded row IDs when only membership matters |
| Primitive value | `$state(value)` | `$state(false)`, `$state('')`, `$state(0)` |
| Replace-only ordered data | `$state.raw<T[]>([])` | command history, open file tab order |

Project collections to arrays with `$derived` when consumers depend on stable
identity. Follow [referential stability](component-ui-patterns.md#referential-stability-for-reactive-data-sources)
to check whether a consumer observes reference identity.

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
