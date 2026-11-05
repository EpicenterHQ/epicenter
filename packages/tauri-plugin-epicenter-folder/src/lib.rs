//! The desktop shell's named roots and the storage commands a page reaches
//! them through (ADR-0725).
//!
//! A shell installs the plugin once, then names each root at startup, with
//! the rule that refuses a location it must never be:
//!
//! ```ignore
//! tauri::Builder::default()
//!     .plugin(tauri_plugin_epicenter_folder::init())
//!     .setup(|app| {
//!         let roots = app.roots();
//!         roots.name(Root::AppData, app.path().app_data_dir()?, |_| None);
//!         roots.name(Root::Data, data_folder, refuse_home_and_library);
//!         Ok(())
//!     })
//! ```
//!
//! A page names a root, never a path, and holds no absolute path but the
//! one `open_root` answers for it to show. Opening a root opens whatever is
//! at its path, following a link there, and makes the folder when nothing is
//! there (ADR-0726). The page runs `@epicenter/folder`'s engine over the
//! root, whose storage is this plugin's commands, one per storage method
//! (ADR-0581), each taking the root and a relative path the shared path rule
//! keeps inside it. The `epicenter` CLI owns Git over explicit directories
//! (ADR-0559); this plugin offers file storage.
//!
//! The shell checks each save against the version its page read right
//! before the rename, so a save another writer overtook is answered `stale`
//! rather than silently replaced. No lock spans the check and the rename;
//! Git history is the backstop for that instant (ADR-0562, ADR-0568).
//! `Roots::shutdown` refuses new work without waiting for work already
//! running (ADR-0542).
//!
//! Each open root owns one recursive native watch. Its app event tells pages
//! which paths may differ; each page owns reading those paths.

use tauri::plugin::TauriPlugin;
use tauri::{Manager, RunEvent, Runtime};

pub use epicenter_folder_core::admission;
pub use epicenter_folder_core::directory::{Directory, DirectoryError};
pub use epicenter_folder_core::storage::{Landing, PutOutcome, StorageError};

mod command_names;
mod commands;
pub mod epicenter;
mod roots;
mod watch;

pub use command_names::COMMANDS;
pub use commands::FolderError;
pub use roots::{Root, RootError, Roots, RootsExt};
pub use watch::{FolderChanged, FolderEvent};

const PLUGIN_NAME: &str = "epicenter-folder";

/// The typed command contract. The TypeScript bindings in
/// `../folder/src/native/bindings.gen.ts` are generated from this builder.
/// `put_folder_file` takes a raw body and `read_folder_file` returns one,
/// which specta cannot type, so they are dispatched beside these (`init`)
/// and left out of the bindings. `Landing`, what `put_folder_file`
/// answers, is exported for the page.
fn specta_builder<R: Runtime>() -> tauri_specta::Builder<R> {
    tauri_specta::Builder::<R>::new()
        .plugin_name(PLUGIN_NAME)
        .commands(tauri_specta::collect_commands![
            commands::open_root::<tauri::Wry>,
            commands::reveal_root::<tauri::Wry>,
            commands::list_folder::<tauri::Wry>,
            epicenter::sync_with_epicenter::<tauri::Wry>,
            epicenter::synced_with_epicenter::<tauri::Wry>,
        ])
        .typ::<Landing>()
        .typ::<FolderEvent>()
        .error_handling(tauri_specta::ErrorHandlingMode::DataError)
}

/// The commands outside the typed contract: `put_folder_file` and
/// `read_folder_file`.
fn raw_handler<R: Runtime>() -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![commands::put_folder_file, commands::read_folder_file]
}

/// Install once per shell, then name its roots (`Roots::name`). A window
/// closes like any other window: nothing waits for its page.
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
            app.manage(Roots::default());
            Ok(())
        })
        .on_event(|app, event| match event {
            RunEvent::Exit => app.roots().shutdown(),
            _ => {}
        })
        .build()
}

#[cfg(test)]
mod tests;
