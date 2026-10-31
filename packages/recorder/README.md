# @epicenter/recorder

Recordings, microphone streams, device vocabulary, and voice activity
detection.

## Recording

Each build imports the entry for where it runs; nothing chooses at run time,
so the type checker, tests, and every bundler resolve each specifier to the
same file:

```txt
@epicenter/recorder           the shared vocabulary: types and RecorderError, no implementation
  /tauri    → tauri-plugin-epicenter-recorder: the shell writes <path>.wav into its folder from the first sample
  /browser  → MediaRecorder in memory; stop answers the audio; streams and VAD
  /vad-assets → the VAD runtime files, for a build's static copy
```

In a browser, `stop` answers the audio itself, and the app keeps it where it
keeps files (for a contract app, its device client and outbox):

```ts
import { startRecording } from '@epicenter/recorder/browser';

const { data: recording, error } = await startRecording({
	input: { deviceId, label }, // optional; undefined is the system default
});
const unsubscribe = recording.onLevel((level) => meter.set(level));
const { data: audio } = await recording.stop();
// { bytes, extension: 'm4a' | 'webm', mimeType, durationMs }
```

A browser asks for AAC in MP4 first (`audio/mp4;codecs=mp4a.40.2`, saved as
`.m4a`), then Opus in WebM (`.webm`), and names the file by the type it
actually produced. `browserEnvironment()` is the browser's own microphone,
encoder, audio graph and clock; `createBrowserRecorder(environment)` records
over another, such as a generated tone in place of the microphone.

On the desktop the shell records into the folder it bound to the recording
window, or into a `root` the page opened through the folder plugin (a
standalone app's data folder, by the path the shell answered;
`rootOf(device)` from `@epicenter/folder/tauri`)
([ADR-0543](../../docs/adr/0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md)):

```ts
import { recoverRecordings, startRecording } from '@epicenter/recorder/tauri';

await recoverRecordings({ root, under: 'recordings' });
const { data: recording } = await startRecording({ root, path: 'recordings/2026-10-15-0930' });
const { data: stopped } = await recording.stop(); // { path, durationMs }
```

`onEnded` reports the first unexpected ending, including one received before
subscription. Stop still claims what was captured and retires the listeners.
Nothing deletes a recording. In a browser, final encoder output is collected
even if the browser already stopped after its microphone tracks ended.

| | Desktop | Browser |
| --- | --- | --- |
| Where the audio goes | `<path>.wav`, in the folder from the first sample | Answered by `stop`, for the app to keep |
| Format | WAV | AAC in MP4 (`m4a`), else Opus in WebM (`webm`) |
| Chosen microphone | Asked for by the ID `listInputs` answers (`input.deviceId`) | Asked for by the WebView's ID (`input.deviceId`) |
| `signal` aborted after the microphone opened | Stopped: the WAV is finalized and kept | Released; nothing was kept |
| Quit, crash, closed window | Audio kept up to the cut | Lost |
| `recoverRecordings` | Rewrites the header of any WAV a quit cut off | None |

A chosen microphone that is not connected is refused as `InputUnavailable`
on both; no other microphone is opened in its place. Every failure is a
`RecorderError`, switched on by `name`. Nothing here says whether a
recording is running: that is the handle `startRecording` returns, and it
ends with the page.

## Inputs and levels on the desktop

A desktop page opens no microphone of its own
([ADR-0571](../../docs/adr/0571-on-desktop-rust-owns-the-microphone-and-the-page-never-opens-one.md)).
`@epicenter/recorder/tauri` asks the shell for the inputs and for a level:

```ts
import { listInputs, openMeter } from '@epicenter/recorder/tauri';

const { data: inputs } = await listInputs(); // [{ id, name, isDefault }]
const { data: meter } = await openMeter({ input: { deviceId: inputs[0].id, label: inputs[0].name } });
meter.onLevel((rms) => bar.set(rms)); // at most twenty times a second
await meter.close(); // the shell also closes it when the page reloads or its window closes
```

A meter's `onEnded` reports its first unexpected ending, including one received
before the open reply or subscription. `close` retires its listeners. Each
recording and meter owns a channel with the same notification lifetime.

The ID is cpal's device ID (`coreaudio:<device UID>` on macOS), which stays
the same across launches and reconnections. Listing needs no microphone
permission; the shell's recorder asks macOS for it before it opens a meter
or records, and a denial is `PermissionDenied`.

## Voice activity detection

It calls `getUserMedia`, so it is in the browser entry; a desktop build
imports `@epicenter/recorder/tauri` instead.

```ts
import {
	// Voice activity detection (Silero v5 via @ricky0123/vad-web)
	createVadRecorder,
} from '@epicenter/recorder/browser';
```

Types: `VadRecorder`, `VadRecorderError`, `StartActiveListeningOptions`.

Voice activity detection opens its microphone the way recording does: the
system default, or exactly the `input` it is given. When that microphone
cannot be opened, listening is refused with `RecorderError` and no other
microphone is used.

Transient dictation captures utterances without a folder. The core is callback
and `Result` based, with no framework reactivity. A Svelte app that wants
reactive state wraps it in its own runes layer.

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

## Tests

```sh
bun test         # the browser recorder over fakes, the desktop recorder over a stand-in invoke, and VAD release
bun run typecheck
```
