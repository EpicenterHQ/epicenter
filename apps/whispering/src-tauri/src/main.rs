//! Whispering's desktop window. Recordings live in `recordings/` in the
//! app's local data directory, which the person cannot move: the native
//! recorder writes `<id>.webm` there from the first second, and the page
//! writes `<id>.md` beside it through `tauri-plugin-fs`. Both check the file
//! system scope, which allows only that directory. A second launch focuses
//! the open window, so the app is the directory's one writer.
//!
//! Transcription runs here too (`transcribe.rs`), with the server's API key
//! read from the Keychain (`keys.rs`), and one fixed global shortcut asks the
//! page to start or stop a recording.

// Keeps a console window from opening beside the app in a Windows release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod keys;
mod recordings;
mod transcribe;

use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_fs::FsExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// The window's label, which the capability selects.
const WINDOW: &str = "main";

/// The global shortcut that starts and stops a recording from any app: ⌘⇧; on a Mac.
const SHORTCUT: &str = "CommandOrControl+Shift+Semicolon";
/// What the window hears when the shortcut is pressed; the page decides what it does.
const TOGGLE_RECORDING: &str = "toggle-recording";

fn main() {
    tauri::Builder::default()
        // First, so a second launch stops before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| focus(app)))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_epicenter_recorder::init())
        .setup(|app| Ok(start(app.handle())?))
        .invoke_handler(tauri::generate_handler![
            recordings::recordings_list,
            keys::key_set,
            keys::key_exists,
            transcribe::transcribe
        ])
        .run(tauri::generate_context!())
        .expect("Whispering could not start");
}

/// Make the data directory, allow it in the file system scope, then open
/// the window. The recorder records into a folder the scope allows, and the
/// file system plugin's commands check the same scope. The asset protocol,
/// which the page's audio player streams from, may read `recordings/` only.
fn start<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let folder = recordings::dir(app)?;
    std::fs::create_dir_all(&folder)
        .map_err(|error| format!("{} could not be made: {error}", folder.display()))?;
    let data = folder.parent().unwrap_or(&folder).to_path_buf();
    app.fs_scope()
        .allow_directory(&data, true)
        .map_err(|error| format!("{} could not be opened: {error}", data.display()))?;
    app.asset_protocol_scope()
        .allow_directory(&folder, false)
        .map_err(|error| format!("{} could not be opened: {error}", folder.display()))?;
    WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::default())
        .title("Whispering")
        .inner_size(900.0, 720.0)
        .min_inner_size(400.0, 400.0)
        .build()
        .map_err(|error| format!("The window could not open: {error}"))?;
    listen_for_shortcut(app);
    Ok(())
}

/// Hold the global shortcut, sending each press to the window. Another app
/// holding it leaves the shortcut off, never the app: Record still works.
fn listen_for_shortcut<R: Runtime>(app: &AppHandle<R>) {
    let held = app
        .global_shortcut()
        .on_shortcut(SHORTCUT, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let _ = app.emit_to(WINDOW, TOGGLE_RECORDING, ());
            }
        });
    if let Err(error) = held {
        log::warn!("The shortcut {SHORTCUT} could not be held: {error}");
    }
}

/// Bring the open window forward, for a second launch.
fn focus<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shortcut_parses() {
        assert!(SHORTCUT
            .parse::<tauri_plugin_global_shortcut::Shortcut>()
            .is_ok());
    }
}
