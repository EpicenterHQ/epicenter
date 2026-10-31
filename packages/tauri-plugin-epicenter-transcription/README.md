# Native transcription

`tauri-plugin-epicenter-transcription` gives a standalone desktop app local
transcription: a curated model catalog, downloads into the shared Hugging Face
cache, the app's active-model and unload-policy settings, audio decoding, and a
resident inference cache over transcribe.cpp (whisper.cpp). Only apps that
transcribe depend on it; other standalone apps stay free of transcribe-cpp and
model downloads.

Its companion TypeScript package, `@epicenter/transcription-native`, lives in
`guest-js/`.

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
one download. The plugin never deletes a cached model; `reveal_model` shows its
folder so the person can remove it with Hugging Face's tools.

## Transcribing a file

`transcribe_file(model_id, root, path, hints)` transcribes an audio file in a
folder the folder plugin opened for the calling window: `root` is a root its
page opened (`openDevice` with a path, such as a standalone app's data folder),
by the exact path the shell answered, or `null` for the window's own folder.
`path` is folder-relative, such as `recordings/20261031T101500123.wav`. Rust
reads the file, so audio never crosses IPC.

Each call is checked in this order, and every refusal is a typed
`TranscriptionError`:

| Check | Refusal |
| --- | --- |
| `root` is the calling window's own folder or a root its page opened, and is still there | `FolderUnavailable` |
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
| Navigation | `open_model_settings` | `allow-open-model-settings` |
| Administration | `list_models` | `allow-list-models` |
| Administration | `download_model` | `allow-download-model` |
| Administration | `reveal_model` | `allow-reveal-model` |
| Administration | `get_active_model`, `set_active_model` | `allow-get-active-model`, `allow-set-active-model` |
| Administration | `get_unload_policy`, `set_unload_policy` | `allow-get-unload-policy`, `allow-set-unload-policy` |

`transcribe_file` also needs the folder plugin installed and the window bound;
it does not need any `epicenter-folder` permission.

## TypeScript package

`@epicenter/transcription-native` exports:

- `.`: the generated bindings (`commands` and the wire types), such as
  `commands.listInferenceModels()` and
  `commands.transcribeFile(modelId, path, hints)`.
- `./local-models`: `createLocalModels(commands?)`, a per-mount controller for
  the administration commands. Rust owns downloads; the page owns only its
  intent to activate a model after one finishes. Stopping waiting withdraws that
  intent and calls nothing native.
- `./local-model-administration`: `LocalModelAdministration.svelte`, a
  prop-free model settings card built on `createLocalModels` and `@epicenter/ui`.

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
bun test --isolate packages/tauri-plugin-epicenter-transcription/guest-js/local-models.test.ts
```

The Rust tests check the bindings are fresh, drive the commands through
Tauri's mock runtime, and decode the audio fixtures. To regenerate
`guest-js/bindings.gen.ts` after changing a command or wire type, run
`TRANSCRIPTION_WRITE_BINDINGS=1 cargo test -p tauri-plugin-epicenter-transcription bindings`.
Real inference is an ignored test that needs `EPICENTER_NATIVE_AUDIO` and an
already cached Whisper Tiny model; it never downloads.
