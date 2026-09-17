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

The recordings domain observes committed rows. This module adapts its row
subscriptions to Svelte. Audio bytes live independently in app-local storage;
remote uploads are explicit.

Recording producers save bytes before creating a row. Manual Stop returns the
saved key; imports and voice-activated capture use `saveAudioRecording`.
`recordings.create` initializes the title, transcripts, and transcription status.
The processing pipeline accepts only the resulting recording ID, so retrying
transcription cannot publish another blob or create another row.

```typescript
import { InstantString } from '@epicenter/data/field';
import { unwrap } from 'wellcrafted/result';
import { getWhisperingApp } from '$lib/whispering/context';

const app = getWhisperingApp(); // component initialization
const audioBlobId = unwrap(await app.blobs.local.add(blob));
const recording = unwrap(await app.recordings.create({
	audioBlobId,
	recordedAt: InstantString.now(),
	recordedAtZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	duration: null,
}));
app.recordings.patch(recording.id, { title: 'Meeting' });
await app.recordings.delete(recording.id); // retains local and uploaded bytes
```

Playback uses `recordings.openAudio(id)` and releases its disposable source when
the player closes. Transcription and downloads use `recordings.readAudio(id)`.
Both prefer local bytes and use an explicitly uploaded URL only when local bytes
are missing. `local` availability says the device has bytes; `audioUrl` separately
records an uploaded copy.

`recordings.zip` exports Markdown with audio references, not audio payloads.
Saved-byte and archive recovery do not imply recovery of unfinished microphone
capture after restarting the app.

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
