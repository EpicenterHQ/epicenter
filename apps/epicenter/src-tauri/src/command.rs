#[cfg(target_os = "macos")]
use std::process::Command;

#[cfg(target_os = "macos")]
use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaType, AVMediaTypeAudio};

/// Open macOS Accessibility settings.
///
/// This is intentionally a fixed command instead of a general command
/// runner. The app only needs this one OS handoff, so the frontend should
/// not receive shell or process execution privileges.
#[tauri::command]
#[specta::specta]
pub async fn open_accessibility_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Deep-link straight to Privacy & Security > Accessibility. This
        // `x-apple.systempreferences:` scheme is honored by System Settings from
        // Ventura through Sequoia; the older `x-apple.systemsettings:` form was
        // not claimed by any app and failed with kLSApplicationNotFoundErr, so
        // the button only ever hit its manual-instructions fallback.
        let status = Command::new("/usr/bin/open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .status()
            .map_err(|e| format!("Failed to open accessibility settings: {}", e))?;

        if status.success() {
            return Ok(());
        }

        return Err(format!(
            "Failed to open accessibility settings: exit code {:?}",
            status.code()
        ));
    }

    // Off macOS there is no such pane; the nudge is a no-op, not a failure (the
    // only caller is the macOS Accessibility guide, which never opens elsewhere).
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

/// Show the macOS Accessibility permission prompt.
///
/// macOS never lets an app grant itself Accessibility, so this only surfaces the
/// system prompt (which also adds the app to the Accessibility list, toggled
/// off); the live grant is observed by the Rust tap supervisor, not returned
/// here. Off macOS there is no such prompt, so this does nothing. Pairs with
/// `open_accessibility_settings` the way `request_microphone_permission` does
/// with the microphone privacy page.
#[tauri::command]
#[specta::specta]
pub async fn request_accessibility_permission() {
    #[cfg(target_os = "macos")]
    {
        use core_foundation::base::TCFType;
        use core_foundation::boolean::CFBoolean;
        use core_foundation::dictionary::CFDictionary;
        use core_foundation::string::CFString;

        // `AXIsProcessTrusted` (the keyboard tap's probe) never prompts; the
        // `WithOptions` form does, and only when handed
        // `kAXTrustedCheckOptionPrompt: true`. It returns the current trust
        // immediately and raises the prompt out of band, so there is nothing to
        // await and nothing truthful to return: the grant lands later, in
        // System Settings, and is observed by the tap supervisor.
        // SAFETY: `kAXTrustedCheckOptionPrompt` is an immutable Core Foundation
        // string constant, and `AXIsProcessTrustedWithOptions` is a thread-safe
        // TCC query over a dictionary we own for the length of the call.
        let prompt_key = unsafe {
            CFString::wrap_under_get_rule(accessibility_sys::kAXTrustedCheckOptionPrompt)
        };
        let options = CFDictionary::from_CFType_pairs(&[(
            prompt_key.as_CFType(),
            CFBoolean::true_value().as_CFType(),
        )]);
        unsafe {
            accessibility_sys::AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef());
        }
    }
}

/// The OS-level microphone authorization, read from the platform privacy store.
///
/// Only `Granted` and `Unknown` are usable. `Unknown` (no entry in the store, or
/// a platform with no such gate) means "can't tell from here": the caller treats
/// it as available and lets the recorder's stream-open fallback
/// (`RecorderError::classify_cpal` in `tauri-plugin-epicenter-recorder`)
/// classify any real denial from the error itself. So this signal can only
/// *add* a pre-record denial; it never newly blocks a setup that was already
/// working.
///
/// `NotDetermined` is the one state that is neither usable nor final: the user
/// has not been asked yet. It is not `Unknown` (we know exactly what the OS
/// thinks) and not `Denied` (nothing has been refused). It exists so
/// `request_microphone_permission` can tell the one state that can still raise a
/// system prompt from the states where prompting is a silent no-op.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MicrophonePermission {
    Granted,
    Denied,
    NotDetermined,
    Unknown,
}

/// Fold an AVFoundation authorization status into what this app acts on.
///
/// Apple's four states land on three of ours. `Restricted` is a device policy
/// the user cannot lift from our prompt, which makes it a denial from the
/// recorder's point of view, so it folds into `Denied`. `Unknown` is not one of
/// them: on macOS it is reserved for a value Apple adds later, which reads
/// "can't tell from here" and leaves the stream-open fallback as the sole
/// classifier instead of being guessed into a block.
///
/// This takes the generated `AVAuthorizationStatus` rather than a raw integer on
/// purpose. That type is `#[repr(transparent)]` over `NSInteger`, so the ABI
/// width comes from the binding and a truncating read is not expressible here.
#[cfg(target_os = "macos")]
fn classify_authorization_status(status: AVAuthorizationStatus) -> MicrophonePermission {
    match status {
        AVAuthorizationStatus::Authorized => MicrophonePermission::Granted,
        AVAuthorizationStatus::Denied | AVAuthorizationStatus::Restricted => {
            MicrophonePermission::Denied
        }
        AVAuthorizationStatus::NotDetermined => MicrophonePermission::NotDetermined,
        _ => MicrophonePermission::Unknown,
    }
}

/// The AVFoundation audio media-type constant both microphone calls key on.
///
/// It is an `Option` because the binding models a linked extern static. If
/// AVFoundation ever failed to provide it, callers report `Unknown` rather than
/// crashing the host over a permission read.
#[cfg(target_os = "macos")]
fn audio_media_type() -> Option<&'static AVMediaType> {
    // SAFETY: reading an immutable AVFoundation string constant.
    unsafe { AVMediaTypeAudio }
}

/// The current AVFoundation microphone authorization for this process.
#[cfg(target_os = "macos")]
fn macos_microphone_permission() -> MicrophonePermission {
    let Some(media_type) = audio_media_type() else {
        return MicrophonePermission::Unknown;
    };
    // SAFETY: a thread-safe AVFoundation class method with no side effects,
    // called with the audio media type it documents as valid.
    let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media_type) };
    classify_authorization_status(status)
}

/// Read the microphone authorization the OS records up front.
///
/// One owner for every platform. macOS reads AVFoundation's
/// `authorizationStatusForMediaType:` directly, so all four Apple states arrive
/// intact and a not-yet-asked user is reported as `NotDetermined` instead of
/// being flattened into a denial. Windows reads the CapabilityAccessManager
/// ConsentStore. Every other platform (Linux) returns `Unknown`, where there is
/// no such store and the stream-open fallback stays the sole classifier.
#[tauri::command]
#[specta::specta]
pub async fn get_microphone_permission() -> MicrophonePermission {
    #[cfg(target_os = "macos")]
    {
        macos_microphone_permission()
    }
    #[cfg(target_os = "windows")]
    {
        windows_microphone_permission()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        MicrophonePermission::Unknown
    }
}

/// Windows records the microphone privacy choice as an `"Allow"`/`"Deny"` string
/// under CapabilityAccessManager\ConsentStore. Three scopes gate a desktop app:
/// the machine default (HKLM), the per-user default (HKCU), and the "let desktop
/// apps access the microphone" toggle (HKCU\...\NonPackaged). A deny in any one
/// blocks us, so report `Denied` if any is explicitly deny, `Granted` only when
/// all three explicitly allow, and `Unknown` otherwise: the keys are absent on
/// many installs, and a missing entry must not be read as a denial.
#[cfg(target_os = "windows")]
fn windows_microphone_permission() -> MicrophonePermission {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::{RegKey, HKEY};

    const MICROPHONE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
    const NON_PACKAGED: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged";

    // `Some(true)` allow, `Some(false)` deny, `None` no readable entry.
    fn access(root: HKEY, path: &str) -> Option<bool> {
        let value: String = RegKey::predef(root)
            .open_subkey(path)
            .ok()?
            .get_value("Value")
            .ok()?;
        match value.to_ascii_lowercase().as_str() {
            "allow" => Some(true),
            "deny" => Some(false),
            _ => None,
        }
    }

    let scopes = [
        access(HKEY_LOCAL_MACHINE, MICROPHONE),
        access(HKEY_CURRENT_USER, MICROPHONE),
        access(HKEY_CURRENT_USER, NON_PACKAGED),
    ];

    if scopes.iter().any(|scope| *scope == Some(false)) {
        MicrophonePermission::Denied
    } else if scopes.iter().all(|scope| *scope == Some(true)) {
        MicrophonePermission::Granted
    } else {
        MicrophonePermission::Unknown
    }
}

/// Elicit a microphone grant the way each platform allows, and answer with the
/// authorization that holds once there is nothing left to elicit.
///
/// Returning the status is what lets the caller ask once. macOS is the only
/// platform that can move the answer inside this call: when the status is
/// `NotDetermined` it raises the system prompt and awaits the real completion
/// handler, so the returned value is the user's decision, not a guess. Every
/// other status is already final, so prompting is a documented no-op and the
/// call short-circuits.
///
/// Windows has no programmatic grant for an unpackaged desktop app, so a
/// `Denied` consent store deep-links the privacy page and reports `Denied`: the
/// toggle happens in Settings, outside this call. Other platforms (Linux) have
/// no such affordance and report `Unknown`.
#[tauri::command]
#[specta::specta]
pub async fn request_microphone_permission() -> Result<MicrophonePermission, String> {
    #[cfg(target_os = "macos")]
    {
        // Only a not-yet-asked user can be prompted. macOS shows the prompt at
        // most once per install, so for every other status
        // `requestAccessForMediaType:` just replays the stored decision.
        let status = macos_microphone_permission();
        if status != MicrophonePermission::NotDetermined {
            return Ok(status);
        }
        let Some(media_type) = audio_media_type() else {
            return Ok(MicrophonePermission::Unknown);
        };

        let (sender, receiver) = tokio::sync::oneshot::channel();
        {
            // The block is `Fn`, not `FnOnce`, and AVFoundation documents the
            // handler as called on an arbitrary dispatch queue. The `Mutex`
            // makes that safe and makes the first call the only one that
            // answers, so a double invocation cannot panic on a spent sender.
            let sender = std::sync::Mutex::new(Some(sender));
            let handler = block2::RcBlock::new(move |granted: objc2::runtime::Bool| {
                let Some(sender) = sender.lock().ok().and_then(|mut slot| slot.take()) else {
                    return;
                };
                let _ = sender.send(granted.as_bool());
            });
            // SAFETY: an AVFoundation class method called with the audio media
            // type it documents as valid and a live block. The call is
            // non-blocking and AVFoundation retains the block for as long as it
            // needs it, so the local `RcBlock` may drop at the end of this
            // scope. Scoping it there also keeps it off the await below, which
            // is what keeps this command future `Send`.
            unsafe {
                AVCaptureDevice::requestAccessForMediaType_completionHandler(media_type, &handler);
            }
        }

        match receiver.await {
            Ok(true) => Ok(MicrophonePermission::Granted),
            Ok(false) => Ok(MicrophonePermission::Denied),
            // The handler was dropped without firing. Re-reading is both the
            // truthful answer and the terminating one: the TCC store is the
            // authority either way, so there is nothing to wait for or retry.
            Err(_) => Ok(macos_microphone_permission()),
        }
    }
    #[cfg(target_os = "windows")]
    {
        let status = windows_microphone_permission();
        if status == MicrophonePermission::Denied {
            open_windows_microphone_settings()?;
        }
        Ok(status)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok(MicrophonePermission::Unknown)
    }
}

/// Deep-link the Windows microphone privacy page so the user can toggle access.
#[cfg(target_os = "windows")]
fn open_windows_microphone_settings() -> Result<(), String> {
    use std::process::Command;
    // `ms-settings:` URIs are launched by the shell, not run directly; go
    // through `cmd /C start` so the OS resolves the privacy-microphone page.
    Command::new("cmd")
        .args(["/C", "start", "", "ms-settings:privacy-microphone"])
        .spawn()
        .map_err(|e| format!("Failed to open microphone privacy settings: {e}"))?;
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    /// The four states AVFoundation actually reports, plus the one it does not.
    ///
    /// The raw values are spelled out because they are an Apple ABI contract, not
    /// our choice: a binding that silently renumbered them would change what the
    /// app believes about a real user's privacy settings.
    #[test]
    fn every_avfoundation_status_folds_into_one_the_app_acts_on() {
        assert_eq!(
            classify_authorization_status(AVAuthorizationStatus(0)),
            MicrophonePermission::NotDetermined,
            "nobody has been asked yet, which is the only promptable state"
        );
        assert_eq!(
            classify_authorization_status(AVAuthorizationStatus(1)),
            MicrophonePermission::Denied,
            "Restricted is a policy the user cannot lift from our prompt"
        );
        assert_eq!(
            classify_authorization_status(AVAuthorizationStatus(2)),
            MicrophonePermission::Denied
        );
        assert_eq!(
            classify_authorization_status(AVAuthorizationStatus(3)),
            MicrophonePermission::Granted
        );
        assert_eq!(
            classify_authorization_status(AVAuthorizationStatus(4)),
            MicrophonePermission::Unknown,
            "a status this build does not know must not be guessed into a block"
        );
    }

    /// The constants and the numbers have to be the same fact, or the test above
    /// is checking a table nobody reads.
    #[test]
    fn the_generated_constants_carry_apples_numbering() {
        assert_eq!(
            AVAuthorizationStatus::NotDetermined,
            AVAuthorizationStatus(0)
        );
        assert_eq!(AVAuthorizationStatus::Restricted, AVAuthorizationStatus(1));
        assert_eq!(AVAuthorizationStatus::Denied, AVAuthorizationStatus(2));
        assert_eq!(AVAuthorizationStatus::Authorized, AVAuthorizationStatus(3));
    }
}
