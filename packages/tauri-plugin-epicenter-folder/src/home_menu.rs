//! Native home selection shared by the standalone and Epicenter shells.
//! A selection changes future launches; it never redirects an existing window.

use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::defaults::DesktopPaths;
use crate::homes::{self, Home};

/// Add shell-owned actions, without granting the page a picker or a path API.
/// The shell has already installed its ordinary menu and manages DesktopPaths.
pub fn install<R: Runtime>(app: &AppHandle<R>, homes: &[Home]) -> tauri::Result<()> {
    let menu = app.menu().map(Ok).unwrap_or_else(|| Menu::default(app))?;
    let submenu = Submenu::new(app, "Home Folders", true)?;
    for home in homes {
        submenu.append(&MenuItem::with_id(
            app,
            format!("home-folder:{}", home.key),
            format!("Change {} Home Folder…", home.folder_name),
            true,
            None::<&str>,
        )?)?;
    }
    menu.append(&submenu)?;
    app.set_menu(menu)?;
    let homes = homes.to_vec();
    app.on_menu_event(move |app, event| {
        let Some(key) = event.id().as_ref().strip_prefix("home-folder:") else {
            return;
        };
        let Some(home) = homes.iter().find(|home| home.key == key).copied() else {
            return;
        };
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || choose(&app, home));
    });
    Ok(())
}

fn choose<R: Runtime>(app: &AppHandle<R>, home: Home) {
    let parent = app
        .webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false));
    let title = home.folder_name;
    let (message, kind) = match choose_home(app, home) {
        Ok(None) => return,
        Ok(Some(directory)) => {
            (format!("{title}'s home is now {}.\n\nThe next ordinary launch uses this folder. Existing windows keep their folders. No files were moved.", directory.root().display()), MessageDialogKind::Info)
        }
        Err(error) => (
            format!("The home folder was not changed.\n\n{error}"),
            MessageDialogKind::Error,
        ),
    };
    let message = app
        .dialog()
        .message(message)
        .title(format!("{title} home folder"))
        .kind(kind);
    let message = match parent {
        Some(parent) => message.parent(&parent),
        None => message,
    };
    message.show(|_| {});
}

/// Choose and save an existing home from a blocking worker. Cancellation is
/// distinct from failure so startup recovery can leave the selection untouched.
pub fn choose_home<R: Runtime>(
    app: &AppHandle<R>,
    home: Home,
) -> Result<Option<crate::Directory>, String> {
    let paths = app.state::<DesktopPaths>();
    let initial = homes::home_path(&paths.data_dir, &paths.folder_dir, home)?;
    let initial = if initial.is_dir() {
        initial
    } else {
        paths.folder_dir.clone()
    };
    let Some(picked) = app
        .dialog()
        .file()
        .set_title(format!("Choose {} home folder", home.folder_name))
        .set_directory(initial)
        .blocking_pick_folder()
    else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|error| error.to_string())?;
    homes::select_home(&paths.data_dir, &paths.folder_dir, home, &path).map(Some)
}
