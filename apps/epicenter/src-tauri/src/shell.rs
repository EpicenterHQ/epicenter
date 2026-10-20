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

use crate::{request_window, BuiltInApp, DesktopAppHandle};

const TRAY_ID: &str = "epicenter-tray";

#[derive(Default)]
pub(crate) struct QuitRequest(Mutex<QuitState>);

#[derive(Default)]
struct QuitState {
    checking: bool,
    approved: bool,
}

#[derive(serde::Deserialize)]
struct SaveReply {
    id: u64,
    label: String,
    pending: bool,
}

static NEXT_CHECK: AtomicU64 = AtomicU64::new(1);

/// Ask every mounted folder page for its current save status before one Quit.
pub(crate) fn request_quit<R: Runtime>(app: &AppHandle<R>, api: &ExitRequestApi, code: i32) {
    let quit = app.state::<QuitRequest>();
    let mut state = quit.0.lock().unwrap();
    if state.approved {
        state.approved = false;
        return;
    }
    api.prevent_exit();
    if state.checking {
        return;
    }
    state.checking = true;
    drop(state);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if needs_confirmation(&app).await {
            let windows = app.webview_windows();
            let parent = windows
                .values()
                .find(|window| window.is_focused().unwrap_or(false))
                .or_else(|| windows.values().find(|window| window.is_visible().unwrap_or(false)))
                .or_else(|| windows.values().next());
            let Some(parent) = parent else {
                finish_quit(&app, code, true);
                return;
            };
            if let Err(error) = parent.show().and_then(|()| parent.set_focus()) {
                log::warn!("could not reveal the Quit confirmation window: {error}");
            }
            let finish_app = app.clone();
            app.dialog()
                .message("A change has not saved yet. Quit anyway?")
                .parent(parent)
                .title("Quit Epicenter?")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Quit Anyway".into(),
                    "Cancel".into(),
                ))
                .show(move |confirmed| finish_quit(&finish_app, code, confirmed));
        } else {
            finish_quit(&app, code, true);
        }
    });
}

fn finish_quit<R: Runtime>(app: &AppHandle<R>, code: i32, confirmed: bool) {
    let quit = app.state::<QuitRequest>();
    let mut state = quit.0.lock().unwrap();
    state.checking = false;
    if confirmed {
        state.approved = true;
        drop(state);
        app.exit(code);
    }
}

async fn needs_confirmation<R: Runtime>(app: &AppHandle<R>) -> bool {
    let windows = folder_windows(app);
    if windows.is_empty() {
        return false;
    }

    let id = NEXT_CHECK.fetch_add(1, Ordering::Relaxed);
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
