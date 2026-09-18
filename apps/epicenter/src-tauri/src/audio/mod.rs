//! In-process audio pipeline.
//!
//! Decode any container/codec we plausibly receive (WAV, MP3, M4A/AAC,
//! FLAC, OGG, WebM, including Opus inside any of those) into a `Vec<f32>`
//! of 16 kHz mono samples, ready for local GGUF transcription.
//!
//! Replaces the old `transcription::audio` module, which dispatched
//! across three tiers (WAV fast-path, hound + rubato, external sidecar)
//! and required users to install an external decoder for compressed
//! formats. The new pipeline is one path built on Symphonia (demux +
//! non-Opus decode), libopus via `audiopus` (Opus decode), and rubato
//! (resample to 16 kHz).

mod command;
mod decode;
mod encode;
mod error;
mod resample;

pub use command::encode_recording_for_upload;
pub use decode::decode_to_pcm16k_mono;
pub use encode::encode_pcm_to_opus_ogg;
pub use error::AudioError;

/// Decode a saved blob without depending on whether a recorder created it.
pub fn read_blob_samples(
    app: &tauri::AppHandle,
    id: &str,
    destination: &crate::blobs::BlobDestination,
) -> Result<Vec<f32>, AudioError> {
    let bytes = crate::blobs::read_blob_bytes(app, id, destination)?;
    decode_to_pcm16k_mono(&bytes)
}
