use super::UnavailableReason;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug, Serialize, Deserialize, specta::Type)]
#[serde(tag = "name")]
pub enum TranscriptionError {
    #[error("Audio read error: {message}")]
    AudioReadError { message: String },

    /// The calling window has no usable folder there: the app bound none to
    /// it, its page did not open the root it named, the directory is gone or
    /// unreachable, or the app is shutting down.
    #[error("No folder for this window: {message}")]
    FolderUnavailable { message: String },

    /// The path is not a data path in the window's folder: it is empty,
    /// absolute, names `.`, `..`, or Git's state, or a link is on its way.
    #[error("Path refused: {message}")]
    PathRefused { message: String },

    /// No regular file is at the path in the window's folder.
    #[error("File missing: {message}")]
    FileMissing { message: String },

    /// The local route cannot run: no model is active, or the selected or
    /// explicitly requested model is unknown or not installed on this computer.
    ///
    /// Callers show the refusal and offer this app's model settings.
    /// Explicit inference may name the requested catalog model in its message.
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

/// Render an error and its whole `source()` chain as one message.
///
/// Library errors often put the actionable cause only on the source: an
/// `hf-hub` request error displays as `request error: error sending request
/// for url (...)` while the DNS, TLS, or connection failure lives on the
/// `reqwest` source beneath it. The page shows only this string, so the chain
/// is flattened here. A source whose text the message already ends with (the
/// `#[error("label: {0}")]` plus `#[from]` pattern) is not repeated.
pub(crate) fn error_chain_message(error: &dyn std::error::Error) -> String {
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        let text = cause.to_string();
        if !text.is_empty() && !message.ends_with(&text) {
            message.push_str(": ");
            message.push_str(&text);
        }
        source = cause.source();
    }
    message
}

#[cfg(test)]
mod tests {
    use super::error_chain_message;
    use thiserror::Error;

    #[derive(Error, Debug)]
    #[error("connection refused")]
    struct Connect;

    #[derive(Error, Debug)]
    #[error("error sending request for url (https://huggingface.co/x)")]
    struct Request(#[source] Connect);

    #[derive(Error, Debug)]
    enum Api {
        #[error("request error: {0}")]
        Request(#[from] Request),
        #[error("ORT error")]
        Opaque(#[source] Connect),
    }

    #[test]
    fn opaque_label_shows_its_source() {
        assert_eq!(
            error_chain_message(&Api::Opaque(Connect)),
            "ORT error: connection refused"
        );
    }

    #[test]
    fn source_already_in_the_message_is_not_repeated() {
        assert_eq!(
            error_chain_message(&Api::from(Request(Connect))),
            "request error: error sending request for url (https://huggingface.co/x): connection refused"
        );
    }

    #[test]
    fn error_without_source_is_its_display() {
        assert_eq!(error_chain_message(&Connect), "connection refused");
    }
}
