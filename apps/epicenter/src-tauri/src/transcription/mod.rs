mod catalog;
mod config;
mod error;
mod model_cache;

pub use catalog::{delete_model, download_model, list_models, CatalogError, ModelInfo};
pub use config::{TranscriptionSpec, UnloadPolicy};
pub use error::TranscriptionError;
pub use model_cache::ModelCache;

use crate::audio::decode_to_pcm16k_mono;
use crate::recorder::read_recording_bytes;
use crate::HostState;
use tauri::State;

/// Reconcile the current local-model unload policy into the native idle
/// watcher. The frontend owns the value and pushes it on every change; Rust
/// owns the clock. It carries no model identity, so it applies whether or not a
/// model is selected.
#[tauri::command]
#[specta::specta]
pub fn set_unload_policy(policy: UnloadPolicy, model_cache: State<'_, ModelCache>) {
    model_cache.set_unload_policy(policy);
}

/// Transcribe one saved recording through the record-addressed host boundary.
#[tauri::command]
#[specta::specta]
pub async fn transcribe_recording(
    recording_id: String,
    spec: TranscriptionSpec,
    host: State<'_, HostState>,
    model_cache: State<'_, ModelCache>,
) -> Result<String, TranscriptionError> {
    let bytes = read_recording_bytes(host.inner(), &recording_id)
        .await
        .map_err(|error| TranscriptionError::AudioReadError {
            message: error.to_string(),
        })?;
    let samples = tauri::async_runtime::spawn_blocking(move || {
        crate::timing::measure("transcribe.decode", || decode_to_pcm16k_mono(&bytes))
    })
    .await
    .map_err(join_err)?
    .map_err(|e| TranscriptionError::AudioReadError {
        message: e.to_string(),
    })?;

    let cache = model_cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || cache.transcribe(samples, spec))
        .await
        .map_err(join_err)?
}

/// Prewarm the local model for `spec` so a following transcribe finds it
/// warm. The frontend fires this fire-and-forget at capture start (manual
/// record or VAD listen) for a local provider, overlapping the ~1 s model
/// load with the user's speech instead of paying it after they stop.
///
/// Idempotent and cheap: a no-op when the exact model is already resident.
/// Shares the one load path with `transcribe_recording` (`ModelCache::prewarm`
/// and `transcribe` both resolve through `ensure_loaded`), so the model warmed
/// here is exactly the one transcribe will use, and a mid-recording model change
/// simply reloads at transcribe time. A failure here is non-fatal: transcribe
/// will load normally and surface any real error then.
#[tauri::command]
#[specta::specta]
pub async fn prewarm_model(
    spec: TranscriptionSpec,
    model_cache: State<'_, ModelCache>,
) -> Result<(), TranscriptionError> {
    let cache = model_cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || cache.prewarm(&spec))
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
