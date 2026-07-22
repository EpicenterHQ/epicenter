//! Tauri command surface for record-addressed audio upload encoding.

use log::warn;
use tauri::ipc::Response;
use tauri::State;

use super::decode::decode_to_pcm16k_mono;
use super::encode::encode_pcm_to_opus_ogg;
use crate::recorder::read_recording_bytes;
use crate::HostState;

/// Compress one saved recording's record-owned audio into OGG/Opus.
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
///   recordingId,
/// });
/// ```
#[tauri::command]
pub async fn encode_recording_for_upload(
    recording_id: String,
    host: State<'_, HostState>,
) -> Result<Response, String> {
    let bytes = read_recording_bytes(host.inner(), &recording_id)
        .await
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let samples = crate::timing::measure("encode.decode", || {
            decode_to_pcm16k_mono(&bytes).map_err(|error| error.to_string())
        })?;
        // `decode_to_pcm16k_mono` always decodes to 16 kHz; pass that through so the
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
