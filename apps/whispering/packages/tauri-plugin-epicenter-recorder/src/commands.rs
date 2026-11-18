//! The IPC surface: list the microphones, read one's level, start and stop
//! one recording, and recover cut-off ones.
//!
//! A microphone is named by the id `inputs` answers, never by the name a
//! WebView gives it: on the desktop the page opens no microphone of its own.
//!
//! A page opens the Data root through the folder plugin, then names a
//! folder-relative path. The folder plugin
//! answers the folder that root reached; the shared path rule decides whether
//! the path is a data path. Only then is the microphone opened.

use std::path::PathBuf;
use std::sync::Arc;

use epicenter_folder_core::page_files;
use epicenter_folder_core::paths::path_problem;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime, Webview};
use tauri_plugin_epicenter_folder::{Root, RootsExt};

use crate::ended::{EndedReason, RecordingSignal};
use crate::error::RecorderError;
use crate::meter::OpenedMeter;
use crate::recorder::{Input, Result, StoppedRecording};
use crate::staging::Recovery;
use crate::{refresh_capturing, Recorders};

/// The folder Data reached when the app opened it (`open_root`), read
/// once for this operation, so nothing that happens meanwhile redirects it.
/// Data must already be open.
fn opened_root<R: Runtime>(webview: &Webview<R>) -> Result<PathBuf> {
    webview
        .roots()
        .opened(&Root::Data)
        .map(|directory| directory.root().to_path_buf())
        .map_err(|refusal| RecorderError::refused(refusal.to_string()))
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
    let opening_app = app.clone();
    let opening_owner = owner.clone();
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
        // Permission may outlive the page. Like recording start, keep the
        // ownership check and microphone opening under the recorder lock.
        let recorders = opening_app.state::<Recorders<R>>();
        let recorder = recorders.lock();
        recorder.require_running()?;
        if recorder.page(&opening_owner) != page {
            return Err(RecorderError::not_recording(
                "the page that asked to open a meter has gone",
            ));
        }
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

/// Start recording `<path>.webm` in Data (`opened_root`), from the
/// microphone whose id is `device` or the system default; answers the id to
/// stop it by. An ending nobody asked for arrives on `signals`.
///
/// The path must be a data path the shared path rule accepts, with nothing at
/// `<path>.webm` yet. While it records, it is a WebM beside that path under
/// a new reserved name (`staging::pending`), written a second at a time;
/// `stop` finishes it and places it at its path. Missing directories on the
/// way are made.
/// Microphone access is asked for before the device is resolved. A refusal
/// opens nothing.
#[tauri::command]
#[specta::specta]
pub async fn start<R: Runtime>(
    webview: Webview<R>,
    path: String,
    device: Option<String>,
    signals: Channel<RecordingSignal>,
) -> Result<String> {
    let app = webview.app_handle().clone();
    let owner = webview.label().to_string();
    let recorders = app.state::<Recorders<R>>();
    // Read on arrival: a page that reloads while this runs is gone by the
    // time it would record, and nobody could stop what it started.
    let page = recorders.lock().page(&owner);

    let root = opened_root(&webview)?;
    // The path the page named is checked too, so an empty one is not `.webm`.
    if let Some(problem) = path_problem(&path) {
        return Err(RecorderError::refused(format!("{path:?}: {problem}")));
    }
    // Where it lands.
    let relative = format!("{path}.webm");
    let target = page_files::data_path(&root, &relative).map_err(RecorderError::refused)?;
    if std::fs::symlink_metadata(&target).is_ok() {
        return Err(RecorderError::refused(format!(
            "a file is already at {relative}"
        )));
    }
    if let Some((parent, _)) = path.rsplit_once('/') {
        page_files::mkdir(&root, &root.join(parent)).map_err(RecorderError::refused)?;
    }
    let pending = crate::staging::pending(&root, &path).map_err(RecorderError::refused)?;

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
            pending,
            root,
            path,
            owner,
            signals,
            Arc::new(move |id: &str, reason| end_recording_capture(&on_ended_app, id, reason)),
        )?
    };
    refresh_capturing(&app);
    Ok(started)
}

/// Stop the recording `id` this window started, finish its file, and place it
/// at its path, never over a file there; answers where it is and how long it
/// plays. Finishing writes the last second, the Cues, and the length, so it
/// takes the same few milliseconds for a recording of any length. A file
/// that cannot be placed stays beside its path under its reserved name, and
/// the refusal says why.
#[tauri::command]
#[specta::specta]
pub async fn stop<R: Runtime>(webview: Webview<R>, id: String) -> Result<StoppedRecording> {
    let app = webview.app_handle().clone();
    let stopped = app
        .state::<Recorders<R>>()
        .lock()
        .stop(&id, webview.label());
    refresh_capturing(&app);
    stopped
}

/// Finish and place every recording under `under` in Data (`opened_root`)
/// that a quit or a crash left beside its path (or, from an older build, in
/// the folder's `.epicenter/recordings`), and answer each one placed
/// (`recovered`), by folder-relative path with how long it plays
/// (`durationMs`, so a page never reads the audio back to measure it), and
/// each one left pending because another file is at its path (`unplaced`),
/// with where its audio is. A page runs it before it
/// lists, plays, or transcribes a recording, and says what is unplaced. The
/// recording still being written is left alone. Running it again places
/// nothing more.
#[tauri::command]
#[specta::specta]
pub async fn recover<R: Runtime>(webview: Webview<R>, under: String) -> Result<Recovery> {
    let root = opened_root(&webview)?;
    let app = webview.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Asked per file, under the recorder lock: a `start` holds that lock
        // from creating its file until the recording is held, so a file
        // listed here and live is always named.
        let held =
            |path: &std::path::Path| app.state::<Recorders<R>>().lock().held_path() == Some(path);
        crate::staging::recover(&root, &under, held).map_err(RecorderError::refused)
    })
    .await
    .map_err(|error| RecorderError::failed(error.to_string()))?
}

/// End a recording's capture because its stream died, and tell the owner why.
///
/// Not a command: the recorder calls this from a thread of its own when the
/// cpal error callback or a failed write ends capture. Nobody asked for this
/// ending, so unlike `stop` there is no call to return through,
/// which is the entire reason the signal exists at all.
///
/// # The captured audio survives, and the signal does not carry it
///
/// The microphone is released and the recording stays exactly where it was:
/// holding the one recorder slot, owned by the same window, with its file
/// intact. The owner finalizes it by calling `stop`; if its page leaves
/// first, it is finalized for it.
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
