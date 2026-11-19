//! Whispering's desktop window. Recordings live in `recordings/` in the
//! app's local data directory, which the person cannot move: the native
//! recorder writes `<id>.webm` there from the first second, and the page
//! writes `<id>.md` beside it through `tauri-plugin-fs`. Both check the file
//! system scope, which allows only that directory. A second launch focuses
//! the open window, so the app is the directory's one writer.
//!
//! Transcription runs here too (`transcribe.rs`), with the server's API key
//! read from the Keychain (`keys.rs`).

// Keeps a console window from opening beside the app in a Windows release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod keys;
mod recordings;
mod transcribe;

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_fs::FsExt;

/// The window's label, which the capability selects.
const WINDOW: &str = "main";

fn main() {
    tauri::Builder::default()
        // First, so a second launch stops before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| focus(app)))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_epicenter_recorder::init())
        .setup(|app| Ok(start(app.handle())?))
        .invoke_handler(tauri::generate_handler![
            recordings_list,
            keys::key_set,
            keys::key_exists,
            transcribe::transcribe
        ])
        .run(tauri::generate_context!())
        .expect("Whispering could not start");
}

/// Make the data directory, allow it in the file system scope, then open
/// the window. The recorder records into a folder the scope allows, and the
/// file system plugin's commands check the same scope.
fn start<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let data = app.path().app_local_data_dir().map_err(|error| {
        format!("The system did not say where Whispering keeps its files: {error}")
    })?;
    std::fs::create_dir_all(data.join("recordings"))
        .map_err(|error| format!("{} could not be made: {error}", data.display()))?;
    app.fs_scope()
        .allow_directory(&data, true)
        .map_err(|error| format!("{} could not be opened: {error}", data.display()))?;
    WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::default())
        .title("Whispering")
        .inner_size(900.0, 720.0)
        .min_inner_size(400.0, 400.0)
        .build()
        .map_err(|error| format!("The window could not open: {error}"))?;
    Ok(())
}

/// Every recording in `recordings/`: its note's text and whether its audio is there.
#[tauri::command]
async fn recordings_list<R: Runtime>(app: AppHandle<R>) -> Result<Vec<recordings::Listed>, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("recordings");
    tauri::async_runtime::spawn_blocking(move || recordings::list(&dir))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

/// Bring the open window forward, for a second launch.
fn focus<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
