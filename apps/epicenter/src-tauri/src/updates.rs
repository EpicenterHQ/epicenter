//! Native-only update checks. Pages have no updater capability or endpoint input.
//! Verified bytes are installed only after the person confirms, and the app
//! restarts into them.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Update alerts stay with a visible Epicenter window.
fn parent_window<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::WebviewWindow<R>> {
    let windows = app.webview_windows();
    let window = windows
        .values()
        .find(|window| window.is_focused().unwrap_or(false))
        .cloned()
        .or_else(|| app.get_webview_window("folders"))
        .or_else(|| windows.into_values().next());
    if let Some(window) = &window {
        let _ = window.show();
        let _ = window.set_focus();
    }
    window
}

fn message<R: Runtime>(
    app: &AppHandle<R>,
    text: impl Into<String>,
) -> tauri_plugin_dialog::MessageDialogBuilder<R> {
    let dialog = app.dialog().message(text);
    match parent_window(app) {
        Some(window) => dialog.parent(&window),
        None => dialog,
    }
}

/// Whether a check, download, or install question is under way; a second
/// Check for Updates does nothing until it ends.
#[derive(Default)]
pub(crate) struct Updates {
    busy: AtomicBool,
}

fn finish<R: Runtime>(app: &AppHandle<R>) {
    app.state::<Updates>().busy.store(false, Ordering::Release);
}

/// Ask once the verified bytes are here. A failed install keeps the running
/// app open; Tauri restores the bundle on failure.
fn offer_install<R: Runtime>(app: &AppHandle<R>, update: Update, bytes: Vec<u8>) {
    let owner = app.clone();
    message(
        app,
        format!(
            "Epicenter {} is downloaded and ready to install.",
            update.version
        ),
    )
    .title("Install update and restart Epicenter?")
    .buttons(MessageDialogButtons::OkCancelCustom(
        "Install and Restart".into(),
        "Cancel".into(),
    ))
    .show(move |confirmed| {
        if !confirmed {
            finish(&owner);
            return;
        }
        let installed = update.install(bytes);
        finish(&owner);
        match installed {
            Ok(()) => owner.request_restart(),
            Err(error) => show_error(&owner, &error.to_string()),
        }
    });
}

fn show_error<R: Runtime>(app: &AppHandle<R>, message: &str) {
    log::warn!("Epicenter update: {message}");
    self::message(app, message)
        .title("Epicenter update failed")
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

pub(crate) fn check<R: Runtime>(app: &AppHandle<R>) {
    log::info!("Checking for Epicenter updates");
    let updates = app.state::<Updates>();
    if updates.busy.swap(true, Ordering::AcqRel) {
        return;
    }
    let configured = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(|key| key.as_str())
        .is_some_and(|key| !key.is_empty());
    if !configured {
        updates.busy.store(false, Ordering::Release);
        message(
            app,
            "Signed updates are not configured for this local build.",
        )
        .title("Epicenter updates")
        .show(|_| {});
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = async {
            app.updater_builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()?
                .check()
                .await
        }
        .await;
        match result {
            Err(error) => {
                finish(&app);
                show_error(&app, &error.to_string());
            }
            Ok(None) => {
                finish(&app);
                message(&app, "You have the latest Epicenter release.")
                    .title("Epicenter updates")
                    .show(|_| {});
            }
            Ok(Some(update)) => {
                log::info!("Epicenter update {} is available", update.version);
                let message = format!("Epicenter {} is available. Download the update? Your app stays open while it downloads.", update.version);
                let owner = app.clone();
                self::message(&app, message)
                    .title("Epicenter update available")
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "Download".into(),
                        "Cancel".into(),
                    ))
                    .show(move |confirmed| {
                        if !confirmed {
                            finish(&owner);
                            return;
                        }
                        tauri::async_runtime::spawn(async move {
                            match update.download(|_, _| {}, || {}).await {
                                Err(error) => {
                                    finish(&owner);
                                    show_error(&owner, &error.to_string());
                                }
                                Ok(bytes) => offer_install(&owner, update, bytes),
                            }
                        });
                    });
            }
        }
    });
}
