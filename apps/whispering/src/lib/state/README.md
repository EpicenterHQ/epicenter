# State

This folder owns live capture state, device preferences, and UI projections that
need more than a table read. Declared application data is read through the
existing store API. Do not add a listener set or a copied array to make a table
reactive.

`WhisperingShell` mounts only after the framework App opens. Its UI session adapts
the selected library with `fromData` and device settings with `fromKv`. Adapting
KV alone avoids projecting the local recording library when the person is
viewing Personal. The context gives components those ready handles; operations
receive their dependencies explicitly.

## Settings and rows

Device settings belong to the captured account's local namespace. They do not
sync. `getSetting` applies a release-local default when a key is absent or cannot
be read; writes go directly to KV.

```ts
const app = getWhisperingApp();
const trigger = $derived(getSetting(app.device.kv, 'recordingTrigger'));
app.device.kv.update({ recordingTrigger: 'vad' });

const recording = $derived(app.library.tables.recordings.get(recordingId));
const history = $derived(sortedRecordings(app.library));
```

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
