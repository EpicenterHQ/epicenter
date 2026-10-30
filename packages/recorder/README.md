# @epicenter/recorder

Recordings written into a folder, microphone streams, device vocabulary, and
voice activity detection.

## Recording into a folder

A recording is a file in its folder
([ADR-0543](../../docs/adr/0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md)).
Each build imports the entry for where it runs; nothing chooses at run
time, so the type checker, tests, and every bundler resolve each specifier to
the same file:

```txt
@epicenter/recorder           the recording contract: types and RecorderError, no implementation
  /tauri    → tauri-plugin-epicenter-recorder: the shell writes <path>.wav from the first sample
  /browser  → MediaRecorder in memory, written to the folder on stop; streams and VAD
  /vad-assets → the VAD runtime files, for a build's static copy
```

An app that runs in both picks the entry through its own build-time seam
(Whispering's `#platform/services`), and its shared code names only the bare
contract.

```ts
import { recoverRecordings, startRecording } from '@epicenter/recorder/browser'; // or /tauri

await recoverRecordings({ under: 'recordings' });
const { data: recording, error } = await startRecording({
	folder: { write: opened.files.write },
	path: 'recordings/2026-10-15-0930',
	input: { deviceId, label }, // optional; undefined is the system default
});
const unsubscribe = recording.onLevel((level) => meter.set(level));
const { data: stopped } = await recording.stop(); // { path, durationMs }
```

`onEnded` reports the first unexpected ending, including one received before
subscription. Stop still claims what was captured and retires the listeners.
Nothing deletes a recording. In a browser, final encoder output is collected even if the browser
already stopped after its microphone tracks ended.

`folder` supplies `write(path, bytes)`, which publishes the complete recording.
A handle from `@epicenter/folder` supplies it. On the desktop the shell records into
the folder it bound to the recording window, and no call names a folder.

| | Desktop | Browser |
| --- | --- | --- |
| `recording.path` | `<path>.wav`, already in the folder | `<path>.webm`, or `.mp4` or `.ogg` where the browser records those, written on stop |
| Chosen microphone | Asked for by the ID `listInputs` answers (`input.deviceId`) | Asked for by the WebView's ID (`input.deviceId`) |
| `stop` | Finalizes the WAV | Publishes the file with `write(path, bytes)` |
| `signal` aborted after the microphone opened | Stopped: the WAV is finalized and kept | Released; nothing was written |
| Quit, crash, closed window | Audio kept up to the cut | Lost |
| `recoverRecordings` | Rewrites the header of any WAV a quit cut off | Answers `[]` |

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
