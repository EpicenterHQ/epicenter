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
//!             folder: FolderConfig::new(todos_directory),
//!             windows: vec!["todos".into()],
//!         })?;
//!         Ok(())
//!     })
//! ```
//!
//! `Folders::permit` lets another window into a registered folder later.
//! `Folders::hand` records which app a window runs and the folder the shell
//! handed it, which the window asks for with `window_folder`: an app's page
//! opens that folder, so it never names its folder from its own URL. A
//! page names a scope and nothing else. The root comes from `register`. The page runs `@epicenter/folder`'s engine over the
//! directory `grant_directory` hands it: its folder storage is this plugin's
//! commands, one per storage method (ADR-0581). Its history runs in the `epicenter` CLI,
//! which the shell starts for it over the root `Folders::granted_root`
//! names (ADR-0559); this plugin runs no `git`.
//!
//! Several windows and scopes may edit one folder: the shell checks and
//! publishes each of their saves under one mutex per root, and under the
//! folder's save lock, which every other process that writes the folder
//! takes too, so a save another writer overtook is answered `stale` rather
//! than silently replaced (ADR-0562, ADR-0568). `Folders::shutdown`
//! refuses new work without waiting for work already running (ADR-0542).
//!
//! From a folder's first grant the plugin also watches its root and tells
//! the scope's windows what changed outside them, as the Tauri event
//! `epicenter-folder://changed` (`watcher`, ADR-0548).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use specta::Type;

use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime};

use epicenter_folder_core::registry::Registry;
pub use epicenter_folder_core::storage::{PutOutcome, StorageError};
pub use epicenter_folder_core::registry::{
    FolderConfig, FolderKind, GrantError, Granted, ScopeConfig,
};

mod command_names;
mod commands;
mod watcher;

pub use command_names::COMMANDS;
pub use watcher::{FolderChanged, FOLDER_CHANGED_EVENT};

const PLUGIN_NAME: &str = "epicenter-folder";

/// Which app a window runs, and the folder the shell handed it: what
/// `window_folder` answers that window. The app's own folder is the scope
/// named by its id; any other is a folder the person chose "Open in" on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WindowFolder {
    /// The app's id, such as `so.epicenter.todos`.
    pub app: String,
    /// The scope of the folder the window opens.
    pub folder: String,
}

/// The shell's folders. Reached with `app.folders()`.
#[derive(Default)]
pub struct Folders {
    registry: Registry,
    /// One watcher per granted root. See `watcher`.
    watchers: watcher::Watchers,
    /// What each window was handed, by label (`hand`).
    handed: Mutex<HashMap<String, WindowFolder>>,
}

impl Folders {
    /// Register a folder under a scope and name the windows that may edit
    /// it. Afterward only its windows change, through `permit`.
    pub fn register(&self, config: ScopeConfig) -> Result<(), String> {
        self.registry.register(config)
    }

    /// Let `window` edit the registered folder `scope` beside the windows
    /// already permitted. It is granted the same root.
    pub fn permit(&self, scope: &str, window: &str) -> Result<(), GrantError> {
        self.registry.permit(scope, window)
    }

    /// Record that `window` runs `handed.app` on the folder `handed.folder`,
    /// which `window_folder` answers it from then on. The shell calls this
    /// when it opens the window, beside `permit`; it does not permit the
    /// window into the folder. A label is one app on one folder, so handing
    /// it again replaces the same answer.
    pub fn hand(&self, window: &str, handed: WindowFolder) {
        self.handed
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(window.to_string(), handed);
    }

    /// What `window` was handed, or `None` for a window that runs no app.
    pub fn handed(&self, window: &str) -> Option<WindowFolder> {
        self.handed
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(window)
            .cloned()
    }

    /// The canonical root `window` was granted for `scope`: where the
    /// `epicenter` CLI the shell runs for that window works (ADR-0559), and
    /// where another plugin that writes into the folder on the page's behalf,
    /// such as the recorder, writes. Refused until the window's page has been
    /// granted the scope.
    pub fn granted_root(&self, scope: &str, window: &str) -> Result<PathBuf, GrantError> {
        self.registry.granted_root(scope, window)
    }

    /// Refuse new work and stop watching, without waiting for work already
    /// admitted. The plugin also does this when the
    /// app exits.
    pub fn shutdown(&self) {
        self.watchers.shutdown();
        self.registry.shutdown();
    }

    /// Watch `root`, just granted for `scope`, unless it is watched already,
    /// and report what changes to the scope's windows. A folder that cannot
    /// be watched still opens; its windows hear of no outside change.
    fn watch<R: Runtime>(&self, app: &AppHandle<R>, scope: &str, root: &std::path::Path) {
        let report = changed_reporter(app.clone(), scope.to_string());
        if let Err(message) = self.watchers.watch(scope, root, report) {
            log::warn!("the folder scope '{scope}' is not watched: {message}");
        }
    }
}

/// Send a scope's changes to each window permitted into it, as the windows
/// are when the change is reported, and to no other window.
fn changed_reporter<R: Runtime>(app: AppHandle<R>, scope: String) -> watcher::Report {
    std::sync::Arc::new(move |paths| {
        let change = FolderChanged {
            scope: scope.clone(),
            paths,
        };
        for window in app.folders().registry.windows(&scope) {
            let _ = app.emit_to(window.as_str(), FOLDER_CHANGED_EVENT, &change);
        }
    })
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
/// `put_folder_file` takes a raw body and `read_folder_file` returns one,
/// which specta cannot type, so they are dispatched beside these (`init`)
/// and left out of the bindings. `PutOutcome`, what `put_folder_file`
/// answers, is exported for the page.
///
/// The change event is exported as its payload type, `FolderChanged`, and
/// its name, `FOLDER_CHANGED_EVENT`, rather than through tauri-specta's
/// events: those are named `plugin:epicenter-folder:<name>`, and the event
/// is `epicenter-folder://changed`.
fn specta_builder<R: Runtime>() -> tauri_specta::Builder<R> {
    tauri_specta::Builder::<R>::new()
        .plugin_name(PLUGIN_NAME)
        .commands(tauri_specta::collect_commands![
            commands::window_folder::<tauri::Wry>,
            commands::grant_directory::<tauri::Wry>,
            commands::list_folder::<tauri::Wry>,
            commands::read_folder_children::<tauri::Wry>,
            commands::make_folder_directory::<tauri::Wry>,
            commands::remove_folder_directory::<tauri::Wry>,
        ])
        .typ::<FolderChanged>()
        .typ::<PutOutcome>()
        .typ::<WindowFolder>()
        .constant("FOLDER_CHANGED_EVENT", FOLDER_CHANGED_EVENT)
        .error_handling(tauri_specta::ErrorHandlingMode::DataError)
}

/// The commands outside the typed contract: `put_folder_file` and
/// `read_folder_file`.
fn raw_handler<R: Runtime>() -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![commands::put_folder_file, commands::read_folder_file]
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let typed = specta_builder::<R>().invoke_handler();
    let raw = raw_handler::<R>();
    tauri::plugin::Builder::new(PLUGIN_NAME)
        .invoke_handler(move |invoke| match invoke.message.command() {
            "put_folder_file" | "read_folder_file" => raw(invoke),
            _ => typed(invoke),
        })
        .setup(move |app, _api| {
            app.manage(Folders::default());
            Ok(())
        })
        .on_event(|app, event| {
            if let RunEvent::Exit = event {
                app.folders().shutdown();
            }
        })
        .build()
}

#[cfg(test)]
mod tests;
