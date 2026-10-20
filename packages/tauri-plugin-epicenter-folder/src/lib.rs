//! The desktop shell's binding of one existing directory to each window that
//! edits it.
//!
//! A shell installs the plugin once. Before it builds a window's WebView, it
//! resolves the directory that window edits and binds it to the label, in
//! trusted Rust:
//!
//! ```ignore
//! tauri::Builder::default()
//!     .plugin(tauri_plugin_epicenter_folder::init())
//!     .setup(|app| {
//!         let folders = app.folders();
//!         let directory = Directory::create(&app.path().app_data_dir()?)?;
//!         folders.bind_while_building(&label, directory, || {
//!             WebviewWindowBuilder::new(app, &label, url).build()
//!         })?;
//!         Ok(())
//!     })
//! ```
//!
//! The binding is the window's for its lifetime: a live label is never bound
//! again, and the plugin removes the binding when the window is destroyed. A
//! page names no root, scope, or label. It runs `@epicenter/folder`'s engine
//! over its window's directory, whose storage is this plugin's commands, one
//! per storage method (ADR-0581); each derives the directory from the calling
//! WebView. The `epicenter` CLI owns Git over explicit directories
//! (ADR-0559); this plugin offers file storage.
//!
//! Several windows may be bound to one directory: the shell checks and
//! publishes each save under the folder's save lock, which native windows
//! and other participating processes all take, so a save another writer
//! overtook is answered `stale` rather
//! than silently replaced (ADR-0562, ADR-0568). `Folders::shutdown` refuses
//! new work without waiting for work already running (ADR-0542).
//!
//! From a window's first `open_folder` the plugin also watches its root,
//! until the last window bound to that root is destroyed, and tells every
//! window bound to it what changed outside it, as the Tauri event
//! `epicenter-folder://changed` (`watcher`, ADR-0548).

use tauri::plugin::TauriPlugin;
use tauri::{Manager, RunEvent, Runtime, WindowEvent};

pub use epicenter_folder_core::directory::{Directory, DirectoryError};
pub use epicenter_folder_core::storage::{PutOutcome, StorageError};

mod command_names;
mod commands;
mod folders;
mod watcher;

pub use command_names::COMMANDS;
pub use folders::{BindError, Folders, WindowError};
pub use watcher::{FolderChanged, FOLDER_CHANGED_EVENT};

const PLUGIN_NAME: &str = "epicenter-folder";

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
            commands::open_folder::<tauri::Wry>,
            commands::list_folder::<tauri::Wry>,
            commands::read_folder_children::<tauri::Wry>,
            commands::make_folder_directory::<tauri::Wry>,
            commands::remove_folder_directory::<tauri::Wry>,
        ])
        .typ::<FolderChanged>()
        .typ::<PutOutcome>()
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
