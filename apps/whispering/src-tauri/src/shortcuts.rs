//! The global shortcuts: keys that reach Whispering from any app.
//!
//! The page says which keys to hold, by name, each time the settings
//! change (`shortcuts_set`), and hears every press and release of one as
//! the event `shortcut`. What a shortcut does is the page's to decide; hold
//! to talk is the release as much as the press. Another app holding the
//! same keys leaves that one shortcut off and says so, never the app.

use std::collections::HashMap;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};
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

/// Hold exactly the shortcuts in `shortcuts`, each a name and its keys
/// (`Alt+Space`); a name with no keys holds nothing. Answers, by name, why
/// each one that could not be held was not.
#[tauri::command]
pub fn shortcuts_set<R: Runtime>(
    app: AppHandle<R>,
    shortcuts: HashMap<String, String>,
) -> Result<HashMap<String, String>, String> {
    let held = app.global_shortcut();
    held.unregister_all()
        .map_err(|error| format!("The shortcuts could not be let go: {error}"))?;
    let mut problems = HashMap::new();
    for (name, keys) in shortcuts {
        if keys.is_empty() {
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
        let registered = held.on_shortcut(shortcut, move |app, _shortcut, event| {
            let press = Press {
                name: &pressed,
                down: event.state == ShortcutState::Pressed,
            };
            let _ = app.emit_to(crate::WINDOW, PRESS, press);
        });
        if let Err(error) = registered {
            log::warn!("The shortcut {keys} could not be held: {error}");
            problems.insert(
                name,
                "These keys could not be held. Another app may be using them.".to_string(),
            );
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
        ] {
            assert!(keys.parse::<Shortcut>().is_ok(), "{keys} does not parse");
        }
    }
}
