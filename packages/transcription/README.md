# Native transcription

`tauri-plugin-epicenter-transcription` gives a standalone desktop app local
transcription: a curated model catalog, downloads into the shared Hugging Face
cache, the app's active-model and unload-policy settings, audio decoding, and a
resident inference cache over transcribe.cpp (whisper.cpp). Only apps that
transcribe depend on it; other standalone apps stay free of transcribe-cpp and
model downloads.

Its TypeScript package, `@epicenter/transcription`, lives in `guest-js/`
beside it (ADR-0755: a capability keeps its TypeScript and its Rust plugin
in one directory).

## Installing

Install the plugin after `tauri_plugin_epicenter_folder::init()`, and run the
built app through this crate's `run`:

```rust
let app = tauri::Builder::default()
    .plugin(tauri_plugin_epicenter_folder::init())
    .plugin(tauri_plugin_epicenter_transcription::Builder::new().build())
    .build(tauri::generate_context!())?;
tauri_plugin_epicenter_transcription::run(app, |_handle, _event| {});
```

`Builder::new().open_settings(callback)` supplies what the
`open_model_settings` command does, for an app with somewhere to navigate. The
default callback refuses with "This app has no model settings."; an app whose
model settings are a page route keeps the default and navigates in the page.
`init()` is `Builder::new().build()`.

`model_cache(app)` returns the app's `ModelCache` for Rust callers, such as
`prewarm` at capture start or `readiness`. The cache is created on first use,
with its idle watcher; installing the plugin downloads and loads nothing.

`run(app, callback)` matters on macOS. After plugin exit hooks, the app's
callback, and Tauri cleanup have run, it exits without running C++ static
finalizers, which can otherwise race a resident Metal model or a running
inference. Quit does not wait for inference. `request_restart` keeps Tauri's
replacement-executable lookup and arguments; calling `process::restart`
directly bypasses this path. Other platforms run the ordinary event loop.

## Settings and model files

Each app owns its settings at its own
`app.path().app_local_data_dir()/local-transcription.json`: the directory named
by the app's bundle identifier, so `so.epicenter.whispering` and
`so.epicenter.whispering.dev` keep separate choices. Plugin setup fails if that
directory cannot be resolved. The file holds the active model and the unload
policy; both are device-local and never synchronize.

Model files live in the shared Hugging Face cache (`~/.cache/huggingface/hub`,
or under `HF_HOME`), so every app and Hugging Face tool on the machine reuses
one download. That cache is a cache (ADR-0757): `remove_model` deletes a
model's file from it when the person asks, unloading the model first, and any
app or tool that used the file downloads it again. It removes every snapshot
pointer that resolves to the model's bytes and the blob, and keeps a file of
the same name with other bytes. A model still downloading is refused `Busy`.
`reveal_model` shows a model's folder.

## Transcribing a file

`transcribe_file(model_id, root, path, hints)` transcribes an audio file in a
root the page opened through the folder plugin, named by name (`Data`, from
`rootOf`). It is required: no command falls back to a default root.
`path` is folder-relative, such as `recordings/20261031T101500123.wav`. Rust
reads the file, so audio never crosses IPC.

Each call is checked in this order, and every refusal is a typed
`TranscriptionError`:

| Check | Refusal |
| --- | --- |
| `root` is a root the page opened | `FolderUnavailable` |
| `path` is a data path under the folder's shared path rule: not empty or absolute, no `.` or `..`, no `.git` or `HEAD`, no link on the way | `PathRefused` |
| A regular file is at `path` | `FileMissing` |
| `model_id` is a catalog model installed on this machine | `LocalRouteUnavailable` |
| The bytes decode as audio | `AudioReadError` |

The path rule is the folder plugin's own (`page_files::data_path` and
`paths::path_problem` in `epicenter-folder-core`), the same one the recorder
plugin uses for `start(path)`. The window's binding is read once on arrival, so
a window closed and replaced under the same label meanwhile does not redirect
the call.

The model is always named explicitly: `transcribe_file` neither reads nor
changes the active model, and an unknown or uninstalled model is refused before
the file is read or decoded. Audio with no samples answers `empty-audio` without
loading a model. Otherwise the answer is `transcribed`, naming the exact model
that ran and which hints it applied. The inference job owns its input until it
finishes, even when the page stops waiting.

## Transcribing an upload

`transcribe_audio(model_id, audio, hints)` transcribes audio the page holds,
such as a dictation's blob, sent as base64. Rust decodes the bytes where they
arrive and writes nothing to disk. Audio that is not base64 is an
`AudioReadError`; then the model is checked and the bytes decoded as in
`transcribe_file`.

## Memory

A transcription loads its model on first use and keeps it resident under the
unload policy. `load_model(model_id)` loads a catalog model now so the next
transcription with it starts warm, replacing any other resident model;
`unload_model(model_id)` drops it once a transcription with it finishes. Its
file stays in the cache.

Downloads work the same way: stopping the page's wait does not stop the
transfer. The worker keeps a per-model reservation until it finishes, so another
request for that model is answered `Busy`; another process holding the cache's
blob lock is answered `DownloadingElsewhere`.

## Commands and grants

There is no default grant. Every permission is prefixed
`epicenter-transcription:`; grant each window only what it uses.

| Use | Command | Permission |
| --- | --- | --- |
| Inference | `list_inference_models` | `allow-list-inference-models` |
| Inference | `transcribe_file` | `allow-transcribe-file` |
| Inference | `transcribe_audio` | `allow-transcribe-audio` |
| Memory | `load_model`, `unload_model` | `allow-load-model`, `allow-unload-model` |
| Navigation | `open_model_settings` | `allow-open-model-settings` |
| Administration | `list_models` | `allow-list-models` |
| Administration | `download_model` | `allow-download-model` |
| Administration | `remove_model` | `allow-remove-model` |
| Administration | `reveal_model` | `allow-reveal-model` |
| Administration | `get_active_model`, `set_active_model` | `allow-get-active-model`, `allow-set-active-model` |
| Administration | `get_unload_policy`, `set_unload_policy` | `allow-get-unload-policy`, `allow-set-unload-policy` |

`transcribe_file` also needs the folder plugin installed and its Data root
opened. It does not need any `epicenter-folder` permission.

## TypeScript package

`@epicenter/transcription` exports:

- `.`: `localSpeech()`, described last below.
- `./bindings`: the generated bindings (`commands` and the wire types), such
  as `commands.listInferenceModels()` and
  `commands.transcribeFile(modelId, root, path, hints)`.
- `./local-models`: `createLocalModels(commands?)`, a per-mount controller for
  the administration commands. Rust owns downloads; the page owns only its
  intent to activate a model after one finishes. Stopping waiting withdraws that
  intent and calls nothing native.
- `./local-model-administration`: `LocalModelAdministration.svelte`, a
  prop-free model settings card built on `createLocalModels` and `@epicenter/ui`.
- `localSpeech()` (the `.` export): this app's transcribe.cpp as an
  `@epicenter/ai` endpoint (ADR-0757), or `null` outside the desktop app. Its
  `fetch` answers `audio/transcriptions` and `models` in-process through
  `transcribe_audio` (an uploaded `file`) or `transcribe_file` (a `path` in
  the data folder, read where it is) and `list_inference_models`. A refusal
  answers as an OpenAI error whose `code` is the `TranscriptionError` name.
  The handle carries the local lifecycle the OpenAI vocabulary cannot say:
  `download(id)` and `remove(id)` run `download_model` and `remove_model`
  and then list the models again; `load(id)` and `unload(id)` run
  `load_model` and `unload_model`. It imports only types from
  `@epicenter/ai`.

## Building an app

A final app keeps a direct `transcribe-cpp` dependency so its build script
receives the `DEP_TRANSCRIBE_CPP_*` metadata, and calls
`epicenter_transcription_build::link_runtime()` from that build script (crate
`packages/epicenter-transcription-build`). It bakes the Linux rpath and stages
transcribe-cpp's shared libraries and backend modules into the app's
`transcribe-libs/` for Tauri's bundles. macOS links transcribe-cpp statically.

## Checks

From the repository root:

```sh
cargo test -p tauri-plugin-epicenter-transcription
cargo check -p epicenter-transcription-build
bun run --cwd packages/transcription typecheck
bun run --cwd packages/transcription test
```

The Rust tests check the bindings are fresh, drive the commands through
Tauri's mock runtime, and decode the audio fixtures. To regenerate
`guest-js/bindings.gen.ts` after changing a command or wire type, run
`TRANSCRIPTION_WRITE_BINDINGS=1 cargo test -p tauri-plugin-epicenter-transcription bindings`.
Real inference is an ignored test that needs `EPICENTER_NATIVE_AUDIO` and an
already cached Whisper Tiny model; it never downloads.
