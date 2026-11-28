//! The global shortcuts: keys that reach Whispering from any app.
//!
//! The page says which keys to hold, by name, each time the settings
//! change (`shortcuts_set`), and hears every press and release of one as
//! the event `shortcut`. What a shortcut does is the page's to decide; hold
//! to talk is the release as much as the press. Another app holding the
//! same keys leaves that one shortcut off and says so, never the app.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// What the main window hears for each press and release.
const PRESS: &str = "shortcut";

#[derive(Clone, Serialize)]
struct Press<'a> {
    /// The name the page gave the shortcut.
    name: &'a str,
    /// True as the keys go down, false as they come up.
    down: bool,
}

/// The shortcuts held now, each name with its keys.
#[derive(Default)]
pub struct Held(Mutex<HashMap<String, String>>);

/// Hold exactly the shortcuts in `shortcuts`, each a name and its keys
/// (`Alt+Space`); a name with no keys holds nothing. Answers, by name, why
/// each one that could not be held was not.
///
/// A shortcut already held with the same keys is left alone. Letting keys
/// go and holding them again loses a release under way, and one shortcut
/// (Escape, to cancel) comes and goes while another may be held down.
#[tauri::command]
pub fn shortcuts_set<R: Runtime>(
    app: AppHandle<R>,
    held: State<'_, Held>,
    shortcuts: HashMap<String, String>,
) -> Result<HashMap<String, String>, String> {
    let system = app.global_shortcut();
    let mut held = held
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // Let go of every shortcut that is no longer wanted, or wanted with other keys.
    held.retain(|name, keys| {
        if shortcuts.get(name) == Some(keys) {
            return true;
        }
        match system.unregister(keys.as_str()) {
            Ok(()) => false,
            // Still held by the system, so still listed: the next call
            // tries again, and nothing tries to hold it a second time.
            Err(error) => {
                log::warn!("The shortcut {keys} could not be let go: {error}");
                true
            }
        }
    });
    let mut problems = HashMap::new();
    for (name, keys) in shortcuts {
        if keys.is_empty() || held.get(&name) == Some(&keys) {
            continue;
        }
        if held.contains_key(&name) {
            problems.insert(name, "Its old keys could not be let go.".to_string());
            continue;
        }
        let shortcut = match keys.parse::<Shortcut>() {
            Ok(shortcut) => shortcut,
            Err(error) => {
                problems.insert(name, format!("{keys} is not a shortcut: {error}"));
                continue;
            }
        };
        let pressed = name.clone();
        let registered = system.on_shortcut(shortcut, move |app, _shortcut, event| {
            let press = Press {
                name: &pressed,
                down: event.state == ShortcutState::Pressed,
            };
            let _ = app.emit_to(crate::WINDOW, PRESS, press);
        });
        match registered {
            Ok(()) => {
                held.insert(name, keys);
            }
            Err(error) => {
                log::warn!("The shortcut {keys} could not be held: {error}");
                problems.insert(
                    name,
                    "These keys could not be held. Another app may be using them.".to_string(),
                );
            }
        }
    }
    Ok(problems)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The defaults in `settings.ts`, and what the page writes for a key it
    /// reads from a key press (`shortcut.ts`).
    #[test]
    fn the_shortcuts_the_page_writes_parse() {
        for keys in [
            "CommandOrControl+Shift+Semicolon",
            "Alt+Space",
            "Control+Alt+Shift+Command+KeyA",
            "Command+Digit1",
            "Shift+F5",
            "Control+ArrowUp",
            "Alt+Backquote",
            "Escape",
        ] {
            assert!(keys.parse::<Shortcut>().is_ok(), "{keys} does not parse");
        }
    }
}
