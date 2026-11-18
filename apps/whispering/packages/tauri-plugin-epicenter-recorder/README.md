# tauri-plugin-epicenter-recorder

Whispering's desktop microphone. It lists the inputs, reads one's level, and
records: a page in the shell opens no microphone of its own.
A recording is written to the disk from the first sample and reaches
Whispering's folder only once it is finished
([ADR-0543](../../../../docs/adr/0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md),
[ADR-0894](../../../../docs/adr/0894-whispering-8-keeps-its-recordings-and-their-audio-in-its-own-data-directory-and-needs-no-epicenter.md)):
`start` creates the take, `<appLocalDataDir>/local/recording/<id>.webm`, and
encodes the microphone into it as Opus as it captures, a second at a time,
and `stop` finishes it in place and places it at `recordings/<id>.webm` in
the folder. Nothing deletes a recording's audio. A quit, a crash, or a
closed window keeps the audio up to the cut. A recording adds no Close or
Quit warning.

A microphone is opened at the rate it already runs at, never another: on
macOS a stream at another rate changes the device's rate for every app using
it, and leaves it changed. The writer converts to 16 kHz.

A page reaches it through `@epicenter/recorder/tauri`. `recover` is the desktop's alone: the
shell outlives the page, so it can finish a take a cut left
([ADR-0780](../../../../docs/adr/0780-a-surface-uses-what-its-platform-gives-and-parity-is-not-a-goal.md)).

## Layout

| Path | What it is |
| --- | --- |
| `src/recorder.rs` | The CPAL pipeline: a non-blocking audio callback, a bounded queue, and a writer thread that converts to 16 kHz, encodes and writes as it captures. One recording at a time, owned by the window that started it. |
| `src/rate.rs` | The conversion from the microphone's rate to the recording's 16 kHz, on the writer thread. |
| `src/opus.rs` | The encoder: 20 ms at a time, to Opus at 24 kbps, as the recording arrives. |
| `src/webm.rs` | The WebM it is written in, a whole second at a time (`LiveWebm`), and `finish_cut_off`, which finishes a file a crash cut off from its whole seconds. |
| `src/takes.rs` | Where a take is recorded (`local/recording/<id>.webm`), how it reaches the folder (`place_take`, the shared place step in `whispering-files`), and `recover`, which finishes and places what a cut left. |
| `src/meter.rs` | A microphone opened for its level only, closed by its page or with it, or on its own when its stream dies or its page stops hearing it. |
| `src/permission.rs` | Microphone access through AVFoundation, asked before any microphone opens. |
| `src/commands.rs` | `inputs`, `open_meter`, `close_meter`, `start`, `stop`, and `recover`. |
| `src/ended.rs`, `src/error.rs` | Why a capture ended on its own, and the refusals a page switches on by `name`. |
| `../recorder/src/native/bindings.gen.ts` | TypeScript commands and types, generated from the plugin into `@epicenter/recorder`. Do not edit. |

## Installing it in a shell

Install it beside `tauri-plugin-fs`, whose scope says which folders it may
place a take in: the default folder the shell allows at start, and one the
person picks in the folder dialog. Takes are recorded in
`local/recording/` in the app's local data directory
(`app.path().app_local_data_dir()`), which the plugin makes when it first
records.

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_epicenter_recorder::init())
```

To draw a recording indicator, build it with a listener, which runs on the
main thread whenever a microphone may have opened or closed:

```rust
.plugin(
    tauri_plugin_epicenter_recorder::Builder::new()
        .on_capturing(|app, capturing| set_tray_icon(app, capturing))
        .build(),
)
```

Give the recording window `epicenter-recorder:default`. It needs no event permission: a meter's levels
and an ending arrive on the channel the page passes to `open_meter` or
`start`.

## Commands

A page names a microphone by the id `inputs` answers, cpal's `DeviceId` as
text (`coreaudio:<device UID>` on macOS), which stays the same across
launches and reconnections. To record, it names its folder by its absolute
path and the recording's id, one plain name (`A-Z a-z 0-9 - _`). A folder
the file system scope does not allow is refused.

| Command | What it does |
| --- | --- |
| `inputs()` | Lists the input devices connected now as `{ id, name, isDefault }`. Opens nothing, so it needs no microphone permission. |
| `open_meter(device, levels)` | Opens the microphone with id `device`, or the system default, and sends its level on `levels` until `close_meter(id)`, or until the window's page reloads or the window is destroyed. Nothing is recorded. Answers the meter's `id` and the microphone's name. |
| `close_meter(id)` | Closes a meter. Only the window that opened it may close it. |
| `start(dir, id, device, signals)` | Records the take `id` into `local/recording/<id>.webm`, from the microphone with id `device` or the system default, for the folder `dir`. Answers nothing. |
| `stop()` | Finishes the recording this window started, places it at `recordings/<id>.webm` in its folder, and answers `{ id, durationMs }`. It takes the same few milliseconds for a recording of any length. A file already at that path is never replaced: the answer is `Unplaced`, whose message says where the finished take is kept, and the take stays in `local/recording/`. Only the window that started it may stop it. |
| `recover(dir)` | Finishes every take a cut left in `local/recording/` from its whole seconds and places it at `recordings/<id>.webm` in `dir`, leaving the take still being written alone. Answers `{ recovered, unplaced }`: each take it placed as `{ id, durationMs }`, from the length its file states, so a page never reads the audio back to measure it (a second run places none); and each take it could not place as `{ id, take }`, where `take` is its absolute path, because a file is already at its audio path or it could not be finished or placed. That take is never deleted and never placed beside the other file: it stays, finished, and is answered on every run until it is placed or a person moves it. A leftover with no whole second holds no audio and is deleted. First it removes each `.ep-<random>.save` a crash left in the folder, `recordings/`, or `transcriptions/` (`whispering_files::clear_saves`), never one a copy is still writing. A page runs it once its folder is open. |

`start` refuses before it opens anything:

- `Refused`: the folder is not one the file system scope allows, the id is
  not one plain name, a link is on the way to `recordings/`, or the
  recording's audio or its take already exists.
- `PermissionDenied`: macOS does not allow Epicenter the microphone.
- `InputUnavailable`: no microphone with the id `device` is connected.
  Another is never opened in its place. `open_meter` refuses the same way.
- `Busy`: another recording holds the host's one recorder.

`signals` carries `{ kind: 'ended', reason }` once if the capture ends on its own: the
microphone went away, permission was withdrawn, the stream failed, or the
file could not be written. What was captured stays the owner's to `stop`.

## The take

While it records, the recording is a take outside the folder,
`<appLocalDataDir>/local/recording/<id>.webm`, so a listing, a file syncer,
or a home's checkpoint (`git add -A`) never sees it grow. It is created with
`create_new`, so nothing already there is written through. `local/` is this
computer's own and stays in the app's local data directory wherever the
folder moves. Nothing in `local/recording/` is ever deleted while it holds
audio: a take is only placed.

It is Opus in WebM from the first sample, as Safari and Chromium play it to
the exact length:

- Opus, mono, 24 kbps variable rate, tuned for voice, in 20 ms packets, from
  16 kHz: about 10.5 MB an hour of speech. libopus is the copy
  `audiopus_sys` bundles, built from source for every build (`OPUS_NO_PKG`
  in the repository's `.cargo/config.toml`), never a system or Homebrew
  copy. Encoding as it records costs about half a second of one core a
  minute of audio.
- WebM (`src/webm.rs`): the encoder's lookahead as the `OpusHead` pre-skip
  and as CodecDelay, 80 ms of SeekPreRoll, Clusters of one second. Each
  Cluster is held in memory until it is whole and then written in one
  write, with its size, so the file is always whole seconds. The Segment's
  size, the Duration, and the Cues' place are left unstated (a Void holds
  each place) until the recording is finished.

`stop` finishes the take in place: the last second from memory, its last
packet's padding trimmed (DiscardPadding), then the Cues, the Duration, and
last the Segment's size, each flushed to the disk first, so a file whose
Segment states its size is finished. It then places the take at
`recordings/<id>.webm` without replacing anything there, through the place
step Whispering's file commands share (`whispering-files`): a rename that
fails when a name is already there, or, where the disk has no such rename,
a hard link then the take's name removed. When the folder is on another
volume, the take is copied to `.ep-<random>.save` beside its target,
synced, and renamed into place, and only then removed. On one volume all
of it takes the same few milliseconds for a recording of any length.

A write the disk refuses (it is full, or its volume went) ends the capture
with `storageFailed`, and the second it was writing is cut back off the
file; `stop` then finishes what reached it. If even that cannot be
written, `stop` says so and the take stays for the next `recover`.

The recording is finished and placed, never deleted, when:

- the page that started it begins to reload (`on_page_load`), or its window is
  destroyed, so no page is left to stop it;
- the app exits;
- `stop` is called after the capture ended on its own.

A process that ends before any of those leaves the take in
`local/recording/` with every whole second but the one held in memory:
a crash loses at most about a second. `recover`, which a page calls once its
folder is open, finishes it from those seconds (a torn one at its end is
dropped) and places it. Until then nothing reads it: it is not in the
folder, and a cut-off file reads wrong in a player (no length) and in the
transcription decoder (a torn block).

## Tests

```sh
cargo test                       # the pipeline over a stand-in worker, the encoder and its file, a kill and cuts at every byte, a full disk, recovery, and the commands on the mock runtime
RECORDER_WRITE_BINDINGS=1 cargo test bindings   # rewrite the committed TypeScript bindings
cargo test -- --ignored physical # opens the physical default microphone for a second
cargo test --release -- --ignored an_hour --nocapture   # records an hour and prints its size and how long Stop took (RECORDER_MEASURE_WAV=<16 kHz WAV> for real speech)
```

The encoder's and recovery's tests decode what they wrote with the
transcription plugin's decoder, which a recording is transcribed with: every
sample a file says it plays comes back, in place. The kill test records in a
child process and kills it with SIGKILL. No test but the ignored physical one opens a microphone: every refusal the commands
make happens before a stream is built, and a meter's lifecycle is driven with
a stand-in worker.

Microphone access is the plugin's own (`src/permission.rs`): `open_meter` and
`start` ask macOS before they resolve a device, for every caller. A person not
yet asked sees the system prompt; a denial is `PermissionDenied` and nothing
opens. `inputs` asks for nothing. A meter or a recording counts as an open
microphone for `on_capturing`.

If the page leaves while permission is pending, granting it does not open a
microphone for that page. Both meter opening and recording start recheck page
ownership after permission, before resolving a device.
