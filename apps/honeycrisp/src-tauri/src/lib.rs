//! The Honeycrisp desktop shell.
//!
//! The shell opens one window on the bundled notes page and gives that window
//! two things:
//!
//! - Its folder, through the shared folder plugin. The shell registers one
//!   folder scope for the window `main`: the root from `HONEYCRISP_ROOT`
//!   or the default, and the fallback author. The page names the scope and
//!   runs `@epicenter/folder`'s own engine over the directory the plugin
//!   grants it: the folder plugin makes every read and change and runs the
//!   folder's `git` for it. The engine reads the
//!   author and any `origin` from Git's configuration.
//! - Honeycrisp's own commands (`commands.rs`): the terminal, per-file
//!   history, and reveal.
//!
//! Closing the window or quitting quits at once: nothing asks the page or
//! waits for it. Every save is an atomic rename into the folder (ADR-0542),
//! so what a person has saved is already in its file.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_epicenter_folder::{Author, FolderConfig, FolderExt, ScopeConfig};

mod command_names;
mod commands;
mod history;
mod process;
mod reveal;
mod root;
mod terminal;

#[cfg(test)]
mod testing;
#[cfg(test)]
mod tests;

pub use command_names::COMMANDS;

use commands::{Shell, WINDOW};
use terminal::Terminal;

/// The plugins and the commands of the notes window. The folder and the
/// window are added in setup, once paths can be resolved.
fn shell<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .plugin(tauri_plugin_epicenter_folder::init())
        .invoke_handler(tauri::generate_handler![
            commands::shell_info,
            commands::terminal_run,
            commands::file_log,
            commands::file_show,
            commands::reveal_folder,
        ])
}

/// The notes folder, opened by the page's own engine. The engine reads the
/// author and `origin` from Git's configuration; this author is the fallback
/// for whichever of `user.name` and `user.email` is not configured.
fn folder_config(root: &Path) -> FolderConfig {
    FolderConfig::new(
        root,
        Author {
            name: "Honeycrisp".to_string(),
            email: "honeycrisp@localhost".to_string(),
        },
    )
}

/// Register the notes directory for the notes window and hold the shell's own
/// state for that window. Nothing is written inside the directory here: the
/// plugin takes its lock on the first grant, and the page sets up a missing
/// layout through it.
fn install<R: Runtime>(app: &AppHandle<R>, root: PathBuf) -> Result<(), String> {
    let root = root::locate(&root)?;
    app.folders().register(ScopeConfig {
        scope: root::SCOPE.to_string(),
        folder: folder_config(&root),
        windows: vec![WINDOW.to_string()],
    })?;
    app.manage(Shell {
        terminal: Arc::new(Terminal::new(root)),
    });
    Ok(())
}

/// The app's configuration, capabilities, and bundled page. Expanded once:
/// the tests build the mock app from this same context.
fn context<R: Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

/// Whether `target` is the bundled page. The window shows that and nothing
/// else. The bundled page has exactly one origin per platform:
/// `tauri://localhost`, or `http://tauri.localhost` where the webview cannot
/// serve a custom scheme. Another port on the same host is another origin,
/// and an address carrying credentials is not one the shell ever produces.
fn is_app_page(target: &Url) -> bool {
    let bundled = matches!(
        (target.scheme(), target.host_str()),
        ("tauri", Some("localhost")) | ("http", Some("tauri.localhost"))
    );
    bundled
        && target.port().is_none()
        && target.username().is_empty()
        && target.password().is_none()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    shell(tauri::Builder::default())
        .setup(|app| {
            let handle = app.handle();
            let root = root::choose(std::env::var_os("HONEYCRISP_ROOT"), || {
                handle
                    .path()
                    .home_dir()
                    .map_err(|cause| format!("resolve the home directory: {cause}"))
            })?;
            install(handle, root)?;
            WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("index.html".into()))
                .title("Honeycrisp")
                .inner_size(1280.0, 820.0)
                .min_inner_size(900.0, 560.0)
                .on_navigation(is_app_page)
                .build()?;
            Ok(())
        })
        .run(context())
        .expect("error while running the Honeycrisp application");
}
