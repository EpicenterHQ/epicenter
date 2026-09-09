//! Structured recorder failures that cross the IPC boundary.
//!
//! Every recorder command returns `Result<T, RecorderError>`. The enum is
//! internally tagged (`{ "name": "...", "message": "..." }`) so the TypeScript
//! side switches on `error.name`.
//!
//! A variant exists only where the frontend acts differently: a microphone
//! permission denial (route the user to grant access), a missing input device
//! (ask them to connect one), a recorder already in use by another window
//! (say so instead of stealing it), a recording that is not the caller's to end
//! (a benign no-op for an idempotent stop), and everything else, which the
//! frontend labels by the command that failed and shows the message for. A
//! finer taxonomy (io vs config vs internal) was deliberately not modeled: the
//! frontend would discard the distinction, so it would be a decorative name on
//! a string. The detail still travels, in `message`.

use cpal::{Error as CpalError, ErrorKind};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug, Serialize, Deserialize, specta::Type)]
#[serde(tag = "name")]
pub enum RecorderError {
    /// The OS refused microphone access. The frontend checks microphone
    /// permission before recording, so this is the stream-open fallback for a
    /// denial that slips past that gate (e.g. a declined first-run prompt).
    #[error("{message}")]
    PermissionDenied { message: String },

    /// No usable input device: none selected and no default, the named device
    /// is gone, cpal reports the device unavailable mid-open, or the device
    /// yields no input configurations at all (query errors or returns empty).
    #[error("{message}")]
    NoInputDevice { message: String },

    /// A recording started by some window is already in flight. There is one
    /// host recorder, and a competing start is refused rather than silently
    /// displacing a recording another window is relying on.
    #[error("{message}")]
    Busy { message: String },

    /// The named recording is not this window's to end: it has already
    /// finished, it is not the one in flight, or another window owns it. One
    /// variant for all three because a caller cannot act differently on them,
    /// and the distinguishing detail travels in `message`.
    #[error("{message}")]
    NotRecording { message: String },

    /// Any other recording failure (device config, stream build, filesystem,
    /// internal). The frontend does not branch on these.
    #[error("{message}")]
    Failed { message: String },
}

impl RecorderError {
    pub(crate) fn no_input_device(message: impl Into<String>) -> Self {
        Self::NoInputDevice {
            message: message.into(),
        }
    }

    pub(crate) fn busy(message: impl Into<String>) -> Self {
        Self::Busy {
            message: message.into(),
        }
    }

    pub(crate) fn not_recording(message: impl Into<String>) -> Self {
        Self::NotRecording {
            message: message.into(),
        }
    }

    pub(crate) fn failed(message: impl Into<String>) -> Self {
        Self::Failed {
            message: message.into(),
        }
    }

    /// Classify a cpal error by its typed `ErrorKind`.
    ///
    /// cpal 0.18 collapsed its three error enums into one `cpal::Error` carrying
    /// a typed `ErrorKind`. Each backend maps an OS denial to
    /// `ErrorKind::PermissionDenied` (coreaudio's `Unauthorized`, WASAPI's
    /// `E_ACCESSDENIED`, an ALSA permission error) and a vanished device to
    /// `ErrorKind::DeviceNotAvailable` at the source, so the classification is
    /// locale-proof: no description-string matching. Everything else collapses
    /// to `Failed`, which the frontend labels by the command that failed. The
    /// frontend's pre-record permission check is still the primary gate; this
    /// only catches a denial surfacing at stream-open.
    pub(crate) fn classify_cpal(context: &str, err: CpalError) -> Self {
        let message = format!("{context}: {err}");
        match err.kind() {
            ErrorKind::PermissionDenied => Self::PermissionDenied { message },
            ErrorKind::DeviceNotAvailable => Self::NoInputDevice { message },
            _ => Self::Failed { message },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name_of(err: &RecorderError) -> &'static str {
        match err {
            RecorderError::PermissionDenied { .. } => "PermissionDenied",
            RecorderError::NoInputDevice { .. } => "NoInputDevice",
            RecorderError::Busy { .. } => "Busy",
            RecorderError::NotRecording { .. } => "NotRecording",
            RecorderError::Failed { .. } => "Failed",
        }
    }

    // The macOS bug fix, now locale-proof: a TCC mic denial reaches cpal 0.18 as
    // ErrorKind::PermissionDenied (coreaudio's Unauthorized), so it classifies
    // as PermissionDenied instead of the old generic Failed. Same path on
    // Windows (E_ACCESSDENIED) and Linux (ALSA permission), by construction.
    #[test]
    fn permission_denied_kind_is_permission_denied() {
        let err = RecorderError::classify_cpal("ctx", CpalError::new(ErrorKind::PermissionDenied));
        assert_eq!(name_of(&err), "PermissionDenied");
    }

    // A vanished or absent device classifies as NoInputDevice ("connect a mic").
    #[test]
    fn device_not_available_kind_is_no_input_device() {
        let err =
            RecorderError::classify_cpal("ctx", CpalError::new(ErrorKind::DeviceNotAvailable));
        assert_eq!(name_of(&err), "NoInputDevice");
    }

    // Every other kind is the catch-all the frontend labels by failing command.
    #[test]
    fn other_kinds_are_failed() {
        for kind in [
            ErrorKind::BackendError,
            ErrorKind::UnsupportedConfig,
            ErrorKind::DeviceBusy,
            ErrorKind::HostUnavailable,
            ErrorKind::Other,
        ] {
            let err = RecorderError::classify_cpal("ctx", CpalError::new(kind));
            assert_eq!(name_of(&err), "Failed", "expected Failed for {kind:?}");
        }
    }

    // Regression guard for the get_optimal_config site (recorder.rs): a device
    // that yields no input configs is unusable, so the call site remaps a Failed
    // config-query error to NoInputDevice. A permission denial must survive that
    // remap unchanged rather than being downgraded.
    #[test]
    fn config_query_failed_fallback_remaps_to_no_input_device() {
        let remap = |e: CpalError| match RecorderError::classify_cpal("ctx", e) {
            RecorderError::Failed { message } => RecorderError::NoInputDevice { message },
            classified => classified,
        };

        // A generic backend failure -> NoInputDevice.
        assert_eq!(
            name_of(&remap(CpalError::new(ErrorKind::BackendError))),
            "NoInputDevice"
        );

        // A permission denial must NOT be downgraded.
        assert_eq!(
            name_of(&remap(CpalError::new(ErrorKind::PermissionDenied))),
            "PermissionDenied"
        );
    }

    // The context is prepended to the underlying error message.
    #[test]
    fn message_includes_context() {
        let err = RecorderError::classify_cpal(
            "Failed to build F32 stream",
            CpalError::new(ErrorKind::DeviceNotAvailable),
        );
        let RecorderError::NoInputDevice { message } = err else {
            panic!("expected NoInputDevice");
        };
        assert!(message.starts_with("Failed to build F32 stream: "));
    }

    // The wire shape the TypeScript side switches on: internally tagged
    // `{ name, message }`, not externally tagged `{ NoInputDevice: { .. } }`.
    #[test]
    fn serializes_as_internally_tagged_name_message() {
        let json = serde_json::to_value(RecorderError::no_input_device("no mic")).unwrap();
        assert_eq!(json["name"], "NoInputDevice");
        assert_eq!(json["message"], "no mic");

        let json = serde_json::to_value(RecorderError::failed("boom")).unwrap();
        assert_eq!(json["name"], "Failed");
        assert_eq!(json["message"], "boom");

        let json = serde_json::to_value(RecorderError::PermissionDenied {
            message: "denied".to_string(),
        })
        .unwrap();
        assert_eq!(json["name"], "PermissionDenied");
        assert_eq!(json["message"], "denied");

        // The two ownership refusals reach TypeScript by name like the rest:
        // `Busy` is what a competing start sees, `NotRecording` is what an
        // idempotent stop of an already-finished recording sees.
        let json = serde_json::to_value(RecorderError::busy("already recording")).unwrap();
        assert_eq!(json["name"], "Busy");
        assert_eq!(json["message"], "already recording");

        let json = serde_json::to_value(RecorderError::not_recording("not yours")).unwrap();
        assert_eq!(json["name"], "NotRecording");
        assert_eq!(json["message"], "not yours");
    }
}

impl From<crate::blobs::BlobError> for RecorderError {
    fn from(error: crate::blobs::BlobError) -> Self {
        Self::failed(error.to_string())
    }
}
