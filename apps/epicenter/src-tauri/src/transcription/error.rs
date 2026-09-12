use super::UnavailableReason;
use serde::{Deserialize, Serialize};
use std::error::Error as StdError;
use thiserror::Error;

#[derive(Error, Debug, Serialize, Deserialize, specta::Type)]
#[serde(tag = "name")]
pub enum TranscriptionError {
    #[error("Audio read error: {message}")]
    AudioReadError { message: String },

    /// The local route cannot run at all: no model is active on this device, or
    /// the active model's file is not here.
    ///
    /// One public precondition family (ADR-0180). The two cases differ only as
    /// compact `reason` data, because the caller's job is the same either way:
    /// say so honestly and point at Home. `message` never names a model, since
    /// model identity is administration data an application does not receive.
    ///
    /// Failing here changes nothing. No model is adopted, downloaded,
    /// substituted, or routed to the cloud on the caller's behalf.
    #[error("Local transcription unavailable: {message}")]
    LocalRouteUnavailable {
        reason: UnavailableReason,
        message: String,
    },

    /// Operational, not a precondition: the active model was resolvable but the
    /// runtime could not load it. Kept distinct so a broken install does not
    /// read as "you have not set this up".
    #[error("Model load error: {message}")]
    ModelLoadError { message: String },

    /// Operational: inference itself failed.
    #[error("Transcription error: {message}")]
    TranscriptionError { message: String },
}

/// Flatten an error and its `source()` chain into one user-facing message.
///
/// Upstream wrappers sometimes use a fixed Display label (for example the old
/// Parakeet `ORT error` variant) while the actionable ONNX / runtime detail
/// lives only on the nested source. Walking the chain keeps "More details"
/// useful instead of repeating a bare opaque string.
pub(crate) fn format_error_chain(err: &dyn StdError) -> String {
    let mut parts = vec![err.to_string()];
    let mut current = err.source();
    while let Some(source) = current {
        let text = source.to_string();
        if !text.is_empty() && parts.last().is_none_or(|prev| prev != &text) {
            parts.push(text);
        }
        current = source.source();
    }
    parts.join(": ")
}

#[cfg(test)]
mod tests {
    use super::format_error_chain;
    use std::error::Error;
    use std::fmt;

    #[derive(Debug)]
    struct Leaf(&'static str);

    impl fmt::Display for Leaf {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str(self.0)
        }
    }

    impl Error for Leaf {}

    #[derive(Debug)]
    struct Wrapper {
        label: &'static str,
        source: Leaf,
    }

    impl fmt::Display for Wrapper {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str(self.label)
        }
    }

    impl Error for Wrapper {
        fn source(&self) -> Option<&(dyn Error + 'static)> {
            Some(&self.source)
        }
    }

    #[test]
    fn format_error_chain_includes_nested_source() {
        let err = Wrapper {
            label: "ORT error",
            source: Leaf("Failed to allocate 2147483647 bytes"),
        };
        assert_eq!(
            format_error_chain(&err),
            "ORT error: Failed to allocate 2147483647 bytes"
        );
    }
}
