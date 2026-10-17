# How Whispering Uses Parakeet with transcribe-rs

Whispering uses [transcribe-rs](https://github.com/cjpais/transcribe-rs) for all local transcription. This Rust library provides a unified interface for different speech recognition engines through a trait-based design:

```rust
pub trait TranscriptionEngine {
    fn load_model(&mut self, model_path: &Path) -> Result<(), Box<dyn std::error::Error>>;
    fn transcribe_samples(&mut self, samples: Vec<f32>, params: Option<Self::InferenceParams>) -> Result<TranscriptionResult, Box<dyn std::error::Error>>;
    // ... other methods
}
```

What's interesting is how differently Whisper and Parakeet engines consume models:

- **Whisper**: Single GGML file (`whisper-medium-q4_1.bin`)
- **Parakeet**: Structured directory with multiple ONNX files

The Parakeet engine specifically expects a directory, not individual files.

## Parakeet's Directory Requirements

When you pass a model path to transcribe-rs, the Parakeet engine looks for this exact structure:

```
parakeet-tdt-0.6b-v3-int8/
├── config.json                    # Model configuration
├── decoder_joint-model.int8.onnx  # Decoder joint network (18.2 MB)
├── encoder-model.int8.onnx        # Encoder network (652 MB)
├── nemo128.onnx                   # Audio preprocessor (140 KB)
└── vocab.txt                      # Vocabulary mappings (93.9 KB)
```

Here's the actual Rust code that loads these files from transcribe-rs:

```rust
impl ParakeetModel {
    pub fn new<P: AsRef<Path>>(model_dir: P, quantized: bool) -> Result<Self, ParakeetError> {
        let encoder = Self::init_session(&model_dir, "encoder-model", None, quantized)?;
        let decoder_joint = Self::init_session(&model_dir, "decoder_joint-model", None, quantized)?;
        let preprocessor = Self::init_session(&model_dir, "nemo128", None, false)?;

        let (vocab, blank_idx) = Self::load_vocab(&model_dir)?;
        // ... initialization
    }
}
```

Notice how it constructs file paths by appending model names to the directory. The `quantized` parameter determines whether to load `.int8.onnx` or `.onnx` files.

## INT8 Quantization Choice

We chose INT8 quantization for significant performance gains. The numbers are striking:

- **Decoder**: 72.5 MB → 18.2 MB (over 4x smaller)
- **Encoder**: 2.44 GB → 652 MB (over 15x smaller)

The Rust code tries to load quantized versions first:

```rust
let model_filename = if try_quantized {
    let quantized_name = format!("{}.int8.onnx", model_name);
    let quantized_path = model_dir.as_ref().join(&quantized_name);
    if quantized_path.exists() {
        log::info!("Loading quantized model from {}...", quantized_name);
        quantized_name
    } else {
        let regular_name = format!("{}.onnx", model_name);
        log::info!("Quantized model not found, loading regular model from {}...", regular_name);
        regular_name
    }
} else {
    format!("{}.onnx", model_name)
};
```

This fallback mechanism means if we packaged full-precision models, transcribe-rs would use those instead.

## How Whispering Calls transcribe-rs

In our Tauri transcription command, the Parakeet branch instantiates the engine and points it to the model directory:

```rust
fn transcribe_parakeet(
    samples: Vec<f32>,
    model_path: &str,
) -> Result<String, TranscriptionError> {
    let mut engine = ParakeetEngine::new();
    engine.load_model_with_params(&PathBuf::from(model_path), ParakeetModelParams::int8())?;
    let result = engine.transcribe_samples(samples, None)?;
    engine.unload_model();

    Ok(result.text.trim().to_string())
}
```

The `model_path` is literally the directory path: `/path/to/parakeet-tdt-0.6b-v3-int8/`

## Model Download in Whispering

Whispering handles Parakeet model downloads automatically through its UI. When users select a Parakeet model for download, the app downloads each required file individually and organizes them into the correct directory structure.

The download process is implemented in the [`LocalModelDownloadCard`](https://github.com/EpicenterHQ/epicenter/blob/main/apps/whispering/src/lib/components/settings/LocalModelDownloadCard.svelte) component:

1. Creates the model directory: `{appDataDir}/models/parakeet/parakeet-tdt-0.6b-v3-int8/`
2. Downloads each file individually from the [GitHub release](https://github.com/EpicenterHQ/epicenter/releases/tag/models/parakeet-tdt-0.6b-v3-int8)
3. Places files directly in the correct structure for transcribe-rs
4. Shows progress for the entire download process

This approach eliminates the need for archive extraction and provides better download progress tracking. Users simply click "Download" in the settings and the model is ready to use.

## Why This Works

**Directory-based models match ML architecture.** Modern neural networks often split into multiple components (encoder, decoder, preprocessor). Managing them as a unit makes sense.

**transcribe-rs abstracts ONNX complexity.** We don't deal with ONNX Runtime sessions, tensor shapes, or model loading. Just provide a directory and audio data.

**Automatic file management simplifies usage.** Whispering handles all the complexity - users just click download and the model is ready.

The result is fast CPU transcription without users needing to understand model file structures or extraction steps. The UI abstracts away the multi-file nature of Parakeet models while still organizing them correctly for transcribe-rs.
