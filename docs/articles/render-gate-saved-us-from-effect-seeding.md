# Gate Rendering to Avoid Effect Seeding

[PR #1376](https://github.com/EpicenterHQ/epicenter/pull/1376) · See also: [Gate the Component, Not the Data](/docs/articles/gate-the-component-not-the-data.md) (the general pattern)

We had a singleton service called [`browserState`](https://github.com/EpicenterHQ/epicenter/blob/9b893eddc/apps/tab-manager/src/lib/state/browser-state.svelte.ts) that manages all browser windows and tabs for a tab manager extension. It's constructed synchronously at module scope so any component can import it, but the actual data comes from an async call to the browser API. The service starts empty and fills in after the seed resolves.

```typescript
// browser-state.svelte.ts: the singleton
function createBrowserState() {
  const windowStates = new SvelteMap<WindowCompositeId, WindowState>();

  // Fires immediately, resolves later
  (async () => {
    const browserWindows = await browser.windows.getAll({ populate: true });
    for (const win of browserWindows) {
      windowStates.set(win.id, toWindowState(win));
    }
  })();

  return {
    get windows() { return [...windowStates.values()].map((s) => s.window) },
  };
}

export const browserState = createBrowserState();
```

The question: a child component needs to derive local state from `browserState.windows` at construction. But at construction, `windows` is empty. How do you initialize state that depends on async data?

```
Timeline
────────
  t=0   createBrowserState() returns         browserState.windows = []
  t=1   Component mounts, reads windows      SvelteSet initialized with []
  t=2   Async seed resolves                  browserState.windows = [win1, win2, ...]
                                             ...but SvelteSet already constructed
```

## The Bug

[`FlatTabList.svelte`](https://github.com/EpicenterHQ/epicenter/blob/9b893eddc/apps/tab-manager/src/lib/components/FlatTabList.svelte) renders browser windows as collapsible headers with tabs underneath, using a virtualized list. At construction, it creates a `SvelteSet` seeded with the focused window's ID so that window starts expanded.

```typescript
// FlatTabList.svelte
const expandedWindows = new SvelteSet<WindowCompositeId>(
  browserState.windows.filter((w) => w.focused).map((w) => w.id),
);
```

This looks right. But `browserState.windows` is always `[]` here because the async seed hasn't resolved. The `SvelteSet` starts empty. Every window stays collapsed.

```
createBrowserState()       FlatTabList mounts        Async seed resolves
        │                        │                         │
        │  windows = []          │                         │
        │───────────────────────>│                         │
        │                        │                         │
        │                        │  new SvelteSet([])      │
        │                        │  (empty, no focused    │
        │                        │   window found)         │
        │                        │                         │
        │                        │                   windows = [A, B, C]
        │                        │                   (too late: set already
        │                        │                    constructed)
```

## Fix 1: Effect Seeding

Our first attempt was to make the component watch for data arrival using `$effect`.

```svelte
<!-- FlatTabList.svelte. The $effect approach -->
<script>
  const expandedWindows = new SvelteSet<WindowCompositeId>();

  let hasSeeded = false;
  $effect(() => {
    const focused = browserState.windows.filter((w) => w.focused);
    if (hasSeeded || focused.length === 0) return;
    for (const w of focused) expandedWindows.add(w.id);
    hasSeeded = true;
  });
</script>
```

The effect subscribes to `browserState.windows`. When the async seed resolves and the windows array goes from `[]` to `[win1, win2, ...]`, the effect fires, finds the focused window, and adds it to the set. The `hasSeeded` flag prevents it from re-seeding on subsequent updates.

```
createBrowserState()       FlatTabList mounts        Async seed resolves
        │                        │                         │
        │  windows = []          │                         │
        │───────────────────────>│                         │
        │                        │                         │
        │                        │  new SvelteSet()        │
        │                        │  $effect registered     │
        │                        │  (effect runs, sees     │
        │                        │   empty, does nothing)  │
        │                        │                         │
        │                        │                   windows = [A, B*, C]
        │                        │                         │
        │                        │  $effect re-runs ◄──────│
        │                        │  finds B (focused)      │
        │                        │  expandedWindows.add(B)  │
        │                        │  hasSeeded = true        │
```

This works. But the component is now responsible for handling the timing of a service it doesn't own. Every new component that needs data at construction would need its own `$effect` with its own `seeded` flag.

## Fix 2: The Render Gate

The real fix was structural. Instead of making the component deal with the timing, we made the component not exist until the timing was resolved.

The service side: capture the fire-and-forget IIFE as a promise and [expose it](https://github.com/EpicenterHQ/epicenter/blob/9b893eddc/apps/tab-manager/src/lib/state/browser-state.svelte.ts#L83-L109).

```typescript
// browser-state.svelte.ts: BEFORE
(async () => {
  const browserWindows = await browser.windows.getAll({ populate: true });
  // ... populate windowStates ...
})();

return {
  get windows() { ... },
  // no way for consumers to know when data is ready
};
```

```typescript
// browser-state.svelte.ts: AFTER
const whenReady = (async () => {
  const browserWindows = await browser.windows.getAll({ populate: true });
  // ... populate windowStates ...
})();

return {
  whenReady,
  get windows() { ... },
};
```

The UI side: [`App.svelte`](https://github.com/EpicenterHQ/epicenter/blob/9b893eddc/apps/tab-manager/src/entrypoints/sidepanel/App.svelte#L43-L54) awaits the promise before rendering children.

```svelte
<!-- App.svelte -->
{#await browserState.whenReady}
  <div class="flex-1 flex items-center justify-center">
    <p class="text-sm text-muted-foreground">Loading tabs…</p>
  </div>
{:then}
  <Tabs.Content value="windows" class="flex-1 min-h-0 mt-0">
    <FlatTabList />
  </Tabs.Content>
  <Tabs.Content value="saved" class="flex-1 min-h-0 mt-0">
    <SavedTabList />
  </Tabs.Content>
{/await}
```

Now `FlatTabList` only mounts after `whenReady` resolves. By the time its `<script>` block runs, `browserState.windows` is populated. The [original one-liner](https://github.com/EpicenterHQ/epicenter/blob/9b893eddc/apps/tab-manager/src/lib/components/FlatTabList.svelte#L14-L19) works.

```typescript
// FlatTabList.svelte: back to the simple version
const expandedWindows = new SvelteSet<WindowCompositeId>(
  browserState.windows.filter((w) => w.focused).map((w) => w.id),
);
```

```
createBrowserState()       App.svelte                 FlatTabList
        │                      │                          │
        │                      │                          │
        │                      │  {#await whenReady}      │
        │                      │  show "Loading tabs…"    │
        │                      │                          │
        │  seed resolves       │                          │
        │  windows = [A,B*,C]  │                          │
        │─────────────────────>│                          │
        │                      │                          │
        │                      │  {:then}                 │
        │                      │  mount FlatTabList ──────>│
        │                      │                          │
        │                      │                          │  read windows → [A, B*, C]
        │                      │                          │  SvelteSet = { B }  ✓
```

## The Difference

| Aspect | $effect seeding | Render gate |
| :--- | :--- | :--- |
| Who handles timing | Each component, independently | Once, in the parent |
| Component code | Effects, flags, guards | Plain synchronous constructors |
| Adding new components | Must duplicate effect pattern | No extra work |
| UX | Content shifts as effects fire | Clean loading → ready transition |

The `$effect` approach treats the symptom: data isn't there yet, so wait for it. The render gate treats the cause: the component shouldn't exist yet. One `{#await}` at the root means every child component lives in a world where the data already exists. No component needs to wonder whether the service has finished initializing.

If a component derives local state from async service data, don't seed it with an effect. Gate the component so it only mounts after the data is ready. See [Gate the Component, Not the Data](/docs/articles/gate-the-component-not-the-data.md) for the general pattern, and the [sync construction, async property](/docs/articles/sync-construction-async-property-ui-render-gate-pattern.md) article for the underlying approach.

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
