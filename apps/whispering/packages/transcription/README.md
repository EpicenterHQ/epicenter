# Native transcription

`tauri-plugin-epicenter-transcription` gives a standalone desktop app local
transcription: a curated model catalog, downloads into the shared Hugging Face
cache, the app's unload-policy setting, audio decoding, and a
resident inference cache over transcribe.cpp (whisper.cpp). Only apps that
transcribe depend on it; other standalone apps stay free of transcribe-cpp and
model downloads.

Its TypeScript package, `@epicenter/transcription`, lives in `guest-js/`
beside it, so the capability keeps its TypeScript and its Rust plugin in
one directory.

## Installing

Install the plugin, and run the built app through this crate's `run`:

```rust
let app = tauri::Builder::default()
    .plugin(tauri_plugin_epicenter_transcription::init())
    .build(tauri::generate_context!())?;
tauri_plugin_epicenter_transcription::run(app, |_handle, _event| {});
```

The model cache is created on first use, with its idle watcher; installing
the plugin downloads and loads nothing.

`run(app, callback)` matters on macOS. After plugin exit hooks, the app's
callback, and Tauri cleanup have run, it exits without running C++ static
finalizers, which can otherwise race a resident Metal model or a running
inference. Quit does not wait for inference. `request_restart` keeps Tauri's
replacement-executable lookup and arguments; calling `process::restart`
directly bypasses this path. Other platforms run the ordinary event loop.

## Settings and model files

Each app owns its settings in its local data directory's `local/`,
`app.path().app_local_data_dir()/local/local-transcription.json`, where the
app keeps what belongs to this computer alone: the directory named
by the app's bundle identifier, so `so.epicenter.whispering` and
`so.epicenter.whispering.dev` keep separate choices. Plugin setup fails if that
directory cannot be resolved. The file holds the unload policy, which is
device-local and never synchronizes. The app names its model on every request
and keeps that choice with its other model choices.

Model files live in the shared Hugging Face cache (`~/.cache/huggingface/hub`,
or under `HF_HOME`), so every app and Hugging Face tool on the machine reuses
one download. That cache is a cache: `remove_model` deletes a
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
| `model_id` is a catalog model installed on this machine | `ModelUnavailable` |
| The bytes decode as audio | `AudioReadError` |

The model is always named explicitly, and an unknown or uninstalled model is
refused before the bytes are decoded. Audio with no samples answers `empty-audio` without
loading a model. Otherwise the answer is `transcribed`, naming the exact model
that ran and which hints it applied. The inference job owns its input until it
finishes, even when the page stops waiting.

## Memory

A transcription loads its model on first use, replacing any other resident
model, and keeps it resident under the unload policy. Removing a model unloads
it first, once a transcription with it finishes.

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
| Administration | `list_models` | `allow-list-models` |
| Administration | `download_model` | `allow-download-model` |
| Administration | `remove_model` | `allow-remove-model` |
| Administration | `reveal_model` | `allow-reveal-model` |
| Administration | `get_unload_policy`, `set_unload_policy` | `allow-get-unload-policy`, `allow-set-unload-policy` |

## TypeScript package

`@epicenter/transcription` exports:

- `.`: `localSpeech()`, described last below, which is null outside a
  Tauri window (`isTauri()`), and `openLocalSpeech()`, the same
  handle for code that runs only in one. The generated bindings load with
  the first command, so a browser never loads them.
- `./bindings`: the generated bindings (`commands` and the wire types), such
  as `commands.listInferenceModels()` and
  `commands.transcribeAudio(modelId, audio, hints)`.
- `./local-models`: `createLocalModels({ speech, choice })`, a per-mount
  controller over a `localSpeech()` handle and the app's choice of model
  (`LocalModelChoice`). Rust owns downloads; the page owns only its intent to
  use a model after one finishes. Stopping waiting withdraws that intent and
  calls nothing native.
- `./local-model-administration`: `LocalModelAdministration.svelte`, the model
  settings card built on `createLocalModels` and `@epicenter/ui`: download,
  use, show the folder, remove, and the unload policy. It takes the app's
  handle (`speech`, the same value its `openAi` merges, so a download reaches
  the picker) and its choice (`choice`); without a handle it opens its own
  (`openLocalSpeech()`). It is a
  Tauri window's view: an app shows it where `localSpeech()` is not null.
- `localSpeech()` (the `.` export): this app's transcribe.cpp as an
  `@epicenter/ai` endpoint ([Whispering's model rules](../../README.md#models-and-keys)), or `null` in a browser. Its `fetch`
  answers `audio/transcriptions` and `models` in-process through
  `transcribe_audio` (the uploaded `file`) and `list_inference_models`. A
  refusal answers as an OpenAI error whose `code` is the `TranscriptionError`
  name. The handle carries what the OpenAI vocabulary cannot say:
  `catalog()` lists every model with whether it is downloaded;
  `download(id)` and `remove(id)` run `download_model` and `remove_model`
  and then list the models again; `reveal(id)` shows a model's folder;
  `unloadPolicy()` and `setUnloadPolicy(policy)` read and set when an idle
  model leaves memory. It imports only types from `@epicenter/ai`.

## Building an app

A final app keeps a direct `transcribe-cpp` dependency so its build script
receives the `DEP_TRANSCRIBE_CPP_*` metadata. Whispering's build script
(`src-tauri/build.rs`) then bakes the Linux rpath and stages
transcribe-cpp's shared libraries and backend modules into the app's
`transcribe-libs/` for Tauri's bundles. macOS links transcribe-cpp statically.

## Checks

From the repository root:

```sh
cargo test -p tauri-plugin-epicenter-transcription
bun run --cwd packages/transcription typecheck
bun run --cwd packages/transcription test
```

The Rust tests check the bindings are fresh, drive the commands through
Tauri's mock runtime, and decode the audio fixtures. To regenerate
`guest-js/bindings.gen.ts` after changing a command or wire type, run
`TRANSCRIPTION_WRITE_BINDINGS=1 cargo test -p tauri-plugin-epicenter-transcription bindings`.
Real inference is an ignored test that needs `EPICENTER_NATIVE_AUDIO` and an
already cached Whisper Tiny model; it never downloads.
