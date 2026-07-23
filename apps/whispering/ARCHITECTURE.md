# Whispering Architecture Deep Dive

Whispering uses a clean three-layer architecture that shares one SPA between its browser deployment and the Epicenter desktop host. This is possible because platform differences are selected at build time and business logic stays separate from UI concerns.

**Quick Navigation:** [Service Layer](#service-layer---pure-business-logic--platform-abstraction) | [Query Layer](#query-layer---adding-reactivity-and-state-management) | [Error Handling](#error-handling-with-wellcrafted)

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│  UI Layer   │ --> │ Query Layer │ --> │ Service Layer│
│ (Svelte 5)  │     │ (TanStack)  │     │   (Pure)     │
└─────────────┘     └─────────────┘     └──────────────┘
      ↑                    │
      └────────────────────┘
         Reactive Updates
```

## Record composition

Whispering binds its inert Lens through one environment-owned record Epicenter, acquired as one ready app inside the mounted Svelte root:

```txt
defineLens()                            src/lib/data/lens.ts (inert projection)
  -> openWhisperingApp()        src/lib/whispering/app.ts (transactional async open)
    -> #platform/whispering             whisperingPlatform: the per-build dependencies
      -> openWhisperingUiSession()      src/lib/whispering/ui-session.ts (app + query runtime)
        -> (app)/+layout.svelte         raw {#await} owns pending / ready / failed
          -> WhisperingUiSessionProvider      typed context for ready-only descendants
```

`src/lib/data/lens.ts` defines the Whispering Lens, its record tables, and its settings collection with no platform APIs. `openWhisperingApp(whisperingPlatform, { signal })` opens the record Epicenter supplied by the environment, hydrates settings, recordings, and recipes, and resolves only when those UI-free product namespaces are ready. Any failure releases everything it opened and rejects. The (app) layout wraps that open in one UI session (`openWhisperingUiSession`), which composes the Svelte reactivity adapters, a session-scoped TanStack `QueryClient`, and the query namespace over the ready app, and owns their ordered disposal. The layout creates the session promise during component initialisation, so the `{#await}` observes it from the first microtask. The fulfilled branch mounts `WhisperingUiSessionProvider`, which publishes only the ready session: typed `getWhisperingApp()` and `getWhisperingQueries()` context plus the session's query client. Boot retry is a full page reload; unmount or HMR aborts acquisition, and the layout is the single owner of session disposal. Bun scripts import `@epicenter/whispering/app` and `@epicenter/whispering/app/bun`, then use the same product API: `await using app = await openWhisperingApp(createWhisperingBunDependencies({ dataDir }))`. That `dataDir` roots one record replica and its blob obligations.

The `#platform/whispering` leaves bind the platform's record Epicenter: the web build (`whispering.browser.ts`) selects the device or account browser owner from the boot auth state (`whispering.browser-runtime.ts`); the Epicenter-hosted build (`whispering.tauri.ts`) uses the same-origin desktop record owner, whose `open` performs an honest host acquisition handshake. The app's recordings namespace owns scalar and immutable audio consistency at one record address. Scalar rows live in runtime-native SQLite; row documents are lazy Yjs 14 documents behind the record runtime's document provider (ADR-0144).

## Service Layer - Pure Business Logic + Platform Abstraction

The service layer contains all business logic as **pure functions** with zero UI dependencies. Services don't know about reactive Svelte variables, user settings, or UI state. They only accept explicit parameters and return `Result<T, E>` types for consistent error handling.

The key innovation is **build-time platform resolution** via Node-standard `#platform/*` subpath imports. Each platform-bound service lives in a folder with both implementations as sibling files plus a shared contract; the app's `package.json` `imports` map points each seam at the matching file per build condition:

```
src/lib/services/recorder/
  index.browser.ts    Browser MediaRecorder APIs
  index.tauri.ts      Tauri recorder plugin
  types.ts            Shared contract both impls are annotated with
```

```jsonc
// package.json
{
  "imports": {
    "#platform/recorder": {
      "tauri": "./src/lib/services/recorder/index.tauri.ts",
      "default": "./src/lib/services/recorder/index.browser.ts"
    }
  }
}
```

The Tauri build activates the `tauri` condition; the web build falls through to `default` (browser):

```ts
// vite.config.ts
const isEpicenterSurface = process.env.EPICENTER_SURFACE === '1';
export default defineConfig(async () => ({
  resolve: {
    // The `...defaultClientConditions` spread is load-bearing: custom
    // conditions REPLACE Vite's defaults rather than adding to them.
    ...(isEpicenterSurface && {
      conditions: ['tauri', ...defaultClientConditions],
    }),
  },
}));
```

Consumers (for example the services barrel `src/lib/services/index.ts`) import the bare specifier `from '#platform/recorder'` with **no platform branch at the call site**. Vite resolves `index.tauri.ts` on Tauri builds and `index.browser.ts` on web builds; the off-target file is never resolved, so it is physically absent from the bundle (a build-time guarantee, not Rollup tree-shaking). This makes the web bundle structurally unable to ship Tauri APIs and vice versa: a Tauri-only file imported by shared code fails the web build instead of shipping a broken runtime.

This mechanism is scoped to `#platform/*` only; every other bare import resolves normally. The browser typecheck uses the default condition, and `tsconfig.tauri.json` repeats the check with the `tauri` condition. Each impl is annotated with the shared contract (`export const x: Contract = ...`, not `satisfies`, so the concrete type stays hidden and the variants stay in lockstep).

Tauri-only exports (Whispering's `tauriOnly` namespace in `src/lib/tauri.tauri.ts`) are imported **directly** by `.tauri.ts` files (`import { tauriOnly } from '$lib/tauri.tauri'`), not through a `#platform/*` seam, since that seam is null on web. Shared code that only needs the platform boolean reaches it through `import { tauri } from '#platform/tauri'` and checks `if (tauri)`.

Services are **testable** (just pass mock parameters), **reusable** (work identically anywhere via the shared contract in `types.ts`), and **maintainable** (no hidden runtime branches).

The codebase distinguishes two kinds of "which implementation" decisions and uses different mechanisms for each. See `docs/articles/20260526T012650-two-switches-build-time-and-runtime.md` for the walkthrough.

**→ Learn more:** [Services README](./src/lib/services/README.md) | [Constants Organization](./src/lib/constants/README.md)

## Query Layer - Adding Reactivity and State Management

The query layer (`$lib/queries`) is where TanStack Query reactivity gets injected on top of the ready app and pure services. One `WhisperingUiSession` owns one `QueryClient` and one `WhisperingQueries` namespace; there is no module-global client. Components reach both through context:

```svelte
<script>
  import { createQuery } from '@tanstack/svelte-query';
  import { getWhisperingApp, getWhisperingQueries } from '$lib/whispering/context';

  const app = getWhisperingApp();
  const queries = getWhisperingQueries();

	// Domain data: record state (reactive, no queries needed)
	const latestRecording = $derived(app.recordings.sorted[0]);

	// Audio playback: TanStack owns the async read or host media URL for this
	// record's immutable blob.
	const audio = createQuery(
		() => queries.audio.recording(() => latestRecording.id).options,
	);
</script>
```

**Record state**: The UI-free app owns domain data (recordings, recipes, settings). Thin `$lib/state/*.svelte.ts` adapters add `createSubscriber` tracking, so components react to the same namespaces that Bun scripts use.

The query layer's role has narrowed to asynchronous work that does not belong in the live scalar projection:

- **External APIs**: Transcription mutations (`queries.transcription.*`) around the transcription operations
- **Microphone enumeration**: Async device list with loading states (`manualRecorder.enumerateDevices`). Recorder state itself lives in `$lib/state/manual-recorder.svelte.ts` and `$lib/state/vad-recorder.svelte.ts` as `$state`, not queries.
- **Audio blob access**: Each recording owns one immutable blob at its record address. The browser reads it from its record owner; desktop playback and downloads use the host media URL (`queries.audio.recording`, `queries.download.downloadRecording`).

This design keeps services pure and platform-agnostic while giving the UI immediate reactivity for domain data and cached access for external resources.

**→ Learn more:** [Queries README](./src/lib/queries/README.md) | [State README](./src/lib/state/README.md)

## Error reporting

Services and operations return tagged errors built with `defineErrors` from `wellcrafted/error`. The call site decides what the user should see by calling `report.error`, `report.info`, `report.success`, or `report.loading` from `$lib/report`. The toast and OS notification surfaces are sinks the spine fans out to; the per-event copy is inline at the call site, not a translator function.

```typescript
const { data, error } = await services.recorder.startRecording(...);

if (error) {
  // Default: title is humanized from error.name, description is error.message,
  // a "More details" action opens the raw error.
  report.error({ cause: error });
  return;
}

// Inline override only when context-specific copy or an action helps:
if (error) {
  report.error({
    cause: error,
    title: 'Authentication required',
    action: { label: 'Update API key', onClick: () => goto('/settings') },
  });
  return;
}
```

## Error Handling with WellCrafted

Whispering uses [WellCrafted](https://github.com/wellcrafted-dev/wellcrafted), a lightweight TypeScript library I created to bring Rust-inspired error handling to JavaScript. I built WellCrafted after using the [effect-ts library](https://github.com/Effect-TS/effect) when it first came out in 2023. I was very excited about the concepts but found it too verbose. WellCrafted distills my takeaways from effect-ts and makes them better by leaning into more native JavaScript syntax, making it perfect for this use case. Unlike traditional try-catch blocks that hide errors, WellCrafted makes all potential failures explicit in function signatures using the `Result<T, E>` pattern.

`wellcrafted` ensures robust error handling across the entire codebase, from service layer functions to UI components, while maintaining excellent developer experience with TypeScript's control flow analysis.

## Architecture Patterns

- **Service Layer**: Platform-agnostic business logic with Result types
- **Query Layer**: Reactive data management with caching, scoped to one UI session (`queries.audio.*`, `queries.transcription.*`, `queries.download.*`)
- **Dependency Injection**: Clean separation of concerns

## Key Architectural Decisions

1. **Pure Functions Over Classes**: Services are functions, not classes, making them easier to test and compose
2. **Explicit Error Handling**: Every function that can fail returns a Result type
3. **Platform Abstraction at Build Time**: Platform detection happens once, not at runtime
4. **Three Clear Layers**: Each layer has a specific responsibility with clear boundaries
5. **TypeScript Throughout**: Full type safety from services to UI components
