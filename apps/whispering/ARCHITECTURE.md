# Whispering Architecture Deep Dive

Whispering is one SPA in three layers, served by the Epicenter desktop host. Platform differences are selected at build time, and business logic stays separate from UI concerns.

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

## Application composition

`src/lib/application.ts` captures the raw auth Account and opens one App,
using the local library when signed out. The mounted `(app)` layout dynamically
imports that plain TypeScript module. Authentication callbacks and overlays do
not import it. `auth.svelte.ts` adds UI tracking after composition.

The layout awaits `app.ready` before rendering `WhisperingShell`, which creates
its UI session, query client, and recording workflow. Application routes share
the same App. Library changes close this page and use full document navigation.

Voluntary departure checks recording recovery and refuses while capture or
saving needs attention. Terminal retirement stops new recording admission,
awaits admitted recording work, releases VAD, and disposes the UI before storage
closes. Network retirement remains immediate. Reload alone is not an awaited
recording shutdown; native capture still requires explicit recovery.

## Service Layer - Pure Business Logic + Platform Abstraction

The service layer contains all business logic as **pure functions** with zero UI dependencies. Services don't know about reactive Svelte variables, user settings, or UI state. They only accept explicit parameters and return `Result<T, E>` types for consistent error handling.

The key innovation is **build-time platform resolution** via Node-standard `#platform/*` subpath imports. Each platform-bound service lives in a folder with both implementations as sibling files plus a shared contract; the app's `package.json` `imports` map points each seam at the matching file per build condition:

Storage and saved recording are selected together through `#platform/runtime`:
the browser leaf selects `browser`, and the host leaf selects `epicenterHost`
from App. The saved-recording contract lives at `@epicenter/app/recorder`.
The UI session composes `createWhisperingRecording(app, openedApp.recording)`
once and exposes `app.recording`. The workflow captures one framework recording service. Buttons and the overlay read the workflow state; UI disposal releases
the capture subscription. The opened
App owns capture admission, draining, cancellation, and storage closure. Device configuration
selects browser device IDs or native device names through its matching seam.

This mechanism is scoped to `#platform/*` only; every other bare import resolves normally. `tsconfig.json` typechecks the default resolution and `tsconfig.epicenter-host.json` repeats the check with the condition the Epicenter build activates. Each impl is annotated with the shared contract (`export const x: Contract = ...`, not `satisfies`, so the concrete type stays hidden and the variants stay in lockstep).

Tauri-only exports (Whispering's `tauriOnly` namespace in `src/lib/tauri.tauri.ts`) are imported **directly** by `.tauri.ts` files (`import { tauriOnly } from '$lib/tauri.tauri'`), not through a `#platform/*` seam, which does not export it. Shared code reaches the namespace through `import { tauri } from '#platform/tauri'` and narrows with `if (tauri)`; the export is annotated `Tauri | null` to force that narrowing.

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

  // Domain data: workspace state (reactive, no queries needed)
  const latestRecording = $derived(app.recordings.sorted[0]);

  // Audio availability: still needs TanStack Query (blobs are too large for
  // workspace rows)
  const availability = createQuery(
    () => queries.audio.availability(() => latestRecording).options,
  );
</script>
```

**Workspace State** - The UI-free app owns domain data (recordings, recipes, settings). Thin `$lib/state/*.svelte.ts` adapters add `createSubscriber` tracking, so components react to the same namespaces that Bun scripts use.

The query layer's role has narrowed to things that don't fit in workspace rows:

- **External APIs**: Transcription mutations (`queries.transcription.*`) around the transcription operations
- **Microphone enumeration**: Async device list with loading states (`app.recording.enumerateDevices`). Recorder state itself lives in `$lib/operations/recording.svelte.ts` and `$lib/state/vad-recorder.svelte.ts` as `$state`, not queries.
- **Audio blob access**: Too large for workspace rows, still served via the blob store (`queries.audio.availability`, `queries.download.downloadRecording`)

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
