//! One global shortcut, held while the app runs: it starts a recording, and
//! stops the one under way, from any app. The shell only hears the key; the
//! page decides (`whispering://toggle-recording`), exactly as its own button
//! does. Another app already holding the key leaves the shortcut off, never
//! the app.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Emitter, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// The key, in the global-shortcut plugin's spelling.
pub const SHORTCUT: &str = "CommandOrControl+Shift+Semicolon";
/// What the page hears when it is pressed.
pub const EVENT: &str = "whispering://toggle-recording";

/// The global-shortcut plugin, sending each press to the page.
pub fn listener<R: Runtime>() -> TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let _ = app.emit(EVENT, ());
            }
        })
        .build()
}

/// Registers the shortcut once the app is up.
pub fn register<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("whispering-shortcut")
        .setup(|app, _| {
            if let Err(error) = app.global_shortcut().register(SHORTCUT) {
                eprintln!("Whispering's shortcut {SHORTCUT} is unavailable: {error}");
            }
            Ok(())
        })
        .build()
}
