use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::image::Image;
use tauri::menu::MenuBuilder;
use tauri::tray::TrayIconBuilder;
use tauri::{
    AppHandle, Emitter, EventTarget, ExitRequestApi, Listener, Manager, Runtime, WebviewWindow,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_epicenter_folder::FolderExt;
use tauri_plugin_epicenter_recorder::recording_owner;

use crate::{request_window, BuiltInApp, DesktopAppHandle};

const TRAY_ID: &str = "epicenter-tray";

/// Application Quit owns one check and confirmation across all folder windows.
/// Window close is answered independently by each page.
#[derive(Default)]
pub(crate) struct QuitRequest(Mutex<QuitState>);

#[derive(Default)]
enum QuitState {
    #[default]
    Ready,
    Checking {
        id: u64,
        parent: Option<String>,
    },
    Approved,
}

/// Whether the invoking window owns a recording that closing would end.
/// The recorder remains the source of truth; the page stores no copy.
#[tauri::command]
#[specta::specta]
pub(crate) fn window_is_recording<R: Runtime>(app: AppHandle<R>, window: tauri::Window<R>) -> bool {
    recording_owner(&app).as_deref() == Some(window.label())
}

#[derive(serde::Deserialize)]
struct SaveReply {
    id: u64,
    label: String,
    pending: bool,
}

static NEXT_CHECK: AtomicU64 = AtomicU64::new(1);

fn quit_message(recording: bool, unsaved: bool) -> Option<&'static str> {
    match (recording, unsaved) {
        (false, false) => None,
        (true, false) => Some(
            "A recording is running. Quitting ends it and keeps the audio captured so far.",
        ),
        (false, true) => Some("Changes may not have saved. Quit anyway?"),
        (true, true) => Some(
            "A recording is running, and changes may not have saved. Quitting ends it and keeps the audio captured so far.",
        ),
    }
}

/// Ask every mounted folder page for its current save status and the recorder
/// whether it is capturing. Repeated Quit requests join this one decision.
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
    if matches!(*state, QuitState::Checking { .. }) {
        return;
    }
    let id = NEXT_CHECK.fetch_add(1, Ordering::Relaxed);
    *state = QuitState::Checking { id, parent: None };
    drop(state);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let unsaved = needs_confirmation(&app, id).await;
        // Read after the pages answer so a recording started meanwhile counts.
        let Some(message) = quit_message(recording_owner(&app).is_some(), unsaved) else {
            finish_quit(&app, id, code, true);
            return;
        };
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
        let Some(parent) = parent else {
            finish_quit(&app, id, code, true);
            return;
        };
        {
            let quit = app.state::<QuitRequest>();
            let mut state = quit
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let QuitState::Checking {
                id: current,
                parent: owner,
            } = &mut *state
            else {
                return;
            };
            if *current != id {
                return;
            }
            *owner = Some(parent.label().to_owned());
        }
        // The parent may have closed while the pages answered. A destroyed
        // parent need not deliver a dialog callback; release this Quit attempt.
        if app.get_webview_window(parent.label()).is_none() {
            finish_quit(&app, id, code, false);
            return;
        }
        if let Err(error) = parent.show().and_then(|()| parent.set_focus()) {
            log::warn!("could not reveal the Quit confirmation window: {error}");
        }
        let finish_app = app.clone();
        app.dialog()
            .message(message)
            .parent(parent)
            .title("Quit Epicenter?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Quit Anyway".into(),
                "Cancel".into(),
            ))
            .show(move |confirmed| finish_quit(&finish_app, id, code, confirmed));
    });
}

/// An independently confirmed window close can remove the Quit sheet's parent.
/// Its missing or late answer must not strand or approve another Quit attempt.
pub(crate) fn quit_parent_ended<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let quit = app.state::<QuitRequest>();
    let mut state = quit
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if matches!(&*state, QuitState::Checking { parent: Some(parent), .. } if parent == label) {
        *state = QuitState::Ready;
    }
}

fn finish_quit<R: Runtime>(app: &AppHandle<R>, id: u64, code: i32, confirmed: bool) {
    let quit = app.state::<QuitRequest>();
    let mut state = quit
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !matches!(*state, QuitState::Checking { id: current, .. } if current == id) {
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

async fn needs_confirmation<R: Runtime>(app: &AppHandle<R>, id: u64) -> bool {
    let windows = folder_windows(app);
    if windows.is_empty() {
        return false;
    }

    let (sender, mut replies) = tokio::sync::mpsc::unbounded_channel();
    let listener = app.listen_any("epicenter://quit-status", move |event| {
        if let Ok(reply) = serde_json::from_str::<SaveReply>(event.payload()) {
            if reply.id == id {
                let _ = sender.send(reply);
            }
        }
    });
    let mut waiting: HashSet<String> = windows
        .iter()
        .map(|window| window.label().to_owned())
        .collect();
    for window in &windows {
        if let Err(error) = app.emit_to(
            EventTarget::webview_window(window.label()),
            "epicenter://quit-check",
            id,
        ) {
            log::warn!("could not check save status of {}: {error}", window.label());
            app.unlisten(listener);
            return true;
        }
    }
    let result = tokio::time::timeout(Duration::from_millis(750), async {
        while !waiting.is_empty() {
            let Some(reply) = replies.recv().await else {
                return true;
            };
            if !waiting.remove(&reply.label) {
                continue;
            }
            if reply.pending {
                return true;
            }
        }
        false
    })
    .await;
    app.unlisten(listener);
    // A page that did not answer, or a folder window opened during the check,
    // leaves the answer uncertain, so show the confirmation.
    result.unwrap_or(true)
        || folder_windows(app).iter().any(|window| {
            !windows
                .iter()
                .any(|checked| checked.label() == window.label())
        })
}

fn folder_windows<R: Runtime>(app: &AppHandle<R>) -> Vec<WebviewWindow<R>> {
    app.webview_windows()
        .into_values()
        .filter(|window| app.folders().bound(window.label()).is_ok())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_closed_quit_parent_releases_the_attempt_and_late_answers_cannot_end_its_replacement() {
        let app = tauri::test::mock_builder()
            .manage(QuitRequest(Mutex::new(QuitState::Checking {
                id: 1,
                parent: Some("closing".into()),
            })))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let quit = app.state::<QuitRequest>();
        quit_parent_ended(app.handle(), "another-window");
        assert!(matches!(
            *quit.0.lock().unwrap(),
            QuitState::Checking { id: 1, .. }
        ));
        quit_parent_ended(app.handle(), "closing");
        assert!(matches!(*quit.0.lock().unwrap(), QuitState::Ready));
        *quit.0.lock().unwrap() = QuitState::Checking {
            id: 2,
            parent: Some("remaining".into()),
        };
        for answer in [false, true] {
            finish_quit(app.handle(), 1, 0, answer);
            assert!(matches!(
                *quit.0.lock().unwrap(),
                QuitState::Checking { id: 2, .. }
            ));
        }
        finish_quit(app.handle(), 2, 0, false);
        assert!(matches!(*quit.0.lock().unwrap(), QuitState::Ready));
    }

    #[test]
    fn a_saved_application_with_no_recording_needs_no_quit_warning() {
        assert_eq!(quit_message(false, false), None);
    }

    #[test]
    fn quit_warns_about_unsaved_or_unknown_saves_without_claiming_a_save_will_finish() {
        let message = quit_message(false, true).unwrap();
        assert!(message.contains("may not have saved"));
        assert!(!message.contains("recording"));
    }

    #[test]
    fn quit_combines_a_recording_and_unsaved_input_in_one_warning() {
        for unsaved in [false, true] {
            let message = quit_message(true, unsaved).unwrap();
            assert!(message.contains("recording"));
            assert!(message.contains("keeps the audio captured so far"));
            assert_eq!(message.contains("may not have saved"), unsaved);
        }
    }
}
