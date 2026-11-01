# tauri-plugin-epicenter-recorder

The desktop shell's microphone. It lists the inputs, reads one's level, and
records: a page in the shell opens no microphone of its own
([ADR-0571](../../docs/adr/0571-on-desktop-rust-owns-the-microphone-and-the-page-never-opens-one.md)).
A recording is written from the first sample
into a folder the recording window opened
([ADR-0543](../../docs/adr/0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md)):
`start` creates a WebM in the folder's `.epicenter/recordings` and encodes
the microphone into it as Opus as it captures, a second at a time, and
`stop` finishes it in place and places it at `<path>.webm`. Nothing
deletes a recording's audio. A quit, a crash, or a closed window keeps the
audio up to the cut. A recording adds no Close or Quit warning.

A microphone is opened at the rate it already runs at, never another: on
macOS a stream at another rate changes the device's rate for every app using
it, and leaves it changed. The writer converts to 16 kHz.

A page reaches it through `@epicenter/recorder/tauri`, whose
`recorder.start({ device, path })` and `recorder.recover({ device, under })`
are the same calls a browser build makes through `/browser`, which appends
each piece of a recording to this browser's files instead (decision 84).

## Layout

| Path | What it is |
| --- | --- |
| `src/recorder.rs` | The CPAL pipeline: a non-blocking audio callback, a bounded queue, and a writer thread that converts to 16 kHz, encodes and writes as it captures. One recording at a time, owned by the window that started it. |
| `src/rate.rs` | The conversion from the microphone's rate to the recording's 16 kHz, on the writer thread. |
| `src/opus.rs` | The encoder: 20 ms at a time, to Opus at 24 kbps, as the recording arrives. |
| `src/webm.rs` | The WebM it is written in, a whole second at a time (`LiveWebm`), and `finish_cut_off`, which finishes a file a crash cut off from its whole seconds. |
| `src/staging.rs` | Where a recording is written while it records (`pending`), how it reaches its path without replacing a file (`place_recording`, through the folder core's `storage::place`), and `recover`, which finishes and places what a cut left in `.epicenter/recordings`. |
| `src/meter.rs` | A microphone opened for its level only, closed by its page or with it, or on its own when its stream dies or its page stops hearing it. |
| `src/permission.rs` | Microphone access through AVFoundation, asked before any microphone opens. |
| `src/commands.rs` | `inputs`, `open_meter`, `close_meter`, `start`, `stop`, and `recover`. |
| `src/ended.rs`, `src/error.rs` | Why a capture ended on its own, and the refusals a page switches on by `name`. |
| `../recorder/src/native/bindings.gen.ts` | TypeScript commands and types, generated from the plugin into `@epicenter/recorder`. Do not edit. |

## Installing it in a shell

Install it beside `tauri-plugin-epicenter-folder`, which binds each window's folder:

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_epicenter_folder::init())
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

Give the recording window `epicenter-recorder:default` beside
`epicenter-folder:default`. It needs no event permission: a meter's levels
and an ending arrive on the channel the page passes to `open_meter` or
`start`.

## Commands

A page names a microphone by the id `inputs` answers, cpal's `DeviceId` as
text (`coreaudio:<device UID>` on macOS), which stays the same across
launches and reconnections. To record, it names a folder-relative path and
the root it is in, by the exact path the folder plugin answered when the page
opened it (`open_folder`, as `openDevice` does, such as a standalone app's
data folder): the folder the shell bound to the calling window, or another
root the page opened. The root is required, so no recording lands in a
folder the page did not name; any other root is refused. The root is read
once when the command arrives.

| Command | What it does |
| --- | --- |
| `inputs()` | Lists the input devices connected now as `{ id, name, isDefault }`. Opens nothing, so it needs no microphone permission. |
| `open_meter(device, levels)` | Opens the microphone with id `device`, or the system default, and sends its level on `levels` until `close_meter(id)`, or until the window's page reloads or the window is destroyed. Nothing is recorded. Answers the meter's `id` and the microphone's name. |
| `close_meter(id)` | Closes a meter. Only the window that opened it may close it. |
| `start(root, path, device, signals)` | Records `<path>.webm` in `root`, from the microphone with id `device` or the system default, writing it in `.epicenter/recordings` until it stops. Answers the recording's `id`. |
| `stop(id)` | Finishes the recording in place, places it at its path, and answers `{ path, durationMs }`. It takes the same few milliseconds for a recording of any length. A file already at the path is never replaced: the refusal says so, and where the finished recording is kept in `.epicenter/recordings`. Only the window that started it may stop it. |
| `recover(root, under)` | Finishes every recording a cut left under `under` in `root`'s `.epicenter/recordings` from its whole seconds and places it at its path, leaving the recording still being written alone. Answers `{ recovered, unplaced }`: each recording it placed as `{ path, durationMs }`, from the length its file states, so a page never reads the audio back to measure it (a second run places none); and each one whose path holds another file as `{ path, pending }`, where `pending` is its folder-relative path under `.epicenter/recordings`. That one is never deleted and never placed beside the other file: it stays pending, finished, and is answered on every run until a person moves one of the two, so a page says where its audio is. A leftover with no whole second holds no audio and is deleted. A page runs it when it opens its folder, before it lists, plays, or transcribes a recording. |

`start` refuses before it opens anything:

- `Refused`: the shell bound no folder to the window, the page did not open
  `root`, the path is not a data path
  the shared path rule accepts (`page_files::data_path` in the folder
  plugin's core, no link on the way), or a file is already at `<path>.webm`
  or at its place in `.epicenter/recordings`.
- `PermissionDenied`: macOS does not allow Epicenter the microphone.
- `InputUnavailable`: no microphone with the id `device` is connected.
  Another is never opened in its place. `open_meter` refuses the same way.
- `Busy`: another recording holds the host's one recorder.

`signals` carries `{ kind: 'ended', reason }` once if the capture ends on its own: the
microphone went away, permission was withdrawn, the stream failed, or the
file could not be written. What was captured stays the owner's to `stop`.

## The file in the folder

While it records, the recording is one of the folder's unfinished writes,
at `.epicenter/recordings/<path>.webm` (`state::recording` in the folder
core, which alone lays out `.epicenter`): a hidden path, which no watcher
reports and `epicenter sync` never commits, so sync never commits a
half-written recording and no reader sees one at a data path. The
folder's sweep never reads `recordings/`: a cut-off recording waits there
until the app opens once. It is created with `create_new` there
(`.epicenter` made `0700` when missing, and refused when it is a link), so
nothing already there is written through.

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

`stop` finishes the file in place: the last second from memory, its last
packet's padding trimmed (DiscardPadding), then the Cues, the Duration, and
last the Segment's size, each flushed to the disk first, so a file whose
Segment states its size is finished. It then places the file at
`<path>.webm` without replacing anything there: a rename that fails when
a name is already there (`storage::place` in the folder core, the one
placement a save expecting nothing at its path uses too), or, where the
disk has no such rename, a hard link then the pending name removed. A path below a mount point inside the folder is on
another file system: placing there fails saying it cannot save across a
mount point, nothing is copied, and the file stays in
`.epicenter/recordings`. All of it takes the same few milliseconds for a
recording of any length.

A write the disk refuses (it is full, or its volume went) ends the capture
with `storageFailed`, and the second it was writing is cut back off the
file; `stop` then finishes what reached it. If even that cannot be
written, `stop` says so and the file stays for the next `recover`.

The recording is finished and placed, never deleted, when:

- the page that started it begins to reload (`on_page_load`), or its window is
  destroyed, so no page is left to stop it;
- the app exits;
- `stop` is called after the capture ended on its own.

A process that ends before any of those leaves the file in
`.epicenter/recordings` with every whole second but the one held in memory:
a crash loses at most about a second. `recover`, which a page calls when it
opens its folder, finishes it from those seconds (a torn one at its end is
dropped) and places it. Until then nothing reads it: it is at no data path,
and a cut-off file reads wrong in a player (no length) and in the
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
