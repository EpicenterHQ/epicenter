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
//! non-Opus decode), libopus via `audiopus` (Opus decode, straight to
//! 16 kHz), and rubato (resample everything else to 16 kHz).
//!
//! The whole file is decoded into memory before transcription reads it: an
//! hour is about 230 MB of 16 kHz f32 samples, more for a source at a higher
//! rate until it is resampled.

mod decode;
mod error;
mod resample;

pub use decode::decode_to_pcm16k_mono;
pub use error::AudioError;
