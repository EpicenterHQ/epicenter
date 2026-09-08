# State

Reactive state that stays in sync with the app. Unlike the query layer, which uses stale-while-revalidate caching, state modules maintain live state that updates immediately and persists across the app lifecycle.

Two shapes live here. Workspace-backed state (`settings`, `recordings`, `recipes`) is owned and hydrated by the UI-free app; these modules are thin Svelte reactivity adapters over that ready product API. Device/hardware state (`device-config`, recorders, lifecycle) remains module singletons.

## When to Use State vs Query Layer

| Aspect | `$lib/state/` | `$lib/queries/` |
|--------|----------------|---------------|
| **Pattern** | App-owned domain state plus Svelte adapters | Stale-while-revalidate (TanStack Query) |
| **State Location** | Ready `WhisperingApp` | TanStack Query cache |
| **Updates** | Immediate, live | Cached with background refresh |
| **Use Case** | Hardware state, user preferences, live status, workspace table data | Data fetching, mutations, external API calls |
| **Lifecycle** | App lifetime | Managed by TanStack Query |

## Current State Modules

### `settings.svelte.ts`

Synced workspace settings backed by the canonical workspace KV section (ADR-0130). Settings roam across devices through row sync. The app core hydrates every key before the app resolves; `createSettingsView` wraps it with `createSubscriber` so reads are reactive. Product defaults remain release-local app policy.

```typescript
import { getWhisperingApp } from '$lib/whispering/context';

const app = getWhisperingApp(); // component initialisation

// Read settings reactively (re-renders on change)
const trigger = app.settings.get('settings.recording.trigger');

// Update settings (writes to the document and syncs to other devices)
app.settings.set('settings.recording.trigger', 'vad');
```

### `recordings.svelte.ts`

Recording metadata backed by structural workspace row ids. The app namespace maintains the cache, owns row/blob consistency (`storeAudio`, `create` cleanup, `delete`, the audio workflows, and the `uploadedAt` marker), and refreshes after local writes or installed remote record changes; this module only makes its reads reactive. Use `$lib/queries/audio` for availability query identity and `app.blobs.open` for playback; the blob store is scoped by the app handle, so it is reached through the app rather than a module-level service.

```typescript
import { InstantString } from '@epicenter/data/field';

import { getWhisperingApp } from '$lib/whispering/context';

const { recordings } = getWhisperingApp(); // component initialisation

// Read recordings reactively
const recording = recordings.get(id);
const sorted = recordings.sorted; // newest first

// Writes are async and refresh the app-level cache after commit.
// `uploadedAt` is blob-state metadata owned by the audio workflows; creation
// starts it at null and public updates cannot touch it.
const stored = await recordings.storeAudio(blob);
const created = await recordings.create({
	audioBlobId: stored.data.audioBlobId,
	// remaining recording fields
});
await recordings.update(id, {
	transcript,
	transcription: { status: 'completed', completedAt: InstantString.now() },
});
// Deletes the online copy (when one exists), the device copy, then the row.
await recordings.delete(id);
```

### `recipes.svelte.ts`

The on-demand Recipe library backed by canonical records. Each recipe is a single self-contained row (`name`, `instructions`, optional `icon`); built-in recipes are merged ahead of the user's saved rows.

```typescript
import { getWhisperingApp } from '$lib/whispering/context';

const { recipes } = getWhisperingApp(); // component initialisation

const list = recipes.pickable; // built-ins followed by saved recipes
await recipes.set({ id, name, instructions, icon: null });
```

### `device-config.svelte.ts`

Device-bound configuration backed by per-key localStorage. Secrets, hardware IDs, filesystem paths, and global OS shortcuts that should never sync across devices. Uses a SvelteMap for per-key reactivity with cross-tab sync via storage events.

```typescript
import { deviceConfig } from '$lib/state/device-config.svelte';

// Read config reactively
const apiKey = deviceConfig.get('providers.openai.apiKey');

// Update config (writes to localStorage per-key)
deviceConfig.set('providers.openai.apiKey', 'sk-...');

// Get definition default (for "Default: X" placeholders)
const defaultShortcut = deviceConfig.getDefault('shortcuts.global.toggleManualRecording');
```

### `vad-recorder.svelte.ts`

Voice Activity Detection (VAD) recorder singleton. Manages the VAD hardware state and provides reactive access to detection status.

```typescript
import { vadRecorder } from '$lib/state/vad-recorder.svelte';

// Reactive state access (triggers $effect when changed)
$effect(() => {
  console.log('VAD state:', vadRecorder.state); // 'IDLE' | 'LISTENING' | 'SPEECH_DETECTED'
});

// Start/stop VAD
await vadRecorder.startActiveListening({
  onSpeechStart: () => console.log('Speaking...'),
  onSpeechEnd: (blob) => processAudio(blob),
});
await vadRecorder.stopActiveListening();
```

## Why VAD Lives Here

The VAD recorder doesn't fit the query layer pattern because:

1. **Live state**: VAD state (`IDLE` → `LISTENING` → `SPEECH_DETECTED`) must update immediately as hardware events occur
2. **Singleton nature**: Only one VAD instance can exist at a time
3. **Resource management**: Requires explicit cleanup (`stopActiveListening`) rather than cache invalidation
4. **Hardware lifecycle**: Tied to microphone access, not data fetching

## Adding New State Modules

Create a new state module when you need:

1. **Live reactive state** that must update immediately (not stale-while-revalidate)
2. **Singleton behavior** where only one instance should exist
3. **App-lifetime persistence** (not request-scoped)
4. **Hardware or system state** that can't be "refreshed" like data

Use the query layer (`$lib/queries/`) instead when you need:
- Data fetching with caching
- Mutations with optimistic updates
- Background refresh and stale-while-revalidate
- TanStack Query devtools integration

If a state module still exposes a TanStack query for one live concern, keep the key map beside the state owner:

```typescript
export const recorderKeys = defineKeys({
	devices: ['recorder', 'devices'],
});
```

Use the same module shape as `$lib/queries/`: exported `*Keys` for shared cache identity, local `defineErrors` namespaces for state-owned failures, named input object types for structured public methods, and `ReturnType<typeof createThing>` when exporting the exact shape returned by a factory.

See `$lib/queries/README.md` for the query layer documentation.
