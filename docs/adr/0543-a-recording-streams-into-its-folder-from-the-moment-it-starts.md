# 0543. A recording streams into its folder from the moment it starts

- **Status:** Superseded
- **Date:** 2026-10-15
- **Superseded by:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md): the full desktop app platform; only a local built-app runner over chosen data repositories remains, without source installation, build approvals, or general native services.
- **Amended:** 2026-10-16, at "One interface, chosen by host": the bare `@epicenter/recorder` no longer chooses by `isTauri()`. It is the recording contract alone, and a build imports `/tauri` or `/browser` (Whispering through `#platform/workspace`), because the runtime branch was reached only by the type checker and tests while builds aliased it away.
- **Amended by:** [ADR-0577](0577-audio-stays-on-the-machine-that-recorded-it.md) at "`recordings/<name>.wav`": the audio is written to `audio/<name>.wav`, and rows stay in `recordings/`.
- **Unbuilt:** a real desktop run: the microphone permission prompt, a recording through the shell's recorder, and a quit mid-recording leaving a playable WAV once `recoverRecordings` runs.

## Context

Epicenter's native recorder (since moved to
`packages/tauri-plugin-epicenter-recorder/src/recorder.rs`) already appends
PCM16 to a WAV through `hound`'s `WavWriter` as it captures,
but into a staged blob in app data that is published into the folder only on
stop, and `cancel_recording_owned_by` deletes it when its window reloads or
closes. Standalone Whispering records with the browser's `MediaRecorder` and
holds the audio in page memory until stop. A quit mid-recording loses the
recording on both.

## Decision

**A desktop recording writes `recordings/<name>.wav` in its folder from the
moment it starts, appending as it captures.** It is the one data file written in
place rather than staged and renamed, and the shell checks its path like any
other. Stop finalizes the header. Closing or reloading the window that owns it
finalizes it too; nothing deletes it but `cancel`.

**One interface, chosen by host, as `@epicenter/folder` is
([ADR-0533](0533-one-folder-handle-opens-in-three-hosts-chosen-by-where-the-code-runs.md)).**

```txt
@epicenter/recorder                    the bare import chooses by isTauri()
  /tauri    → tauri-plugin-epicenter-recorder: the recorder moved out of
              apps/epicenter, registered by the Epicenter host (ADR-0493)
  /browser  → MediaRecorder in memory, written to the folder on stop
```

```ts
await recoverRecordings({ folder, under: 'recordings' });
const recording = await startRecording({ folder, path: 'recordings/2026-10-15-0930' });
const unsubscribe = recording.onLevel((level) => meter.set(level));
const { path, durationMs } = await recording.stop();   // or recording.cancel()
```

| | Desktop | Browser |
| --- | --- | --- |
| `startRecording` | Creates `<path>.wav` and appends | Records in memory |
| `stop` | Finalizes the WAV header | Writes `<path>.webm` (`.mp4` or `.ogg` where the browser records those) |
| Quit, crash, window closed | Audio kept up to the cut | Lost |
| `recoverRecordings` | Rewrites the header of any WAV whose length disagrees with it | Does nothing |

**The row stores facts only** ([ADR-0542](0542-quitting-is-immediate-because-unfinished-work-already-lives-in-its-folder.md)):
`audioPath`, `startedAt`, and later the transcript. Whether a recording is
running is the live handle; whether it has audio is whether `audioPath` exists.

## Consequences

- A quit, crash, or closed window keeps the recording on the desktop; nothing
  asks first.
- Whispering's in-memory capture on the desktop, its unsaved-work checks, and
  the delete-on-cancel staging go.
- Save version during a recording commits the audio written so far, which is
  valid audio; the next commit holds the whole recording. Nothing tracks which
  file is live.
- The browser keeps no such guarantee, and says so by showing a row without
  audio.

## Considered alternatives

- **A `status` field (`recording`, `done`, `interrupted`, `lost`).** Each value
  goes stale when the process ends, which is why it would need repair.
- **One native recorder for every host.** The browser has no native side.

## Amendment, 2026-11-01: a desktop recording is written in `.epicenter` until it stops

The desktop recorder still writes from the first sample, but into the
folder's own `.epicenter/recording/<path>.wav`, which no listing shows, no
watcher reports, and `epicenter init`'s `.gitignore` keeps out of history.
`stop` (and the shell finishing a recording whose page left) finalizes the
header and moves the WAV to `<path>.wav` without replacing anything there: a
hard link, then the staged name removed. `recoverRecordings` repairs what a
quit or a crash left there and moves it the same way. So `epicenter sync`
never commits a half-written WAV, and readers never see a growing file at a
data path. The browser recorder is unchanged: it appends to its file at its
path in this browser's private storage, which nothing syncs.

## Amendment, 2026-11-01: a stopped desktop recording is Opus in WebM

While it records, a desktop recording is still the WAV in
`.epicenter/recording/<path>.wav`, so a quit or a crash keeps every sample
behind a header `recoverRecordings` repairs. At `stop` the shell encodes it
to Opus in WebM, mono, 24 kbps variable rate, tuned for voice, in 20 ms
packets: about 10.5 MB an hour of speech against the WAV's 115 MB. It
encodes after the microphone is released and the recorder is free, off the
main thread, reading the WAV 20 ms at a time, so an hour costs the memory a
second does. The encode is written into a scratch file of the folder's,
placed at `<path>.webm` without replacing anything there, and only then is
the WAV removed. A crash part-way leaves the WAV, which `recoverRecordings`
encodes again, and a scratch file the folder sweeps once stale. A WAV the
encoder refuses is placed itself, at `<path>.wav`, and `stop` says so: no
audio is lost to an encoder.

The container is the shell's own small WebM writer, which states what Safari
and Chromium need to play and decode the exact samples: the pre-skip as
CodecDelay, SeekPreRoll, the last packet's padding as DiscardPadding, the
Duration, and Cues. Ogg was rejected because WebKit misreports an Ogg Opus
file's duration and seeks (an hour read as 3,682 s); WebM costs Finder and
Quick Look preview on macOS. Nothing in the file varies between two encodes
of one WAV, so recovery tells a recording it already placed by its bytes.
libopus is built from the source `audiopus_sys` bundles, never a system or
Homebrew copy (`OPUS_NO_PKG` in `.cargo/config.toml`). The transcription
decoder trims the pre-skip and the end padding, and decodes Opus straight
to 16 kHz, so it reads back exactly the samples recorded. The browser
recorder is unchanged.

## Amendment, 2026-11-01: a recording in progress is in `.epicenter/recordings`

The WAV the two amendments above place in `.epicenter/recording/<path>.wav`
is written to `.epicenter/recordings/<path>.wav`, and its encode to a
scratch file in `.epicenter/saves`. The folder's sweep never reads
`recordings/`, so a cut-off recording waits there until the app opens and
`recoverRecordings` finishes it. A change under `.epicenter` is a change
under a hidden path, which no watcher reports, so the header rewrite about
once a second wakes no sync round. [ADR-0562's amendment](0562-the-cli-and-the-shell-take-turns-writing-a-folder-under-one-save-lock.md#amendment-2026-11-01-epicenter-holds-only-unfinished-writes-in-saves-and-recordings)
gives the layout.

## Amendment, 2026-11-01: a desktop recording always names its folder

`start` and `recover` take the root the recording is in as a required
absolute path, the one the folder plugin answered when the page opened the
data folder (`rootOf(device)` from `@epicenter/folder/tauri`). No command of
the folder, recorder, or transcription plugin falls back to the directory the
shell bound to the window, which in a standalone app is its AppData, so a
recording can no longer land there because a page named no root.
`openDevice` from `@epicenter/folder/tauri` takes the root's absolute path
too: the window's own folder, a folder inside it, and a client with no root
are gone.
