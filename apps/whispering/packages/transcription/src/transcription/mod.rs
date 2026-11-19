mod catalog;
mod error;
mod model_cache;
mod settings;

pub use catalog::{
    download_model, list_models, remove_model, reveal_model, CatalogError, ModelInfo,
};
pub use error::TranscriptionError;
pub use model_cache::ModelCache;
pub use settings::{LocalTranscriptionSettings, SettingsError, UnloadPolicy};

use crate::PluginState;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime, State};

// ── Wire types ────────────────────────────────────────────────────────

/// The advisory hints an application supplies with a transcription. The model
/// is named separately. Language and prompt remain application-owned; nothing
/// here is retained between calls.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionHints {
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub initial_prompt: Option<String>,
}

/// Which advisory hints the run actually applied.
///
/// Built from the exact values handed to the runtime, never from what the caller
/// asked for. A hint the model cannot take is reported as not applied
/// rather than dropped in silence, so a caller can tell its user that the prompt
/// or language did not reach the recognizer instead of wondering why it had no
/// effect.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AppliedHints {
    /// The language hint the runtime received. `None` means it autodetected:
    /// the caller asked for autodetect, sent nothing, or asked for a language
    /// the model does not take.
    pub language: Option<String>,
    /// Whether the caller's initial prompt reached the runtime. `false` when the
    /// caller sent none, or the model does not accept one (Whisper does;
    /// the Parakeet family does not).
    pub initial_prompt: bool,
}

/// What a transcription request produced.
///
/// Two outcomes because there are two honest stories. `transcribed` names the
/// exact model that produced the text, which makes accidental substitution
/// detectable: it is always the requested model.
/// `empty-audio` reports that nothing ran, and deliberately carries no model and
/// no applied hints, because claiming either would be claiming an inference that
/// never happened.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, specta::Type)]
#[serde(
    tag = "outcome",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum TranscriptionOutcome {
    Transcribed {
        text: String,
        model_id: String,
        applied: AppliedHints,
    },
    /// The audio held no samples, so no model was loaded and no hint applied.
    EmptyAudio,
}

// Model administration.

/// When the app drops the resident model.
#[tauri::command]
#[specta::specta]
pub fn get_unload_policy<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, PluginState>,
) -> UnloadPolicy {
    state.cache().settings().unload_policy()
}

/// Set the unload policy. Rust owns the idle clock because a backgrounded
/// webview timer throttles exactly when idle eviction must fire (ADR-0012),
/// and owns the value too, so it applies from launch instead of waiting for a
/// webview to reconcile it. It carries no model identity.
#[tauri::command]
#[specta::specta]
pub fn set_unload_policy<R: Runtime>(
    policy: UnloadPolicy,
    _app: AppHandle<R>,
    state: State<'_, PluginState>,
) -> Result<(), SettingsError> {
    state.cache().settings().set_unload_policy(policy)
}

// ── Applications: transcribe ──────────────────────────────────────────

/// Map a join failure from spawn_blocking into a TranscriptionError so the
/// frontend always sees a structured error even when the background task
/// panics or is cancelled.
fn join_err(e: tauri::Error) -> TranscriptionError {
    TranscriptionError::TranscriptionError {
        message: format!(
            "Background transcription task failed: {}",
            error::error_chain_message(&e)
        ),
    }
}

/// Installed native models available to explicit inference. No cache paths escape.
#[tauri::command]
#[specta::specta]
pub fn list_inference_models() -> Vec<InferenceModel> {
    catalog::list_models()
        .into_iter()
        .filter(|model| model.downloaded)
        .map(|model| InferenceModel {
            id: model.id,
            installed: true,
        })
        .collect()
}

/// Transcribe audio the page holds (an upload, such as a dictation's blob),
/// base64-encoded, with the exact catalog model `model_id`. The bytes are
/// decoded where they arrive; nothing is written to disk. Audio that is not
/// base64 is an `AudioReadError`; then an unknown or uninstalled model is
/// refused before the audio is decoded, and audio that does not decode is an
/// `AudioReadError`.
#[tauri::command]
#[specta::specta]
pub async fn transcribe_audio<R: Runtime>(
    model_id: String,
    audio: String,
    hints: TranscriptionHints,
    _app: AppHandle<R>,
    state: State<'_, PluginState>,
) -> Result<TranscriptionOutcome, TranscriptionError> {
    use base64::Engine;
    let cache = state.cache();
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(audio)
            .map_err(|error| TranscriptionError::AudioReadError {
                message: format!("The audio is not base64: {error}"),
            })?;
        cache.transcribe_bytes(model_id, &bytes, hints)
    })
    .await
    .map_err(join_err)?
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct InferenceModel {
    pub id: String,
    pub installed: bool,
}

