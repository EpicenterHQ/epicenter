//! Microphone access, asked for by the code that opens the microphone.
//!
//! `open_meter` and `start` call [`ensure_access`] before they resolve a
//! device, for every caller, so no page can open a stream macOS has not
//! allowed and none has to remember to ask first. Listing needs no access and
//! does not call it.
//!
//! macOS asks once per install: a person not yet asked sees the system prompt
//! and this waits for the answer; every later call answers the stored
//! decision. Off macOS there is nothing to ask (ADR-0567), and a real denial
//! still arrives from cpal as `PermissionDenied`.

use crate::error::RecorderError;
use crate::recorder::Result;

/// What the system says about microphone access for this process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Access {
    Granted,
    /// Nobody has been asked yet: the one state a request can change.
    NotDetermined,
    /// Denied, or restricted by a policy the person cannot lift from a prompt.
    Denied,
    /// A status this build does not know. cpal's own classification decides.
    Unknown,
}

/// Proceed only with access: `request` is asked only when nobody has been
/// asked yet, and answers whether access was granted.
pub(crate) fn decide(access: Access, request: impl FnOnce() -> bool) -> Result<()> {
    let granted = match access {
        Access::Granted | Access::Unknown => true,
        Access::Denied => false,
        Access::NotDetermined => request(),
    };
    if granted {
        Ok(())
    } else {
        Err(RecorderError::PermissionDenied {
            message: "Microphone access is not allowed for Epicenter".to_string(),
        })
    }
}

/// Make sure this process may open the microphone, asking the person if
/// nobody has yet. Blocks until they answer, so call it off the async runtime.
pub fn ensure_access() -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        macos::ensure_access()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::sync::{mpsc, Mutex};

    use objc2_av_foundation::{
        AVAuthorizationStatus, AVCaptureDevice, AVMediaType, AVMediaTypeAudio,
    };

    use super::{decide, Access};
    use crate::recorder::Result;

    /// Apple's four states on ours. `Restricted` is a policy the person cannot
    /// lift from our prompt, so it is a denial.
    pub(super) fn classify(status: AVAuthorizationStatus) -> Access {
        match status {
            AVAuthorizationStatus::Authorized => Access::Granted,
            AVAuthorizationStatus::Denied | AVAuthorizationStatus::Restricted => Access::Denied,
            AVAuthorizationStatus::NotDetermined => Access::NotDetermined,
            _ => Access::Unknown,
        }
    }

    fn audio() -> Option<&'static AVMediaType> {
        // SAFETY: reading an immutable AVFoundation string constant.
        unsafe { AVMediaTypeAudio }
    }

    pub(super) fn ensure_access() -> Result<()> {
        let Some(audio) = audio() else {
            return Ok(());
        };
        // SAFETY: a thread-safe class method with no side effects.
        let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio) };
        decide(classify(status), || {
            let (sender, receiver) = mpsc::channel();
            // The handler runs on an arbitrary queue and is `Fn`; the first
            // call answers and any later one finds the sender spent.
            let sender = Mutex::new(Some(sender));
            let handler = block2::RcBlock::new(move |granted: objc2::runtime::Bool| {
                if let Some(sender) = sender.lock().ok().and_then(|mut slot| slot.take()) {
                    let _ = sender.send(granted.as_bool());
                }
            });
            // SAFETY: called with the media type it documents and a live block,
            // which AVFoundation retains for as long as it needs it.
            unsafe {
                AVCaptureDevice::requestAccessForMediaType_completionHandler(audio, &handler);
            }
            // A handler dropped without answering grants nothing.
            receiver.recv().unwrap_or(false)
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// Apple's raw values are an ABI contract, so they are spelled out.
        #[test]
        fn every_avfoundation_status_folds_into_one_access() {
            assert_eq!(classify(AVAuthorizationStatus(0)), Access::NotDetermined);
            assert_eq!(classify(AVAuthorizationStatus(1)), Access::Denied);
            assert_eq!(classify(AVAuthorizationStatus(2)), Access::Denied);
            assert_eq!(classify(AVAuthorizationStatus(3)), Access::Granted);
            assert_eq!(classify(AVAuthorizationStatus(4)), Access::Unknown);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(result: Result<()>) -> bool {
        matches!(result, Err(RecorderError::PermissionDenied { .. }))
    }

    #[test]
    fn only_a_person_not_yet_asked_is_asked_and_only_a_grant_proceeds() {
        let never = || -> bool { panic!("asked although the answer is known") };
        assert!(decide(Access::Granted, never).is_ok());
        assert!(decide(Access::Unknown, never).is_ok());
        assert!(refused(decide(Access::Denied, never)));
        assert!(decide(Access::NotDetermined, || true).is_ok());
        assert!(refused(decide(Access::NotDetermined, || false)));
    }
}
