use thiserror::Error;

/// Why audio could not be decoded.
///
/// The variants are for logs. Transcription (`model_cache.rs`) turns any of
/// them into `TranscriptionError::AudioReadError` with its message, so the
/// variant does not cross the IPC boundary.
#[derive(Error, Debug)]
pub enum AudioError {
    #[error("Audio decode failed: {message}")]
    DecodeFailed { message: String },

    #[error("Unsupported audio format: {message}")]
    UnsupportedFormat { message: String },

    #[error("Audio resample failed: {message}")]
    ResampleFailed { message: String },
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
}
