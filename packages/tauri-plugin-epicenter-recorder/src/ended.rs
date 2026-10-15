//! Why a recording ended without anyone asking it to.
//!
//! The capture stream can die under a live recording: the microphone is
//! unplugged, macOS revokes microphone access mid-dictation, the audio route
//! collapses. Before this existed, cpal's error callback only logged, so the
//! recorder kept its one slot occupied, the tray kept claiming a recording, and
//! the owning window waited forever for audio that would never arrive.
//!
//! What ends is the capture, not the recording. The reason below travels to the
//! owner so it can say something true about what happened; the audio captured up
//! to that moment is already in its file, and stays the owner's to stop or
//! cancel.
//!
//! # The taxonomy is exactly as fine as cpal's evidence
//!
//! Every variant below is one the host can actually tell apart from a typed
//! `cpal::ErrorKind`, and each maps to a different thing the person can do.
//! Nothing here is inferred from a message string, and nothing distinguishes
//! two situations the host would have to guess between.
//!
//! # Not every stream error is terminal
//!
//! This is the part that is easy to get wrong. cpal reports routine, survivable
//! conditions through the same callback as fatal ones, and it documents which
//! is which. `DeviceChanged` explicitly says the stream stays active and needs
//! no rebuild, which is what happens when headphones are plugged in mid
//! sentence. `Xrun` is a glitched buffer. `RealtimeDenied` means audio keeps
//! flowing with worse scheduling. Ending a recording on any of those would
//! destroy a dictation over an event the user would otherwise never notice, so
//! [`classify`] returns `None` for them and the capture continues.

use serde::{Deserialize, Serialize};

/// Why the host ended a recording's capture on its own.
///
/// This never describes a stop, a cancel, or an owner window being destroyed.
/// Those are endings someone asked for, and the caller already knows about them
/// from its own call returning.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum EndedReason {
    /// The microphone went away while recording (`ErrorKind::DeviceNotAvailable`).
    /// The recovery is physical: reconnect it, or pick another input.
    DeviceDisconnected,
    /// The OS withdrew microphone access mid-recording
    /// (`ErrorKind::PermissionDenied`). The device is still there and still
    /// works; the recovery is a permission toggle, which is why this is not
    /// folded into `DeviceDisconnected`.
    PermissionRevoked,
    /// The capture stream failed for a reason the host cannot make actionable:
    /// the configuration was invalidated, the audio host vanished, a resource
    /// limit was hit, or the backend reported something cpal could not classify.
    /// One variant rather than five, because the person does the same thing
    /// about all of them.
    StreamFailed,
    /// The recording's file could not be written any further: the disk filled, its
    /// volume went away, or the recording reached the longest audio a WAV can
    /// describe (about 12 hours of mono capture).
    ///
    /// Kept apart from `StreamFailed` because the microphone is fine and the
    /// remedy is on the machine, not the hardware. The three storage causes are
    /// *not* kept apart from each other: whichever one it was, the recording is
    /// capped at what already reached disk and the next step is the same, so a
    /// finer split would be a decorative name on a message string.
    StorageFailed,
}

/// Classify a live-stream error, or `None` when the stream survives it.
///
/// `None` is the important half of this function: it is what keeps a routine
/// audio-route change from ending a recording.
pub fn classify(error: &cpal::Error) -> Option<EndedReason> {
    use cpal::ErrorKind;
    match error.kind() {
        // Documented as survivable by cpal, so the capture keeps running.
        ErrorKind::DeviceChanged | ErrorKind::Xrun | ErrorKind::RealtimeDenied => None,
        ErrorKind::DeviceNotAvailable | ErrorKind::DeviceBusy => {
            Some(EndedReason::DeviceDisconnected)
        }
        ErrorKind::PermissionDenied => Some(EndedReason::PermissionRevoked),
        _ => Some(EndedReason::StreamFailed),
    }
}

/// What the recorder tells the page that started a recording, over the channel
/// it passed to `start`: the microphone's level while it captures, and once,
/// if it happens, that the capture ended without being asked.
///
/// The channel belongs to that page alone, so nothing here names the window.
/// Both are signals, never results: an ending carries no audio, because the
/// recording is still the owner's and `stop` finalizes what it captured.
/// Missing one costs nothing; a page that reloads has already had its
/// recording finalized.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RecordingSignal {
    /// The root mean square of the samples since the last level, from 0 to 1.
    Level { level: f32 },
    /// The host ended the capture on its own, and why.
    Ended { reason: EndedReason },
}

#[cfg(test)]
mod tests {
    use super::*;
    use cpal::{Error as CpalError, ErrorKind};

    /// The regression this module exists to prevent: plugging in headphones
    /// mid-dictation raises `DeviceChanged`, and cpal documents the stream as
    /// still active. Ending the recording there would be a data-loss bug that
    /// only shows up on real hardware.
    #[test]
    fn survivable_stream_errors_do_not_end_the_recording() {
        for kind in [
            ErrorKind::DeviceChanged,
            ErrorKind::Xrun,
            ErrorKind::RealtimeDenied,
        ] {
            assert_eq!(
                classify(&CpalError::new(kind)),
                None,
                "{kind:?} must not end a recording"
            );
        }
    }

    #[test]
    fn a_vanished_microphone_reads_as_disconnected() {
        for kind in [ErrorKind::DeviceNotAvailable, ErrorKind::DeviceBusy] {
            assert_eq!(
                classify(&CpalError::new(kind)),
                Some(EndedReason::DeviceDisconnected)
            );
        }
    }

    /// Kept apart from `DeviceDisconnected` because the recovery differs: the
    /// microphone is present and working, and the fix is a permission toggle.
    #[test]
    fn a_withdrawn_grant_reads_as_permission_revoked() {
        assert_eq!(
            classify(&CpalError::new(ErrorKind::PermissionDenied)),
            Some(EndedReason::PermissionRevoked)
        );
    }

    #[test]
    fn everything_else_terminal_collapses_to_stream_failed() {
        for kind in [
            ErrorKind::StreamInvalidated,
            ErrorKind::HostUnavailable,
            ErrorKind::ResourceExhausted,
            ErrorKind::BackendError,
            ErrorKind::UnsupportedConfig,
            ErrorKind::Other,
        ] {
            assert_eq!(
                classify(&CpalError::new(kind)),
                Some(EndedReason::StreamFailed),
                "{kind:?} should collapse to StreamFailed"
            );
        }
    }

    #[test]
    fn signals_cross_the_wire_tagged_by_kind() {
        let json = serde_json::to_value(RecordingSignal::Ended {
            reason: EndedReason::DeviceDisconnected,
        })
        .unwrap();
        assert_eq!(json["kind"], "ended");
        assert_eq!(json["reason"], "deviceDisconnected");
        let json = serde_json::to_value(RecordingSignal::Level { level: 0.5 }).unwrap();
        assert_eq!(json["kind"], "level");
        assert_eq!(json["level"], 0.5);
    }
}
