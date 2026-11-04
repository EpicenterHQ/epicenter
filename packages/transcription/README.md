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

Install the plugin, and run the built app through this crate's `run`:

```rust
let app = tauri::Builder::default()
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

Each app owns its settings at the top of its AppData root,
`app.path().app_data_dir()/local-transcription.json`, where every capability
keeps its state on this computer: the directory named by the app's bundle
identifier, so `so.epicenter.whispering` and
`so.epicenter.whispering.dev` keep separate choices. Plugin setup fails if that
directory cannot be resolved. The file holds the active model and the unload
policy; both are device-local and never synchronize. The active model is
what the shell transcribes with by itself (`ModelCache::transcribe`,
`prewarm`), for an app whose dictation runs in Rust; an app that transcribes
through `localSpeech()` names its model on every request and keeps its own
choice with its other model choices.

Model files live in the shared Hugging Face cache (`~/.cache/huggingface/hub`,
or under `HF_HOME`), so every app and Hugging Face tool on the machine reuses
one download. That cache is a cache (ADR-0757): `remove_model` deletes a
model's file from it when the person asks, unloading the model first, and any
app or tool that used the file downloads it again. It removes every snapshot
pointer that resolves to the model's bytes and the blob, and keeps a file of
the same name with other bytes. A model still downloading is refused `Busy`.
`reveal_model` shows a model's folder.

## Transcribing an upload

`transcribe_audio(model_id, audio, hints)` transcribes audio the page holds,
a dictation's blob or a recording read from the folder, sent as base64. It
is the one way a page transcribes. Rust decodes the bytes where they arrive
and writes nothing to disk. Each call is checked in this order, and every
refusal is a typed `TranscriptionError`:

| Check | Refusal |
| --- | --- |
| `audio` is base64 | `AudioReadError` |
| `model_id` is a catalog model installed on this machine | `LocalRouteUnavailable` |
| The bytes decode as audio | `AudioReadError` |

The model is always named explicitly: `transcribe_audio` neither reads nor
changes the active model, and an unknown or uninstalled model is refused before
the bytes are decoded. Audio with no samples answers `empty-audio` without
loading a model. Otherwise the answer is `transcribed`, naming the exact model
that ran and which hints it applied. The inference job owns its input until it
finishes, even when the page stops waiting.

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
| Inference | `transcribe_audio` | `allow-transcribe-audio` |
| Memory | `load_model`, `unload_model` | `allow-load-model`, `allow-unload-model` |
| Navigation | `open_model_settings` | `allow-open-model-settings` |
| Administration | `list_models` | `allow-list-models` |
| Administration | `download_model` | `allow-download-model` |
| Administration | `remove_model` | `allow-remove-model` |
| Administration | `reveal_model` | `allow-reveal-model` |
| Administration | `get_active_model`, `set_active_model` | `allow-get-active-model`, `allow-set-active-model` |
| Administration | `get_unload_policy`, `set_unload_policy` | `allow-get-unload-policy`, `allow-set-unload-policy` |

## TypeScript package

`@epicenter/transcription` exports:

- `.`: `localSpeech()`, described last below. The build picks its
  implementation: `guest-js/local-speech.ts` under the `tauri` condition,
  and `guest-js/local-speech.web.ts`, which answers `null`, otherwise.
- `./bindings`: the generated bindings (`commands` and the wire types), such
  as `commands.listInferenceModels()` and
  `commands.transcribeAudio(modelId, audio, hints)`.
- `./local-models`: `createLocalModels({ speech, choice })`, a per-mount
  controller over a `localSpeech()` handle and the app's choice of model
  (`LocalModelChoice`). Rust owns downloads; the page owns only its intent to
  use a model after one finishes. Stopping waiting withdraws that intent and
  calls nothing native. `createNativeChoice()` is the shell's active model as
  that choice.
- `./local-model-administration`: `LocalModelAdministration.svelte`, the model
  settings card built on `createLocalModels` and `@epicenter/ui`: download,
  use, show the folder, remove, and the unload policy. It takes the app's
  handle (`speech`, the same value its `openAi` merges, so a download reaches
  the picker) and its choice (`choice`); with neither, it makes its own handle
  and administers the shell's active model.
- `localSpeech()` (the `.` export): this app's transcribe.cpp as an
  `@epicenter/ai` endpoint (ADR-0757), or `null` in a browser. Its `fetch`
  answers `audio/transcriptions` and `models` in-process through
  `transcribe_audio` (the uploaded `file`) and `list_inference_models`. A
  refusal answers as an OpenAI error whose `code` is the `TranscriptionError`
  name. The handle carries what the OpenAI vocabulary cannot say:
  `catalog()` lists every model with whether it is downloaded;
  `download(id)` and `remove(id)` run `download_model` and `remove_model`
  and then list the models again; `reveal(id)` shows a model's folder;
  `load(id)` and `unload(id)` run `load_model` and `unload_model`; and
  `unloadPolicy()` and `setUnloadPolicy(policy)` read and set when an idle
  model leaves memory. It imports only types from `@epicenter/ai`.

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
