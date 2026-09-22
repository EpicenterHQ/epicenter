# State

This folder owns live capture state, device preferences, and UI projections that
need more than a table read. Declared application data is read through the
existing store API. Do not add a listener set or a copied array to make a table
reactive.

`WhisperingShell` mounts after the product resources open. Its UI session uses
`fromData` to adapt both stores. The context gives components those ready handles;
operations receive their dependencies explicitly.

## Settings and rows

Device settings use the account-independent Local store and do not sync.
Dictionary, custom instructions, and custom recipes belong to the personal
store. Call sites name the store and apply `DEVICE_DEFAULTS` or
`PERSONAL_DEFAULTS` when a key is absent or unreadable. Signed-out account reads
use built-in defaults, never device values. Editing account content requires
sign-in. The general reset button resets device settings only.

```ts
const app = getWhisperingApp();
const trigger = $derived(app.local.kv.get('recordingTrigger') ?? DEVICE_DEFAULTS.recordingTrigger);
app.local.kv.update({ recordingTrigger: 'vad' });
const dictionary = $derived(app.personal?.kv.get('dictionary') ?? []);

const recording = $derived(app.library.tables.recordings.get(recordingId));
const history = $derived(sortedRecordings(app.library));
```

The selected `library` remains only for recording history while its permanent
owner is being decided. It does not route settings or recipes. Previous
device-authored content remains downloadable from the shell; it is not copied
into an account automatically. Dictionary is one KV array: concurrent edits
replace that field rather than merging individual terms.

`fromData` owns the live row projection. Recordings and recipes have no second
cache or subscription lifetime. The functions in `whispering/recordings.ts` and
`whispering/recipes.ts` handle product behavior: recording defaults, audio
loading, history ordering, and copying a built-in recipe into an editable row.

## Inference choices

The device KV stores `transcriptionConnection` with `transcriptionModel` and
`completionConnection` with `completionModel`. Each picker callback writes its
pair in one update. Both workflows start unselected. `getInferenceTarget` reads
the pair, and the shared catalog resolves that exact destination to an SDK
client. Missing connections never fall back to another provider.

The UI session imports matching legacy browser selections once. Explicit null
marks an unselected or reset workflow, so resetting settings cannot restore an
old choice. The importer immediately disposes the legacy reader; KV is the only
ongoing source of truth.

## Audio lifetime

Recording producers save bytes before creating a row. Manual Stop returns the
saved key; imports and voice-activated capture use `saveAudioRecording`. Failed
row creation retains those bytes. Deleting a row also retains local and uploaded
audio.

Playback uses `openRecordingAudio` and releases its disposable source when the
player closes. Transcription and downloads use `readRecordingAudio`. Both prefer
local bytes and use an explicitly uploaded URL only when local bytes are missing
and the app has remote access. `recordingAudioAvailability` checks metadata
without loading the audio.

The processing pipeline receives a recording ID, so retrying transcription does
not publish another blob or create another row. Markdown ZIP export reads table
rows and includes audio references rather than audio payloads.

## Capture and device state

Device configuration, microphone selection, voice activity detection, and the
dictation lifecycle have their own event sources. They remain live state because
a table subscription cannot describe a microphone starting or capture failing.
The UI session owns the recording workflow and stops admitting new work when it
is disposed.

Use the query layer for asynchronous capabilities such as downloading audio or
running transcription. Use a `$derived` read over the adapted store for settings,
recording rows, and recipe lists. A new state owner needs an event source or a
lifetime that the existing store does not already own.
