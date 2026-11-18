# tauri-plugin-epicenter-recorder

Whispering's desktop microphone. It lists the inputs, reads one's level, and
records: a page in the shell opens no microphone of its own.
A recording is written at its final path from the first sample
([ADR-0962](../../../../docs/adr/0962-whispering-8-writes-every-file-inside-its-folder-at-or-beside-its-final-path.md)):
`start` creates `recordings/<id>.webm` in Whispering's folder and encodes
the microphone into it as Opus as it captures, a second at a time, and
`stop` finishes it there. Nothing deletes a recording's audio. A quit or a
closed window finishes it; a crash keeps the audio up to the cut. A
recording adds no Close or Quit warning.

A microphone is opened at the rate it already runs at, never another: on
macOS a stream at another rate changes the device's rate for every app using
it, and leaves it changed. The writer converts to 16 kHz.

A page reaches it through `@epicenter/recorder/tauri`.

## Layout

| Path | What it is |
| --- | --- |
| `src/recorder.rs` | The CPAL pipeline: a non-blocking audio callback, a bounded queue, and a writer thread that converts to 16 kHz, encodes and writes as it captures. One recording at a time, owned by the window that started it. |
| `src/rate.rs` | The conversion from the microphone's rate to the recording's 16 kHz, on the writer thread. |
| `src/opus.rs` | The encoder: 20 ms at a time, to Opus at 24 kbps, as the recording arrives. |
| `src/webm.rs` | The WebM it is written in, a whole second at a time (`LiveWebm`), and how it is finished at Stop. |
| `src/meter.rs` | A microphone opened for its level only, closed by its page or with it, or on its own when its stream dies or its page stops hearing it. |
| `src/permission.rs` | Microphone access through AVFoundation, asked before any microphone opens. |
| `src/commands.rs` | `inputs`, `open_meter`, `close_meter`, `start`, and `stop`. |
| `src/ended.rs`, `src/error.rs` | Why a capture ended on its own, and the refusals a page switches on by `name`. |
| `../recorder/src/native/bindings.gen.ts` | TypeScript commands and types, generated from the plugin into `@epicenter/recorder`. Do not edit. |

## Installing it in a shell

Install it beside `tauri-plugin-fs`, whose scope says which folders it may
record into: the default folder the shell allows at start, and one the
person picks in the folder dialog. The plugin makes `recordings/` in the
folder when it first records there.

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
| `start(dir, id, device, signals)` | Records `recordings/<id>.webm` in the folder `dir`, from the microphone with id `device` or the system default. Answers nothing. |
| `stop()` | Finishes the recording this window started at its path and answers `{ id, durationMs }`. It takes the same few milliseconds for a recording of any length. When what was captured cannot be finished, it says so, and what reached the disk stays at its path as it is. Only the window that started it may stop it. |

`start` refuses before it opens anything:

- `Refused`: the folder is not one the file system scope allows, the id is
  not one plain name, a link is on the way to `recordings/`, or the
  recording's audio already exists.
- `PermissionDenied`: macOS does not allow Epicenter the microphone.
- `InputUnavailable`: no microphone with the id `device` is connected.
  Another is never opened in its place. `open_meter` refuses the same way.
- `Busy`: another recording holds the host's one recorder.

`signals` carries `{ kind: 'ended', reason }` once if the capture ends on its own: the
microphone went away, permission was withdrawn, the stream failed, or the
file could not be written. What was captured stays the owner's to `stop`.

## The take

While it records, the recording is `recordings/<id>.webm` in the folder,
growing a second at a time. It is created with `create_new`, so nothing
already there is written through. Whispering leaves the take under way out
of its library until its note is written.

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
Segment states its size is finished. It takes the same few milliseconds for
a recording of any length.

A write the disk refuses (it is full, or its volume went) ends the capture
with `storageFailed`, and the second it was writing is cut back off the
file; `stop` then finishes what reached it. If even that cannot be
written, `stop` says so and the file stays as it is.

The recording is finished, never deleted, when:

- the page that started it begins to reload (`on_page_load`), or its window is
  destroyed, so no page is left to stop it;
- the app exits;
- `stop` is called after the capture ended on its own.

A process that ends before any of those leaves the file with every whole
second but the one held in memory, perhaps a torn second at its end, and no
Duration or Cues: a crash loses at most about a second. Nothing repairs it.
Whispering lists it as an untitled recording, and the transcription decoder
reads its whole seconds and stops at the torn one.

## Tests

```sh
cargo test                       # the pipeline over a stand-in worker, the encoder and its file, a kill and cuts at every byte, a full disk, and the commands on the mock runtime
RECORDER_WRITE_BINDINGS=1 cargo test bindings   # rewrite the committed TypeScript bindings
cargo test -- --ignored physical # opens the physical default microphone for a second
cargo test --release -- --ignored an_hour --nocapture   # records an hour and prints its size and how long Stop took (RECORDER_MEASURE_WAV=<16 kHz WAV> for real speech)
```

The encoder's tests decode what they wrote with the
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
