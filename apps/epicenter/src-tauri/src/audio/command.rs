//! Tauri command surface for the audio module. One endpoint:
//! `encode_recording_for_upload(audio_blob_id)` resolves the durable local
//! blob by id, decodes it to mono 16 kHz PCM, and re-encodes
//! to OGG/Opus for cloud upload.

use log::warn;
use tauri::ipc::Response;
use tauri::AppHandle;

use super::encode::encode_pcm_to_opus_ogg;
use crate::recorder::read_blob_samples;
use crate::recorder::blob::BlobScope;

/// Compress a saved audio blob into OGG/Opus for cloud upload.
///
/// Returns a raw IPC byte body via `tauri::ipc::Response`. tauri-specta
/// cannot generate either bindings or a runtime handler for this shape
/// because `Response` is not `specta::Type`, so the command is mounted
/// through a separate `tauri::generate_handler!` and hand-rolled at the
/// JS boundary (`src/lib/tauri/commands.ts`) where callers see
/// `Promise<Result<ArrayBuffer, string>>`.
///
/// JS call shape:
/// ```js
/// const compressed = await invoke('encode_recording_for_upload', {
///   audioBlobId,
/// });
/// ```
#[tauri::command]
pub async fn encode_recording_for_upload(
    audio_blob_id: String,
    scope: BlobScope,
    app_handle: AppHandle,
) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let samples = crate::timing::measure("encode.read+decode", || {
            read_blob_samples(&app_handle, &audio_blob_id, &scope)
        })
        .map_err(|e| e.to_string())?;
        // `read_blob_samples` always decodes to 16 kHz; pass that through so the
        // encoder's source-to-48k resample sees the right input rate.
        crate::timing::measure("encode.opus", || {
            encode_pcm_to_opus_ogg(samples, 16_000).map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| format!("background encode task failed: {e}"))?
    .map(Response::new)
    .map_err(|e| {
        warn!("[Audio Encode] failed: {e}");
        e
    })
}
