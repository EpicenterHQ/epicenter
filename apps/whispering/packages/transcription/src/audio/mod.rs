//! In-process audio pipeline.
//!
//! Decode any container/codec we plausibly receive (WAV, MP3, M4A/AAC,
//! FLAC, OGG, WebM, including Opus inside any of those) into a `Vec<f32>`
//! of 16 kHz mono samples, ready for local GGUF transcription.
//!
//! One path: Symphonia demuxes every container and decodes everything but
//! Opus, libopus via `audiopus` decodes Opus straight to 16 kHz, and rubato
//! resamples everything else to 16 kHz.
//!
//! The whole file is decoded into memory before transcription reads it: an
//! hour is about 230 MB of 16 kHz f32 samples, more for a source at a higher
//! rate until it is resampled.

mod decode;
mod error;
mod resample;

pub use decode::decode_to_pcm16k_mono;
pub use error::AudioError;
