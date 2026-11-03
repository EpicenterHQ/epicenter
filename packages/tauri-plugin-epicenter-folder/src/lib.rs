//! The desktop shell's binding of one existing directory to each window that
//! edits it.
//!
//! A shell installs the plugin once. Before it builds a window's WebView, it
//! resolves the directory that window edits in trusted Rust. The shared opener
//! chooses the window identity and binds before construction:
//!
//! ```ignore
//! tauri::Builder::default()
//!     .plugin(tauri_plugin_epicenter_folder::init())
//!     .setup(|app| {
//!         let directory = Directory::create(&app.path().app_data_dir()?)?;
//!         app.open_folder_window("notes", directory, url, |builder| {
//!             Ok(builder.title("Notes"))
//!         })?;
//!         Ok(())
//!     })
//! ```
//!
//! The binding is the window's for its lifetime: a live label is never bound
//! again, and the plugin removes the binding when the window is destroyed. A
//! page names no scope or label, and names every root by the absolute path
//! `open_folder` answered for it: its window's own directory, or one Tauri's
//! file-system scope allows. It runs `@epicenter/folder`'s engine over that
//! root, whose storage is this plugin's commands, one per storage method
//! (ADR-0581); each checks the root against the calling WebView's. The `epicenter` CLI owns Git over explicit directories
//! (ADR-0559); this plugin offers file storage.
//!
//! Several windows may be bound to one directory: the shell checks each save
//! against the version its page read right before the rename, so a save
//! another writer overtook is answered `stale` rather than silently replaced.
//! No lock spans the check and the rename; Git history is the backstop for
//! that instant (ADR-0562, ADR-0568). `Folders::shutdown` refuses
//! new work without waiting for work already running (ADR-0542).
//!
//! Each opened binding owns one recursive native watch. Its private channel
//! tells the page which paths may differ; the page owns reading those paths.

use std::fmt;
use std::path::PathBuf;

use serde::Serialize;
use specta::Type;
use tauri::plugin::TauriPlugin;
use tauri::{Manager, RunEvent, Runtime, WindowEvent};

pub use epicenter_folder_core::admission;
pub use epicenter_folder_core::directory::{Directory, DirectoryError};
pub use epicenter_folder_core::storage::{PutOutcome, StorageError};

mod command_names;
mod commands;
pub mod epicenter;
mod folders;
pub mod scope;
mod watch;
mod windows;

pub use command_names::COMMANDS;
pub use folders::{BindError, Folders, WindowError};
pub use watch::FolderChanged;
pub use windows::{FolderExt, OpenWindowError};

/// What a standalone shell found at its derived data folder at startup: the
/// resolved folder it granted, or why it granted none. A shell that manages
/// no `DataFolder` derives none (`DataFolderError::NoDataFolder`).
pub struct DataFolder(pub Result<PathBuf, DataFolderError>);

/// Why `data_folder` answered no folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "name")]
pub enum DataFolderError {
    /// This shell derives no data folder for its app.
    NoDataFolder,
    /// The derived folder is, or is inside, a link whose target is not there,
    /// as when it is on a drive that is not connected. Nothing was granted or
    /// made.
    Disconnected { folder: String, target: String },
}

impl fmt::Display for DataFolderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoDataFolder => formatter.write_str("This app has no data folder."),
            Self::Disconnected { folder, target } => {
                write!(formatter, "{folder} links to {target}, which is not there.")
            }
        }
    }
}

impl std::error::Error for DataFolderError {}

const PLUGIN_NAME: &str = "epicenter-folder";

/// The typed command contract. The TypeScript bindings in
/// `../folder/src/native/bindings.gen.ts` are generated from this builder.
/// `put_folder_file` takes a raw body and `read_folder_file` returns one,
/// which specta cannot type, so they are dispatched beside these (`init`)
/// and left out of the bindings. `PutOutcome`, what `put_folder_file`
/// answers, is exported for the page.
fn specta_builder<R: Runtime>() -> tauri_specta::Builder<R> {
    tauri_specta::Builder::<R>::new()
        .plugin_name(PLUGIN_NAME)
        .commands(tauri_specta::collect_commands![
            commands::data_folder::<tauri::Wry>,
            commands::open_folder::<tauri::Wry>,
            commands::resolve_folder::<tauri::Wry>,
            commands::list_folder::<tauri::Wry>,
            epicenter::sync_with_epicenter::<tauri::Wry>,
            epicenter::synced_with_epicenter::<tauri::Wry>,
        ])
        .typ::<PutOutcome>()
        .error_handling(tauri_specta::ErrorHandlingMode::DataError)
}

/// The commands outside the typed contract: `put_folder_file` and
/// `read_folder_file`.
fn raw_handler<R: Runtime>() -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![commands::put_folder_file, commands::read_folder_file]
}

/// Install once per shell. A bound window closes like any other window:
/// nothing waits for its page.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let contract = specta_builder::<R>();
    let typed = contract.invoke_handler();
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
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                webview.app_handle().folders().page_started(webview.label());
            }
        })
        .on_event(|app, event| match event {
            // A destroyed window's label may be built again, on any folder.
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::Destroyed,
                ..
            } => app.folders().unbind(label),
            RunEvent::Exit => app.folders().shutdown(),
            _ => {}
        })
        .build()
}

#[cfg(test)]
mod tests;
