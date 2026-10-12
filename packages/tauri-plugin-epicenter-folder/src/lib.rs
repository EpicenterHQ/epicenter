//! One native owner per Epicenter folder, shared by every window of a shell.
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
//! A page names a scope and nothing else. The root, the author, and the
//! remote all come from `register`.
//!
//! The owner of a scope is opened on its first attach and kept until the app
//! exits or the shell calls `Folders::shutdown`, which fences new work, lets
//! admitted saves and admitted commits finish, and releases each folder's
//! cross-process lock. It commits nothing on its own.

use tauri::plugin::TauriPlugin;
use tauri::webview::PageLoadEvent;
use tauri::{Manager, RunEvent, Runtime, WindowEvent};

/// Whether a directory already holds a repository: what a shell checks before
/// offering to open a folder that must not be initialized.
pub use epicenter_folder_core::files::has_repository;
pub use epicenter_folder_core::git::{Author, Remote};
pub use epicenter_folder_core::owner::FolderConfig;
use epicenter_folder_core::registry::Registry;
pub use epicenter_folder_core::registry::ScopeConfig;
/// A shell's own transfers: staged first downloads, and the per-transfer
/// relays a folder's owner can be given in [`FolderConfig::transport`].
pub use epicenter_folder_core::{download, transport};

mod command_names;
mod commands;
mod lifecycle;

pub use command_names::COMMANDS;
pub use commands::{Attached, FolderFilesChanged, FolderSnapshotChanged, PROTOCOL};
pub use epicenter_folder_core::history::StagedCommit;

const PLUGIN_NAME: &str = "epicenter-folder";

/// The shell's folders. Reached with `app.folders()`.
#[derive(Default)]
pub struct Folders {
    registry: Registry,
    /// Which page each session belongs to, so sessions end with their page
    /// and their window. See `lifecycle`.
    lifecycles: lifecycle::Lifecycles,
}

impl Folders {
    /// Register a folder under a scope and name the windows that may use it.
    /// A scope's configuration never changes once registered.
    pub fn register(&self, config: ScopeConfig) -> Result<(), String> {
        self.registry.register(config)
    }

    /// Fence new work, drain every folder, and release every lock. Returns
    /// once that has happened. The plugin also does this when the app exits.
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

/// The typed command and event contract. The TypeScript bindings in
/// `../folder/src/native/bindings.gen.ts` are generated from this builder.
fn specta_builder<R: Runtime>() -> tauri_specta::Builder<R> {
    tauri_specta::Builder::<R>::new()
        .plugin_name(PLUGIN_NAME)
        .commands(tauri_specta::collect_commands![
            commands::attach::<tauri::Wry>,
            commands::detach::<tauri::Wry>,
            commands::list::<tauri::Wry>,
            commands::children::<tauri::Wry>,
            commands::read::<tauri::Wry>,
            commands::read_many::<tauri::Wry>,
            commands::apply::<tauri::Wry>,
            commands::mkdir::<tauri::Wry>,
            commands::rmdir::<tauri::Wry>,
            commands::status::<tauri::Wry>,
            commands::commit::<tauri::Wry>,
            commands::open_request::<tauri::Wry>,
            commands::withdraw_request::<tauri::Wry>,
            commands::push::<tauri::Wry>,
            commands::fetch::<tauri::Wry>,
            commands::pull_fast_forward::<tauri::Wry>,
            commands::merge_incoming::<tauri::Wry>,
            commands::recover_incoming::<tauri::Wry>,
            commands::paths::<tauri::Wry>,
            commands::stage::<tauri::Wry>,
            commands::commit_staged::<tauri::Wry>,
            commands::diff::<tauri::Wry>,
            commands::log::<tauri::Wry>,
        ])
        .events(tauri_specta::collect_events![
            FolderSnapshotChanged,
            FolderFilesChanged,
        ])
        .constant("FOLDER_PROTOCOL", commands::PROTOCOL)
        .error_handling(tauri_specta::ErrorHandlingMode::DataError)
        // Sizes, timestamps, and sequence numbers stay far below 2^53.
        .dangerously_cast_bigints_to_number()
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let builder = specta_builder::<R>();
    tauri::plugin::Builder::new(PLUGIN_NAME)
        .invoke_handler(builder.invoke_handler())
        .setup(move |app, _api| {
            builder.mount_events(app);
            app.manage(Folders::default());
            // Webviews that exist before the plugin is installed were never
            // announced to it.
            for window in app.webview_windows().values() {
                commands::adopt(window.as_ref());
            }
            Ok(())
        })
        // Each actual webview gets its own identity as Tauri announces it.
        .on_webview_ready(|webview| commands::adopt(&webview))
        // A webview's resources outlive its pages. When a page starts loading,
        // the sessions the previous page attached are ended.
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started {
                commands::end_page(webview);
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

/// A window was destroyed. Tauri's manager removes the window and its
/// webviews before a plugin hears of it, so nothing here asks the manager for
/// them: the plugin's own index says which webview instances were that
/// window's.
fn window_destroyed<R: Runtime>(app: &tauri::AppHandle<R>, window: &str) {
    app.folders().lifecycles.window_destroyed(window);
}

#[cfg(test)]
mod tests;
