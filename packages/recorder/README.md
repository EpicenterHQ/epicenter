# @epicenter/recorder

Microphone capture without application settings, tables, transcription, or UI.
The recording subpaths supply one session contract for browser and desktop;
the root supplies lower-level browser stream acquisition and voice activity
detection for consumers that need utterances instead of saved recordings.

## Saved recordings

The opened application exposes saved capture through `app.recording`:

```ts
const app = epicenter.openLocal();
const ready = await app.ready;
if (ready.error) return showError(ready.error);
const started = await app.recording.start();
if (started.error) return showError(started.error);
const recording = started.data;
const unlevel = recording.onLevel(showLevel);
const stopped = await recording.stop();
unlevel();
if (stopped.error) return showError(stopped.error);
// stopped.data: { audioBlobId, durationMs, byteLength }
```

`@epicenter/recorder/recording` owns the contract.
`createBrowserRecording(appId, account)` from `/browser` uses MediaRecorder and
the app's scoped browser blob store. `createDesktopRecording(appId, account)` from `/desktop`
invokes Epicenter's native recorder. Choose the binding once at composition;
construction opens no microphone, dataset, or model. Optional `selectedDeviceId`
uses the same device vocabulary as stream acquisition.

Opening the app captures its local or account destination before permission acquisition.
`openLocal()` binds the local library; `openAccount(account)` binds that account's
library. These platform factories receive the captured identity at composition;
feature code never passes an account into a recording operation.
Stop publishes complete bytes there; cancel discards them. Each session resolves
once, and subsequent stop/cancel calls return `NoActiveRecording`. Identity is
immutable. An unexpected capture ending leaves accepted audio available to stop
or cancel; `onEnded` reports that fact, including to a late subscriber.

`app.recording.current()` recovers only the opened app's destination. Desktop recordings
can survive a reload of their owning window, and window destruction cancels
them. Browser recordings belong to their document. Recording methods share the
app's readiness and close gate. `app.close()` waits for admitted starts and stops,
then cancels unresolved capture before releasing storage. Applications that want
to save that audio must stop and save it before closing. Recording does
not insert rows, upload audio, or apply transcription policy.

Text-only dictation should own temporary capture and release it with its session;
it need not publish saved recordings. The browser stream/VAD primitives below
remain independent of this saved-artifact API.

Run `bun test` for lifecycle checks and `bun run smoke:browser` for Chromium
capture, storage, decoding, metering, and cancellation with a synthetic microphone.

## Public API

```ts
import {
  // Device stream (navigator.mediaDevices)
  getRecordingStream,
  enumerateDevices,
  cleanupRecordingStream,
  DeviceStreamError,

  // Voice activity detection (Silero v5 via @ricky0123/vad-web)
  createVadRecorder,

  // Device vocabulary
  asDeviceIdentifier,
} from '@epicenter/recorder';
```

Types: `Device`, `DeviceIdentifier`, `DeviceAcquisitionOutcome`,
`VadRecorder`, `VadRecorderError`, `StartActiveListeningOptions`.

The core is callback and `Result` based, with no framework reactivity. A Svelte
app that wants reactive state wraps the core in its own thin runes layer (see
Whispering's `vad-recorder.svelte.ts`).

## VAD runtime assets (required)

`@ricky0123/vad-web` fetches its worklet, Silero ONNX model, and onnxruntime
wasm from a base path at runtime; the files are not bundled. `createVadRecorder`
loads them from `assetBaseUrl` (default `/vad/`). Each consuming app must copy
those files so they are served at that path, or VAD fails to initialize at
runtime (this is not caught by `tsc`).

The package resolves the source paths from its own pinned dependency tree.
Feed them to your build's static-copy step. With Vite:

```ts
// vite.config.ts
import { VAD_ASSET_DEST, vadAssetSources } from '@epicenter/recorder/vad-assets';
import { viteStaticCopy } from 'vite-plugin-static-copy';

viteStaticCopy({
  targets: vadAssetSources.map((src) => ({
    src,
    dest: VAD_ASSET_DEST, // 'vad' -> served at /vad/
    rename: { stripBase: true },
  })),
});
```

If you set a non-default `assetBaseUrl`, serve the files at that path instead.
