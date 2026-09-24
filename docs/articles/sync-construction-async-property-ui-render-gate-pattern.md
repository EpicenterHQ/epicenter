# Sync Construction, Async Property, UI Render Gate Pattern

Export the app synchronously, then wait once before rendering the components
that use its initialized data. The children do not render until the promise is
done. Their instance scripts can read the shared handle directly.

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

## Pass a ready app once, then use context in descendants

Passing the resolved value need not become prop drilling. The gate passes it to
one provider component, which sets context during component initialization.
Intermediate components need no `app` prop. These are conceptual Svelte examples;
`App` is the ready application type and UI imports are omitted.

```ts
// app-context.ts
import { createContext } from 'svelte';
import type { App } from './app-types';
export const [getApp, setApp] = createContext<App>();
```

```svelte
<!-- Parent.svelte: alternative with an owned session -->
<script>
  import { onDestroy } from 'svelte';
  const session = epicenter.openLocal(); // Proposed Epicenter API.
  onDestroy(() => { void session.close(); });
</script>

{#await session.opened}
  <Loading />
{:then result}
  {#if result.error}
    <OpenFailure error={result.error} />
  {:else}
    <AppProvider app={result.data}>
      <Recordings />
    </AppProvider>
  {/if}
{/await}
```

```svelte
<!-- AppProvider.svelte -->
<script>
  import { setApp } from './app-context';
  let { app, children } = $props();
  setApp(app);
</script>

{@render children()}
```

```svelte
<!-- Recordings.svelte: alternative to a singleton import -->
<script>
  import { getApp } from './app-context';
  const app = getApp();
  const recordings = app.tables.recordings;
</script>
```

The provider belongs to one session identity and must be recreated if that
identity changes. Context is useful when local and account libraries, or two
editors, coexist in separate subtrees. A client-only singleton is simpler when
there truly is one app instance. Context distributes the value; the render gate
establishes readiness. [Svelte context](https://svelte.dev/docs/svelte/context)

A synchronous session with `opened` and `close` has a further job: the owner can
close it before opening completes. An async opener can support cancellation too,
but needs an explicit signal or late-result cleanup. Render gating works with
either promise shape; it does not decide resource ownership.

See [Gate the Component, Not the Data](gate-the-component-not-the-data.md) for
replacing effect seeding, [the tab-manager example](render-gate-saved-us-from-effect-seeding.md)
for the original bug, and [await in every method](idb-await-every-method-pattern.md)
for a lower-level API whose operations are all asynchronous.
