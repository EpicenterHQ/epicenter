# Whispering Architecture Deep Dive

Whispering uses a clean three-layer architecture that shares one SPA between its browser deployment and the Epicenter desktop host. This is possible because platform differences are selected at build time and business logic stays separate from UI concerns.

**Quick Navigation:** [Service Layer](#service-layer---pure-business-logic--platform-abstraction) | [RPC Layer](#rpc-layer---adding-reactivity-and-state-management) | [Error Handling](#error-handling-with-wellcrafted)

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│  UI Layer   │ --> │  RPC Layer│ --> │ Service Layer│
│ (Svelte 5)  │     │ (TanStack)  │     │   (Pure)     │
└─────────────┘     └─────────────┘     └──────────────┘
      ↑                    │
      └────────────────────┘
         Reactive Updates
```

## Workspace Composition

Whispering uses the same workspace composition vocabulary as the rest of the repo across browser and Epicenter-hosted builds:

```txt
defineWorkspace()
  -> defineWhispering(defaultTranscriptionService)
    -> openWhisperingBrowser({ auth, defaultTranscriptionService })
```

`defineWhispering(defaultTranscriptionService)` in `src/lib/workspace/definition.ts` is the shared model factory. It defines the fixed workspace id, tables, and KV schema with no platform APIs; the platform argument only changes read-side KV defaults.

`openWhisperingBrowser({ auth, defaultTranscriptionService })` in `src/lib/whispering/whispering.active.ts` is the shared browser/Tauri runtime opener. It connects once at boot with `toWorkspaceConnection(auth)`, layers the recording markdown export, and aliases `storage.whenLoaded` as `whenReady`; settings metadata comes from the workspace's own `kv.keys` / `kv.getDefault` / `kv.reset` (ADR-0093). The `#platform/whispering` leaves supply the auth client and default transcription service.

The rule is the same as Fuji and Honeycrisp:

```txt
create<App>()
  shared isomorphic model

open<App>Browser/open<App>Daemon/open<App>Tauri()
  runtime resources around that model

attach*
  one side-effectful layer
```

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

## RPC Layer - Adding Reactivity and State Management

The rpc layer is where reactivity gets injected on top of pure services. It wraps service functions with TanStack Query and handles two key responsibilities:

**Runtime Dependency Injection** - Dynamically switching service implementations based on user settings:

```typescript
// From transcription rpc layer
async function transcribeBlob(blob: Blob) {
  const selectedService = settings.value['transcription.selectedTranscriptionService'];

  switch (selectedService) {
    case 'OpenAI':
      return services.transcriptions.openai.transcribe(blob, {
        apiKey: settings.value['apiKeys.openai'],
        model: settings.value['transcription.openai.model'],
      });
    case 'Groq':
      return services.transcriptions.groq.transcribe(blob, {
        apiKey: settings.value['apiKeys.groq'], 
        model: settings.value['transcription.groq.model'],
      });
  }
}
```

**Workspace State** - After migrating to Yjs CRDTs, domain data (recordings, transformations, transformation runs) lives in reactive workspace state modules (`$lib/state/*.svelte.ts`). These use SvelteMap backed by Yjs documents for instant reactivity. No cache invalidation or optimistic updates needed.

The rpc layer's role has narrowed to things that don't fit in CRDTs:

- **External APIs**: Transcription services, LLM completions (`rpc.transcription.*`, `rpc.transformer.*`)
- **Microphone enumeration**: Async device list with loading states (`manualRecorder.enumerateDevices`). Recorder state itself lives in `$lib/state/manual-recorder.svelte.ts` and `$lib/state/vad-recorder.svelte.ts` as `$state`, not queries.
- **Audio blob access**: Too large for Yjs CRDTs, still served via DbService (`rpc.audio.getPlaybackUrl`)

```svelte
<script>
  import { rpc } from '$lib/rpc';
  import { recordings } from '$lib/state/recordings.svelte';

  // Domain data: workspace state (reactive, no queries needed)
  const latestRecording = $derived(recordings.sorted[0]);

  // Audio blob: still needs TanStack Query (too large for CRDTs)
  const audioUrl = createQuery(() => ({
    ...rpc.audio.getPlaybackUrl(() => latestRecording?.id ?? '').options,
    enabled: !!latestRecording?.id,
  }));
</script>
```

This design keeps services pure and platform-agnostic while giving the UI immediate reactivity for domain data and cached access for external resources.

**→ Learn more:** [RPC README](./src/lib/rpc/README.md) | [State README](./src/lib/state/README.md)

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
- **RPC Layer**: Reactive data management with caching
- **RPC Pattern**: Unified API interface for non-CRUD operations (`rpc.audio.*`, `rpc.transcription.*`, `rpc.actions.*`)
- **Dependency Injection**: Clean separation of concerns

## Key Architectural Decisions

1. **Pure Functions Over Classes**: Services are functions, not classes, making them easier to test and compose
2. **Explicit Error Handling**: Every function that can fail returns a Result type
3. **Platform Abstraction at Build Time**: Platform detection happens once, not at runtime
4. **Three Clear Layers**: Each layer has a specific responsibility with clear boundaries
5. **TypeScript Throughout**: Full type safety from services to UI components
