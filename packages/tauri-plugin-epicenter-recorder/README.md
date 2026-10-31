# tauri-plugin-epicenter-recorder

The desktop shell's microphone. It lists the inputs, reads one's level, and
records: a page in the shell opens no microphone of its own
([ADR-0571](../../docs/adr/0571-on-desktop-rust-owns-the-microphone-and-the-page-never-opens-one.md)).
A recording is written from the first sample
into a folder the recording window opened
([ADR-0543](../../docs/adr/0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md)):
`start` creates a WAV in the folder's `.epicenter/recording` and appends
16 kHz mono PCM16 as the microphone captures, and `stop` finalizes its header,
encodes it to Opus in WebM, and places that at `<path>.webm`. Nothing
deletes a recording's audio. A quit, a crash, or a closed window keeps the
audio up to the cut. A recording adds no Close or Quit warning.

A microphone is opened at the rate it already runs at, never another: on
macOS a stream at another rate changes the device's rate for every app using
it, and leaves it changed. The writer converts to 16 kHz.

A page reaches it through `@epicenter/recorder/tauri`, whose
`startRecording({ device, path })` and `recoverRecordings({ device, under })`
are the same calls a browser build makes through `/browser`, which appends
each piece of a recording to this browser's files instead (decision 84).

## Layout

| Path | What it is |
| --- | --- |
| `src/recorder.rs` | The CPAL and `hound` pipeline: a non-blocking audio callback, a bounded queue, and a writer thread that appends to the WAV, updates its header about once a second, and sends the level. One recording at a time, owned by the window that started it. |
| `src/rate.rs` | The conversion from the microphone's rate to the recording's 16 kHz, on the writer thread. |
| `src/wav.rs` | `repair` and `recover`: rewrite a WAV header whose sizes disagree with the file's length, and settle what a cut left in `.epicenter/recording` as a stop does. |
| `src/staging.rs` | Where a recording is written while it records (`pending`, `pending_under`) and encoded (`encode_scratch`), and `settle`: encode it and place it at its path without replacing a file (`place`, `sweep`). |
| `src/opus.rs` | The encoder: a finalized WAV, read 20 ms at a time, to Opus at 24 kbps. |
| `src/webm.rs` | The WebM writer the encoder writes through. |
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
`epicenter-folder:default`. It needs no event permission: levels arrive on
the channel the page passes to `start`.

## Commands

A page names a microphone by the id `inputs` answers, cpal's `DeviceId` as
text (`coreaudio:<device UID>` on macOS), which stays the same across
launches and reconnections. To record, it names a folder-relative path and
the root it is in: `null` for the folder the shell bound to the calling
window, or a root the page opened through the folder plugin (`open_folder`,
as `openDevice` does with a path, such as a standalone app's data folder), by
the exact path the plugin answered. Any other root is refused. The root is
read once when the command arrives.

| Command | What it does |
| --- | --- |
| `inputs()` | Lists the input devices connected now as `{ id, name, isDefault }`. Opens nothing, so it needs no microphone permission. |
| `open_meter(device, levels)` | Opens the microphone with id `device`, or the system default, and sends its level on `levels` until `close_meter(id)`, or until the window's page reloads or the window is destroyed. Nothing is recorded. Answers the meter's `id` and the microphone's name. |
| `close_meter(id)` | Closes a meter. Only the window that opened it may close it. |
| `start(root, path, device, signals)` | Records `<path>.webm` in `root`, from the microphone with id `device` or the system default, writing a WAV in `.epicenter/recording` until it stops. Answers the recording's `id`, its path, and the microphone's name. |
| `stop(id)` | Finalizes the WAV, encodes it, places it at its path, and answers that path and its length. Only the window that started it may stop it. |
| `recover(root, under)` | Repairs every `.wav` a cut left under `under` in `root`'s `.epicenter/recording` and settles it as `stop` does, never over a file there, leaving the recording still being written, and any a stop is still settling, alone. Where the path is taken, a recording with the same bytes is removed and any other goes to the first free `<name>-recovered.webm` (`-recovered-2`, ...), so none stays stranded in `.epicenter`. Answers the paths it placed; a second run places none. |

`start` refuses before it opens anything:

- `Refused`: the shell bound no folder to the window, the page did not open
  `root`, the path is not a data path
  the shared path rule accepts (`page_files::data_path` in the folder
  plugin's core, no link on the way), or a file is already at `<path>.webm`,
  at `<path>.wav`, or at its place in `.epicenter/recording`.
- `PermissionDenied`: macOS does not allow Epicenter the microphone.
- `InputUnavailable`: no microphone with the id `device` is connected.
  Another is never opened in its place. `open_meter` refuses the same way.
- `Busy`: another recording holds the host's one recorder.

`signals` carries `{ kind: 'level', level }` at most twenty times a second, and
`{ kind: 'ended', reason }` once if the capture ends on its own: the
microphone went away, permission was withdrawn, the stream failed, or the
file could not be written. What was captured stays the owner's to `stop`.

## The file in the folder

While it records, the recording lives in the folder's own state directory,
at `.epicenter/recording/<path>.wav`: no listing shows it, no watcher reports
it, and `epicenter init`'s `.gitignore` keeps it out of history, so sync never
commits a half-written WAV and no reader sees one at a data path. It is
created with `create_new` there (`.epicenter` made `0700` when missing, and
refused when it is a link), so nothing already there is written through. Its
header states the samples written so far about once a second.

When it stops, the WAV is encoded (`staging::settle`), after the microphone
is released and the recorder is free for the next recording, off the main
thread and the IPC handler. The encoder reads the WAV 20 ms at a time and
writes each packet as it is made, so an hour costs the memory a second does
(12 MB peak for the whole process, measured). Speech encodes at about 0.4 s
a minute in a release build on an Apple-silicon Mac, and comes to about
10.5 MB an hour against the WAV's 115 MB:

- Opus, mono, 24 kbps variable rate, tuned for voice, in 20 ms packets, from
  the 16 kHz WAV. libopus is the copy `audiopus_sys` bundles, built from
  source for every build (`OPUS_NO_PKG` in the repository's
  `.cargo/config.toml`), never a system or Homebrew copy. It encodes the
  same WAV to the same bytes every time, which recovery relies on.
- WebM (`src/webm.rs`), as Safari and Chromium play it to the exact length:
  the encoder's lookahead as the `OpusHead` pre-skip and as CodecDelay, 80 ms
  of SeekPreRoll, the last packet's padding as DiscardPadding, the Duration
  that plays, and Cues for seeking. Nothing in it varies between two
  encodes of one WAV: no date, no random ID.

The encode is written into a new file in the folder's scratch directory
(`.epicenter/scratch`, as a save stages there: `0600`, named so a stale one
is swept). That file is placed at `<path>.webm` without replacing anything
there: a hard link to the path, which fails when a name is already there,
then the scratch name removed (`staging::place`). A move cut off between the
two is finished by the next one. Where the disk has no hard links it is
renamed only while nothing is at the path. Only then is the WAV removed. A
WAV the encoder refuses is placed itself, at `<path>.wav`, and `stop`
answers a failure that says so. A recording that cannot be placed, because
something took its path while it recorded or the disk refused, stays in
`.epicenter/recording`, and `stop` says so; the next `recover` places it
beside the taken path.

A crash while it encodes leaves the WAV, which the next `recover` encodes
again, and a part-written scratch file, which the folder removes once it is
an hour old. A crash after the WebM is placed and before the WAV is removed
leaves a WAV that encodes to the same bytes, which `recover` removes as a
copy.

The recording is finalized, never deleted, when:

- the page that started it begins to reload (`on_page_load`), or its window is
  destroyed, so no page is left to stop it: it is then encoded and placed on
  a thread of its own;
- the app exits: it is not encoded then, so a Quit does not wait, and the
  next `recover` settles it;
- `stop` is called after the capture ended on its own.

A process that ends before any of those leaves the WAV in
`.epicenter/recording` with a header that undercounts the last second.
`recover`, which a page calls when it opens its folder, rewrites it from the
file's length, rounded down to a whole frame, and settles it as `stop` does.

## Tests

```sh
cargo test                       # the pipeline over a stand-in worker, the WAV repair, the encoder, and the commands on the mock runtime
RECORDER_WRITE_BINDINGS=1 cargo test bindings   # rewrite the committed TypeScript bindings
cargo test -- --ignored physical # opens the physical default microphone for a second
cargo test --release -- --ignored an_hour --nocapture   # encodes an hour of audio and prints its size and time
```

The encoder's tests decode what it wrote with the transcription plugin's
decoder, which a recording is transcribed with: every sample comes back, in
place. No test but the ignored physical one opens a microphone: every refusal the commands
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
