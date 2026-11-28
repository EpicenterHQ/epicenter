# Native transcription

`tauri-plugin-epicenter-transcription` gives a standalone desktop app local
transcription: a curated model catalog, downloads into the shared Hugging Face
cache, an unload policy, audio decoding, and a resident inference cache over
transcribe.cpp (whisper.cpp). Whispering installs it. The recorder plugin's
tests use its decoder (`audio::decode_to_pcm16k_mono`).

The page gets four commands, all model administration. Transcription has no
command: the app's own Rust reads the audio and calls the model cache.

`guest-js/bindings.gen.ts` holds the generated TypeScript for those commands.
The `@epicenter/transcription` package exports that file and nothing else.

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
device-local and never synchronizes. No command reads or sets it: a missing
file means the default, five minutes after the last transcription, and a host
changes it through `model_cache(app)?.settings()`. The app names its model on
every transcription and keeps that choice in its own settings.

Model files live in the shared Hugging Face cache (`~/.cache/huggingface/hub`,
or under `HF_HOME`), so every app and Hugging Face tool on the machine reuses
one download. That cache is a cache: `remove_model` deletes a
model's file from it when the person asks, unloading the model first, and any
app or tool that used the file downloads it again. It removes every snapshot
pointer that resolves to the model's bytes and the blob, and keeps a file of
the same name with other bytes. A model still downloading is refused `Busy`.
`reveal_model` shows a model's folder.

## Transcribing

The app transcribes from a command of its own, so the page never carries
audio. Whispering's `transcribe_local` (`src-tauri/src/local.rs`) reads a
recording's file and calls:

```rust
let cache = tauri_plugin_epicenter_transcription::model_cache(&app)?;
let outcome = cache.transcribe_bytes(model_id, &audio, hints)?;
```

`transcribe_bytes` blocks, so call it from `spawn_blocking`. It decodes the
bytes in memory and writes nothing to disk. It checks each call in this
order, and every refusal is a `TranscriptionError`:

| Check | Refusal |
| --- | --- |
| `model_id` is a catalog model installed on this machine | `ModelUnavailable` |
| The bytes decode as audio | `AudioReadError` |

The caller names the model on every call. Audio with no samples answers
`EmptyAudio` without loading a model. Otherwise the answer is `Transcribed`,
naming the model that ran and which hints it applied.

## Memory

A transcription loads its model on first use, replacing any other resident
model, and keeps it resident under the unload policy. Removing a model unloads
it first, once a transcription with it finishes.

A download outlives its waiter: stopping the page's wait does not stop the
transfer. The worker keeps a per-model reservation until it finishes, so another
request for that model is answered `Busy`; another process holding the cache's
blob lock is answered `DownloadingElsewhere`.

## Commands and grants

There is no default grant. Every permission is prefixed
`epicenter-transcription:`; grant each window only what it uses.

| Command | Permission |
| --- | --- |
| `list_models` | `allow-list-models` |
| `download_model` | `allow-download-model` |
| `remove_model` | `allow-remove-model` |
| `reveal_model` | `allow-reveal-model` |

## TypeScript bindings

`@epicenter/transcription/bindings` is `guest-js/bindings.gen.ts`: `commands`
(`listModels`, `downloadModel`, `removeModel`, `revealModel`) and the wire
types `ModelInfo`, `DownloadProgress`, and `CatalogError`. Whispering calls
them from `src/lib/platform/local/native.ts`. A command that can refuse
answers `{ data, error }`, where `error` is the `CatalogError`.

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
bun run --cwd apps/whispering/packages/transcription typecheck
```

The Rust tests check the bindings are fresh, drive the commands through
Tauri's mock runtime, and decode the audio fixtures. To regenerate
`guest-js/bindings.gen.ts` after changing a command or wire type, run
`TRANSCRIPTION_WRITE_BINDINGS=1 cargo test -p tauri-plugin-epicenter-transcription bindings`.
The commands are listed twice, in `src/command_names.rs` and in
`specta_builder` in `src/lib.rs`. The build script reads the first list and
rewrites `permissions/`; delete the permission file of a command you remove.
Real inference is an ignored test that needs `EPICENTER_NATIVE_AUDIO` and an
already cached Whisper Tiny model; it never downloads.
