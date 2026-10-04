# RPC Layer

Thin TanStack adapters over services, state, or operations. Each module here adds the things components need to observe work reactively: cache keys for queries, mutation lifecycle state, and cache invalidation. Folder name matches the exported barrel: `import { rpc } from '$lib/rpc'`.

## Current modules

These examples are not an ownership map. Check call sites before changing a module.

| Module             | Shape    | What it observes                                           |
| ------------------ | -------- | ---------------------------------------------------------- |
| `audio.ts`         | query    | Derived local and historical remote availability           |
| `download.ts`      | mutation | Download service lifecycle                                 |
| `transcription.ts` | mutation | Transcription operation lifecycle and transcribing status   |
| `client.ts`        | infra    | `QueryClient` + `defineQuery` / `defineMutation` factories |

## The `rpc` barrel

```ts
import { rpc } from '$lib/rpc';

// Reactive read in a component
const availability = createQuery(() =>
  rpc.audio.availability(() => recording).options,
);

// Reactive mutation observed in batch UI
const transcribeRecordings = createMutation(
  () => rpc.transcription.transcribeRecordings.options,
);
```

## Authoring rule

A module belongs here if it has the **adapter shape**:

- Wraps a single service call, state query, or operation that components need to observe.
- Keeps UI effects out: no toasts, sounds, analytics, or copy. The only effects allowed here are TanStack cache reads, writes, invalidations, and operation calls whose lifecycle is the thing being observed.
- Adds a cache key for query or mutation identity.
- Useful to multiple observers, or earns its own module by participating in cache invalidation.

If your work coordinates a user workflow, put the workflow in `$lib/operations/`. The RPC layer may expose a thin mutation wrapper over that operation when shared UI needs `isPending`, `isMutating`, or a named mutation key.

For one-off local lifecycle state, wrap the operation in the component instead:

```svelte
<script lang="ts">
  import { createMutation } from '@tanstack/svelte-query';
  import { resultMutationOptions } from 'wellcrafted/query';
  import {
    startManualRecording,
    stopManualRecording,
  } from '$lib/operations/recording';

  const startMutation = createMutation(() =>
    resultMutationOptions({
      mutationKey: ['recording', 'startManual'],
      mutationFn: startManualRecording,
    }),
  );

  const stopMutation = createMutation(() =>
    resultMutationOptions({
      mutationKey: ['recording', 'stopManual'],
      mutationFn: stopManualRecording,
    }),
  );

  const isPreparing = $derived(startMutation.isPending || stopMutation.isPending);
</script>

<Button disabled={isPreparing} onclick={...}>...</Button>
```

Cross-adapter coordination still belongs in operations. An RPC file should not import a sibling RPC module just to sequence work.

If the one-off operation returns a Wellcrafted `Result`, use `resultMutationOptions({ mutationKey, mutationFn })` at the hook call site. The adapter resolves `Ok(data)` into TanStack's data channel and throws `Err(error)` into its error channel.

## Canonical module shape

Keep each adapter file in source-of-truth order:

```ts
export const audioKeys = defineKeys({
  availability: (id: RecordingId, audioBlobId: BlobId, uploadedAt: InstantString | null) =>
    ['audio', 'availability', id, audioBlobId, uploadedAt] as const,
});

export const audio = {
  availability: (recording: Accessor<Recording>) =>
    defineQuery({
      queryKey: audioKeys.availability(
        recording().id,
        recording().audioBlobId,
        recording().uploadedAt,
      ),
      queryFn: () => getRecordingAudioAvailability(recording()),
    }),
};
```

Rules:

- Define keys with `defineKeys` and export the key map beside the adapter that owns it.
- Static key entries do not need `as const`; `defineKeys` preserves literal tuple types for them.
- Key factories need `as const` when the literal positions matter, like `['audio', 'availability', id] as const`.
- Disposable handles do not belong in TanStack Query. A mounted player owns one
  `blobSources.open` acquisition and calls its `[Symbol.dispose]()` before
  replacement or unmount.
- Keep keys in the owning module. Only lift them into a standalone file when a separate layer genuinely must reference the same key without importing the owning adapter (for example, a web fallback that cannot pull in a Tauri-only module).
- Keep adapter-specific errors local unless another module needs to name that exact error union.
- Inline small single-use input objects. Name an input type only when it is reused, exported, large enough to obscure the function, or carries domain meaning. Put named input types immediately before the adapter namespace that uses them.
- If you export the exact return shape of a `create*` factory, derive it with `ReturnType<typeof createThing>` instead of duplicating the object shape.

## Dependency direction

```
$lib/ui/          ->  $lib/rpc/  ->  $lib/services/ + $lib/state/
                              \->  $lib/operations/
```

- `rpc/` may wrap operations when the UI needs shared TanStack mutation state over that operation.
- `rpc/` may import from `rpc/client` (the shared infra), but not from another sibling in `rpc/`. Cross-adapter coordination is an orchestration.

## Errors flow through unchanged

Services and operations return tagged errors built with `defineErrors` from `wellcrafted/error`. RPC adapters pass them through without translation; the component (or the operation it dispatches into) decides what the user should see by calling `report.error`, `report.info`, etc., from `$lib/report`.

```ts
downloadRecording: defineMutation({
  mutationKey: downloadKeys.downloadRecording,
  mutationFn: async (recording: Recording) => {
    const { data: audioBlob, error } =
      await services.blobs.get(recording.audioBlobId);
    if (error !== null) return Err(error);

    return services.download.downloadBlob({
      name: `whispering_recording_${recording.id}`,
      blob: audioBlob,
    });
  },
});
```

## Imperative escape hatches

Queries expose `.fetch()` and `.ensure()` for imperative reads. `.fetch()` evaluates TanStack's staleness policy and can return fresh cached data; `.ensure()` accepts any cached value and fetches only when the cache is empty.

Mutations are callable for imperative writes:

```ts
const { error } = await rpc.transcription.transcribeRecording(recording);
```

Prefer plain async functions in `$lib/operations/` for code that is not observed by a component, instead of promoting every workflow into `$lib/rpc`.

## Architecture context

```
UI (.svelte)
  │  createQuery(() => rpc.<x>.options)         ← shared cached reads
  │  createMutation(() => rpc.<y>.options)      ← shared mutations w/ cache invalidation
  │  createMutation(() => resultMutationOptions(...)) ← local lifecycle over an orchestration
  │  await <operation>(...)                     ← imperative orchestration without observed lifecycle
  ▼
$lib/rpc/*          TanStack adapters (this directory)
  │                 wraps services/state directly, or wraps an operation when
  │                 shared UI needs mutation state
  ├──▶
$lib/operations/*   imperative orchestrations (delivery, recording, upload,
                    pipeline, transcribe, run-polish, run-recipe,
                    recipe-clipboard, analytics, sound, shortcuts)
  ▼
$lib/services/*     UI-free; fallible APIs are Result-typed
$lib/state/*        reactive (Svelte runes, Yjs)
```

See `$lib/services/README.md` for the service layer.
