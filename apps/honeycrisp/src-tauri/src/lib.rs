//! The Honeycrisp desktop shell.
//!
//! The shell opens one window on the bundled notes page and gives that window
//! two things:
//!
//! - Its folder, through the shared folder plugin. The shell registers one
//!   scope for the window `main`: the root from `HONEYCRISP_ROOT` or the
//!   default, and the fallback author and local history policy. The plugin
//!   reads the person's Git identity under its lock and owns the files,
//!   change detection, and Git history. The
//!   page names the scope and nothing else.
//! - Honeycrisp's own commands (`commands.rs`): flush on close, the terminal,
//!   per-file history, and reveal.
//!
//! Closing never asks. The window's close button, an exit request from the
//! runtime, and the macOS Quit menu item each give the page a bounded moment
//! to land a save already in flight, then the app exits (`flush.rs`). A draft
//! whose save failed ends with the page; the save bar said so when it failed.
//!
//! A quit from the system on macOS (the Dock, a logout, a shutdown, an Apple
//! Event) is AppKit's `terminate:`. Tao's application delegate implements
//! `applicationWillTerminate:` and not `applicationShouldTerminate:`, so that
//! quit reaches the run loop as `RunEvent::Exit` with no exit request before
//! it. The page cannot be reached then: its IPC needs the main thread, which
//! is ending. The folder plugin drains the writes it already accepted on
//! `RunEvent::Exit`; an autosave snapshot the page still held behind a
//! running write in that instant is lost. The shell does not add
//! `applicationShouldTerminate:` to hold such a quit, so it never cancels a
//! logout or a shutdown.

use std::path::{Path, PathBuf};
use std::sync::Arc;

#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{
    AppHandle, Manager, RunEvent, Runtime, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_epicenter_folder::{Author, FolderConfig, FolderExt, ScopeConfig};

mod command_names;
mod commands;
mod flush;
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
use flush::{hold, CloseFlush};
use terminal::Terminal;

const QUIT_MENU_ITEM: &str = "quit-notes";

/// The plugin, the commands, and the close routing of the notes window: a
/// close or Quit is held for the page's flush, then exits. The
/// folder and the window are added in setup, once paths can be resolved.
fn shell<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .plugin(tauri_plugin_epicenter_folder::init())
        .invoke_handler(tauri::generate_handler![
            commands::flush_done,
            commands::shell_info,
            commands::terminal_run,
            commands::file_log,
            commands::file_show,
            commands::reveal_folder,
        ])
        .on_menu_event(|app, event| {
            if event.id().as_ref() == QUIT_MENU_ITEM && !hold(app) {
                app.exit(0);
            }
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == WINDOW && hold(window.app_handle()) {
                    api.prevent_close();
                }
            }
        })
}

/// Local history, using the repository's author after the owner takes its lock.
/// An origin never turns this app into a syncing folder.
fn folder_config(root: &Path) -> FolderConfig {
    FolderConfig {
        remote: None,
        use_repository_author: true,
        use_repository_origin: false,
        ..FolderConfig::new(
            root,
            Author {
                name: "Honeycrisp".to_string(),
                email: "honeycrisp@localhost".to_string(),
            },
        )
    }
}

/// Register the notes directory for the notes window and hold the shell's own
/// state for that window. Nothing is written inside the directory here: the
/// owner takes its lock on the first attach, and the page sets up a missing
/// layout through it.
fn install<R: Runtime>(app: &AppHandle<R>, root: PathBuf) -> Result<(), String> {
    let root = root::locate(&root)?;
    app.folders().register(ScopeConfig {
        scope: root::SCOPE.to_string(),
        folder: folder_config(&root),
        windows: vec![WINDOW.to_string()],
    })?;
    app.manage(CloseFlush::new());
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

/// The predefined macOS Quit item calls Cocoa's `terminate:` directly, which
/// skips the exit request and so the page's flush. Quit (Cmd+Q) is an item of
/// our own.
#[cfg(target_os = "macos")]
fn quit_menu(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::default(app)?;
    let quit = MenuItem::with_id(
        app,
        QUIT_MENU_ITEM,
        "Quit Honeycrisp",
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    let app_menu = Submenu::with_items(
        app,
        "Honeycrisp",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    menu.remove_at(0)?;
    menu.insert(&app_menu, 0)?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    shell(tauri::Builder::default())
        .setup(|app| {
            let handle = app.handle();
            #[cfg(target_os = "macos")]
            quit_menu(handle)?;
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
        .build(context())
        .expect("error while building the Honeycrisp application")
        .run(|handle, event| {
            // The folder plugin drains and unlocks the folder on exit itself.
            if let RunEvent::ExitRequested { api, .. } = event {
                if hold(handle) {
                    api.prevent_exit();
                }
            }
        });
}
