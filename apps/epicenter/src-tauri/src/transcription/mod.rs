mod catalog;
mod error;
mod model_cache;
mod settings;

pub use catalog::{
    delete_model, download_model, list_models, ActiveModel, CatalogError, ModelInfo,
};
pub use error::TranscriptionError;
pub use model_cache::ModelCache;
pub use settings::{LocalTranscriptionSettings, SettingsError, UnloadPolicy};

use crate::recorder::read_blob_samples;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

// ── Wire types ────────────────────────────────────────────────────────

/// Why the local transcription route cannot run right now.
///
/// A compact reason, deliberately not a model. It is enough for an application
/// to write an honest sentence and name Home as the fix, and it carries no
/// identity, no inventory, and nothing about what is cached or resident.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum UnavailableReason {
    /// Nobody has chosen an active local model on this device.
    NoActiveModel,
    /// A model is active, but it cannot run here: its file is not on this
    /// machine, or it is not a model this build knows about.
    ActiveModelUnavailable,
}

/// What an application may learn about the local transcription route: whether it
/// is ready, and which advisory inputs it accepts.
///
/// Readiness and capability, never identity (ADR-0180). This is advisory UI
/// state, not a preflight gate: a caller uses it to warn before capture and to
/// decide whether to offer a prompt or language field, never to decide whether
/// `transcribe_recording` may be called. Transcription resolves the active model
/// independently at the point of use, so a stale read here can only produce a
/// stale hint, never a wrong transcription.
///
/// That distinction is load-bearing because the shared Hugging Face cache can
/// change outside Epicenter: a model deleted by another tool between this read
/// and the next transcribe turns a `ready` answer stale, and the transcribe path
/// still fails closed on its own.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, specta::Type)]
#[serde(tag = "status", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum LocalTranscriptionReadiness {
    Ready {
        /// Whether the active model accepts an initial prompt.
        supports_prompt: bool,
        /// Whether it takes a spoken-language hint.
        supports_language: bool,
    },
    Unavailable {
        reason: UnavailableReason,
        /// A user-facing sentence that names no model.
        message: String,
    },
}

/// The advisory hints an application supplies with a transcription.
///
/// Model identity is deliberately absent (ADR-0180): the host resolves the one
/// active model at use, so an ordinary request cannot reassign the shared model
/// cache. Language and prompt stay application-owned and read-at-use, exactly as
/// ADR-0012 left them; nothing here is retained between calls.
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
/// asked for. A hint the active model cannot take is reported as not applied
/// rather than dropped in silence, so a caller can tell its user that the prompt
/// or language did not reach the recognizer instead of wondering why it had no
/// effect.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AppliedHints {
    /// The language hint the runtime received. `None` means it autodetected:
    /// the caller asked for autodetect, sent nothing, or asked for a language
    /// the active model does not take.
    pub language: Option<String>,
    /// Whether the caller's initial prompt reached the runtime. `false` when the
    /// caller sent none, or the active model does not accept one (Whisper does;
    /// the Parakeet family does not).
    pub initial_prompt: bool,
}

/// What a transcription request produced.
///
/// Two outcomes because there are two honest stories. `transcribed` names the
/// exact model that produced the text, which is what makes an accidental
/// substitution detectable: with the active model unchanged, identical ordinary
/// requests must name the same model however the host arranges residency.
/// `empty-audio` reports that nothing ran, and deliberately carries no model and
/// no applied hints, because claiming either would be claiming an inference that
/// never happened.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, specta::Type)]
#[serde(tag = "outcome", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum TranscriptionOutcome {
    Transcribed {
        text: String,
        model_id: String,
        applied: AppliedHints,
    },
    /// The audio held no samples, so no model was loaded and no hint applied.
    EmptyAudio,
}

// ── Home: model administration ────────────────────────────────────────

/// The active local model's identity and whether it can run right now, or
/// `None` when nobody has chosen one.
///
/// **Administration only.** Home holds this grant because Home chooses the
/// active model and must show which one that is. Applications are not granted
/// it and read `get_local_transcription_readiness` instead, which answers the
/// question they actually have without handing them an identity they could
/// start keying behaviour off.
#[tauri::command]
#[specta::specta]
pub fn get_active_model(model_cache: State<'_, ModelCache>) -> Option<ActiveModel> {
    model_cache
        .settings()
        .active_model_id()
        .as_deref()
        .and_then(catalog::describe)
}

/// Make `model_id` the active local model, or clear the choice with `null`.
/// Home's administration write: the only way the active model changes.
#[tauri::command]
#[specta::specta]
pub fn set_active_model(
    model_id: Option<String>,
    model_cache: State<'_, ModelCache>,
) -> Result<(), SettingsError> {
    model_cache.settings().set_active_model_id(model_id)
}

/// When the host drops the resident model.
#[tauri::command]
#[specta::specta]
pub fn get_unload_policy(model_cache: State<'_, ModelCache>) -> UnloadPolicy {
    model_cache.settings().unload_policy()
}

/// Set the unload policy. Host-owned and durable alongside the active model:
/// Rust owns the idle clock because a backgrounded webview timer throttles
/// exactly when idle eviction must fire (ADR-0012), and now owns the value too,
/// so it applies from launch instead of waiting for a webview to reconcile it.
/// It carries no model identity, so it applies whether or not a model is active.
#[tauri::command]
#[specta::specta]
pub fn set_unload_policy(
    policy: UnloadPolicy,
    model_cache: State<'_, ModelCache>,
) -> Result<(), SettingsError> {
    model_cache.settings().set_unload_policy(policy)
}

// ── Applications: readiness and transcribe ────────────────────────────

/// Whether the local transcription route can run right now, and what it accepts.
///
/// The one ordinary application-facing read. It exists so an app can warn the
/// user *before* they speak, which matters because the surface that reports a
/// failure afterwards (a dictation pill) has nowhere to put a recovery action.
/// Advisory only: it never mutates, and it is not a gate the caller must pass
/// before transcribing.
#[tauri::command]
#[specta::specta]
pub fn get_local_transcription_readiness(
    model_cache: State<'_, ModelCache>,
) -> LocalTranscriptionReadiness {
    model_cache.readiness()
}

// ── Applications: transcribe ──────────────────────────────────────────

/// Canonical transcribe-by-id path. Resolves the canonical local blob, decodes
/// it, then runs inference on the **active** model with the caller's advisory
/// hints. The caller names audio and hints; it does not name a model.
#[tauri::command]
#[specta::specta]
pub async fn transcribe_recording(
    audio_blob_id: String,
    hints: TranscriptionHints,
    app_handle: AppHandle,
    model_cache: State<'_, ModelCache>,
) -> Result<TranscriptionOutcome, TranscriptionError> {
    let samples = crate::timing::measure("transcribe.read+decode", || {
        read_blob_samples(&app_handle, &audio_blob_id)
    })
    .map_err(|e| TranscriptionError::AudioReadError {
        message: error::format_error_chain(&e),
    })?;

    let cache = model_cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || cache.transcribe(samples, hints))
        .await
        .map_err(join_err)?
}

/// Prewarm the active local model so a following transcribe finds it warm. The
/// frontend fires this fire-and-forget at capture start (manual record or VAD
/// listen) for a local route, overlapping the ~1 s model load with the user's
/// speech instead of paying it after they stop.
///
/// Idempotent and cheap: a no-op when the active model is already resident.
/// Shares the one load path with `transcribe_recording` (`ModelCache::prewarm`
/// and `transcribe` both resolve through `ensure_loaded`), so the model warmed
/// here is exactly the one transcribe will use, because there is only one. A
/// failure here is non-fatal: transcribe will load normally and surface any real
/// error then.
#[tauri::command]
#[specta::specta]
pub async fn prewarm_model(model_cache: State<'_, ModelCache>) -> Result<(), TranscriptionError> {
    let cache = model_cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || cache.prewarm())
        .await
        .map_err(join_err)?
}

/// Map a join failure from spawn_blocking into a TranscriptionError so the
/// frontend always sees a structured error even when the background task
/// panics or is cancelled.
fn join_err(e: tauri::Error) -> TranscriptionError {
    TranscriptionError::TranscriptionError {
        message: format!("Background transcription task failed: {}", e),
    }
}
