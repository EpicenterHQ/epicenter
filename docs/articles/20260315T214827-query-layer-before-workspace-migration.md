# The Query Layer That Did Everything

> **Historical snapshot.** This README records Whispering's query layer before the workspace migration. TanStack Query managed recordings, transformations, and runs alongside runtime settings and cache updates. The `.options` examples below use the API from that period. For current shared queries and mutations, see [the query-layer skill](../../.agents/skills/query-layer/SKILL.md#compose-a-service-in-two-maps).

The key architectural insight worth preserving: the query layer co-locates three things in one place: the service call, runtime settings injection based on reactive variables, and cache manipulation. This creates a layer that bridges reactivity with services in an intuitive way, and gives developers a consistent place to put this logic. Whether the cache lives in TanStack Query or Yjs, the co-location principle still holds.

---

# Query Layer

The query layer is the reactive bridge between your UI components and the isolated service layer. It adds caching, reactivity, and state management on top of pure service functions.

```typescript
import { createQueryFactories } from 'wellcrafted/query';
import { queryClient } from './client';

export const { defineQuery, defineMutation } =
	createQueryFactories(queryClient);
```

These factory functions `defineQuery` and `defineMutation` take in Result-aware query or mutation options:

1. **`.options`** - A static object containing query/mutation options. Wrap in an accessor function for reactive use: `() => x.options`
2. **`.fetch()` / `.ensure()` for queries, direct calls for mutations** - Imperative usage without subscriptions. These still go through TanStack Query's cache or mutation cache, so mutations still register and can be debugged in the devtools.

## Reactive And Imperative Pattern

Query layer definitions support reactive hook usage and explicit imperative usage:

### Reactive Interface (`.options`) - Automatic State Management

```svelte
<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { rpc } from '$lib/query';

	// Reactive in components - wrap .options in accessor function
	const recordings = createQuery(() => rpc.recordings.getAllRecordings.options);
	// Syncs: recordings.isPending, recordings.data, recordings.error, recordings.isStale automatically
</script>

{#if recordings.isPending}
	<div class="spinner">Loading recordings...</div>
{:else if recordings.error}
	<div class="error">Error: {recordings.error.message}</div>
{:else if recordings.data}
	{#each recordings.data as recording}
		<RecordingCard {recording} />
	{/each}
{/if}
```

**Perfect for** when you want the UI to track and synchronize with the query/mutation lifecycle. This provides automatic state management where your components react to loading states, data changes, and errors without manual intervention.

Examples:

- Component data display
- Loading states and spinners
- Automatic re-renders when data changes
- Cache synchronization across components

### Imperative Interface - Direct Execution

```typescript
// Imperative in actions - lightweight and fast
const { data, error } =
	await rpc.recordings.deleteRecording(recordingId);
// No observers, no subscriptions, just the result
```

**Perfect for** when you don't need the overhead of observers or subscriptions, and when you want to call operations outside of component lifecycle. This avoids having to create mutations first or prop-drill mutation functions down to child components. Mutations can be called directly from anywhere without being constrained by component boundaries.

Examples:

- Event handlers (button clicks, form submissions)
- Sequential operations and workflows
- One-time data fetches
- Performance-critical operations
- Utility functions outside components

## Runtime Dependency Injection

The query layer handles **runtime dependency injection**: dynamically switching service implementations based on user settings. Unlike services which use build-time platform detection, the query layer makes decisions based on reactive variables:

```typescript
// Simplified example inspired by the actual transcription implementation
async function transcribeBlob(blob: Blob) {
	const selectedService =
		settings.value['transcription.selectedTranscriptionService'];

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

## Optimistic Updates

The query layer uses the TanStack Query client to manipulate the cache for optimistic UI. By updating the cache, reactivity automatically kicks in and the UI reflects these changes, giving you instant optimistic updates:

```typescript
// From recordings mutations
createRecording: defineMutation({
	mutationFn: async (recording: Recording) => {
		const { data, error } = await services.db.createRecording(recording);
		if (error) return Err(error);

		// Optimistically update cache - UI updates instantly
		queryClient.setQueryData(['recordings'], (oldData) => {
			if (!oldData) return [recording];
			return [...oldData, recording];
		});

		return Ok(data);
	},
});
```

The query layer co-locates three key things in one place: (1) the service call, (2) runtime settings injection based on reactive variables, and (3) cache manipulation (also reactive). This creates a layer that bridges reactivity with services in an intuitive way, and gives developers a consistent place to put this logic. Now developers know that all cache manipulation lives in the query folder.

## Error Transformation Pattern

A critical responsibility of the query layer is transforming service-specific errors into `WhisperingError` types that work seamlessly with our toast notification system. This transformation happens inside `mutationFn` or `queryFn`, creating a clean boundary between business logic errors and UI presentation.

### Error Handling Architecture

The error handling follows a clear pattern across three layers:

1. **Service Layer**: Returns domain-specific errors using `defineErrors` pattern
2. **Query Layer**: Wraps service errors into `WhisperingError` objects
3. **UI Layer**: Uses `WhisperingError` directly without re-wrapping

This pattern ensures consistent error handling and avoids double-wrapping errors.

### How It Works

Services return their own specific error types (defined with `defineErrors`), which contain detailed error information. The query layer transforms these into `WhisperingError` with UI-friendly formatting:

```typescript
// From manualRecorder.ts - Error transformation in mutationFn
startRecording: defineMutation({
	mutationFn: async ({ toastId }: { toastId: string }) => {
		const { data: deviceAcquisitionOutcome, error: startRecordingError } =
			await services.recorder.startRecording(recordingSettings, {
				sendStatus: (options) =>
					notify.loading({ id: toastId, ...options }),
			});

		// Transform service error to WhisperingError
		if (startRecordingError) {
			return Err(
				WhisperingError({
					title: '❌ Failed to start recording',
					description: startRecordingError.message, // Use service error message
					action: { type: 'more-details', error: startRecordingError },
				}),
			);
		}
		return Ok(deviceAcquisitionOutcome);
	},
	// WhisperingError is now available in onError hook
	onError: (error) => {
		// error is WhisperingError, ready for toast display
		notify.error(error);
	},
});
```

### The Pattern Explained

1. **Service Layer**: Returns domain-specific errors using `defineErrors`

   ```typescript
   // In manual-recorder.ts
   const { RecorderError } = defineErrors({
	RecorderError: {},
   });
   ```

2. **Query Layer**: Transforms to `WhisperingError` in `mutationFn`/`queryFn`

   ```typescript
   if (serviceError) {
	return Err(
		WhisperingError({
			title: '❌ User-friendly title',
			description: serviceError.message, // Preserve detailed message
			action: { type: 'more-details', error: serviceError },
		}),
	);
   }
   ```

3. **UI Layer**: Receives `WhisperingError` in hooks, perfect for toasts
   ```typescript
   onError: (error) => notify.error(error); // error is WhisperingError
   ```

### Why This Pattern?

- **Separation of Concerns**: Services focus on business logic errors, not UI presentation
- **Consistent UI**: All errors are transformed to a format that toasts understand
- **Detailed Context**: Original service errors are preserved in the `action` field
- **Type Safety**: TypeScript knows exactly what error types flow through each layer
- **No Double Wrapping**: Each error is wrapped exactly once, at the query layer

### Real Example: CPAL Recorder

```typescript
// From cpalRecorder.ts
getRecorderState: defineQuery({
	queryFn: async () => {
		const { data: recorderState, error: getRecorderStateError } =
			await services.cpalRecorder.getRecorderState();

		if (getRecorderStateError) {
			// Transform CpalRecorderError → WhisperingError
			return Err(
				WhisperingError({
					title: '❌ Failed to get recorder state',
					description: getRecorderStateError.message,
					action: { type: 'more-details', error: getRecorderStateError },
				}),
			);
		}
		return Ok(recorderState);
	},
});
```

### Anti-Patterns to Avoid

#### ❌ Double Wrapping

```typescript
// BAD: Don't wrap an already-wrapped WhisperingError
if (getRecorderStateError) {
	const whisperingError = WhisperingErr({
		title: '❌ Failed to get recorder state',
		description: getRecorderStateError.message,
		action: { type: 'more-details', error: getRecorderStateError },
	});
	notify.error({ id: nanoid(), ...whisperingError.error });
	return whisperingError;
}
```

#### ❌ Inconsistent Query Layer

```typescript
// BAD: Query layer should wrap errors, not return raw service errors
getRecorderState: defineQuery({
	queryKey: recorderKeys.state,
	queryFn: () => services.recorder.getRecorderState(), // Missing error wrapping!
	initialData: 'IDLE' as WhisperingRecordingState,
});
```

#### ✅ Correct Pattern

```typescript
// GOOD: Query wraps service errors, UI uses them directly
getRecorderState: defineQuery({
	queryFn: async () => {
		const { data, error } = await services.recorder.getRecorderState();
		if (error) {
			return Err(
				WhisperingError({
					title: '❌ Failed to get recorder state',
					description: error.message,
					action: { type: 'more-details', error },
				}),
			);
		}
		return Ok(data);
	},
});

// In UI/command layer - use WhisperingError directly
if (error) {
	notify.error(error); // No re-wrapping!
}
```

This pattern ensures that:

- Services remain pure and testable with their own error types
- The query layer handles all UI-specific error formatting
- Toast notifications receive properly formatted `WhisperingError` objects
- Original error context is preserved for debugging
- Errors are wrapped exactly once, avoiding redundant object creation

## Static Site Generation Advantage

This application is fully static site generated and client-side only, which gives us a unique architectural advantage: direct access to the TanStack Query client.

Unlike server-side rendered applications where the query client lifecycle is managed by frameworks, our static approach means:

- Direct Query Client Access: We can call `queryClient.fetchQuery()` and `queryClient.getMutationCache().build()` directly
- Imperative Control: No need to go through reactive hooks for one-time operations
- Performance Benefits: We can build mutations using direct execution rather than creating unnecessary subscribers
- Flexible Interfaces: Both reactive (`.options`) and imperative (`.fetch()`, `.ensure()`, or direct mutation call) patterns work seamlessly

This enables a query layer where every shared definition has a reactive hook bridge and explicit imperative behavior.

## What is RPC?

**RPC** (Result Procedure Call) is our central namespace that bundles all query operations into one unified interface. Think of it as your app's "API client" that lives in the frontend:

```typescript
import { rpc } from '$lib/query';

// Everything you can do in the app is available through rpc.*
rpc.recordings.getAllRecordings;
rpc.transcription.transcribeRecording;
rpc.clipboard.copyToClipboard;
// ... and much more
```

### The Notify API - Query Layer Coordination

The `notify` API demonstrates how the query layer coordinates multiple services:

```typescript
import { notify } from '$lib/query';

// Shows BOTH a toast (in-app) AND OS notification
await notify.success({
	title: 'Recording saved',
	description: 'Your recording has been transcribed',
});

// Loading states only show toasts (no OS notification spam)
const loadingId = await notify.loading({
	title: 'Processing...',
});
notify.dismiss(loadingId);
```

This showcases the query layer's coordination role:

- Calls the `toast` service for in-app notifications
- Calls the `notifications` service for OS-level alerts
- Adds intelligent logic (e.g., skipping OS notifications for loading states)
- Provides a unified API that's easier to use than calling services directly

The name "RPC" is inspired by Remote Procedure Calls, but adapted for our needs:

- **R**esult: Every operation returns a `Result<T, E>` type for consistent error handling
- **P**rocedure: Each operation is a well-defined procedure (query or mutation)
- **C**all: You can call these procedures reactively or imperatively

> **Author's Note**: I know, I know... "RPC" traditionally stands for "Remote Procedure Call," but I've reused the acronym to mean because it's fun and technically this builds off the Result type. People are already familiar with the RPC mental model, and honestly it just feels good to write `rpc`. Plus, it sounds way cooler than "query namespace" or whatever. 🤷‍♂️

## The Direct Mutation Call Performance Advantage

When you call `createMutation()`, you're creating a _mutation observer_ that subscribes to reactive state changes. If you don't need the reactive state (like `isPending`, `isError`, etc.), you're paying a performance cost for functionality you're not using.

### Performance Comparison

```typescript
// ❌ createMutation() approach - Creates subscriber
const mutation = createMutation(() => rpc.recordings.createRecording.options);
// This creates a mutation observer that:
// - Subscribes to state changes
// - Triggers component re-renders
// - Manages reactive state (isPending, isError, etc.)
// - Adds memory overhead

// Then you call it with callbacks:
mutation.mutate(recording, {
	onSuccess: () => {
		/* ... */
	},
	onError: (error) => {
		/* ... */
	},
});
```

```typescript
// ✅ Direct mutation call approach - Direct execution
const { data, error } = await rpc.recordings.createRecording(recording);
// This directly:
// - Executes the mutation immediately
// - Returns a simple Result<T, E>
// - No reactive state management
// - No component subscriptions
// - No memory overhead from observers
```

### When to Use Each Approach

**Use direct mutation calls when:**

- Event handlers that just need the result
- Sequential operations in commands/workflows
- You don't need reactive state (isPending, etc.)
- Performance is critical
- Non-component code (services, utilities)

**Use `createMutation()` when:**

- You need reactive state for UI feedback
- Loading spinners, disable states, error displays
- The component needs to react to mutation state changes

## Why RPC?

Instead of importing individual queries from different files:

```typescript
// ❌ Without RPC (scattered imports)
import { getAllRecordings } from '$lib/query/recordings';
import { transcribeRecording } from '$lib/query/transcription';
import { copyToClipboard } from '$lib/query/clipboard';
```

You get everything through one clean namespace:

```typescript
// ✅ With RPC (unified interface)
import { rpc } from '$lib/query';

// Now you have intellisense for everything!
rpc.recordings.getAllRecordings;
rpc.transcription.transcribeRecording;
rpc.clipboard.copyToClipboard;
```

RPC provides:

- Unified Import: One import gives you access to everything
- Better DX: IntelliSense shows all available operations organized by domain
- Consistent Interface: Every operation follows the same dual-interface pattern
- Discoverability: Easy to explore what operations are available

## Architecture Philosophy

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│     UI      │ --> │  RPC/Query  │ --> │   Services   │
│ Components  │     │    Layer    │     │    (Pure)    │
└─────────────┘     └─────────────┘     └──────────────┘
      ↑                    │
      └────────────────────┘
         Reactive Updates
```

### How It Works

1. **Services**: Pure functions that return `Result<T, E>` (never throw)
2. **Query Layer**: Uses WellCrafted's factories to wrap service functions
3. **RPC Namespace**: Bundles all queries into one global object for easy access
4. **UI Components**: Choose reactive (`.options`) or imperative direct mutation calls based on needs

## Real-World RPC Usage Throughout the App

### 1. Reactive Queries in Components

```svelte
<!-- From: /routes/+page.svelte -->
<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { rpc } from '$lib/query';

	// These queries automatically update when data changes
	const recorderState = createQuery(
		rpc.manualRecorder.getRecorderState.options,
	);
	const latestRecording = createQuery(
		rpc.recordings.getLatestRecording.options,
	);
</script>

{#if $recorderState.data === 'RECORDING'}
	<RecordingIndicator />
{/if}

{#if $latestRecording.data}
	<RecordingCard recording={$latestRecording.data} />
{/if}
```

### 2. Imperative Mutations with Error Handling

```typescript
// From: /lib/deliverTextToUser.ts
// ✅ Direct execution - no reactive overhead
async function copyToClipboard(text: string) {
	const { error } = await rpc.clipboard.copyToClipboard({ text });

	if (error) {
		// Using the notify API to show both toast and OS notification
		await notify.error({
			title: 'Error copying to clipboard',
			description: error.message,
			action: { type: 'more-details', error },
		});
	}
}

// ❌ Alternative with createMutation (unnecessary overhead)
// const copyMutation = createMutation(() => rpc.clipboard.copyToClipboard.options);
// copyMutation.mutate({ text }); // Creates observer, manages state we don't need
```

### 3. Sequential Operations - The Direct Mutation Call Sweet Spot

```typescript
// From: /lib/commands.ts
// ✅ Perfect use case for direct mutation calls - sequential workflow without UI reactivity
async function stopAndTranscribe() {
	// Step 1: Stop recording
	const { data: blob, error } = await rpc.manualRecorder.stopRecording({
		toastId,
	});

	if (error) {
		toast.error({ title: 'Failed to stop recording' });
		return;
	}

	// Step 2: Play sound effect (fire-and-forget)
	rpc.sound.playSoundIfEnabled('manual-stop');

	// Step 3: Create recording in database
	const { data: recording, error: createError } =
		await rpc.recordings.createRecording({
			blob,
			timestamp: new Date(),
			transcriptionStatus: 'PENDING',
		});

	if (createError) return;

	// Step 4: Transcribe the recording
	await rpc.transcription.transcribeRecording(recording);
}

// ❌ With createMutation (overkill for workflows)
// const stopMutation = createMutation(() => rpc.manualRecorder.stopRecording.options);
// const createMutation = createMutation(() => rpc.recordings.createRecording.options);
// Multiple observers created, state managed unnecessarily
```

### 4. Dynamic Queries with Parameters

```typescript
// From: /routes/(config)/settings/recording/SelectRecordingDevice.svelte
// Enumerate available recording devices
const devices = createQuery(() => rpc.recorder.enumerateDevices.options);
```

### 5. Options Factory Pattern for Conditional Queries

```typescript
// From: /routes/+layout/alwaysOnTop.svelte.ts
const recorderStateQuery = createQuery(() => ({
	...rpc.manualRecorder.getRecorderState.options,
	// Only enable this query when in manual recording mode
	enabled: settings.value['recording.mode'] === 'manual',
}));

const vadStateQuery = createQuery(() => ({
	...rpc.vadRecorder.getVadState.options,
	// Only enable when using voice activity detection
	enabled: settings.value['recording.mode'] === 'vad',
}));
```

### 6. Direct Function Calls (Synchronous Operations)

```typescript
// Some RPC methods are direct functions, not queries/mutations
if (rpc.transcription.isCurrentlyTranscribing()) {
	showTranscribingIndicator();
}
```

### 7. Batch Mutations in UI

```svelte
<!-- From: /routes/(config)/recordings/+page.svelte -->
<script lang="ts">
	// Create mutations with just .options (no parentheses!)
	const transcribeRecordings = createMutation(
		rpc.transcription.transcribeRecordings.options,
	);
	const deleteRecordings = createMutation(
		rpc.recordings.deleteRecordings.options,
	);

	async function handleBulkAction(
		selectedIds: string[],
		recordings: Recording[],
	) {
		if (action === 'transcribe') {
			transcribeRecordings.mutate(selectedIds, {
				onSuccess: ({ oks, errs }) => {
					if (errs.length === 0) {
						toast.success(`Transcribed ${oks.length} recordings!`);
					} else {
						toast.warning(
							`Transcribed ${oks.length} of ${selectedIds.length} recordings`,
						);
					}
				},
				onError: (error) => {
					toast.error('Failed to transcribe recordings', {
						description: error.message,
					});
				},
			});
		} else if (action === 'delete') {
			deleteRecordings.mutate(selectedIds, {
				onSuccess: () => {
					toast.success('Deleted recordings!');
				},
				onError: (error) => {
					toast.error('Failed to delete recordings', {
						description: error.message,
					});
				},
			});
		}
	}
</script>
```

## Getting Started

The easiest way to understand the query layer is to see it in action:

```svelte
<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { rpc } from '$lib/query';

	// This automatically subscribes to all recordings
	const recordingsQuery = createQuery(() => rpc.recordings.getAllRecordings.options);
</script>

{#if recordingsQuery.isPending}
	<p>Loading recordings...</p>
{:else if recordingsQuery.error}
	<p>Error: {recordingsQuery.error.message}</p>
{:else if recordingsQuery.data}
	{#each recordingsQuery.data as recording}
		<RecordingCard {recording} />
	{/each}
{/if}
```

Or imperatively in an event handler:

```typescript
async function handleDelete(id: string) {
	const { error } = await rpc.recordings.deleteRecording(id);
	if (error) {
		notify.error({
			title: 'Failed to delete',
			description: error.message,
		});
	}
}
```

WellCrafted handles the `Result<T, E>` unwrapping, so TanStack Query gets regular values/errors while you keep type safety.

## Core Utilities from WellCrafted

### `defineQuery` and `defineMutation`

These factory functions (`defineQuery` and `defineMutation`) take query options with result functions - functions that return `Result<T, E>`. From there, you get two ways to use it:

- `.options` - Static object with query/mutation options (wrap in accessor: `() => x.options`)
- `.fetch()` / `.ensure()` for queries, direct calls for mutations - Direct execution methods

**`defineQuery`** - For data fetching:

```typescript
// Your service returns Result<T, E>
const userQuery = defineQuery({
	queryKey: ['users', userId],
	queryFn: () => services.getUser(userId), // Returns Result<User, ApiError>
});

// ✅ Reactive interface - creates query observer
const query = createQuery(() => userQuery.options);
// - Subscribes to state changes
// - Manages loading, error, success states
// - Triggers component re-renders

// ✅ Imperative interface - direct query client usage
const { data, error } = await userQuery.fetch();
// - Calls queryClient.fetchQuery() directly
// - Returns cached data if fresh
// - No reactive overhead
```

**`defineMutation`** - For data modifications:

```typescript
const createRecording = defineMutation({
	mutationKey: ['recordings', 'create'],
	mutationFn: async (recording) => {
		const result = await services.db.createRecording(recording);
		if (result.error) return Err(result.error);

		// Update cache on success
		queryClient.setQueryData(['recordings'], (old) => [
			...(old || []),
			recording,
		]);
		return Ok(result.data);
	},
});

// ✅ Reactive interface - creates mutation observer
const mutation = createMutation(() => createRecording.options);
// - Subscribes to mutation state (isPending, isError, etc.)
// - Triggers component re-renders on state changes
// - Useful for loading states and error displays

// ✅ Imperative interface - direct execution
const { error } = await createRecording(recording);
// - Uses queryClient.getMutationCache().build() directly
// - Returns simple Result<T, E>
// - No reactive state management
// - Still goes through mutation cache for debugging
```

## Common Patterns

### 1. Basic Query Definition

```typescript
export const recordings = {
	getAllRecordings: defineQuery({
		queryKey: ['recordings'],
		queryFn: () => services.db.getAllRecordings(),
	}),
};
```

### 2. Parameterized Queries

```typescript
getRecordingById: (id: Accessor<string>) =>
  defineQuery({
    queryKey: ['recordings', id()], // Dynamic key based on ID
    queryFn: () => services.db.getRecordingById(id()),
  }),
```

### 3. Mutations with Cache Updates

```typescript
createRecording: defineMutation({
  mutationKey: ['recordings', 'create'],
  mutationFn: async (recording: Recording) => {
    const result = await services.db.createRecording(recording);
    if (result.error) return Err(result.error);

    // Optimistically update cache
    queryClient.setQueryData(['recordings'], (old) =>
      [...(old || []), recording]
    );

    return Ok(result.data);
  },
}),
```

### 4. Settings-Dependent Operations

```typescript
// Transcription uses current settings dynamically
function transcribeBlob(blob: Blob) {
	return services.transcription().transcribe(blob, {
		outputLanguage: settings.value['transcription.outputLanguage'],
		prompt: settings.value['transcription.prompt'],
		temperature: settings.value['transcription.temperature'],
	});
}
```

### 5. Multi-Step Operations

```typescript
transcribeRecording: defineMutation({
  mutationFn: async (recording) => {
    // Step 1: Update status
    await recordings.updateRecording({
      ...recording,
      transcriptionStatus: 'TRANSCRIBING',
    });

    // Step 2: Perform transcription
    const { data, error } = await transcribeBlob(recording.blob);

    // Step 3: Update with results
    await recordings.updateRecording({
      ...recording,
      transcribedText: data,
      transcriptionStatus: error ? 'FAILED' : 'DONE',
    });

    return error ? Err(error) : Ok(data);
  },
}),
```

## Usage in Components

### Reactive Usage (Recommended for UI)

```svelte
<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { rpc } from '$lib/query';

	// This automatically subscribes to updates
	const recordings = createQuery(() => rpc.recordings.getAllRecordings.options);
</script>

{#if recordings.isPending}
	<p>Loading...</p>
{:else if recordings.error}
	<p>Error: {recordings.error.message}</p>
{:else}
	{#each recordings.data as recording}
		<RecordingCard {recording} />
	{/each}
{/if}
```

### Imperative Usage (For Actions)

```typescript
async function handleDelete(recording: Recording) {
	const { error } = await rpc.recordings.deleteRecording(recording);

	if (error) {
		toast.error({
			title: 'Failed to delete',
			description: error.message,
		});
	}
}
```

## File Organization

- `_utils.ts` - Core factory functions
- `index.ts` - Query client setup and unified `rpc` export
- Feature-specific files (e.g., `recordings.ts`, `transcription.ts`)

Each feature file typically exports an object with:

- Query definitions
- Mutation definitions
- Helper functions
- Utility methods

## Actions: Always Return Ok

Actions in the query layer always return `Ok` after handling errors. They notify the user and return success because the action itself executed; error handling is part of that execution.

```typescript
const startManualRecording = defineMutation({
	mutationFn: async () => {
		const { error } = await recorder.startRecording();
		if (error) {
			notify.error(error); // Notify user
			return Ok(undefined); // Action succeeded
		}
		notify.success({ title: 'Recording started' });
		return Ok(undefined);
	},
});
```

Actions are UI-boundary mutations invoked from anywhere: command registry (`/lib/commands.ts`), components, state modules, etc. Since they're the end of the operation chain, errors flow sideways through notifications rather than up the call stack.

## Best Practices

1. Always use Result types - Never throw errors in query/mutation functions
2. **Mutation Pattern Preference**:
   - **In `.svelte` files**: Always prefer `createMutation` unless you have a specific reason not to (e.g., you don't need pending states)
   - **In `.ts` files**: Use direct mutation calls since createMutation requires component context
   - This gives you consistent loading states, error handling, and better UX in components
3. **Mutation callback pattern**: When using `createMutation`, pass callbacks as the second argument to `.mutate()` for maximum context
4. Choose the right interface for the job:
   - Use direct mutation calls in `.ts` files and when you don't need pending state
   - Use `createMutation()` when you need reactive state for UI feedback
5. Keep queries simple - Complex logic belongs in services or orchestration mutations
6. Update cache optimistically - Better UX for mutations
7. Use proper query keys - Hierarchical and consistent
8. Leverage direct client access - Our static architecture enables powerful patterns unavailable in SSR apps

## Quick Reference: Common RPC Patterns

### Basic Query (Reactive)

```typescript
// In component
const recordingsQuery = createQuery(() => rpc.recordings.getAllRecordings.options);

// In template
{#if recordingsQuery.isPending}Loading...{/if}
{#if recordingsQuery.data}{recordingsQuery.data}{/if}
```

### Query with Parameters

```typescript
// Define with accessor
const recordingId = () => '123';
const recordingQuery = createQuery(
	rpc.recordings.getRecordingById(recordingId).options,
);
```

### Basic Mutation (Reactive)

```typescript
// Create mutation with just .options (no parentheses!)
const deleteRecordingMutation = createMutation(
	rpc.recordings.deleteRecording.options,
);

// Trigger mutation with callbacks as second argument
deleteRecordingMutation.mutate(recordingId, {
	onSuccess: () => {
		toast.success('Recording deleted');
		// Navigate away, close modal, etc.
	},
	onError: (error) => {
		toast.error(error.title, { description: error.description });
	},
});
```

### Imperative Execute - Performance Optimized

```typescript
// ✅ Queries - uses queryClient.fetchQuery() directly
const { data, error } = await rpc.recordings.getAllRecordings.fetch();
// - Returns cached data if fresh
// - No reactive subscription
// - Perfect for prefetching or one-time fetches

// ✅ Mutations - uses queryClient.getMutationCache().build() directly
const { data, error } = await rpc.recordings.createRecording(recording);
// - Direct execution without mutation observer
// - No reactive state management overhead
// - Ideal for event handlers and workflows
```

### Error Handling Pattern

```typescript
const { data, error } = await rpc.clipboard.copyToClipboard({ text });
if (error) {
	toast.error({
		title: 'Failed to copy',
		description: error.message,
	});
	return;
}
// Success path continues...
```

### Conditional Queries

```typescript
const vadStateQuery = createQuery(() => ({
	...rpc.vadRecorder.getVadState.options,
	enabled: settings.value['recording.mode'] === 'vad',
}));
```

### Cache Updates in Mutations

```typescript
defineMutation({
	mutationFn: async (recording) => {
		const result = await services.db.createRecording(recording);
		if (result.error) return Err(result.error);

		// Update cache
		queryClient.setQueryData(['recordings'], (old) => [
			...(old || []),
			recording,
		]);

		return Ok(result.data);
	},
});
```

### Settings-Dependent Operations

```typescript
// Query layer automatically uses current settings
function transcribeBlob(blob: Blob) {
	return services.transcription().transcribe(blob, {
		outputLanguage: settings.value['transcription.outputLanguage'],
		temperature: settings.value['transcription.temperature'],
	});
}
```
