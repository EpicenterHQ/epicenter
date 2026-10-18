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
//! - Honeycrisp's own commands (`commands.rs`): the terminal, per-file
//!   history, and reveal.
//!
//! Closing the window is the page's: its close handler awaits the notes'
//! `close()`, which lets the saves in flight land, and then Tauri destroys
//! the window. The app exits when its one window is gone. The macOS Quit menu
//! item closes that window the same way. Nothing here waits on the page or
//! sets a timer; a slow close shows "Still saving…" in the page, with Close
//! anyway.
//!
//! A quit from the system on macOS (the Dock, a logout, a shutdown, an Apple
//! Event) is AppKit's `terminate:`. Tao's application delegate implements
//! `applicationWillTerminate:` and not `applicationShouldTerminate:`, so that
//! quit reaches the run loop as `RunEvent::Exit` with no window closed first.
//! The page is not asked then. The folder plugin drains the writes it already
//! accepted on `RunEvent::Exit`; a save the page still held in that instant is
//! lost. The shell never cancels a logout or a shutdown.

use std::path::{Path, PathBuf};
use std::sync::Arc;

#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
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

const QUIT_MENU_ITEM: &str = "quit-notes";

/// The plugin, the commands, and Quit, which closes the notes window. The
/// folder and the window are added in setup, once paths can be resolved.
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
        .on_menu_event(|app, event| {
            if event.id().as_ref() == QUIT_MENU_ITEM {
                quit(app);
            }
        })
}

/// Close the notes window, which runs its page's close handler; the app exits
/// once it is gone. With no window open, exit now.
fn quit<R: Runtime>(app: &AppHandle<R>) {
    match app.get_webview_window(WINDOW) {
        Some(window) => {
            if window.close().is_err() {
                app.exit(0);
            }
        }
        None => app.exit(0),
    }
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
/// ends the app without closing its window, so the page would not finish its
/// saves. Quit (Cmd+Q) is an item of our own, which closes the window.
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
        // The folder plugin drains and unlocks the folder on exit itself.
        .run(|_, _| {});
}
