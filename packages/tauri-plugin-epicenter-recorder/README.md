# tauri-plugin-epicenter-recorder

The desktop shell's microphone recorder. A recording is a WAV in the folder
the recording window was granted, written from the first sample
([ADR-0543](../../docs/adr/0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md)):
`start` creates `<path>.wav` and appends mono PCM16 as the microphone
captures, `stop` finalizes its header, and `cancel` deletes it. A quit, a
crash, or a closed window keeps the audio up to the cut.

A page reaches it through `@epicenter/recorder`, whose bare entry uses it
inside a desktop app (or `@epicenter/recorder/tauri`).

## Layout

| Path | What it is |
| --- | --- |
| `src/recorder.rs` | The CPAL and `hound` pipeline: a non-blocking audio callback, a bounded queue, and a writer thread that appends to the WAV, updates its header about once a second, and sends the level. One recording at a time, owned by the window that started it. |
| `src/wav.rs` | `repair` and `recover`: rewrite a WAV header whose sizes disagree with the file's length. |
| `src/commands.rs` | `start`, `stop`, `cancel`, and `recover`. |
| `src/ended.rs`, `src/error.rs` | Why a capture ended on its own, and the refusals a page switches on by `name`. |
| `../recorder/src/native/bindings.gen.ts` | TypeScript commands and types, generated from the plugin into `@epicenter/recorder`. Do not edit. |

## Installing it in a shell

Install it beside `tauri-plugin-epicenter-folder`, which grants the folder:

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

A page names a folder scope and a folder-relative path, never a root.

| Command | What it does |
| --- | --- |
| `start(scope, path, device, signals)` | Records into `<path>.wav` in the folder this window was granted for `scope`, from the microphone named `device` or the system default. Answers the recording's `id`, its path, and the microphone's name. |
| `stop(id)` | Finalizes the WAV and answers its path and length. Only the window that started it may stop it. |
| `cancel(id)` | Deletes the WAV. Only the window that started it may cancel it. |
| `recover(scope, under)` | Rewrites the header of every `.wav` under `under` whose sizes disagree with its length, leaving the recording still being written alone. Answers the paths it rewrote; a second run rewrites none. |

`start` refuses before it opens anything:

- `Refused`: the window was not granted `scope`, the path is not a data path
  the shared path rule accepts (`page_files::data_path` in the folder
  plugin's core, no link on the way), or a file is already at `<path>.wav`.
- `InputUnavailable`: no microphone has the name `device`. Another is never
  opened in its place.
- `Busy`: another recording holds the host's one recorder.

`signals` carries `{ kind: 'level', level }` about twenty times a second, and
`{ kind: 'ended', reason }` once if the capture ends on its own: the
microphone went away, permission was withdrawn, the stream failed, or the
file could not be written. What was captured stays the owner's to `stop` or
`cancel`.

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
make happens before the device is resolved.
