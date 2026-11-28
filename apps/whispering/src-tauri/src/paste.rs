//! Paste at the cursor: press the paste keys (⌘V on a Mac, Ctrl+V
//! elsewhere) in whatever app is in front, after the page has put the text
//! on the clipboard. The clipboard is always written first and never
//! restored, so a paste that does not land costs the person one ⌘V.
//!
//! On a Mac a made-up key press reaches other apps only with the
//! Accessibility permission. Without it the press is dropped and nothing
//! says so, so `paste` asks macOS first (`AXIsProcessTrusted`) and refuses
//! when it is not granted; it never reports a paste it could not make.
//! A grant that went stale after an update can still read as trusted while
//! macOS drops the press: that one case reports a paste that did not land,
//! and the text is on the clipboard all the same.

use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use tauri::{AppHandle, Runtime};

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    /// Whether this process may control the computer (Accessibility).
    fn AXIsProcessTrusted() -> u8;
    /// The same, and with the prompt option, has macOS ask the person and
    /// list this app under Accessibility so it can be switched on there.
    fn AXIsProcessTrustedWithOptions(
        options: core_foundation_sys::dictionary::CFDictionaryRef,
    ) -> u8;
    /// The option's key: a boolean, whether to prompt.
    static kAXTrustedCheckOptionPrompt: core_foundation_sys::string::CFStringRef;
}

/// Have macOS ask for Accessibility and add Whispering to its list. Until
/// this runs once, the list in System Settings does not show the app at
/// all, and there is nothing there to switch on.
#[cfg(target_os = "macos")]
fn prompt_for_accessibility() {
    use core_foundation_sys::base::{kCFAllocatorDefault, CFRelease};
    use core_foundation_sys::dictionary::{
        kCFTypeDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks, CFDictionaryCreate,
    };
    use core_foundation_sys::number::kCFBooleanTrue;
    // SAFETY: a one-entry dictionary of two CoreFoundation constants, made,
    // read by the call, and released here.
    unsafe {
        let keys = [kAXTrustedCheckOptionPrompt.cast::<std::ffi::c_void>()];
        let values = [kCFBooleanTrue.cast::<std::ffi::c_void>()];
        let options = CFDictionaryCreate(
            kCFAllocatorDefault,
            keys.as_ptr(),
            values.as_ptr(),
            1,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        );
        AXIsProcessTrustedWithOptions(options);
        CFRelease(options.cast());
    }
}

/// Where System Settings lists the apps allowed Accessibility.
#[cfg(target_os = "macos")]
const ACCESSIBILITY_SETTINGS: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

/// Whether a paste can land: on a Mac, whether Accessibility is granted now.
/// Windows and Linux need no permission.
#[tauri::command]
pub fn paste_allowed() -> bool {
    #[cfg(target_os = "macos")]
    // SAFETY: a C function that takes nothing and reads the process's grant.
    return unsafe { AXIsProcessTrusted() } != 0;
    #[cfg(not(target_os = "macos"))]
    true
}

/// Ask for the permission and open the place the person grants it: macOS
/// lists Whispering under Accessibility, and System Settings opens there.
/// Elsewhere there is nothing to allow.
#[tauri::command]
pub fn paste_ask<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_opener::OpenerExt;
        if !paste_allowed() {
            prompt_for_accessibility();
        }
        app.opener()
            .open_url(ACCESSIBILITY_SETTINGS, None::<&str>)
            .map_err(|error| format!("System Settings could not be opened: {error}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(())
    }
}

/// Press the paste keys in the app in front. Refused when macOS has not
/// allowed it, since the press would be dropped without a word.
#[tauri::command]
pub async fn paste() -> Result<(), String> {
    if !paste_allowed() {
        return Err("macOS has not allowed Whispering to paste.".to_string());
    }
    let mut enigo = Enigo::new(&Settings::default()).map_err(|error| error.to_string())?;
    // Key codes, not characters: the V key pastes on every keyboard layout.
    #[cfg(target_os = "macos")]
    let (modifier, v) = (Key::Meta, Key::Other(9));
    #[cfg(target_os = "windows")]
    let (modifier, v) = (Key::Control, Key::Other(0x56));
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let (modifier, v) = (Key::Control, Key::Unicode('v'));

    // Every press and release is sent even after one fails, so a failure
    // never leaves the modifier held down.
    let modifier_down = enigo.key(modifier, Direction::Press);
    let v_down = enigo.key(v, Direction::Press);
    let v_up = enigo.key(v, Direction::Release);
    let modifier_up = enigo.key(modifier, Direction::Release);
    modifier_down
        .and(v_down)
        .and(v_up)
        .and(modifier_up)
        .map_err(|error| format!("The paste keys could not be pressed: {error}"))
}
