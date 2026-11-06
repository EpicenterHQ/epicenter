//! Starting at login (ADR-0819): Epicenter keeps every folder in sync while
//! it runs, so it starts when the person logs in, a setting on by default.
//! The operating system's login item is the setting itself
//! (`tauri-plugin-autostart`: a launch agent on macOS), so nothing else
//! keeps it. On a release build's first start the app turns it on and leaves
//! a mark in its data saying it did, so a person who turns it off is not
//! overruled at the next start. A development build never turns it on by
//! itself: it would start a build from a working copy at every login.
//!
//! The login item starts the app with `AT_LOGIN`, and the app then opens its
//! Folders window unseen (`hidden_window` in `lib.rs`).

use std::path::Path;

use tauri::{AppHandle, Runtime};
use tauri_plugin_autostart::ManagerExt;

/// The argument the login item starts the app with.
pub const AT_LOGIN: &str = "--at-login";

/// The mark, in the app's data, that the default was applied.
const DEFAULTED: &str = "start-at-login.defaulted";

/// Whether this process was started by the login item.
pub fn launched_at_login() -> bool {
    std::env::args().any(|argument| argument == AT_LOGIN)
}

/// On the first start of a release build, turn starting at login on, once.
pub fn start_by_default<R: Runtime>(app: &AppHandle<R>, app_data: &Path) {
    let mark = app_data.join(DEFAULTED);
    if cfg!(debug_assertions) || mark.exists() {
        return;
    }
    if let Err(error) = app.autolaunch().enable() {
        log::warn!("Epicenter could not start at login: {error}");
        return;
    }
    let written = std::fs::create_dir_all(app_data).and_then(|()| std::fs::write(&mark, ""));
    if let Err(error) = written {
        log::warn!("{} could not be written: {error}", mark.display());
    }
}

/// Whether Epicenter starts when the person logs in.
#[tauri::command]
#[specta::specta]
pub fn start_at_login(app: crate::DesktopAppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|error| error.to_string())
}

/// Start Epicenter when the person logs in, or stop doing so.
#[tauri::command]
#[specta::specta]
pub fn set_start_at_login(app: crate::DesktopAppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable()
    } else {
        manager.disable()
    }
    .map_err(|error| error.to_string())
}
