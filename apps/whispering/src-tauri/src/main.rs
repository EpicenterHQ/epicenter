//! Whispering's desktop window. Recordings live in `recordings/` in the
//! app's local data directory, which the person cannot move: the native
//! recorder writes `<id>.webm` there from the first second, and the page
//! writes `<id>.md` beside it through `tauri-plugin-fs`. Both check the file
//! system scope, which allows only that directory. A second launch focuses
//! the open window, so the app is the directory's one writer.
//!
//! Requests to the person's servers run here too (`servers.rs`), with each
//! server's API key read from the Keychain (`keys.rs`), and the global shortcuts the page
//! names reach it from any app (`shortcuts.rs`). A second, small window floats the
//! pill over every app while a take is under way (`pill.rs`). A recording
//! can also be transcribed on this computer (`local.rs`).

// Keeps a console window from opening beside the app in a Windows release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod files;
mod keys;
mod local;
mod pill;
mod servers;
mod shortcuts;

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_fs::FsExt;

/// The window's label, which the capability selects.
pub(crate) const WINDOW: &str = "main";

fn main() {
    let builder = tauri::Builder::default();
    // The pill's window is a panel that never activates the app.
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());
    let app = builder
        // First, so a second launch stops before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| focus(app)))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_epicenter_recorder::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_epicenter_transcription::init())
        .setup(|app| {
            start(app.handle())?;
            pill::open(app.handle())
                .map_err(|error| format!("The pill's window could not open: {error}"))?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            files::files_read,
            files::files_size,
            files::files_reveal,
            keys::key_set,
            keys::key_exists,
            servers::transcribe,
            servers::complete,
            local::transcribe_local,
            pill::pill_show,
            shortcuts::shortcuts_set
        ])
        .build(tauri::generate_context!())
        .expect("Whispering could not start");
    // On a Mac this exits without running C++ static finalizers, which can
    // race a model still loaded on the GPU (the transcription plugin's README).
    tauri_plugin_epicenter_transcription::run(app, |_, _| {});
}

/// Make the data directory, allow it in the file system scope, then open
/// the window. The recorder records into a folder the scope allows, and the
/// file system plugin's commands check the same scope. The asset protocol,
/// which the page's audio player streams from, may read `recordings/` only.
fn start<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let folder = files::recordings_dir(app)?;
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
    Ok(())
}

/// Bring the open window forward, for a second launch.
fn focus<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
