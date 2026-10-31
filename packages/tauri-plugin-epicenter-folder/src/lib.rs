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
//!         let paths = defaults::DesktopPaths::resolve(app.handle())?;
//!         let directory = paths.open_default(library::TODOS)?;
//!         app.manage(paths);
//!         app.open_folder_window("todos", directory, url, |builder| {
//!             Ok(builder.title("Todos"))
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
//! Each opened binding owns one recursive native watch. Its private channel
//! tells the page which paths may differ; the page owns reading those paths.

use tauri::plugin::TauriPlugin;
use tauri::{Manager, RunEvent, Runtime, WindowEvent};

pub use epicenter_folder_core::directory::{Directory, DirectoryError};
pub use epicenter_folder_core::library;
pub use epicenter_folder_core::storage::{PutOutcome, StorageError};

mod command_names;
mod commands;
pub mod defaults;
pub mod epicenter;
mod folders;
pub mod scope;
mod watch;
mod windows;

pub use command_names::COMMANDS;
use folders::CloseRequest;
pub use folders::{BindError, Folders, WindowError};
pub use watch::FolderChanged;
pub use windows::{folder_window_label, FolderExt, OpenWindowError};

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
            commands::open_folder::<tauri::Wry>,
            commands::subscribe_close::<tauri::Wry>,
            commands::unsubscribe_close::<tauri::Wry>,
            commands::destroy_bound_window::<tauri::Wry>,
            commands::list_folder::<tauri::Wry>,
            commands::read_folder_children::<tauri::Wry>,
            commands::make_folder_directory::<tauri::Wry>,
            commands::remove_folder_directory::<tauri::Wry>,
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

/// Register alongside `tauri_plugin_dialog::init()`: a second unanswered
/// window-close request asks for native confirmation through that plugin.
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
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } => match app.folders().request_close(label) {
                CloseRequest::Unhandled => {}
                CloseRequest::Sent | CloseRequest::Waiting => api.prevent_close(),
                CloseRequest::ConfirmNatively(token) => {
                    api.prevent_close();
                    if let Some(window) = app.get_webview_window(label) {
                        commands::confirm_unanswered_close(window, token);
                    } else {
                        app.folders().finish_close_request(label, token);
                    }
                }
            },
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
