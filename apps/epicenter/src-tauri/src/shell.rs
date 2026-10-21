use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::image::Image;
use tauri::menu::MenuBuilder;
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, ExitRequestApi, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_epicenter_recorder::recording_owner;

use crate::{request_window, BuiltInApp, DesktopAppHandle};

const TRAY_ID: &str = "epicenter-tray";

/// Application Quit always asks once, independently of each window’s close.
/// Window close is answered independently by each page.
#[derive(Default)]
pub(crate) struct QuitRequest(Mutex<QuitState>);

#[derive(Default)]
enum QuitState {
    #[default]
    Ready,
    Prompting {
        id: u64,
        parent: Option<String>,
    },
    Approved,
}

static NEXT_QUIT: AtomicU64 = AtomicU64::new(1);

fn quit_message(recording: bool) -> &'static str {
    if recording {
        "A recording is running. Quitting ends it and keeps the audio captured so far. Unsaved changes may be lost."
    } else {
        "Unsaved changes may be lost."
    }
}

/// Called by ExitRequested on the native event thread. Quit always asks;
/// repeated requests share this sheet, without querying any folder page.
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
    if matches!(*state, QuitState::Prompting { .. }) {
        return;
    }
    // Native getters do not yield the event thread. Choose and record the
    // parent before showing or focusing it, which can deliver window events.
    let windows = app.webview_windows();
    let parent = windows
        .values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| {
            windows
                .values()
                .find(|window| window.is_visible().unwrap_or(false))
        })
        .or_else(|| windows.values().next());
    let id = NEXT_QUIT.fetch_add(1, Ordering::Relaxed);
    *state = QuitState::Prompting {
        id,
        parent: parent.map(|window| window.label().to_owned()),
    };
    drop(state);

    let mut dialog = app
        .dialog()
        .message(quit_message(recording_owner(app).is_some()))
        .title("Quit Epicenter?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Quit Anyway".into(),
            "Cancel".into(),
        ));
    if let Some(parent) = parent {
        if let Err(error) = parent.show().and_then(|()| parent.set_focus()) {
            log::warn!("could not reveal the Quit confirmation window: {error}");
        }
        dialog = dialog.parent(parent);
    }
    let finish_app = app.clone();
    dialog.show(move |confirmed| finish_quit(&finish_app, id, code, confirmed));
}

/// An independently confirmed window close can remove the Quit sheet's parent.
/// Its missing or late answer must not strand or approve another Quit attempt.
pub(crate) fn quit_parent_ended<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let quit = app.state::<QuitRequest>();
    let mut state = quit
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if matches!(&*state, QuitState::Prompting { parent: Some(parent), .. } if parent == label) {
        *state = QuitState::Ready;
    }
}

fn finish_quit<R: Runtime>(app: &AppHandle<R>, id: u64, code: i32, confirmed: bool) {
    let quit = app.state::<QuitRequest>();
    let mut state = quit
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !matches!(*state, QuitState::Prompting { id: current, .. } if current == id) {
        return;
    }
    *state = if confirmed {
        QuitState::Approved
    } else {
        QuitState::Ready
    };
    drop(state);
    if confirmed {
        app.exit(code);
    }
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
    fn a_closed_quit_parent_releases_the_attempt_and_late_answers_cannot_end_its_replacement() {
        let app = tauri::test::mock_builder()
            .manage(QuitRequest(Mutex::new(QuitState::Prompting {
                id: 1,
                parent: Some("closing".into()),
            })))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let quit = app.state::<QuitRequest>();
        quit_parent_ended(app.handle(), "another-window");
        assert!(matches!(
            *quit.0.lock().unwrap(),
            QuitState::Prompting { id: 1, .. }
        ));
        quit_parent_ended(app.handle(), "closing");
        assert!(matches!(*quit.0.lock().unwrap(), QuitState::Ready));
        *quit.0.lock().unwrap() = QuitState::Prompting {
            id: 2,
            parent: Some("remaining".into()),
        };
        for answer in [false, true] {
            finish_quit(app.handle(), 1, 0, answer);
            assert!(matches!(
                *quit.0.lock().unwrap(),
                QuitState::Prompting { id: 2, .. }
            ));
        }
        finish_quit(app.handle(), 2, 0, false);
        assert!(matches!(*quit.0.lock().unwrap(), QuitState::Ready));
    }

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
