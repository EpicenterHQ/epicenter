# @epicenter/recorder

Recordings, microphone streams, device vocabulary, and voice activity
detection.

## Recording

A recording lands at its path, whole, when it stops. The two hosts need not
promise the same things
([ADR-0780](../../docs/adr/0780-a-surface-uses-what-its-platform-gives-and-parity-is-not-a-goal.md)):
on the desktop the shell records and outlives the page, so a quit or a
crash keeps the take; in a browser the page keeps the take in memory until
Stop, and a crash or a closed tab loses it
([ADR-0779](../../docs/adr/0779-a-store-is-four-verbs-and-a-browser-recording-lands-whole.md)).
Each entry exports one `recorder`, both satisfying the bare entry's
`Recorder` interface, and every build calls it the same way, from the entry
its `#platform` seam imports; nothing chooses at run time:

```txt
@epicenter/recorder           the shared vocabulary: Recorder, the types, RecorderError, audioDurationMs; no implementation
  /tauri    → recorder over tauri-plugin-epicenter-recorder: the shell writes Opus in WebM under .epicenter/recordings from the first sample, and places it at <path>.webm at stop
  /browser  → recorder over MediaRecorder: pieces kept in memory, written once at <path>.m4a (or .webm) at stop; VAD
  /vad-assets → the VAD runtime files, for a build's static copy
```

| `Recorder` | What it does |
| --- | --- |
| `start({ files, path, input?, signal? })` | Record; the handle's `stop` answers `{ path, durationMs }` once the audio is at its path |
| `recover?({ files, under, unnamed })` | Desktop only: finish recordings a quit or a crash cut off, and answer each the app should now record, among them each of `unnamed` (audio at its path the app keeps no record of) that is whole: `{ recovered, unplaced }` |
| `listInputs()` | The inputs connected now, `{ inputs: [{ deviceId, label }], namesWithheld? }`. Opens nothing and never asks for access |
| `openMeter({ input?, signal? })` | Open one input for its level only, until `close` |
| `allow?({ signal? })` | Browser only: ask for access so inputs are listed by name, releasing the default microphone at once |
| `onInputsChange?(listener)` | Browser only: hear inputs connected or removed. The desktop shell announces nothing |

The functions need no `this`, so an app passes the whole `recorder`, or any
one of them, on its own.

```ts
// From '@epicenter/recorder/tauri' in a desktop build, '@epicenter/recorder/browser' in a web one:
// the module behind the app's #platform seam imports one, and the call is the same.
import { recorder } from '@epicenter/recorder/tauri';

await recorder.recover?.({ files: folder.audio, under: 'recordings', unnamed }); // desktop: when the folder opens
const { data: recording, error } = await recorder.start({
	files: folder.audio, // the folder's audio collection, at recordings/{id}.{ext}
	path: 'recordings/2026-10-15-0930', // no extension: the format's is added; its last segment is the id
	input: { deviceId, label }, // optional; undefined is the system default
});
const { data: stopped } = await recording.stop(); // { path, durationMs }: the microphone is released, and the audio is at its path
stopped.path; // 'recordings/2026-10-15-0930.webm' (desktop, and a browser without MP4) or '.m4a' (browser): only stop says which
```

`files` is a file collection of the app's own folder whose files are named
by `{ id, ext }` (`AudioFiles`), so the audio lands beside the rest of its
files: on the desktop the shell writes into the open `Data` root; in a
browser Stop writes the take once with `files.set`, which answers once it
landed.

| | Desktop | Browser |
| --- | --- | --- |
| The file | `<path>.webm`: Opus in WebM written from the first sample in the folder's `.epicenter/recordings` (hidden, never synced), finished and placed at its path by `stop` | `<path>.m4a`, else `<path>.webm`, written once by `stop` |
| `stop` | Finishes the file in place and places it: the same few milliseconds for a recording of any length. A file already at its path is never replaced: the refusal says so, and where the recording is kept | Joins the pieces and writes them with `files.set`, answering once the write landed |
| Format | Opus in WebM, mono, 24 kbps, from 16 kHz PCM (about 10.5 MB an hour of speech) | AAC in fragmented MP4, else Opus in WebM, named by the type produced |
| While it records | Each whole second is written as it is encoded | Each piece `MediaRecorder` hands over (about a second) is kept in memory; the leave guard asks before the page closes |
| Quit, crash, closed window or tab | Audio kept up to about the last second | The take is lost |
| `recover` | Finishes a recording a quit cut off from its whole seconds and places it as `stop` does. Answers `recovered`, each `{ path, durationMs }` placed, from the length its file states, and `unplaced`, each `{ path, pending }` whose path holds another file: that recording is never deleted, stays finished at `pending` under `.epicenter/recordings`, and is answered on every run until a person moves one of the two, so an app says where it is. Each of `unnamed` not placed now is answered too, its length unread: the shell places a recording at its path only whole. Run it before anything lists, plays, or transcribes a recording | None: a take never reaches the folder unfinished |
| Refused before the microphone opens | The folder or path may not be written, or a file is there | A file is there |
| Chosen microphone | Asked for by the shell's ID, as `listInputs` answers it (`input.deviceId`) | Asked for by the browser's ID, as `listInputs` answers it (`input.deviceId`) |
| Voice processing | None: cpal reads the device as it hears | Off: echo cancellation, noise suppression, and gain control are asked off, since Safari's take about 2 s to start and MediaRecorder drops that time |
| `signal` aborted after the microphone opened | Stopped: the recording is finished and kept | Released; nothing was written |
| `durationMs` at `stop` | The samples written over the rate, which the file's Duration states too | The recorder's own clock: the time it spent recording, pauses left out |

`audioDurationMs(bytes, ext)` reads how long a `wav`, `m4a`, or `webm`
plays, from its own bytes (a desktop `webm`'s stated Duration, exact to the
sample), so an app can measure audio at its path that `recover` did not
answer a length for: a recording the shell placed after its page left, one
whose `stop` answer nobody heard, or an imported file.

AAC in MP4 is asked for first (`audio/mp4;codecs=mp4a.40.2`, saved as `.m4a`),
then Opus in WebM (`.webm`). The browser recorder reads the page's own
microphone, encoder, audio graph and clock; its tests put fakes in place of
those globals.

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
                 # and reading the length of real Chromium, WebKit and desktop recordings (src/fixtures/)
bun run typecheck
```
