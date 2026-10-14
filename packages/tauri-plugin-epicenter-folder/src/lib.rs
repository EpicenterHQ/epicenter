//! The desktop shell's grant of an Epicenter folder to the one window that
//! edits it.
//!
//! A shell installs the plugin once and registers its folders from trusted
//! Rust code once it knows its paths:
//!
//! ```ignore
//! tauri::Builder::default()
//!     .plugin(tauri_plugin_epicenter_folder::init())
//!     .setup(|app| {
//!         app.folders().register(ScopeConfig {
//!             scope: "so.epicenter.todos".into(),
//!             folder: FolderConfig::new(todos_directory, author),
//!             window: "todos".into(),
//!         })?;
//!         Ok(())
//!     })
//! ```
//!
//! A page names a scope and nothing else. The root and the fallback author
//! come from `register`. The page runs `@epicenter/folder`'s engine over the
//! directory `grant_directory` hands it: it reads through Tauri's fs plugin,
//! changes files through this plugin's checked commands, and records history
//! with the system `git`, which `run_git` runs for it.
//!
//! The folder is locked on its first grant and stays locked until the app
//! exits or the shell calls `Folders::shutdown`, which refuses new work,
//! waits a bounded time for the changes and `git` runs already admitted, and
//! releases each folder's cross-process lock.

use tauri::plugin::TauriPlugin;
use tauri::webview::PageLoadEvent;
use tauri::{Manager, RunEvent, Runtime, WindowEvent};

use epicenter_folder_core::registry::Registry;
pub use epicenter_folder_core::page_git::GitOutput;
pub use epicenter_folder_core::registry::{
    Author, FolderConfig, GrantError, Granted, ScopeConfig,
};

mod command_names;
mod commands;
mod git_runs;

pub use command_names::COMMANDS;
pub use commands::DIRECTORY_COMMANDS;

const PLUGIN_NAME: &str = "epicenter-folder";

/// The shell's folders. Reached with `app.folders()`.
#[derive(Default)]
pub struct Folders {
    registry: Registry,
    /// The `git` runs each window's page started. See `git_runs`.
    git_runs: git_runs::GitRuns,
    /// The windows and scopes `grant_directory` has added a capability for.
    granted_capabilities: std::sync::Mutex<std::collections::HashSet<(String, String)>>,
}

impl Folders {
    /// Register a folder under a scope and name the window that may use it.
    /// A scope's configuration never changes once registered.
    pub fn register(&self, config: ScopeConfig) -> Result<(), String> {
        self.registry.register(config)
    }

    /// Refuse new work, wait a bounded time for work already admitted, and
    /// release every lock. Returns once that has happened. The plugin also
    /// does this when the app exits.
    pub fn shutdown(&self) {
        self.registry.shutdown();
    }
}

pub trait FolderExt<R: Runtime> {
    fn folders(&self) -> &Folders;
}

impl<R: Runtime, T: Manager<R>> FolderExt<R> for T {
    fn folders(&self) -> &Folders {
        self.state::<Folders>().inner()
    }
}

/// The typed command contract. The TypeScript bindings in
/// `../folder/src/native/bindings.gen.ts` are generated from this builder.
/// `write_folder_file` takes a raw body, which specta cannot type, so it is
/// dispatched beside these (`init`) and left out of the bindings.
fn specta_builder<R: Runtime>() -> tauri_specta::Builder<R> {
    tauri_specta::Builder::<R>::new()
        .plugin_name(PLUGIN_NAME)
        .commands(tauri_specta::collect_commands![
            commands::grant_directory::<tauri::Wry>,
            commands::run_git::<tauri::Wry>,
            commands::cancel_git::<tauri::Wry>,
            commands::rename_folder_path::<tauri::Wry>,
            commands::remove_folder_path::<tauri::Wry>,
            commands::make_folder_directory::<tauri::Wry>,
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::DataError)
}

/// The commands outside the typed contract: `write_folder_file`.
fn raw_handler<R: Runtime>() -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![commands::write_folder_file]
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let typed = specta_builder::<R>().invoke_handler();
    let raw = raw_handler::<R>();
    tauri::plugin::Builder::new(PLUGIN_NAME)
        .invoke_handler(move |invoke| match invoke.message.command() {
            "write_folder_file" => raw(invoke),
            _ => typed(invoke),
        })
        .setup(move |app, _api| {
            app.manage(Folders::default());
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started {
                page_started(webview);
            }
        })
        .on_event(|app, event| match event {
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::Destroyed,
                ..
            } => window_destroyed(app, label),
            RunEvent::Exit => app.folders().shutdown(),
            _ => {}
        })
        .build()
}

/// A page started loading in `webview`: the page before it is over, and so
/// are the `git` runs it started.
fn page_started<R: Runtime>(webview: &tauri::Webview<R>) {
    webview
        .folders()
        .git_runs
        .page_ended(webview.window().label());
}

/// A window was destroyed, and with it its page and that page's `git` runs.
/// Tauri has already forgotten the window when a plugin hears of it, so this
/// needs only its label.
fn window_destroyed<R: Runtime>(app: &tauri::AppHandle<R>, window: &str) {
    app.folders().git_runs.page_ended(window);
}

#[cfg(test)]
mod tests;
