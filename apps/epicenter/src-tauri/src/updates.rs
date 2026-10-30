//! Native-only update checks. Pages have no updater capability or endpoint input.
//! Verified bytes wait for the existing application Quit confirmation.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Update alerts stay with a visible Epicenter window. Ordinary application
/// Quit remains an independent alert; only an update's confirmation uses this.
pub(crate) fn parent_window<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::WebviewWindow<R>> {
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

#[derive(Default)]
pub(crate) struct Updates {
    busy: AtomicBool,
    pending: Mutex<Option<(Update, Vec<u8>)>>,
}

pub(crate) fn has_pending<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<Updates>().pending.lock().unwrap().is_some()
}

fn cancel<R: Runtime>(app: &AppHandle<R>) {
    let updates = app.state::<Updates>();
    updates.pending.lock().unwrap().take();
    updates.busy.store(false, Ordering::Release);
}

/// Cancelling Quit discards a ready candidate without unlocking a check or
/// download that is still running.
pub(crate) fn discard_pending<R: Runtime>(app: &AppHandle<R>) {
    let updates = app.state::<Updates>();
    if updates.pending.lock().unwrap().take().is_some() {
        updates.busy.store(false, Ordering::Release);
    }
}

/// Called only after the person's application Quit confirmation. A failed
/// install keeps the running app open; Tauri restores the bundle on failure.
pub(crate) fn install_pending<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    let pending = app.state::<Updates>().pending.lock().unwrap().take();
    let Some((update, bytes)) = pending else {
        return Ok(false);
    };
    let result = update.install(bytes).map_err(|error| error.to_string());
    app.state::<Updates>().busy.store(false, Ordering::Release);
    result.map(|()| true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::test::{mock_builder, mock_context, noop_assets};

    #[test]
    fn cancelling_quit_during_download_keeps_the_update_busy() {
        let app = mock_builder()
            .manage(Updates::default())
            .build(mock_context(noop_assets()))
            .unwrap();
        app.state::<Updates>().busy.store(true, Ordering::Release);
        discard_pending(app.handle());
        assert!(app.state::<Updates>().busy.load(Ordering::Acquire));
    }
}

pub(crate) fn show_error<R: Runtime>(app: &AppHandle<R>, message: &str) {
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
                cancel(&app);
                show_error(&app, &error.to_string());
            }
            Ok(None) => {
                cancel(&app);
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
                            cancel(&owner);
                            return;
                        }
                        tauri::async_runtime::spawn(async move {
                            match update.download(|_, _| {}, || {}).await {
                                Err(error) => {
                                    cancel(&owner);
                                    show_error(&owner, &error.to_string());
                                }
                                Ok(bytes) => {
                                    *owner.state::<Updates>().pending.lock().unwrap() =
                                        Some((update, bytes));
                                    // The existing Quit owner asks about unsaved work and recording.
                                    owner.exit(0);
                                }
                            }
                        });
                    });
            }
        }
    });
}
