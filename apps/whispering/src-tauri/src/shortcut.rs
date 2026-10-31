//! One global shortcut, held while the app runs: it starts a recording, and
//! stops the one under way, from any app. The shell only hears the key; the
//! page decides (`whispering://toggle-recording`), exactly as its own button
//! does.
//!
//! Which key is a setting (`shortcuts.md`), and Rust never reads a settings
//! note (decision 89): the page resolves it and asks for it with
//! `set_shortcut`, at startup and whenever it changes. Until then no key is
//! held. Another app already holding the key leaves the shortcut off, never
//! the app, and the page says so.

use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

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

/// `accelerator` in the global-shortcut plugin's spelling
/// (`CommandOrControl+Shift+;`), or why it is not a shortcut.
pub fn parse(accelerator: &str) -> Result<Shortcut, String> {
    accelerator
        .parse::<Shortcut>()
        .map_err(|error| format!("{accelerator} is not a shortcut: {error}"))
}

/// Hold `accelerator` as the one global shortcut, in place of the one held
/// before. One that does not parse changes nothing; one another app holds
/// leaves no shortcut held. Asking for the one already held does nothing.
#[tauri::command]
pub fn set_shortcut<R: Runtime>(app: AppHandle<R>, accelerator: String) -> Result<(), String> {
    let shortcut = parse(&accelerator)?;
    let shortcuts = app.global_shortcut();
    if shortcuts.is_registered(shortcut) {
        return Ok(());
    }
    shortcuts
        .unregister_all()
        .map_err(|error| format!("The shortcut held before could not be released: {error}"))?;
    shortcuts
        .register(shortcut)
        .map_err(|error| format!("{accelerator} is unavailable: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The default the page asks for parses, as do the plugin's other
    /// spellings of a key; a key the plugin does not know is refused,
    /// naming what was asked for.
    #[test]
    fn an_accelerator_parses_or_says_why_not() {
        assert_eq!(
            parse("CommandOrControl+Shift+;").unwrap(),
            parse("CmdOrCtrl+Shift+Semicolon").unwrap()
        );
        assert!(parse("Alt+Space").is_ok());
        let refused = parse("Shift+Nope").unwrap_err();
        assert!(
            refused.starts_with("Shift+Nope is not a shortcut"),
            "{refused}"
        );
        assert!(parse("").is_err());
    }
}
