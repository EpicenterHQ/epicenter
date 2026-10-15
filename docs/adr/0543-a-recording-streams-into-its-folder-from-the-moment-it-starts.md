# 0543. A recording streams into its folder from the moment it starts

- **Status:** Proposed
- **Date:** 2026-10-15
- **Unbuilt:** `@epicenter/recorder`; `tauri-plugin-epicenter-recorder`; writing into the folder in place; `recoverRecordings`.

## Context

Epicenter's native recorder (`apps/epicenter/src-tauri/src/recorder/recorder.rs`)
already appends PCM16 to a WAV through `hound`'s `WavWriter` as it captures,
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
              apps/epicenter, registered by the Epicenter host and standalone Whispering
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
| `stop` | Finalizes the WAV header | Writes `<path>.webm` |
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
- Save version skips an audio file that is still being written, so history
  holds finished recordings.
- The browser keeps no such guarantee, and says so by showing a row without
  audio.

## Considered alternatives

- **A `status` field (`recording`, `done`, `interrupted`, `lost`).** Each value
  goes stale when the process ends, which is why it would need repair.
- **One native recorder for every host.** The browser has no native side.
