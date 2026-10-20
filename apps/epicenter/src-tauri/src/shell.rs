use std::sync::Mutex;

use tauri::image::Image;
use tauri::menu::MenuBuilder;
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, ExitRequestApi, Manager, Runtime, WebviewWindow};
use tauri_plugin_epicenter_folder::FolderExt;

use crate::{request_window, BuiltInApp, DesktopAppHandle};

const TRAY_ID: &str = "epicenter-tray";

#[derive(Default)]
pub(crate) struct PendingQuit(Mutex<Option<i32>>);

/// Quit uses the same save and unfinished-input checks as closing a window.
/// Settings and the launcher hide on close, so they do not participate.
pub(crate) fn request_quit<R: Runtime>(app: &AppHandle<R>, api: &ExitRequestApi, code: i32) {
    let windows = folder_windows(app);
    if windows.is_empty() {
        return;
    }
    api.prevent_exit();
    *app.state::<PendingQuit>().0.lock().unwrap() = Some(code);
    for window in windows {
        if let Err(error) = window.close() {
            log::error!(
                "could not request close of {} before quitting: {error}",
                window.label()
            );
        }
    }
}

/// A refused close leaves its window alive. Never exit while any folder
/// window remains, including one opened after the original quit request.
pub(crate) fn window_destroyed<R: Runtime>(app: &AppHandle<R>) {
    let code = *app.state::<PendingQuit>().0.lock().unwrap();
    if let Some(code) = code {
        if folder_windows(app).is_empty() {
            app.exit(code);
        }
    }
}

fn folder_windows<R: Runtime>(app: &AppHandle<R>) -> Vec<WebviewWindow<R>> {
    app.webview_windows()
        .into_values()
        .filter(|window| {
            window.label() != BuiltInApp::Home.id() && app.folders().bound(window.label()).is_ok()
        })
        .collect()
}

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
