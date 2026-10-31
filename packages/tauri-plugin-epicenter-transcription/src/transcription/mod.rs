mod catalog;
mod error;
mod model_cache;
mod settings;

pub use catalog::{
    download_model, list_models, reveal_model, ActiveModel, CatalogError, ModelInfo,
};
pub use error::TranscriptionError;
pub use model_cache::ModelCache;
pub use settings::{LocalTranscriptionSettings, SettingsError, UnloadPolicy};

use crate::PluginState;
use epicenter_folder_core::page_files;
use epicenter_folder_core::paths::path_problem;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Runtime, State, Webview};
use tauri_plugin_epicenter_folder::FolderExt;

// ── Wire types ────────────────────────────────────────────────────────

/// Why the local transcription route cannot run right now.
///
/// A compact reason without model identity or residency. Callers can show the
/// refusal and offer this app's model settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum UnavailableReason {
    /// Nobody has chosen an active local model on this device.
    NoActiveModel,
    /// A model is active, but it cannot run here: its file is not on this
    /// machine, or it is not a model this build knows about.
    ActiveModelUnavailable,
}

/// Whether the active-model transcription route is ready and which hints it accepts.
///
/// This route preserves ADR-0180's identity-free readiness response. It is advisory
/// UI state, not a preflight gate: a caller uses it to warn before capture and to
/// decide whether to offer a prompt or language field, never to decide whether
/// a transcription may be requested. Transcription resolves the active model
/// independently at the point of use, so a stale read here can only produce a
/// stale hint, never a wrong transcription.
///
/// That distinction is load-bearing because the shared Hugging Face cache can
/// change outside this app: a model deleted by another tool between this read
/// and the next transcribe turns a `ready` answer stale, and the transcribe path
/// still fails closed on its own.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, specta::Type)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
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
/// The active-model route resolves the model from host settings. Explicit file
/// inference receives the model separately from these hints. Neither route
/// changes the active-model setting. Language and prompt remain application-owned;
/// nothing here is retained between calls.
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
/// exact model that produced the text, which makes accidental substitution
/// detectable. Explicit inference must name the requested model; the active-model
/// route must name the model it resolved from settings, regardless of residency.
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

/// The active local model's identity and whether it can run right now, or
/// `None` when nobody has chosen one.
///
/// Administration only: the app grants this to its model settings. Explicit
/// inference discovers installed IDs through `list_inference_models`.
#[tauri::command]
#[specta::specta]
pub fn get_active_model<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, PluginState<R>>,
) -> Option<ActiveModel> {
    state
        .cache()
        .settings()
        .active_model_id()
        .as_deref()
        .and_then(catalog::describe)
}

/// Make `model_id` the active local model, or clear the choice with `null`.
/// The settings page's administration write; inference never changes this choice.
#[tauri::command]
#[specta::specta]
pub fn set_active_model<R: Runtime>(
    model_id: Option<String>,
    _app: AppHandle<R>,
    state: State<'_, PluginState<R>>,
) -> Result<(), SettingsError> {
    state.cache().settings().set_active_model_id(model_id)
}

/// When the app drops the resident model.
#[tauri::command]
#[specta::specta]
pub fn get_unload_policy<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, PluginState<R>>,
) -> UnloadPolicy {
    state.cache().settings().unload_policy()
}

/// Set the unload policy. Rust owns the idle clock because a backgrounded
/// webview timer throttles exactly when idle eviction must fire (ADR-0012),
/// and owns the value too, so it applies from launch instead of waiting for a
/// webview to reconcile it. It carries no model identity, so it applies
/// whether or not a model is active.
#[tauri::command]
#[specta::specta]
pub fn set_unload_policy<R: Runtime>(
    policy: UnloadPolicy,
    _app: AppHandle<R>,
    state: State<'_, PluginState<R>>,
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

/// Installed native models available to explicit file inference. No cache paths escape.
#[tauri::command]
#[specta::specta]
pub fn list_inference_models<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, PluginState<R>>,
) -> Vec<InferenceModel> {
    let active = state.cache().settings().active_model_id();
    catalog::list_models()
        .into_iter()
        .filter(|model| model.downloaded)
        .map(|model| InferenceModel {
            active: active.as_deref() == Some(model.id.as_str()),
            id: model.id,
            installed: true,
        })
        .collect()
}

/// The audio file at the data path `path` in `root`, checked on arrival:
/// `root` must be the calling window's own folder (`None`) or a root its page
/// opened (`open_folder`), read once; the path must pass the folder's path
/// rule with no link on the way, and a regular file must be there.
fn audio_file<R: Runtime>(
    webview: &Webview<R>,
    root: Option<&str>,
    path: &str,
) -> Result<PathBuf, TranscriptionError> {
    let directory = webview
        .folders()
        .bound_root(webview.label(), root)
        .map_err(|refusal| TranscriptionError::FolderUnavailable {
            message: refusal.to_string(),
        })?;
    let refused = |message: String| TranscriptionError::PathRefused { message };
    if let Some(problem) = path_problem(path) {
        return Err(refused(format!("{path:?}: {problem}")));
    }
    let target = page_files::data_path(directory.root(), path).map_err(refused)?;
    match std::fs::metadata(&target) {
        Ok(metadata) if metadata.is_file() => Ok(target),
        Ok(_) => Err(TranscriptionError::FileMissing {
            message: format!("{path} is not a file."),
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(TranscriptionError::FileMissing {
                message: format!("Nothing is at {path}."),
            })
        }
        Err(error) => Err(TranscriptionError::AudioReadError {
            message: format!("{path}: {error}"),
        }),
    }
}

/// Transcribe the audio file at the folder-relative data path `path` (such as
/// `recordings/20261031T101500123.wav`) in `root`, with the exact catalog
/// model `model_id`. `root` is a folder the calling window's page opened, by
/// the exact path the shell answered it with, or `None` for the window's own
/// folder; any other root is refused, whatever it holds.
///
/// A root the window did not open, a path the folder rule refuses, and a
/// missing file are refused before any model is resolved. An unknown or
/// uninstalled model is refused before the file is read or decoded. The
/// active-model setting is neither read nor changed. The blocking job owns its
/// input until inference finishes, including after the caller abandons the
/// call.
#[tauri::command]
#[specta::specta]
pub async fn transcribe_file<R: Runtime>(
    model_id: String,
    root: Option<String>,
    path: String,
    hints: TranscriptionHints,
    webview: Webview<R>,
    state: State<'_, PluginState<R>>,
) -> Result<TranscriptionOutcome, TranscriptionError> {
    let audio = audio_file(&webview, root.as_deref(), &path)?;
    let cache = state.cache();
    tauri::async_runtime::spawn_blocking(move || cache.transcribe_explicit(model_id, &audio, hints))
        .await
        .map_err(join_err)?
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct InferenceModel {
    pub id: String,
    pub installed: bool,
    pub active: bool,
}

/// Open this app's model settings through the callback given to
/// `Builder::open_settings`. Refused when the app gave none.
#[tauri::command]
#[specta::specta]
pub async fn open_model_settings<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PluginState<R>>,
) -> Result<(), String> {
    (state.open_settings)(&app)
}
