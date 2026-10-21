# tauri-plugin-epicenter-recorder

The desktop shell's microphone. It lists the inputs, reads one's level, and
records: a page in the shell opens no microphone of its own
([ADR-0571](../../docs/adr/0571-on-desktop-rust-owns-the-microphone-and-the-page-never-opens-one.md)).
A recording is a WAV in the folder
the shell bound to the recording window, written from the first sample
([ADR-0543](../../docs/adr/0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md)):
`start` creates `<path>.wav` and appends 16 kHz mono PCM16 as the microphone
captures, and `stop` finalizes its header. Nothing deletes it. A quit, a
crash, or a closed window keeps the audio up to the cut. Epicenter reads
`is_recording` for its application Quit warning. A recording alone adds no
window Close warning.

A microphone is opened at the rate it already runs at, never another: on
macOS a stream at another rate changes the device's rate for every app using
it, and leaves it changed. The writer converts to 16 kHz.

A page reaches it through `@epicenter/recorder/tauri`.

## Layout

| Path | What it is |
| --- | --- |
| `src/recorder.rs` | The CPAL and `hound` pipeline: a non-blocking audio callback, a bounded queue, and a writer thread that appends to the WAV, updates its header about once a second, and sends the level. One recording at a time, owned by the window that started it. |
| `src/rate.rs` | The conversion from the microphone's rate to the recording's 16 kHz, on the writer thread. |
| `src/wav.rs` | `repair` and `recover`: rewrite a WAV header whose sizes disagree with the file's length. |
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
launches and reconnections. To record, it names a folder-relative path,
never a root or a folder: the folder is the one the shell bound to the
calling window, read once when the command arrives.

| Command | What it does |
| --- | --- |
| `inputs()` | Lists the input devices connected now as `{ id, name, isDefault }`. Opens nothing, so it needs no microphone permission. |
| `open_meter(device, levels)` | Opens the microphone with id `device`, or the system default, and sends its level on `levels` until `close_meter(id)`, or until the window's page reloads or the window is destroyed. Nothing is recorded. Answers the meter's `id` and the microphone's name. |
| `close_meter(id)` | Closes a meter. Only the window that opened it may close it. |
| `start(path, device, signals)` | Records into `<path>.wav` in the folder bound to this window, from the microphone with id `device` or the system default. Answers the recording's `id`, its path, and the microphone's name. |
| `stop(id)` | Finalizes the WAV and answers its path and length. Only the window that started it may stop it. |
| `recover(under)` | Rewrites the header of every `.wav` under `under` whose sizes disagree with its length, leaving the recording still being written alone. Answers the paths it rewrote; a second run rewrites none. |

`start` refuses before it opens anything:

- `Refused`: the shell bound no folder to the window, the path is not a data path
  the shared path rule accepts (`page_files::data_path` in the folder
  plugin's core, no link on the way), or a file is already at `<path>.wav`.
- `PermissionDenied`: macOS does not allow Epicenter the microphone.
- `InputUnavailable`: no microphone with the id `device` is connected.
  Another is never opened in its place. `open_meter` refuses the same way.
- `Busy`: another recording holds the host's one recorder.

`signals` carries `{ kind: 'level', level }` at most twenty times a second, and
`{ kind: 'ended', reason }` once if the capture ends on its own: the
microphone went away, permission was withdrawn, the stream failed, or the
file could not be written. What was captured stays the owner's to `stop`.

## The file in the folder

The recording is the one data file written in place rather than staged and
renamed. It is created with `create_new` at a path the folder plugin's path
rule accepts, so nothing already there is written through. Its header states
the samples written so far about once a second, so a commit, a copy, or a
player reading it mid-recording reads valid audio up to the last update.

The recording is finalized, never deleted, when:

- the page that started it begins to reload (`on_page_load`), or its window is
  destroyed, so no page is left to stop it;
- the app exits;
- `stop` is called after the capture ended on its own.

A process that ends before any of those leaves a header that undercounts the
last second. `recover`, which a page calls when it opens its folder, rewrites
it from the file's length, rounded down to a whole frame. Nothing else in the
file changes.

## Tests

```sh
cargo test                       # the pipeline over a stand-in worker, the WAV repair, and the commands on the mock runtime
RECORDER_WRITE_BINDINGS=1 cargo test bindings   # rewrite the committed TypeScript bindings
cargo test -- --ignored          # opens the physical default microphone for a second
```

No test but the ignored one opens a microphone: every refusal the commands
make happens before a stream is built, and a meter's lifecycle is driven with
a stand-in worker.

Microphone access is the plugin's own (`src/permission.rs`): `open_meter` and
`start` ask macOS before they resolve a device, for every caller. A person not
yet asked sees the system prompt; a denial is `PermissionDenied` and nothing
opens. `inputs` asks for nothing. A meter or a recording counts as an open
microphone for `on_capturing`.
