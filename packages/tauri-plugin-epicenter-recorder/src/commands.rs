//! The IPC surface: list the microphones, read one's level, start, stop, and
//! cancel one recording, and recover cut-off ones.
//!
//! A microphone is named by the id `inputs` answers, never by the name a
//! WebView gives it: on the desktop the page opens no microphone of its own.
//!
//! A page names a folder scope and a folder-relative path, never a root. The
//! folder plugin decides whether the invoking window was granted the scope and
//! where its directory is; the shared path rule decides whether the path is a
//! data path. Only then is the microphone opened.

use std::sync::Arc;

use epicenter_folder_core::page_files;
use epicenter_folder_core::paths::path_problem;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime, Webview};
use tauri_plugin_epicenter_folder::FolderExt;

use crate::ended::{EndedReason, RecordingSignal};
use crate::error::RecorderError;
use crate::meter::OpenedMeter;
use crate::recorder::{Input, Result, StartedRecording, StoppedRecording};
use crate::{refresh_capturing, Recorders};

/// The directory this window was granted for `scope`.
fn granted_root<R: Runtime>(webview: &Webview<R>, scope: &str) -> Result<std::path::PathBuf> {
    webview
        .folders()
        .granted_root(scope, webview.label())
        .map_err(|refusal| RecorderError::refused(format!("{refusal:?}")))
}

/// The microphones connected now, each with the id to ask for it by. Opens
/// nothing.
#[tauri::command]
#[specta::specta]
pub async fn inputs() -> Result<Vec<Input>> {
    tauri::async_runtime::spawn_blocking(|| crate::recorder::list_inputs(&cpal::default_host()))
        .await
        .map_err(|error| RecorderError::failed(error.to_string()))?
}

/// Open the microphone whose id is `device`, or the system default, to send
/// its level on `levels` until `close_meter`, or until this window's page
/// reloads or the window is destroyed. Nothing is recorded. Microphone access
/// is asked for first, and a denial opens nothing.
#[tauri::command]
#[specta::specta]
pub async fn open_meter<R: Runtime>(
    webview: Webview<R>,
    device: Option<String>,
    levels: Channel<RecordingSignal>,
) -> Result<OpenedMeter> {
    let app = webview.app_handle().clone();
    let owner = webview.label().to_string();
    let recorders = webview.state::<Recorders<R>>();
    let page = recorders.lock().page(&owner);
    let access = recorders.access;
    let id = crate::recorder::next_id();
    let gone_app = app.clone();
    let gone_id = id.clone();
    let on_gone = move || {
        let removed = gone_app
            .try_state::<Recorders<R>>()
            .is_some_and(|recorders| recorders.lock().remove_meter(&gone_id));
        if removed {
            refresh_capturing(&gone_app);
        }
    };
    let (meter, device) = tauri::async_runtime::spawn_blocking(move || {
        access()?;
        crate::meter::open(device.as_deref(), levels, on_gone)
    })
    .await
    .map_err(|error| RecorderError::failed(error.to_string()))??;
    recorders.lock().add_meter(&id, page, &owner, meter)?;
    refresh_capturing(&app);
    Ok(OpenedMeter { id, device })
}

/// Close the meter `id` this window opened, releasing its microphone.
#[tauri::command]
#[specta::specta]
pub async fn close_meter<R: Runtime>(webview: Webview<R>, id: String) -> Result<()> {
    let app = webview.app_handle().clone();
    let result = app
        .state::<Recorders<R>>()
        .lock()
        .close_meter(&id, webview.label());
    refresh_capturing(&app);
    result
}

/// Start recording into `<path>.wav` in the folder this window was granted for
/// `scope`, from the microphone whose id is `device` or the system default. Levels,
/// and an ending nobody asked for, arrive on `signals`.
///
/// The path must be a data path the shared path rule accepts, with nothing at
/// it yet; missing directories on the way are made. Microphone access is
/// asked for before the device is resolved. A refusal opens nothing.
#[tauri::command]
#[specta::specta]
pub async fn start<R: Runtime>(
    webview: Webview<R>,
    scope: String,
    path: String,
    device: Option<String>,
    signals: Channel<RecordingSignal>,
) -> Result<StartedRecording> {
    let app = webview.app_handle().clone();
    let owner = webview.label().to_string();
    let recorders = app.state::<Recorders<R>>();
    // Read on arrival: a page that reloads while this runs is gone by the
    // time it would record, and nobody could stop what it started.
    let page = recorders.lock().page(&owner);

    let root = granted_root(&webview, &scope)?;
    // The path the page named is checked too, so an empty one is not `.wav`.
    if let Some(problem) = path_problem(&path) {
        return Err(RecorderError::refused(format!("{path:?}: {problem}")));
    }
    let relative = format!("{path}.wav");
    let target = page_files::data_path(&root, &relative).map_err(RecorderError::refused)?;
    if std::fs::symlink_metadata(&target).is_ok() {
        return Err(RecorderError::refused(format!(
            "a file is already at {relative}"
        )));
    }
    if let Some((parent, _)) = relative.rsplit_once('/') {
        page_files::mkdir(&root, &root.join(parent)).map_err(RecorderError::refused)?;
    }

    // Asked before any device is resolved, off the async runtime: a person
    // not yet asked answers a system prompt.
    let access = recorders.access;
    tauri::async_runtime::spawn_blocking(access)
        .await
        .map_err(|error| RecorderError::failed(error.to_string()))??;

    let started = {
        let mut recorder = recorders.lock();
        if recorder.page(&owner) != page {
            return Err(RecorderError::not_recording(
                "the page that asked to record has gone",
            ));
        }
        let on_ended_app = app.clone();
        recorder.start(
            device.as_deref(),
            target,
            relative,
            owner,
            signals,
            Arc::new(move |id: &str, reason| end_recording_capture(&on_ended_app, id, reason)),
        )?
    };
    refresh_capturing(&app);
    Ok(started)
}

/// Stop the recording `id` this window started and finalize its file.
#[tauri::command]
#[specta::specta]
pub async fn stop<R: Runtime>(webview: Webview<R>, id: String) -> Result<StoppedRecording> {
    let app = webview.app_handle().clone();
    let result = app
        .state::<Recorders<R>>()
        .lock()
        .stop(&id, webview.label());
    refresh_capturing(&app);
    result
}

/// Cancel the recording `id` this window started, deleting its file.
#[tauri::command]
#[specta::specta]
pub async fn cancel<R: Runtime>(webview: Webview<R>, id: String) -> Result<()> {
    let app = webview.app_handle().clone();
    let result = app
        .state::<Recorders<R>>()
        .lock()
        .cancel(&id, webview.label());
    refresh_capturing(&app);
    result
}

/// Rewrite the header of every WAV under `under` in the folder this window was
/// granted for `scope` whose sizes disagree with its length, and return their
/// folder-relative paths. The recording still being written is left alone.
/// Running it again changes nothing.
#[tauri::command]
#[specta::specta]
pub async fn recover<R: Runtime>(
    webview: Webview<R>,
    scope: String,
    under: String,
) -> Result<Vec<String>> {
    let root = granted_root(&webview, &scope)?;
    let held = webview.state::<Recorders<R>>().lock().held_path();
    tauri::async_runtime::spawn_blocking(move || {
        crate::wav::recover(&root, &under, held.as_deref()).map_err(RecorderError::refused)
    })
    .await
    .map_err(|error| RecorderError::failed(error.to_string()))?
}

/// End a recording's capture because its stream died, and tell the owner why.
///
/// Not a command: the recorder calls this from a thread of its own when the
/// cpal error callback or a failed write ends capture. Nobody asked for this
/// ending, so unlike `stop` and `cancel` there is no call to return through,
/// which is the entire reason the signal exists at all.
///
/// # The captured audio survives, and the signal does not carry it
///
/// The microphone is released and the recording stays exactly where it was:
/// holding the one recorder slot, owned by the same window, with its file
/// intact. The owner finalizes it by calling `stop` or deletes it by calling
/// `cancel`; if its page leaves first, it is finalized for it.
fn end_recording_capture<R: Runtime>(app: &AppHandle<R>, id: &str, reason: EndedReason) {
    let Some(recorders) = app.try_state::<Recorders<R>>() else {
        return;
    };
    // A no-op when the id is not the held recording or its capture already
    // ended: the stream error may have arrived after the owner started
    // another recording, and cpal may report the same failure more than once.
    let Some(signals) = recorders.lock().end_capture(id, reason) else {
        return;
    };
    log::warn!("Recording {id} lost its capture ({reason:?})");
    refresh_capturing(app);
    // Dropped rather than propagated: the capture is already over and there is
    // nothing to repair here. A page that misses it learns the same from its
    // `stop` answer.
    if let Err(error) = signals.send(RecordingSignal::Ended { reason }) {
        log::warn!("Failed to tell the owner that recording {id} ended: {error}");
    }
}
