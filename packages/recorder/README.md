# @epicenter/recorder

Recordings, microphone streams, device vocabulary, and voice activity
detection.

## Recording

A recording is a file in the app's store from its first moments, written as
it records, so a quit, a crash, or a closed tab keeps the audio up to the cut
([ADR-0543](../../docs/adr/0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md),
decision 84). Every build calls the same two functions, from the entry its
`#platform` seam imports; nothing chooses at run time, so the type checker,
tests, and every bundler resolve each specifier to the same file:

```txt
@epicenter/recorder           the shared vocabulary: types, RecorderError, audioDurationMs; no implementation
  /tauri    → tauri-plugin-epicenter-recorder: the shell writes Opus in WebM under .epicenter/recordings from the first sample, and places it at <path>.webm at stop
  /browser  → MediaRecorder: each piece appended to <path>.m4a (or .webm) in this browser's files; streams and VAD
  /vad-assets → the VAD runtime files, for a build's static copy
```

```ts
// From '@epicenter/recorder/tauri' in a desktop build, '@epicenter/recorder/browser' in a web one:
// the module behind the app's #platform seam imports one, and the call is the same.
import { recoverRecordings, startRecording } from '@epicenter/recorder/browser';

await recoverRecordings({ device, under: 'recordings' }); // when the store opens, before anything records
const { data: recording, error } = await startRecording({
	device, // the client openDevice returned: the data folder, or this browser's files
	path: 'recordings/2026-10-15-0930', // no extension: the format's is added
	input: { deviceId, label }, // optional; undefined is the system default
});
const unsubscribe = recording.onLevel((level) => meter.set(level));
const { data: stopped } = await recording.stop(); // { path, durationMs }: the microphone is released, and the audio is at its path
stopped.path; // 'recordings/2026-10-15-0930.webm' (desktop, and a browser without MP4) or '.m4a' (browser): only stop says which
```

`device` is the app's own store, so the audio lands beside the rest of its
files: on the desktop the shell writes into the root it answered when the page
opened the data folder (`rootOf(device)` from `@epicenter/folder/tauri`); in a
browser the page appends through `deviceFiles(device)` from
`@epicenter/folder/browser`, whose Worker writes each piece to the end of the
file with a sync access handle.

| | Desktop | Browser |
| --- | --- | --- |
| The file | `<path>.webm`: Opus in WebM written from the first sample in the folder's `.epicenter/recordings` (hidden, never synced), finished and placed at its path by `stop` | `<path>.m4a`, else `<path>.webm`, from the first piece (about a second) |
| `stop` | Finishes the file in place and places it: the same few milliseconds for a recording of any length. A file already at its path is never replaced: the refusal says so | The file was written at its path as it recorded |
| Format | Opus in WebM, mono, 24 kbps, from 16 kHz PCM (about 10.5 MB an hour of speech) | AAC in fragmented MP4, else Opus in WebM, named by the type produced |
| While it records | Each whole second is written as it is encoded | Each piece is appended as it arrives; the store's listeners hear the file made and finished, not every piece |
| Quit, crash, closed window or tab | Audio kept up to about the last second | Every piece already written is kept |
| `recoverRecordings` | Finishes a recording a quit cut off from its whole seconds and places it as `stop` does; one whose path already holds a file was placed before the cut, and is deleted. Answers each `{ path, durationMs }` placed, from the length its file states. Run it before anything lists, plays, or transcribes a recording: a cut-off file reads wrong until it is finished | Cuts an `m4a` or `webm` back to its last whole piece, skipping one a tab is still writing (it holds a Web Lock named for the recording's path, whatever extension its file took). Answers `{ path, durationMs }` for every recording no tab is writing, cut or already whole, the length read from the file, so an app can tell a cut-off recording from one another tab is recording |
| Refused before the microphone opens | The folder or path may not be written, or a file is there | This browser keeps no files here (a private window), or a file is there |
| Chosen microphone | Asked for by the ID `listInputs` answers (`input.deviceId`) | Asked for by the WebView's ID (`input.deviceId`) |
| Voice processing | None: cpal reads the device as it hears | Off: echo cancellation, noise suppression, and gain control are asked off, since Safari's take about 2 s to start and MediaRecorder drops that time |
| `signal` aborted after the microphone opened | Stopped: the recording is finished and kept | Released; nothing was written |
| `durationMs` at `stop` | The samples written over the rate, which the file's Duration states too | Read from the file written; the time between start and stop only when its bytes do not read. An engine drops the first moments of a recording (Safari about 0.3 s), so the clock says more than the audio holds |

`audioDurationMs(bytes, ext)` reads how long a `wav`, `m4a`, or `webm` the
recorder wrote plays, from its own bytes (a desktop `webm`'s stated Duration,
exact to the sample), so an app can measure audio at its path that
`recoverRecordings` did not answer a length for: a recording the shell
placed after its page left, or one whose `stop` answer nobody heard. A store that stops taking pieces mid-recording ends it
as `storageFailed`; stop keeps what landed.

A page whose store is not in this browser (an online variant, which writes to
the repository when a recording stops) holds the audio in the page instead,
and `stop` answers it:

```ts
import { startPageRecording } from '@epicenter/recorder/browser';

const { data: recording } = await startPageRecording({ input });
const { data: audio } = await recording.stop();
// { bytes, extension: 'm4a' | 'webm', durationMs }
```

AAC in MP4 is asked for first (`audio/mp4;codecs=mp4a.40.2`, saved as `.m4a`),
then Opus in WebM (`.webm`). The browser recorder reads the page's own
microphone, encoder, audio graph, clock, and Web Locks; its tests put fakes
in place of those globals.

`onEnded` reports the first unexpected ending, including one received before
subscription. Stop still claims what was captured and retires the listeners.
Nothing deletes a recording. In a browser, final encoder output is collected
even if the browser already stopped after its microphone tracks ended.

A chosen microphone that is not connected is refused as `InputUnavailable`
on both; no other microphone is opened in its place. Every failure is a
`RecorderError`, switched on by `name`. Nothing here says whether a
recording is running: that is the handle `startRecording` returns, and it
ends with the page. The handle's `microphone` is the name of the one
recording.

## Inputs and levels on the desktop

A desktop page opens no microphone of its own
([ADR-0571](../../docs/adr/0571-on-desktop-rust-owns-the-microphone-and-the-page-never-opens-one.md)).
`@epicenter/recorder/tauri` asks the shell for the inputs and for a level:

```ts
import { listInputs, openMeter } from '@epicenter/recorder/tauri';

const { data: inputs } = await listInputs(); // [{ id, name, isDefault }]
const { data: meter } = await openMeter({ input: { deviceId: inputs[0].id, label: inputs[0].name } });
meter.microphone; // its name
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

## Levels in a browser

`@epicenter/recorder/browser` has the same `openMeter`, over the page's own
microphone, and `allowMicrophone`, which opens the default microphone and
releases it at once so the browser lists inputs by name. Recording, a
meter, enabling access, and voice activity detection all open a microphone
the same way (`microphone.ts`): exactly the chosen input, with the browser's
voice processing off, and released by whoever opened it. Listing inputs is
the browser's own `enumerateDevices`.

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
bun test         # the browser recorder over fakes, the desktop recorder over a stand-in invoke, VAD release,
                 # and reading and repairing real Chromium and WebKit recordings (src/fixtures/) cut anywhere
bun run typecheck
```

The OPFS appends themselves run in Whispering's and the recorder demo's
Playwright suites, which watch a recording's file grow while it records.
