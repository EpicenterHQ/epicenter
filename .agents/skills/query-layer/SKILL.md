---
name: query-layer
description: 'Use when editing TanStack Query integration: createQuery, createMutation, resultQueryOptions, resultMutationOptions, defineQuery, defineMutation, defineKeys, shared cache identity, mutation lifecycle, or service-to-TanStack adapters.'
metadata:
  author: epicenter
  version: '3.0'
---

# Query Layer Patterns

## Reference Repositories

- [TanStack Query](https://github.com/tanstack/query): async state management for data fetching

## Upstream Grounding

When TanStack Query behavior, Svelte adapter types, cache invalidation semantics, optimistic updates, or mutation lifecycle callbacks affect correctness, ask DeepWiki a narrow question against `TanStack/query` before relying on memory. Use it to orient, then verify decisive details against local installed types, source, or official docs before changing code.

Skip DeepWiki for stable basics and repo-local patterns already documented below.

The query layer is the reactive bridge between UI components and the service layer. It wraps service functions or observable operations with caching, mutation lifecycle state, invalidation, and direct imperative access using TanStack Query and Wellcrafted factories.

> **Related Skills**: See `services-layer` for the service layer these queries consume. See `svelte` for Svelte-specific TanStack Query patterns. See `error-handling` for toast/report patterns after Results reach the UI boundary.

## Core Architecture

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│     UI      │ --> │    Query    │ --> │   Services   │
│ Components  │     │    Layer    │     │  (UI-free)   │
└─────────────┘     └─────────────┘     └──────────────┘
      ↑                    │
      └────────────────────┘
         Reactive Updates
```

**Query Layer Responsibilities:**

- Call services with injected settings/configuration
- Preserve typed service and operation errors unless the adapter introduces a new local failure
- Manage TanStack Query cache for optimistic updates
- Provide hook-ready `.options` for shared definitions and explicit imperative APIs where they exist
- Own shared cache identity through exported `*Keys` maps

## Wellcrafted Query API Shape

| Scope | Query | Mutation |
| --- | --- | --- |
| Hook-local Result adapter | `resultQueryOptions(input)` | `resultMutationOptions(input)` |
| Reusable definition | `defineQuery(input)` | `defineMutation(input)` |

Use `resultQueryOptions` and `resultMutationOptions` at one hook call site when a Result-returning function needs to enter TanStack's data/error channels and no imperative API or shared query identity is needed.

The adapters unwrap internally (`Ok.data` is returned, `Err.error` is thrown).
Pass the Result-returning function; do not `unwrap` first.

Use `defineQuery` and `defineMutation` in shared `$lib/queries` modules.

Queries expose `.options`, `.fetch()`, and `.ensure()`. They are not callable.

Mutations expose `.options` and are callable. They do not expose `.execute()`.

## Canonical Whispering Query Module Shape

For Whispering-style `$lib/queries` modules, keep source-of-truth declarations close to the work they describe. Factories receive the session-owned runtime explicitly:

```typescript
export const audioKeys = defineKeys({
	availability: (id: string, blobId: string, uploadedAt: string | null) =>
		['audio', 'availability', id, blobId, uploadedAt] as const,
});

export function createAudioQueries({ defineQuery }: WhisperingQueryRuntime) {
	return {
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
}
```

Rules:

- Export `*Keys = defineKeys({ ... })` beside the adapter or state module that owns the work.
- Static keys do not need `as const`; key factories use `as const` when literal positions matter.
- Keep keys in the owning module unless another layer needs the same fallback identity.
- Inline small single-use input objects. Name an input type only when it is reused, exported, large enough to obscure the function, or carries domain meaning. Put named input types immediately before the adapter namespace that uses them.
- Keep adapter-local `defineErrors` namespaces local unless another module needs to name that exact union.

## Adapter Boundary: Queries vs Operations

Use `$lib/queries` as the shared TanStack observation surface. It may wrap a direct service/state call, or a `$lib/operations` entry point when UI needs shared mutation identity: multiple consumers, cache invalidation, optimistic updates, `useIsMutating`, or a named mutation key over that operation.

Keep orchestration in `$lib/operations`: delivery, sounds, analytics, clipboard writes, and multi-step workflows. A reusable operation returns its outcome; a terminal interaction controller may also report it. Do not promote a one-component operation into `$lib/queries` merely to observe local pending state. The `svelte` skill owns the component's choice between local `createMutation` and direct `await`.

## Dependency Direction

```txt
UI -> operations/* -> services/* + state/* + $lib/tauri
UI -> queries/*    -> services/* or operations/*, plus narrow state reads/writes for observed lifecycle
```

Query modules receive the session-owned query runtime and import services, state, or operations. They do not import sibling query modules just to sequence work; cross-adapter coordination belongs in operations.

## Error Flow

In Whispering, service and operation errors are already tagged errors. Query adapters pass them through. The UI/report boundary decides how to present them.

```txt
Service / Operation       ->  Query Adapter     ->  UI / Report
TaggedError<'Name'>           same error            report.error({ cause: error })
```

Only define a query-local error when the adapter itself discovers a failure that no lower layer can own, such as a missing recording lookup before calling an operation.

## Reactive And Imperative Use

Query-layer adapters provide reactive hook usage and explicit imperative usage.

### Reactive Interface: `.options`

Shared query adapters expose `.options` as a static object. Svelte hooks read it inside an accessor:

```svelte
<script lang="ts">
	import { createQuery, createMutation } from '@tanstack/svelte-query';
	import { getWhisperingQueries } from '$lib/whispering/context';

	const queries = getWhisperingQueries();
	const availability = createQuery(() =>
		queries.audio.availability(() => recording).options,
	);

	const transcribeRecording = createMutation(
		() => queries.transcription.transcribeRecording.options,
	);
</script>

{#if availability.isPending}
	<Spinner />
{:else if availability.error !== null}
	<Error message={availability.error.message} />
{:else}
	<AvailabilityBadge value={availability.data} />
{/if}
```

### Imperative Interface: Queries Choose Cache Policy, Mutations Are Callable

Use outside component context, or whenever the caller needs a direct Result:

```typescript
// In an event handler or workflow
async function handleDownload(recording: Recording) {
	const { error } = await queries.download.downloadRecording(recording);
	if (error !== null) {
		report.error({ cause: error });
		return;
	}
	report.success({ title: 'Recording downloaded' });
}

// In a sequential workflow
async function stopAndTranscribe(toastId: string) {
	const { data: url, error: playbackUrlError } =
		await queries.audio.availability(() => recording).fetch();

	if (playbackUrlError !== null) {
		report.error({ cause: playbackUrlError });
		return;
	}

	// Continue with transcription...
}
```

Use `.fetch()` when TanStack should evaluate the query's normal staleness policy: fresh cached data may still be returned without a request. Use `.ensure()` when any cached data is acceptable and fetching is only required when the cache is empty.

### When to Use Each

| Adapter surface | Pattern |
| --------------- | ------- |
| Shared reactive query | `createQuery(() => queries.thing.options)` |
| Shared reactive mutation | `createMutation(() => queries.thing.options)` |
| Imperative query read | `queries.thing(...).fetch()` or `queries.thing(...).ensure()` |
| Imperative mutation | `queries.thing(input)` |

For local component operation placement and lifecycle decisions, use the
`svelte` skill's mutation guidance.

## Key Rules

1. **Use `defineKeys` for shared cache identity** - Export the key map beside the owner
2. **Use `.options` (no parentheses)** - It's a static object, wrap in accessor for Svelte
3. **Do not translate tagged errors by default** - Pass service/operation errors through to the report boundary
4. **Services receive explicit app inputs** - The consuming edge injects settings and device config
5. **Keep component lifecycle policy in `svelte`** - This skill owns shared adapter shape and cache behavior
6. **Update cache deliberately** - Use optimistic writes only when the cache owner and rollback path are explicit; otherwise invalidate or refetch

## References

Load these on demand based on what you're working on:

- If working with **error pass-through examples and anti-patterns**, read [references/error-transformation-patterns.md](references/error-transformation-patterns.md)
- If working with **runtime dependency injection and service selection**, read [references/runtime-dependency-injection.md](references/runtime-dependency-injection.md)
- If working with **cache management, query definitions, RPC namespace, or notify coordination**, read [references/advanced-query-patterns.md](references/advanced-query-patterns.md)

- See `apps/whispering/src/lib/queries/README.md` for detailed architecture
- See the `services-layer` skill for how services are implemented
- See the `error-handling` skill for trySync/tryAsync patterns and toast-on-error conventions
