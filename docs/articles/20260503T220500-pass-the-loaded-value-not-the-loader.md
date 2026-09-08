# Pass the Loaded Value, Not the Loader

If your factory takes a thing-that-loads and one of its first acts is to await it, you have built a factory with a sync surface and an async interior. That seam costs you bookkeeping: a "did we finish loading yet" flag, a nullable cleanup handle, a deferred to escape if someone disposes mid-load, and a public "wait for me" promise. None of those exist if the caller does the loading and passes the loaded value in.

```ts
// Before: factory takes a loader, hides the await
function createThing({ storage }: { storage: { load(): Promise<T>, save(v: T): void } }) {
    let value: T | null = null;
    let ready = false;
    let disposed = false;
    let cleanup: (() => void) | null = null;

    const whenReady = (async () => {
        value = await storage.load();
        if (disposed) return;
        ready = true;
        cleanup = subscribe((next) => { /* if (disposed) return; */ });
    })();

    return {
        get value() { return value; },
        whenReady,
        [Symbol.dispose]() { disposed = true; cleanup?.(); },
    };
}

// After: caller loads, factory takes the loaded value
function createThing({ initialValue, save }: { initialValue: T, save: (v: T) => void }) {
    let value = initialValue;
    const cleanup = subscribe((next) => { value = next; save(next); });
    return {
        get value() { return value; },
        [Symbol.dispose]() { cleanup(); },
    };
}
```

The initialized behavior stays inside the smaller factory. Loading, failure, and cancellation move to its caller. No flags, no nullable handle, no deferred, no `whenReady` on the public type. The async window the bookkeeping was guarding does not exist anymore, because there is no async window inside the factory.

## The bookkeeping is the receipt for sync-construction-with-async-init

If a factory exposes data before loading completes, it needs a defined rule for
premature access. A render gate can supply that rule for UI consumers: their
instance code does not execute until the data is ready. That does not require
four defensive guards in four child components.

Moving the load outward simplifies a factory whose job is to operate on loaded
data. It does not eliminate the opening owner's responsibility for cancellation
or failed acquisition. A session exposing only `opened` and `close` can own that
responsibility without exposing a half-ready data API.

## "Maybe async" inputs are the worst kind

A `MaybePromise<T>` parameter (load returns either a value or a promise) is a tax on every consumer. The factory has to await it unconditionally because it does not know which case it got. The async-window bookkeeping is there even when the actual implementation is synchronous. You pay the cost of the worst case in every case.

Hoisting changes the calculus. The caller knows whether their storage is sync or async, and reacts accordingly:

```ts
// Sync source: no await, no boot ceremony
const initialValue = state.get();
const thing = createThing({ initialValue, save: state.set });

// Async source: caller awaits at boot, then constructs
const initialValue = await keychain.load();
const thing = createThing({ initialValue, save: keychain.save });
```

The factory does not branch. The caller is honest about which world they are in. The async-only callers pay the await once, at boot, in the place that already has an async context.

## Render-gating handles the rest

The argument for sync construction is usually "I want to export the thing from a module so UI components can read it without awaiting." That argument still holds after hoisting. The async loaders that cannot be made sync (keychain, IndexedDB, network) need exactly one render-gate at the app shell:

```svelte
{#await app.idb.whenLoaded}
  <Loading />
{:then}
  {@render children()}
{:catch error}
  <ErrorState {error} />
{/await}
```

The gate waits for the prerequisites the rendered subtree actually needs. Local initialization need not wait for a network connection. The gate is the right layer for "wait until startup is done", not the inside of every factory that participates in startup.

## The test

Look at the lets and consts at the top of your factory. Are any of them lifecycle bookkeeping? A boolean for "init done", a nullable for "cleanup not yet registered", a deferred for "let awaiters escape on early teardown"? If yes, ask whether this factory owns resource acquisition or only operates on a loaded value. Move the await up in the second case; keep lifecycle coordination with the acquisition owner in the first.

The bigger lesson: a function's parameter list is also its claim about when work happens. `storage: { load, save }` says "I will do the loading inside me." `{ initialValue, save }` says "you have already loaded; I just keep going." The second form is almost always the one that scales.

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
