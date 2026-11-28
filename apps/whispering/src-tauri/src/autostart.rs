//! Launch at login: whether the system opens Whispering when the person
//! logs in. The system holds the answer (a login item on a Mac), so it is
//! not in `settings.json`, and these two commands ask and change it there.
//! Opened that way, Whispering starts with its window hidden
//! ([`HIDDEN`]): the shortcuts work, and the window comes from the Dock.

use tauri::{AppHandle, Runtime};
use tauri_plugin_autostart::ManagerExt;

/// What the system passes when it opens Whispering at login.
pub const HIDDEN: &str = "--hidden";

/// Whether the system opens Whispering at login.
#[tauri::command]
pub fn autostart_enabled<R: Runtime>(app: AppHandle<R>) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// Have the system open Whispering at login, or stop it.
#[tauri::command]
pub fn autostart_set<R: Runtime>(app: AppHandle<R>, on: bool) -> Result<(), String> {
    let launcher = app.autolaunch();
    let changed = if on {
        launcher.enable()
    } else {
        launcher.disable()
    };
    changed.map_err(|error| format!("The system would not change it: {error}"))
}
