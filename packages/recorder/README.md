# @epicenter/recorder

Recordings, microphone streams, device vocabulary, and voice activity
detection.

## Recording

A recording is a file in the app's store from its first moments, written as
it records, so a quit, a crash, or a closed tab keeps the audio up to the cut
([ADR-0543](../../docs/adr/0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md),
decision 84). Each entry exports one `recorder`, both satisfying the bare
entry's `Recorder` interface, and every build calls it the same way, from
the entry its `#platform` seam imports; nothing chooses at run time, so the
type checker, tests, and every bundler resolve each specifier to the same
file:

```txt
@epicenter/recorder           the shared vocabulary: Recorder, the types, RecorderError, audioDurationMs; no implementation
  /tauri    → recorder over tauri-plugin-epicenter-recorder: the shell writes Opus in WebM under .epicenter/recordings from the first sample, and places it at <path>.webm at stop
  /browser  → recorder over MediaRecorder: each piece appended to <path>.m4a (or .webm) in this browser's files; VAD
  /vad-assets → the VAD runtime files, for a build's static copy
```

| `Recorder` | What it does |
| --- | --- |
| `start({ folder, path, input?, signal? })` | Record into the store as it records; the handle's `stop` answers `{ path, durationMs }` |
| `recover({ folder, under, unnamed })` | Repair recordings a quit, a crash, or a closed tab cut off, and answer each the app should now record, among them each of `unnamed` (audio at its path the app keeps no record of) that is whole: `{ recovered, unplaced }` |
| `listInputs()` | The inputs connected now, `{ inputs: [{ deviceId, label }], namesWithheld? }`. Opens nothing and never asks for access |
| `openMeter({ input?, signal? })` | Open one input for its level only, until `close` |
| `allow?({ signal? })` | Browser only: ask for access so inputs are listed by name, releasing the default microphone at once |
| `onInputsChange?(listener)` | Browser only: hear inputs connected or removed. The desktop shell announces nothing |

The functions need no `this`, so an app passes the whole `recorder`, or any
one of them, on its own.

```ts
// From '@epicenter/recorder/tauri' in a desktop build, '@epicenter/recorder/browser' in a web one:
// the module behind the app's #platform seam imports one, and the call is the same.
import { recorder } from '@epicenter/recorder/browser';

await recorder.recover({ folder, under: 'recordings', unnamed }); // when the folder opens, before anything records
const { data: recording, error } = await recorder.start({
	folder, // the app's folder (openFolder), or reactive's copy of it
	path: 'recordings/2026-10-15-0930', // no extension: the format's is added
	input: { deviceId, label }, // optional; undefined is the system default
});
const { data: stopped } = await recording.stop(); // { path, durationMs }: the microphone is released, and the audio is at its path
stopped.path; // 'recordings/2026-10-15-0930.webm' (desktop, and a browser without MP4) or '.m4a' (browser): only stop says which
```

`folder` is the app's own, so the audio lands beside the rest of its files:
on the desktop the shell writes into the open `Data` root; in a browser the
page appends through `filesOf(folder)` from `@epicenter/folder/browser`,
whose Worker writes each piece to the end of the file with a sync access
handle. A folder that keeps no files in this browser (an account's
repository) is refused with `Unavailable` before any microphone opens.

| | Desktop | Browser |
| --- | --- | --- |
| The file | `<path>.webm`: Opus in WebM written from the first sample in the folder's `.epicenter/recordings` (hidden, never synced), finished and placed at its path by `stop` | `<path>.m4a`, else `<path>.webm`, from the first piece (about a second) |
| `stop` | Finishes the file in place and places it: the same few milliseconds for a recording of any length. A file already at its path is never replaced: the refusal says so, and where the recording is kept | The file was written at its path as it recorded |
| Format | Opus in WebM, mono, 24 kbps, from 16 kHz PCM (about 10.5 MB an hour of speech) | AAC in fragmented MP4, else Opus in WebM, named by the type produced |
| While it records | Each whole second is written as it is encoded | Each piece is appended as it arrives; the store's listeners hear the file made and finished, not every piece |
| Quit, crash, closed window or tab | Audio kept up to about the last second | Every piece already written is kept |
| `recover` | Finishes a recording a quit cut off from its whole seconds and places it as `stop` does. Answers `recovered`, each `{ path, durationMs }` placed, from the length its file states, and `unplaced`, each `{ path, pending }` whose path holds another file: that recording is never deleted, stays finished at `pending` under `.epicenter/recordings`, and is answered on every run until a person moves one of the two, so an app says where it is. Each of `unnamed` not placed now is answered too, its length unread: the shell places a recording at its path only whole. Run it before anything lists, plays, or transcribes a recording: a cut-off file reads wrong until it is finished | Cuts an `m4a` or `webm` back to its last whole piece, skipping one a tab is still writing (it holds a Web Lock named for the recording's path, whatever extension its file took). Reads only `unnamed`, since a recording the app keeps a record of is whole, and nothing when it is empty. Answers `recovered`, `{ path, durationMs }` for each of them no tab is writing, cut or already whole, the length read from the file, so an app can tell a cut-off recording from one another tab is recording; `unplaced` is always empty |
| Refused before the microphone opens | The folder or path may not be written, or a file is there | This browser keeps no files here (a private window), or a file is there |
| Chosen microphone | Asked for by the shell's ID, as `listInputs` answers it (`input.deviceId`) | Asked for by the browser's ID, as `listInputs` answers it (`input.deviceId`) |
| Voice processing | None: cpal reads the device as it hears | Off: echo cancellation, noise suppression, and gain control are asked off, since Safari's take about 2 s to start and MediaRecorder drops that time |
| `signal` aborted after the microphone opened | Stopped: the recording is finished and kept | Released; nothing was written |
| `durationMs` at `stop` | The samples written over the rate, which the file's Duration states too | Read from the file written; the time between start and stop only when its bytes do not read. An engine drops the first moments of a recording (Safari about 0.3 s), so the clock says more than the audio holds |

`audioDurationMs(bytes, ext)` reads how long a `wav`, `m4a`, or `webm` the
recorder wrote plays, from its own bytes (a desktop `webm`'s stated Duration,
exact to the sample), so an app can measure audio at its path that
`recover` did not answer a length for: a recording the shell
placed after its page left, or one whose `stop` answer nobody heard. A store that stops taking pieces mid-recording ends it
as `storageFailed`; stop keeps what landed.

AAC in MP4 is asked for first (`audio/mp4;codecs=mp4a.40.2`, saved as `.m4a`),
then Opus in WebM (`.webm`). The browser recorder reads the page's own
microphone, encoder, audio graph, clock, and Web Locks; its tests put fakes
in place of those globals.

`onEnded` reports the first unexpected ending, including one received before
subscription. Stop still claims what was captured and retires the listeners.
Every recording and meter, on either host, keeps its listeners the same way
(`signals.ts`).
Nothing deletes a recording. In a browser, final encoder output is collected
even if the browser already stopped after its microphone tracks ended.

A chosen microphone that is not connected is refused as `InputUnavailable`
on both; no other microphone is opened in its place. Every failure is a
`RecorderError`, switched on by `name`. Nothing here says whether a
recording is running: that is the handle `recorder.start` returns, and it
ends with the page.

## Inputs and levels on the desktop

A desktop page opens no microphone of its own.
`@epicenter/recorder/tauri` asks the shell for the inputs and for a level:

```ts
import { recorder } from '@epicenter/recorder/tauri';

const { data: listing } = await recorder.listInputs(); // { inputs: [{ deviceId, label }] }
const { data: meter } = await recorder.openMeter({ input: listing.inputs[0] });
meter.microphone; // its name
meter.onLevel((rms) => bar.set(rms)); // at most twenty times a second
await meter.close(); // the shell also closes it when the page reloads or its window closes
```

A meter's `onEnded` reports its first unexpected ending, including one received
before the open reply or subscription. `close` retires its listeners. Each
recording and meter owns a channel the shell sends its ending on, and a
meter its levels.
There is no `allow` and no `onInputsChange`: the shell names every input
without access, asks for access itself, and announces no changes.

The ID is cpal's device ID (`coreaudio:<device UID>` on macOS), which stays
the same across launches and reconnections. Listing needs no microphone
permission; the shell's recorder asks macOS for it before it opens a meter
or records, and a denial is `PermissionDenied`.

## Inputs and levels in a browser

`@epicenter/recorder/browser`'s `recorder` has the same `listInputs` and
`openMeter`, over the page's own microphone, and two the desktop has no use
for: `allow`, which opens the default microphone and releases it at once so
the browser lists inputs by name, and `onInputsChange`, the browser's
`devicechange`. `listInputs` is the browser's own `enumerateDevices`,
without the system aliases (`default`, `communications`), which no input
stands for; until access is allowed it names nothing and says
`namesWithheld`. Recording, a meter, enabling access, and voice activity
detection all open a microphone the same way (`microphone.ts`): exactly the
chosen input, with the browser's voice processing off, and released by
whoever opened it.

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
