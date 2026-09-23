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

The mounted `(app)` layout passes the inert definition and plain auth client to
`AppBoot`. Admitted boot initializes the reactive module export `local` once per
document before mounting consumers. Imports, SSR, callbacks and stopped recovery
documents do not acquire stores. Personal opens independently for the captured
account; Local capture and import do not wait for it.

`WhisperingShell` creates the UI session, shell query client and recording workflow.
Local callers import `local`. A ready Personal boundary mounts `PersonalProvider`,
which synchronously calls `setPersonal` before rendering descendants. Descendants
capture `getPersonal()` during initialization and pass that handle into operations.
Shared recording views receive a concrete store and own their query client.

Capture and import save Local bytes and a Local recording. Whispering has no
Personal audio copy path. Local recordings own their audio reads and transcript
writes. Account-dependent transcription waits for its
captured Personal prompt and dictionary; Local saving proceeds independently.

Deliberate account departure fences publication before navigation. Sign-out reloads;
it does not confirm persistence. UI disposal stops admission, cancels owned capture
and releases subscriptions and VAD. Ordinary stop saves the final utterance.
Document-owned recovery retains known BlobIds, row IDs and inferred text, with a
visible Finish saving action across route changes. Successful publication requires
flush, saved persistence status and a matching row. Server delivery is separate.
Reload ends this recovery promise.

Saved transcription captures its SDK client, model and hints before reading audio.
Connection discovery only suggests models; it never selects a destination.
Custom endpoints must accept the workflow's OpenAI SDK request. Direct Deepgram
and ElevenLabs protocols are unsupported; Mistral has no separate adapter.

## Service Layer - Pure Business Logic + Platform Abstraction

The service layer contains all business logic as **pure functions** with zero UI dependencies. Services don't know about reactive Svelte variables, user settings, or UI state. They only accept explicit parameters and return `Result<T, E>` types for consistent error handling.

The key innovation is **build-time platform resolution** via Node-standard `#platform/*` subpath imports. Each platform-bound service lives in a folder with both implementations as sibling files plus a shared contract; the app's `package.json` `imports` map points each seam at the matching file per build condition:

`openWhisperingResources` composes the existing `openLocal` and `openPersonal`
constructors, `createRecorder({ localBlobs: local.blobs })`, and runtime inference. Whispering's
`#platform/*` seams select app capabilities such as auth and native commands.
The saved-recording contract lives at `@epicenter/app/recorder`.
The UI session creates one recording workflow from the opened recorder and exposes
`app.recording`. Buttons and the overlay read that workflow's state. Resource close
and document departure release capture. Device configuration selects browser device
IDs or native device names through its matching seam.

This mechanism is scoped to `#platform/*` only; every other bare import resolves normally. `tsconfig.json` typechecks the default resolution and `tsconfig.epicenter-host.json` repeats the check with the condition the Epicenter build activates. Each impl is annotated with the shared contract (`export const x: Contract = ...`, not `satisfies`, so the concrete type stays hidden and the variants stay in lockstep).

Tauri-only exports (Whispering's `tauriOnly` namespace in `src/lib/tauri.tauri.ts`) are imported **directly** by `.tauri.ts` files (`import { tauriOnly } from '$lib/tauri.tauri'`), not through a `#platform/*` seam, which does not export it. Shared code reaches the namespace through `import { tauri } from '#platform/tauri'` and narrows with `if (tauri)`; the export is annotated `Tauri | null` to force that narrowing.

Services are **testable** (just pass mock parameters), **reusable** (work identically anywhere via the shared contract in `types.ts`), and **maintainable** (no hidden runtime branches).

The codebase distinguishes two kinds of "which implementation" decisions and uses different mechanisms for each. See `docs/articles/20260526T012650-two-switches-build-time-and-runtime.md` for the walkthrough.

**→ Learn more:** [Services README](./src/lib/services/README.md) | [Constants Organization](./src/lib/constants/README.md)

## Query Layer - Adding Reactivity and State Management

The query layer (`$lib/queries`) adds mutation state around asynchronous
capabilities. Each recording view owns a query client and queries bound to its
concrete store. Components capture the view's query context at initialization.
The shell has its own query client for capture UI.

Domain state stays in the reactive stores:

```svelte
<script>
  import { local } from '$lib/whispering/local';
  import { sortedRecordings } from '$lib/whispering/recordings';

  const latestRecording = $derived(sortedRecordings(local)[0]);
</script>
```

`fromData` preserves table and KV APIs. Personal settings and recipes are read
beneath the ready provider. Operations receive concrete stores explicitly.
Transcription and download mutations use the view's store. Microphone enumeration
has async loading state; capture state remains in the recording workflow and VAD
wrapper. `AudioBlobPlayer` owns source acquisition, loading, failure, reopening and
disposal. It opens audio through the row's containing store without a second
availability query.

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
- **Query Layer**: Reactive data management with caching, scoped to its owning view (`queries.transcription.*`, `queries.download.*`)
- **Dependency Injection**: Clean separation of concerns

## Key Architectural Decisions

1. **Pure Functions Over Classes**: Services are functions, not classes, making them easier to test and compose
2. **Explicit Error Handling**: Every function that can fail returns a Result type
3. **Platform Abstraction at Build Time**: Platform detection happens once, not at runtime
4. **Three Clear Layers**: Each layer has a specific responsibility with clear boundaries
5. **TypeScript Throughout**: Full type safety from services to UI components
