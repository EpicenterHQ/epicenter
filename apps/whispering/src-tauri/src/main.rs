//! Whispering's desktop app (ADR-0894): one window over Whispering's folder,
//! `data/` in the app's local data directory unless the person picked
//! another in the folder dialog. The page reads and writes the folder
//! through Whispering's own file commands (`files.rs`), which check each
//! folder against `tauri-plugin-fs`'s scope: the default folder (allowed
//! here at start) and the one the dialog granted
//! (`tauri-plugin-persisted-scope` restores it at each start). The page
//! holds none of the file system plugin's commands, and Rust keeps no
//! folder setting. Every file is written inside the folder (ADR-0962): a
//! take at its own path from its first second
//! (`tauri-plugin-epicenter-recorder`), and a note through a temporary file
//! beside it (`whispering-files`). It transcribes on this computer (`tauri-plugin-epicenter-transcription`),
//! sends a provider's requests from the page through `tauri-plugin-http`
//! with a key it reads from the Keychain (`secrets.rs`), and starts and stops
//! a recording from a global shortcut (`shortcut.rs`). A second launch
//! focuses the open window (`tauri-plugin-single-instance`), so the app is
//! the folder's one writer.

// Keeps a console window from opening beside the app in a Windows release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod files;
mod secrets;
mod shortcut;

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_fs::FsExt;

include!("command_names.rs");

/// The window's label, which the capability selects (`whispering:*`).
const WINDOW: &str = "whispering:main";

/// The default folder, inside the app's local data directory.
const DEFAULT_FOLDER: &str = "data";

fn main() {
    let context = tauri::generate_context!();
    let app = tauri::Builder::default()
        // First, so a second launch stops before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| focus(app)))
        .plugin(tauri_plugin_fs::init())
        // After the file system plugin, whose scope it restores.
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_epicenter_recorder::init())
        .plugin(tauri_plugin_epicenter_transcription::init())
        .plugin(shortcut::listener())
        .setup(|app| {
            let handle = app.handle().clone();
            if let Err(error) = start(&handle) {
                quit_with(&handle, &error);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            secrets::secret_get,
            secrets::secret_set,
            shortcut::set_shortcut,
            files::files_read,
            files::files_read_many,
            files::files_write,
            files::files_list,
            files::files_remove,
            files::files_change_folder,
            files::folder_git,
        ])
        .build(context)
        .expect("Whispering could not start");
    // Exits without C++ static finalizers on macOS, which can race a
    // resident model (the transcription plugin's README).
    tauri_plugin_epicenter_transcription::run(app, |_, _| {});
}

/// Make the default folder, allow it, then open the window.
///
/// The scope is the grant every file command checks. A capability's file
/// system grant would count only inside the file system plugin's own
/// commands, so the default folder is allowed here; one the person picked
/// is restored by the persisted-scope plugin.
fn start<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let paths = app.path();
    let local_data = paths.app_local_data_dir().map_err(|error| {
        format!("The system did not say where Whispering keeps its files: {error}")
    })?;
    let folder = local_data.join(DEFAULT_FOLDER);
    std::fs::create_dir_all(&folder)
        .map_err(|error| format!("{} could not be made: {error}", folder.display()))?;
    app.manage(files::Opened::default());
    app.fs_scope()
        .allow_directory(&folder, true)
        .map_err(|error| format!("{} could not be opened: {error}", folder.display()))?;
    let webview_data = paths
        .app_cache_dir()
        .map_err(|error| {
            format!("The system did not say where Whispering keeps its cache: {error}")
        })?
        .join("webview");
    WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::default())
        .title("Whispering")
        .inner_size(1100.0, 760.0)
        .min_inner_size(400.0, 400.0)
        .data_directory(webview_data)
        .build()
        .map_err(|error| format!("The window could not open: {error}"))?;
    Ok(())
}

/// Say what went wrong without stopping: the shell has no logger of its own.
fn log_warning(message: &str) {
    eprintln!("Whispering: {message}");
}

/// Bring the open window forward, for a second launch.
fn focus<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Say why Whispering could not start, with only Quit.
fn quit_with<R: Runtime>(app: &AppHandle<R>, error: &str) {
    let exit = app.clone();
    app.dialog()
        .message(error)
        .title("Whispering could not start")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCustom("Quit".into()))
        .show(move |_| exit.exit(1));
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;

    fn read(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    /// The build script declares the Keychain commands, `set_shortcut`, and
    /// the file commands, and nothing else.
    #[test]
    fn the_declared_commands_are_the_secrets_the_shortcut_and_the_files() {
        assert_eq!(
            COMMANDS,
            [
                "secret_get",
                "secret_set",
                "set_shortcut",
                "files_read",
                "files_read_many",
                "files_write",
                "files_list",
                "files_remove",
                "files_change_folder",
                "folder_git",
            ]
        );
    }

    /// The bundle is `so.epicenter.whispering`, and it loads the one build
    /// the web serves (ADR-0781). The development configuration's
    /// identifier is the production one with `.dev`, so it has its own local
    /// data directory and folder. Neither configures the file system plugin:
    /// every path the file commands check is a plain name, which the scope's
    /// default (a leading dot only matched literally) allows.
    #[test]
    fn whispering_is_its_own_app() {
        let config = read(include_str!("../tauri.conf.json"));
        assert_eq!(config["identifier"], "so.epicenter.whispering");
        assert_eq!(config["productName"], "Whispering");
        assert_eq!(config["build"]["frontendDist"], "../build");
        assert!(config.get("plugins").is_none());
        let dev = read(include_str!("../tauri.dev.conf.json"));
        assert_eq!(dev["identifier"], "so.epicenter.whispering.dev");
        assert_eq!(dev["productName"], "Whispering Dev");
        for configuration in [&config, &dev] {
            assert_eq!(
                configuration["app"]["security"]["capabilities"],
                json!(["whispering"])
            );
        }
    }

    /// The window reads and writes files only through Whispering's own
    /// commands, which check the scope (no capability names a folder, and
    /// none grants a file system plugin command), picks a folder, sends
    /// requests to any http or https address, records, transcribes and
    /// administers local models, hears the global shortcut, and calls
    /// exactly the commands the build script declares.
    #[test]
    fn the_capability_grants_plugins_and_the_declared_commands_and_no_folder() {
        let capability = read(include_str!("../capabilities/whispering.json"));
        assert_eq!(capability["windows"], json!(["whispering:*"]));
        assert_eq!(capability["local"], true);
        let mut expected: Vec<Value> = [
            "core:path:default",
            "core:event:allow-listen",
            "core:event:allow-unlisten",
            "dialog:allow-open",
            "opener:allow-reveal-item-in-dir",
        ]
        .map(|permission| json!(permission))
        .to_vec();
        expected.push(json!({
            "identifier": "http:default",
            "allow": [{ "url": "https://*" }, { "url": "http://*" }]
        }));
        expected.extend(
            [
                "epicenter-recorder:default",
                "epicenter-transcription:allow-list-inference-models",
                "epicenter-transcription:allow-transcribe-audio",
                "epicenter-transcription:allow-list-models",
                "epicenter-transcription:allow-download-model",
                "epicenter-transcription:allow-reveal-model",
                "epicenter-transcription:allow-remove-model",
                "epicenter-transcription:allow-get-unload-policy",
                "epicenter-transcription:allow-set-unload-policy",
            ]
            .map(|permission| json!(permission)),
        );
        expected.extend(
            COMMANDS
                .iter()
                .map(|command| json!(format!("allow-{}", command.replace('_', "-")))),
        );
        assert_eq!(capability["permissions"], json!(expected));
        let text = include_str!("../capabilities/whispering.json");
        assert!(
            !text.contains("$APP") && !text.contains("$HOME"),
            "no folder is named"
        );
        assert!(
            !text.contains("\"fs:"),
            "no file system plugin command is granted"
        );
    }
}
