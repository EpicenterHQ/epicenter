use std::sync::Mutex;

use tauri::image::Image;
use tauri::menu::MenuBuilder;
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, ExitRequestApi, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_epicenter_recorder::is_recording;

use crate::{request_window, BuiltInApp, DesktopAppHandle};

const TRAY_ID: &str = "epicenter-tray";

/// Application Quit owns one standalone native alert. Each page answers its
/// own window close independently, without affecting the pending Quit answer.
#[derive(Default)]
pub(crate) struct QuitRequest(Mutex<QuitState>);

#[derive(Default)]
enum QuitState {
    #[default]
    Ready,
    Prompting,
    Approved,
}

fn quit_message(recording: bool) -> &'static str {
    if recording {
        "A recording is running. Quitting ends it and keeps the audio captured so far. Unsaved changes may be lost."
    } else {
        "Unsaved changes may be lost."
    }
}

/// Called by ExitRequested on the native event thread. Quit always asks;
/// repeated requests share this alert, without querying any folder page.
pub(crate) fn request_quit<R: Runtime>(app: &AppHandle<R>, api: &ExitRequestApi, code: i32) {
    let quit = app.state::<QuitRequest>();
    let mut state = quit
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if matches!(*state, QuitState::Approved) {
        return;
    }
    api.prevent_exit();
    if matches!(*state, QuitState::Prompting) {
        return;
    }
    *state = QuitState::Prompting;
    drop(state);

    let finish_app = app.clone();
    app.dialog()
        .message(quit_message(is_recording(app)))
        .title("Quit Epicenter?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Quit Anyway".into(),
            "Cancel".into(),
        ))
        // Application Quit belongs to the app, so its alert has no window parent.
        .show(move |confirmed| {
            let quit = finish_app.state::<QuitRequest>();
            *quit
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = if confirmed {
                QuitState::Approved
            } else {
                QuitState::Ready
            };
            if confirmed {
                finish_app.exit(code);
            }
        });
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quit_always_warns_even_without_a_recording() {
        assert_eq!(quit_message(false), "Unsaved changes may be lost.");
    }

    #[test]
    fn quit_adds_the_recording_warning_without_promising_pending_changes_saved() {
        let message = quit_message(true);
        assert!(message.contains("recording"));
        assert!(message.contains("keeps the audio captured so far"));
        assert!(message.contains("Unsaved changes may be lost"));
    }
}
