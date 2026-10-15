# @epicenter/recorder

Recordings written into a folder, microphone streams, device vocabulary, and
voice activity detection.

## Recording into a folder

A recording is a file in its folder
([ADR-0543](../../docs/adr/0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md)).
The bare entry chooses where the page runs when it is called, as
`@epicenter/folder` does:

```txt
@epicenter/recorder                    chooses by isTauri() when called
  /tauri    → tauri-plugin-epicenter-recorder: the shell writes <path>.wav from the first sample
  /browser  → MediaRecorder in memory, written to the folder on stop
```

```ts
import { recoverRecordings, startRecording } from '@epicenter/recorder';

const folder = { id: 'so.epicenter.whispering', files: opened.files };
await recoverRecordings({ folder, under: 'recordings' });
const { data: recording, error } = await startRecording({
	folder,
	path: 'recordings/2026-10-15-0930',
	input: { deviceId, label }, // optional; undefined is the system default
});
const unsubscribe = recording.onLevel((level) => meter.set(level));
const { data: stopped } = await recording.stop(); // { path, durationMs }, or recording.cancel()
```

`folder` is the folder's ID, which names the scope the desktop shell granted
the window, and its `files`, through which a browser writes. A handle from
`@epicenter/folder` supplies both.

| | Desktop | Browser |
| --- | --- | --- |
| `recording.path` | `<path>.wav`, already in the folder | `<path>.webm`, or `.mp4` or `.ogg` where the browser records those, written on stop |
| Chosen microphone | Asked for by its name (`input.label`) | Asked for by its ID (`input.deviceId`) |
| `stop` | Finalizes the WAV | Writes the file with `files.create` |
| `cancel` | Deletes the WAV | Writes nothing |
| Quit, crash, closed window | Audio kept up to the cut | Lost |
| `recoverRecordings` | Rewrites the header of any WAV a quit cut off | Answers `[]` |

A chosen microphone that is not connected is refused as `InputUnavailable`
on both; no other microphone is opened in its place. Every failure is a
`RecorderError`, switched on by `name`. Nothing here says whether a
recording is running: that is the handle `startRecording` returns, and it
ends with the page.

## Streams and voice activity detection

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
