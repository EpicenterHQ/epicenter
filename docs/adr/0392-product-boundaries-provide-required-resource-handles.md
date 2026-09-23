# 0392. Product boundaries provide required resource handles

- **Status:** Proposed
- **Date:** 2026-09-12
- **Amends:** [ADR-0369](0369-an-application-page-owns-one-library-and-changing-it-ends-the-page.md) at one-library opening and [ADR-0355](0355-local-and-account-sessions-share-the-application-data-api.md) at destination selection: products acquire concrete handles while store operations retain their common contract.
- **Amends:** [ADR-0413](0413-app-boot-owns-the-working-page-lifetime.md) at UI distribution: ready shared handles use typed Svelte context rather than an intact App passed through descendants; the browser/WebView still owns the working lifetime.
- **Unbuilt:** Independent local readiness, required personal contexts, named get/set accessors, and migration of Whispering consumers away from the optional-personal App facade.

## Context

Whispering's `openWhisperingResources` returns Local, optional Personal, blobs,
recording, and inference access. `WhisperingShell` supplies a context containing
the broad App. A dictionary editor still writes through `app.personal?.kv`,
and unrelated local startup waits for Personal acquisition when signed in.

Exporting a live `app` promise would make acquisition an import side effect.
Passing required handles through every component would expose dependencies in
props, but repeat the same types and forwarding through routed UI. The useful
boundary is readiness: a personal editor can mount only after its store opens.

## Decision

**A mounted product boundary acquires handles and renders each consumer only when its required handles are ready.**

Store opening uses `openLocal(definition)` and
`openPersonal(definition, { account })`. Capability constructors use their own
required inputs. Each store supplies its required `.blobs` capability; the
boundary does not open or close blobs separately. The target resource API is described in
[ADR-0423](0423-app-resources-open-as-independent-handles.md); inference and saved
catalogs have separate constructors in
[ADR-0365](0365-ai-owns-inference-access-and-applications-own-workflow-selection.md).

A personal-dependent branch receives a definite Account and awaits
`openPersonal(definition, { account })` before mounting its ready children.
Its personal handle is required. Sign-in presentation, loading, and opening
failure belong to that boundary. A definite Account does not require successful
fresh network verification; cached offline access remains possible.

The mounted working layout starts acquisition once for its browser/WebView
lifetime. A product may factor composition into an async function, named for
the product, such as `openWhispering`. That is an application helper, not a new
SDK App owner. Neither `export const app = openWhispering()` nor eager exports
of individual live handles establish the owner. Module imports acquire nothing.

**Shared application handles use typed Svelte context with `get*` and `set*` accessors.**

Name the store handles `local` and `personal`. Name a workflow's concrete selected
destination `store`. `remote` describes remote blob access, not an account store
that also works offline. No separate data-selection handle or primitive is introduced.
This vocabulary change does not rename existing durable keys.

The target context shape is:

```ts
// Product context module. Types derive from the concrete opened/adapted handles.
export const [getLocal, setLocal] = createContext<LocalData>();
export const [getPersonal, setPersonal] = createContext<PersonalData>();
export const [getStore, setStore] = createContext<RecordingStore>();
export const [getRecorder, setRecorder] = createContext<Recorder>();
```

These are target application declarations, not existing exports. Add contexts
for capabilities actual consumers share; do not mirror every constructor in a
registry. Do not add `usePersonal` or `providePersonal` aliases.

The ready shell publishes each shared handle synchronously during component
initialization. Descendants call `getPersonal()` during their own initialization
and receive the handle, not an optional value, promise, or readiness controller.
An existing shell can provide context; a separate provider component earns its
place only when it establishes a needed initialization/readiness boundary.

```svelte
<!-- Ready shell: personal is a required, resolved prop. -->
<script lang="ts">
  setPersonal(fromData(personal));
</script>
```

```svelte
<!-- A descendant mounted inside that ready branch. -->
<script lang="ts">
  const personal = getPersonal();
  const dictionary = $derived(personal.kv.get('dictionary') ?? []);
</script>
```

The snippets isolate the context calls; imports and prop declarations are
omitted. `fromData` makes store reads reactive. Context only distributes the
result. Passing the same adapted handle through a prop would preserve reactivity.
Props remain appropriate for component-specific values and callbacks, and for
supplying the required handle to its ready shell.

Calling a context getter outside its provider is a programming error. Typed
context does not statically prove component placement. Unlike optional handle
checks, a missing provider must fail visibly rather than disable a write silently.
Do not call context getters from ordinary operation modules or event callbacks;
capture the dependency during component initialization and pass it explicitly.

**Local readiness and account readiness are independent of the selected recording destination.**

A route that supports Local without sign-in receives Local. A route that works
with either store receives the concrete selected store. It does not rediscover
its destination from ambient auth. URL changes, local recording policy, and
copying into Personal remain product decisions; this record does not prescribe
new `/local` or `/personal` routes.

A signed-in person can record into Local and use personal dictionary, prompt,
recipes, and account-backed inference. Do not equate Local selection with being
signed out. Personal acquisition must not gate local capture or playback.
Selecting Personal as the recording destination does require its readiness;
failure must never silently send that recording to Local.

```text
Working browser/WebView: captured account context and departure fence
|-- Local (tables, KV, blobs) -> recorder -> local recording readiness
|-- Account -> Personal (tables, KV, remote blobs) -> personal-dependent ready UI
`-- Inference -> its own feature readiness

Recording operation -> fixed selected store + blobs + captured inputs + signal
```

This is a dependency graph, not a component hierarchy. Personal becoming ready
must not remount an active local recording workflow. Built-in recipes and local
controls remain available without a Personal store. Missing settings inside a
ready store still need their ordinary value defaults.

A failed or pending personal open is not an empty dictionary. A workflow that
needs personal inputs waits for their readiness or reports that feature
unavailable while preserving saved audio. Do not silently replace account
customization with defaults. Signed-out built-in behavior remains available.

Account-backed inference remains separate from Personal data and can open
without a synchronized document. Remote blobs belong to `personal.blobs` and
require that store to open. Required
handles eliminate account-presence branches inside consumers, not network
failures, account retirement, or resource closure.

UI context distributes borrowed capabilities. The product composition owns
acquisition; a component does not close a shared root merely because it unmounts.
The browser/WebView ownership policy and operation cancellation remain explicit.
Context and `{#await}` do not cancel work, close resources, prove a save, or
invalidate a retained handle. Account replacement retires the existing working
lifetime rather than replacing a value inside its context.

Account retirement itself fences network authority, not the cached Personal
store. The product working-lifetime owner closes or replaces Personal on
departure. An outage or sign-out does not invalidate its document generation
or delete pending edits. Retained handles never adopt a successor account.

In SvelteKit, acquire these client/Tauri resources in the admitted working
`+layout.svelte` branch or its mounted owner. Keep callback, overlay, sign-in,
and stopped/recovery surfaces free of primary resource acquisition. Universal
`+layout.ts` load can return non-serializable values, but its rerun/preload
behavior is not the ownership boundary for these handles. Server load and
request `locals` do not own browser resources. Whispering currently disables
SSR; enabling it would require an explicit browser-only acquisition boundary.

## Consequences

Personal editors lose optional-store checks and silent no-op writes. Shared
components lose repeated handle props and type imports. A workflow retains its
original handles and cancellation scope rather than resolving a successor from
global state. Existing product callers require an explicit migration.

The cost is a component-placement contract checked at runtime. Readiness and
failure presentation still exist at the entrance, and operations still own
cancellation across awaits. Local availability means independent acquisition;
it does not promise uninterrupted recording across account replacement.

## Considered alternatives

- Preserve a union or optional account scope everywhere: propagates sign-in
  policy into components that require an account resource.
- Silently use Local when Personal is missing: changes the write destination.
- Put all resources on `device`: recreates an aggregate with unrelated lifetimes.
- Gate every route on sign-in: removes useful local-only workflows.
- Export a live application promise: makes imports acquire resources and caches
  failed or retired access outside the mounted working owner.
- Require props for every shared handle: repeats forwarding across descendants
  and does not directly cross SvelteKit's framework-owned route snippet.
- Resolve every capability before mounting any UI: lets an account feature's
  failure block independent local recording.

## Framework grounding

- [Svelte context](https://svelte.dev/docs/svelte/context) and
  [createContext](https://svelte.dev/docs/svelte/svelte#createContext) define
  typed accessors and the missing-provider failure.
- [SvelteKit state management](https://svelte.dev/docs/kit/state-management)
  describes tree-scoped context and preserved component instances.
- [SvelteKit load](https://svelte.dev/docs/kit/load#Rerunning-load-functions)
  describes reruns without component recreation.

The 2026-09-22 review checked DeepWiki for `sveltejs/svelte` and `sveltejs/kit`,
then verified context initialization and await-branch behavior against the
installed Svelte source. A child mounted after a parent's await resolves can
set context during its own synchronous initialization.
