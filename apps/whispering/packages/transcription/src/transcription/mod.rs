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

use serde::{Deserialize, Serialize};

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
