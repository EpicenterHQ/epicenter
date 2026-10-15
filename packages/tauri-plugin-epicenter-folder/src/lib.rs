//! The desktop shell's grant of an Epicenter folder to the windows that edit
//! it.
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
//!             windows: vec!["todos".into()],
//!         })?;
//!         Ok(())
//!     })
//! ```
//!
//! `Folders::permit` lets another window into a registered folder later. A
//! page names a scope and nothing else. The root and the fallback author
//! come from `register`. The page runs `@epicenter/folder`'s engine over the
//! directory `grant_directory` hands it: it reads and changes files through
//! this plugin's checked commands, and records history with the system
//! `git`, which `run_git` runs for it.
//!
//! Several windows may edit one folder: the shell checks and publishes each
//! of their saves under one mutex per root, so a save another window
//! overtook is refused as `Conflict` rather than silently replaced. The
//! folder is locked against other processes on its first grant, from
//! whichever window, and stays locked until the app exits or the shell calls
//! `Folders::shutdown`, which refuses new work, waits a bounded time for the
//! changes and `git` runs already admitted in every window, and releases each
//! folder's cross-process lock.

use std::path::PathBuf;

use tauri::plugin::TauriPlugin;
use tauri::webview::PageLoadEvent;
use tauri::{Manager, RunEvent, Runtime, WindowEvent};

use epicenter_folder_core::registry::Registry;
pub use epicenter_folder_core::page_files::{ChangeError, Expectation};
pub use epicenter_folder_core::page_git::GitOutput;
pub use epicenter_folder_core::registry::{
    Author, FolderConfig, FolderKind, GrantError, Granted, ScopeConfig,
};

mod command_names;
mod commands;
mod git_runs;

pub use command_names::COMMANDS;

const PLUGIN_NAME: &str = "epicenter-folder";

/// The shell's folders. Reached with `app.folders()`.
#[derive(Default)]
pub struct Folders {
    registry: Registry,
    /// The `git` runs each window's page started. See `git_runs`.
    git_runs: git_runs::GitRuns,
}

impl Folders {
    /// Register a folder under a scope and name the windows that may edit
    /// it. Afterward only its windows change, through `permit`.
    pub fn register(&self, config: ScopeConfig) -> Result<(), String> {
        self.registry.register(config)
    }

    /// Let `window` edit the registered folder `scope` beside the windows
    /// already permitted. It is granted the same root, under the same lock.
    pub fn permit(&self, scope: &str, window: &str) -> Result<(), GrantError> {
        self.registry.permit(scope, window)
    }

    /// The canonical root `window` was granted for `scope`, for another
    /// plugin that writes into the folder on the page's behalf, such as the
    /// recorder. Refused until the window's page has been granted the scope.
    pub fn granted_root(&self, scope: &str, window: &str) -> Result<PathBuf, GrantError> {
        self.registry.granted_root(scope, window)
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
/// `write_folder_file` takes a raw body and `read_folder_file` returns one,
/// which specta cannot type, so they are dispatched beside these (`init`)
/// and left out of the bindings.
fn specta_builder<R: Runtime>() -> tauri_specta::Builder<R> {
    tauri_specta::Builder::<R>::new()
        .plugin_name(PLUGIN_NAME)
        .commands(tauri_specta::collect_commands![
            commands::grant_directory::<tauri::Wry>,
            commands::run_git::<tauri::Wry>,
            commands::cancel_git::<tauri::Wry>,
            commands::read_folder_directory::<tauri::Wry>,
            commands::stat_folder_path::<tauri::Wry>,
            commands::rename_folder_path::<tauri::Wry>,
            commands::remove_folder_path::<tauri::Wry>,
            commands::make_folder_directory::<tauri::Wry>,
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::DataError)
}

/// The commands outside the typed contract: `write_folder_file` and
/// `read_folder_file`.
fn raw_handler<R: Runtime>() -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![commands::write_folder_file, commands::read_folder_file]
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let typed = specta_builder::<R>().invoke_handler();
    let raw = raw_handler::<R>();
    tauri::plugin::Builder::new(PLUGIN_NAME)
        .invoke_handler(move |invoke| match invoke.message.command() {
            "write_folder_file" | "read_folder_file" => raw(invoke),
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
