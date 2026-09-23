# State

This folder owns live capture state, device preferences, and UI projections that
need more than a table read. Declared application data is read through the
existing store API. Do not add a listener set or a copied array to make a table
reactive.

`WhisperingShell` mounts after Local opens. The module export `local` is reactive.
Personal opens independently; its ready provider adapts the store with `fromData`
and establishes context before consumers mount. Operations receive captured handles.

## Settings and rows

Device settings use the account-independent Local store and do not sync.
Dictionary, custom instructions, and custom recipes belong to the personal
store. Call sites name the store and apply `DEVICE_DEFAULTS` or
`PERSONAL_DEFAULTS` when a key is absent or unreadable. Signed-out account reads
use built-in defaults, never device values. Editing account content requires
sign-in. The general reset button resets device settings only.

```ts
import { local } from '$lib/whispering/local';
import { getPersonal } from '$lib/whispering/personal';

const trigger = $derived(local.kv.get('recordingTrigger') ?? DEVICE_DEFAULTS.recordingTrigger);
local.kv.update({ recordingTrigger: 'vad' });
// During component initialization beneath PersonalProvider:
const personal = getPersonal();
const dictionary = $derived(personal.kv.get('dictionary') ?? []);
const history = $derived(sortedRecordings(personal));
```

Local and Personal history have explicit routes. Shared views receive their store.
Dictionary is one KV array: concurrent edits replace that field rather than merging
individual terms. Capture retains the current account's prompt/dictionary acquisition;
a pending or failed Personal open cannot silently substitute defaults for that account.

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

Recording producers save Local bytes before creating a Local row. Deleting a row
retains its audio; it does not erase bytes.

Playback opens the Local row's audio through its store and disposes the source
when the player closes. Transcription and downloads read from that same store.
Expired sources can be reopened in the player.

Document-owned recovery keeps known BlobIds, mapped values, accepted row IDs and
inferred text across route changes. Finish saving retries persistence without another
upload, row creation or inference request. Success requires flush and saved status;
server delivery is separate. Reload ends this recovery promise.

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
