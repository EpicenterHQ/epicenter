use thiserror::Error;

/// Failure modes for the audio decode/encode pipeline.
///
/// Variants document the failure mode for log/debug consumption. The current
/// consumer (`transcription::run_transcription`) stringifies and wraps any
/// variant into `TranscriptionError::AudioReadError`, so the discriminant
/// does not cross the IPC boundary.
#[derive(Error, Debug)]
pub enum AudioError {
    #[error("Audio blob read failed: {0}")]
    BlobRead(#[from] crate::blobs::BlobError),

    #[error("Audio decode failed: {message}")]
    DecodeFailed { message: String },

    #[error("Unsupported audio format: {message}")]
    UnsupportedFormat { message: String },

    #[error("Audio resample failed: {message}")]
    ResampleFailed { message: String },

    #[error("Audio encode failed: {message}")]
    EncodeFailed { message: String },
}

impl AudioError {
    pub(crate) fn decode(msg: impl Into<String>) -> Self {
        AudioError::DecodeFailed {
            message: msg.into(),
        }
    }

    pub(crate) fn unsupported(msg: impl Into<String>) -> Self {
        AudioError::UnsupportedFormat {
            message: msg.into(),
        }
    }

    pub(crate) fn resample(msg: impl Into<String>) -> Self {
        AudioError::ResampleFailed {
            message: msg.into(),
        }
    }

    pub(crate) fn encode(msg: impl Into<String>) -> Self {
        AudioError::EncodeFailed {
            message: msg.into(),
        }
    }
}
