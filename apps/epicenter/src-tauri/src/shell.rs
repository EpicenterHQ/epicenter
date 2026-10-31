use tauri::menu::MenuBuilder;
use tauri::tray::TrayIconBuilder;

use crate::{request_window, BuiltInApp, DesktopAppHandle};

const TRAY_ID: &str = "epicenter-tray";

pub fn create_tray(app: &DesktopAppHandle) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let menu = app
            .menu()
            .ok_or_else(|| anyhow::anyhow!("application menu is missing"))?;
        if let Some(tauri::menu::MenuItemKind::Submenu(application)) = menu.items()?.first() {
            application.insert(
                &tauri::menu::MenuItem::with_id(
                    app,
                    "check-updates",
                    "Check for Updates...",
                    true,
                    None::<&str>,
                )?,
                1,
            )?;
        }
    }
    app.on_menu_event(|app, event| match event.id().as_ref() {
        "show-folders" => request_window(app, BuiltInApp::Folders),
        "show-settings" => request_window(app, BuiltInApp::Home),
        "check-updates" => crate::updates::check(app),
        #[cfg(not(target_os = "macos"))]
        "quit" => app.exit(0),
        _ => {}
    });
    let menu = MenuBuilder::new(app)
        .text("show-folders", "Show Folders")
        .text("show-settings", "Show Settings")
        .text("check-updates", "Check for Updates...")
        .separator()
        .text("quit", "Quit Epicenter")
        .build()?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.tooltip("Epicenter").menu(&menu).build(app)?;
    Ok(())
}
