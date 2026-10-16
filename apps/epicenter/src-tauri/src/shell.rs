use tauri::image::Image;
use tauri::menu::MenuBuilder;
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Wry};
use tauri_plugin_autostart::ManagerExt as AutostartExt;

use crate::{request_window, BuiltInApp, DesktopAppHandle};

const TRAY_ID: &str = "epicenter-tray";

pub fn create_tray(app: &DesktopAppHandle) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text("show-folders", "Show Folders")
        .text("show-settings", "Show Settings")
        .separator()
        .text("quit", "Quit Epicenter")
        .build()?;
    let icon = tray_icon(false)?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Epicenter")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show-folders" => request_window(app, BuiltInApp::Folders),
            "show-settings" => request_window(app, BuiltInApp::Home),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

pub fn set_tray_recording_state(app: &AppHandle, recording: bool) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    match tray_icon(recording).and_then(|icon| tray.set_icon(Some(icon))) {
        Ok(()) => {}
        Err(error) => log::warn!("update Epicenter tray recording state: {error}"),
    }
}

fn tray_icon(recording: bool) -> tauri::Result<Image<'static>> {
    let bytes = if recording {
        include_bytes!("../recorder-state-icons/red_large_square.png").as_slice()
    } else {
        include_bytes!("../recorder-state-icons/studio_microphone.png").as_slice()
    };
    Image::from_bytes(bytes)
}

#[tauri::command]
#[specta::specta]
pub fn is_autostart_enabled(app: AppHandle<Wry>) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn set_autostart_enabled(app: AppHandle<Wry>, enabled: bool) -> Result<(), String> {
    if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    }
    .map_err(|error| error.to_string())
}
