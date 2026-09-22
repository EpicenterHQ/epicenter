# Whispering recording and transcription

**Date**: 2026-09-22
**Status**: Draft

Recording ownership and Personal saving now follow the accepted
[store-relative execution plan](20260923T012158-store-relative-recordings.md).
This older plan retains the separate proposed transcript/attempt redesign; do
not treat that redesign as a prerequisite for the ownership collapse.

## Agreed user workflow

1. Open Whispering and see saved recordings and their transcripts.
2. Start recording.
3. Stop. Save audio locally and add the recording to the local recording list.
4. Automatically start transcription using the selected engine. The recording
   remains available for playback while transcription runs.
5. Save the returned text on that recording and display it for reading or copying.

A failed transcription leaves the saved audio available for manual retry. Starting
another attempt retains previous text until a successful replacement arrives.
Automatic transcription is the default; this decision does not require a new
preference control. An unavailable selection leaves the recording saved and
explains why transcription could not start. Never silently select another engine.

## Building blocks

`@epicenter/app` is the toolkit. The host provides native capabilities. Whispering
composes a store owning structured data and blobs, a recorder, and inference.
This product migration is deferred from the completed API-only implementation
in [the verification report](../docs/reports/20260922-store-owned-blobs-implementation.md).

```text
Whispering
├── Local store
│   ├── Recordings table: metadata, audio references, transcripts, attempt state
│   ├── Settings
│   └── Local blob storage: audio bytes outside the Yjs data document
├── Recorder: captures and commits audio to local blobs
└── Selected transcription engine: reads audio and produces text
```

A definition declares the store schema; an opened store accesses a dataset.
One application can open several stores. A browser/WebView reload replaces
handles, not committed data. A separate overlay can send actions to the main
interface without opening another store. No aggregate App or library object
is needed.

The working layout owns acquisition. Its ready shells publish shared handles
through typed Svelte contexts named with `get*` and `set*`, as specified in
[ADR-0392](../docs/adr/0392-product-boundaries-provide-required-resource-handles.md).
Use `local` and `personal` for concrete stores and `store` for a selected
destination. Components read their ready context during initialization;
operations receive explicit handles. Do not export eager live opening promises.

The transcript starts as `null`. Successful silence produces `''`. Attempt state
is separate from content; failed retranscription preserves the previous text.
Audio bytes remain outside the Yjs document.

## Ideal callsites

These are target design sketches, not a runnable implementation or a claim that
all operations already exist. Store-owned blobs are implemented; these product
operations remain unbuilt. The application
operations `saveRecording` and `transcribeRecording`, and their illustrated
contracts, are proposed Whispering code, not new toolkit exports. `definition`
is Whispering's schema after the nullable-transcript change.

### Open the resources

```ts
import { openLocal } from '@epicenter/app/open';
import { createRecorder } from '@epicenter/app/recorder';

// Inside mounted working startup, not at module scope.
const local = await openLocal(definition);
const localBlobs = local.blobs;
const recorder = createRecorder({ localBlobs });
```

This example chooses local structured data, matching the first workflow. Personal
storage remains a separate explicit acquisition with a required Account. Local
readiness does not wait for it. Personal-dependent children receive a required
`getPersonal()` only inside its ready branch. Inference is optional at startup:
failure to acquire it cannot prevent recording or playback. Required startup
failure presents a persistent failure screen with reload recovery. Openers reject;
the startup boundary handles those rejections without relabeling every bug as an
expected operational failure.

### Start and preserve the exact capture

```ts
const started = await recorder.start({});
// The controller retains started.data only on success.
// A Stop or push-to-talk release targets this exact capture and its id.
```

The controller owns pending state, cancellation, and admission. A delayed release
must never stop a newer capture. The final action caller presents a start failure.

### Stop, save, then automatically transcribe

```ts
// Inside a reusable application operation. capture is the admitted capture;
// selection and signal belong to this action, not a mutable global lookup.
const stopped = await capture.stop();
if (stopped.error) return stopped;

const saved = await saveRecording(store, stopped.data, { signal });
if (saved.error) return saved;

return transcribeRecording(
  { store, localBlobs },
  saved.data.id,
  selection,
  { signal },
);
```

`capture.stop()` already returns committed local bytes identified by `blobId`.
Here `store` is the concrete destination captured before recording; the first
workflow chooses `local`. A signed-in local destination can still use personal
settings and account inference without changing where the recording row goes.
`saveRecording` creates the application's row with `transcript: null`, attaches
recording metadata, and awaits confirmed local persistence before returning
success. A row mutation alone is not that guarantee. Its failure retains the blob
ID, and any known row identity, so recovery need not capture audio again.

After saving, the list can show and play the recording. The same
`transcribeRecording` operation serves automatic transcription and manual retry.
It reads the row's audio reference and local bytes, records the attempt, invokes
the selected engine, and persists the resulting text on that row. Serialize
attempts or fence publication by attempt identity. Its failures retain the
recording identity. If text was produced but persistence failed, the outcome
retains usable text and the write failure; the interface must not claim it was
saved. Cancellation and deliberate departure have explicit outcomes and normally
produce no toast. Departure fences row publication without erasing committed work.

The final caller consumes this Result once. Simple errors can use
`toastOnError(result, title)`; outcomes with usable text or saved audio need
presentation that preserves those successes. Keep logging, notifications, and
recovery actions at that boundary. Do not add a generic action runner.

### Use the selected engine

Native transcription uses the narrow API from ADR-0424. Its direct resource now
exists in the interrupted implementation; consumer migration remains incomplete:

```ts
const runtime = await openRuntimeTranscriber();
// null means unavailable here; an operational failure is a separate outcome.
if (runtime) {
  const result = await runtime.transcribe(
    { audio, model, language, prompt },
    { signal },
  );
  // Return the Result through the application operation.
} else {
  // Return the application's unavailable outcome with the saved recording id.
}
```

Network inference keeps its actual SDK client. Engine-specific request building
belongs in the transcription operation. This does not require a universal
transcriber registry or replacing the network SDK with a new public interface.
Sending audio for remote inference does not require a retained remote blob upload.

## Implementation evidence required

- Stop confirms local audio and row persistence before starting inference.
- Failed or unavailable inference leaves the recording playable and retryable.
- Manual retry uses the saved audio and preserves prior text on failure.
- Successful silence differs from no transcript; stale attempts cannot overwrite
  newer results.
- A failed text write retains usable output without claiming a saved transcript.
- Delayed release targets its original capture; one action has one presentation
  owner; departure prevents retired access from publishing.

This document describes the target, not completed acceptance. The context
documentation pass leaves application code unchanged; earlier implementation
work remains in the checkout. These sketches still need complete integration,
typechecking, and browser/native evidence. Transformations and
retained remote audio upload are separate workflows. Continue with the broader
[execution plan](20260922T170434-page-owned-resources-and-direct-native-transcription.md)
and its adversarial checkpoints after validating these callsites against callers.
