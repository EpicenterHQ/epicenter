//! The Honeycrisp desktop shell.
//!
//! The shell opens one window on the bundled notes page and gives that window
//! two things:
//!
//! - Its folder, through the shared folder plugin. The shell registers one
//!   page-engine scope for the window `main`: the root from `HONEYCRISP_ROOT`
//!   or the default, and the fallback author. The page names the scope and
//!   runs `@epicenter/folder`'s own engine over the directory the plugin
//!   grants it: it reads through the fs plugin, and the folder plugin makes
//!   every change and runs the folder's `git` for it. The engine reads the
//!   author and any `origin` from Git's configuration.
//! - Honeycrisp's own commands (`commands.rs`): close consent, the terminal,
//!   per-file history, and reveal.
//!
//! Pending writes exist only in the page, so every way out asks it first: the
//! window's close button, an exit request from the runtime, the macOS Quit
//! menu item, and on macOS a quit from the system: the Dock, a logout, an
//! Apple Event (`quit.rs`). `close.rs` decides; nothing here approves a close
//! for a page that holds its folder.

use std::path::{Path, PathBuf};
use std::sync::Arc;

#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{
    App, AppHandle, Manager, RunEvent, Runtime, Url, WebviewUrl, WebviewWindowBuilder,
    WindowEvent, Wry,
};
use tauri_plugin_epicenter_folder::{Author, FolderConfig, FolderExt, ScopeConfig};

/// Public for `examples/harness.rs`, which drives the gate for the page
/// client's tests.
pub mod close;

mod command_names;
mod commands;
mod history;
mod process;
#[cfg(target_os = "macos")]
mod quit;
mod reveal;
mod root;
mod terminal;

#[cfg(test)]
mod testing;
#[cfg(test)]
mod tests;

pub use command_names::COMMANDS;

use close::CloseGate;
use commands::{hold, Shell, WINDOW};
use terminal::Terminal;

const QUIT_MENU_ITEM: &str = "quit-notes";

/// The plugins, the commands, and the close routing of the notes window. The
/// folder and the window are added in setup, once paths can be resolved.
fn shell<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .plugin(tauri_plugin_epicenter_folder::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::close_register,
            commands::close_opened,
            commands::close_approve,
            commands::close_decline,
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

/// The notes folder, opened by the page's own engine. The engine reads the
/// author and `origin` from Git's configuration; this author is the fallback
/// for whichever of `user.name` and `user.email` is not configured.
fn folder_config(root: &Path) -> FolderConfig {
    FolderConfig {
        page_engine: true,
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
/// plugin takes its lock on the first grant, and the page sets up a missing
/// layout through it.
fn install<R: Runtime>(app: &AppHandle<R>, root: PathBuf) -> Result<(), String> {
    let root = root::locate(&root)?;
    app.folders().register(ScopeConfig {
        scope: root::SCOPE.to_string(),
        folder: folder_config(&root),
        windows: vec![WINDOW.to_string()],
    })?;
    app.manage(Shell {
        gate: CloseGate::new(),
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

/// The predefined macOS Quit item calls Cocoa's `terminate:` directly,
/// bypassing the preventable exit request, so Quit is an item of our own.
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

/// The notes window's builder, before it is built.
pub type NotesWindow<'a> = WebviewWindowBuilder<'a, Wry, App<Wry>>;

/// The app `run` starts, built and not yet running. `window` receives the
/// notes window's builder last, just before the window is built; `run` adds
/// nothing. Public for `examples/quit`, which runs this same app on a
/// fixture page; nothing else should call it.
#[doc(hidden)]
pub fn build<W>(window: W) -> tauri::Result<App<Wry>>
where
    W: for<'a> FnOnce(NotesWindow<'a>) -> NotesWindow<'a> + Send + 'static,
{
    shell(tauri::Builder::default())
        .setup(move |app| {
            let handle = app.handle();
            // First: a system quit must reach the gate before the page can
            // start a write, and the app does not start without that.
            #[cfg(target_os = "macos")]
            quit::install(handle)?;
            #[cfg(target_os = "macos")]
            quit_menu(handle)?;
            let root = root::choose(std::env::var_os("HONEYCRISP_ROOT"), || {
                handle
                    .path()
                    .home_dir()
                    .map_err(|cause| format!("resolve the home directory: {cause}"))
            })?;
            install(handle, root)?;
            let notes = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("index.html".into()))
                .title("Honeycrisp")
                .inner_size(1280.0, 820.0)
                .min_inner_size(900.0, 560.0)
                .on_navigation(is_app_page);
            window(notes).build()?;
            Ok(())
        })
        .build(context())
}

/// Hold an exit request back while the page holds its folder; whether it was
/// held. The page settles its writes before it approves. On exit the folder
/// plugin refuses new page work, waits for the native file and Git commands
/// already running, and unlocks the folder.
/// Public for `examples/quit`, like `build`.
#[doc(hidden)]
pub fn hold_exit(handle: &AppHandle, event: &RunEvent) -> bool {
    match event {
        RunEvent::ExitRequested { api, .. } if hold(handle) => {
            api.prevent_exit();
            true
        }
        _ => false,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    build(|window| window)
        .expect("error while building the Honeycrisp application")
        .run(|handle, event| {
            hold_exit(handle, &event);
        });
}
