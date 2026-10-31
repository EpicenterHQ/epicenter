//! The macOS application menu, with Quit routed through the guarded exit.

use anyhow::Context;
use tauri::menu::{Menu, MenuItem};
use tauri::{AppHandle, Runtime};

pub(crate) fn install<R: Runtime>(app: &AppHandle<R>) -> anyhow::Result<()> {
    let menu = Menu::default(app)?;
    // Tauri's default app menu ends with AppKit's terminate: item, which
    // bypasses ExitRequested. Keep its title and route Cmd+Q through our
    // guarded exit path, just like the tray's Quit command.
    let application = menu
        .items()?
        .first()
        .and_then(|item| item.as_submenu())
        .cloned()
        .context("default application menu is missing")?;
    let quit = application
        .items()?
        .last()
        .and_then(|item| item.as_predefined_menuitem())
        .cloned()
        .context("default Quit item is missing")?;
    application.remove(&quit)?;
    application.append(&MenuItem::with_id(
        app,
        "quit",
        quit.text()?,
        true,
        Some("Cmd+Q"),
    )?)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id().as_ref() == "quit" {
            app.exit(0);
        }
    });
    Ok(())
}
