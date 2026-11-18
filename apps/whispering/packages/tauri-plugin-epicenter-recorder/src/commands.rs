//! The IPC surface: list the microphones, read one's level, start and stop
//! one recording, and recover cut-off ones.
//!
//! A microphone is named by the id `inputs` answers, never by the name a
//! WebView gives it: on the desktop the page opens no microphone of its own.
//!
//! A page names its folder by its absolute path and a recording by its id.
//! The folder must be one the app's file system scope allows
//! (`tauri-plugin-fs`): the default folder the shell allows at start, or one
//! the person picked in the folder dialog. The id must be one plain name
//! (`takes::check_id`). Only then is the microphone opened. The take is
//! recorded in `local/recording/` and placed in the folder at Stop
//! (`takes`).

use std::path::PathBuf;
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime, Webview};
use tauri_plugin_fs::FsExt;

use crate::ended::{EndedReason, RecordingSignal};
use crate::error::RecorderError;
use crate::meter::OpenedMeter;
use crate::recorder::{Input, Result, StoppedRecording};
use crate::takes::{self, Recovery};
use crate::{refresh_capturing, Recorders};

/// The folder at the absolute path `folder`, when the app's file system
/// scope allows it: the default folder, or one the folder dialog granted.
/// A page cannot widen that scope, so it cannot point the recorder anywhere
/// else.
fn allowed_folder<R: Runtime>(webview: &Webview<R>, folder: &str) -> Result<PathBuf> {
    let root = PathBuf::from(folder);
    if !root.is_absolute() {
        return Err(RecorderError::refused(format!(
            "{folder:?} is not an absolute path"
        )));
    }
    let allowed = webview
        .try_fs_scope()
        .is_some_and(|scope| scope.is_allowed(&root));
    if !allowed {
        return Err(RecorderError::refused(format!(
            "{folder:?} is not a folder this app may write"
        )));
    }
    Ok(root)
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

/// Start recording the take `id` for the folder `dir` (`allowed_folder`),
/// from the microphone whose id is `device` or the system default. An
/// ending nobody asked for arrives on `signals`.
///
/// `id` must be one plain name, with no audio at `recordings/<id>.webm` in
/// the folder and no take of it yet. The take is recorded into
/// `<appLocalDataDir>/local/recording/<id>.webm`, written a second at a
/// time; `stop` finishes it and places it in the folder. Microphone access
/// is asked for before the device is resolved. A refusal opens nothing.
#[tauri::command]
#[specta::specta]
pub async fn start<R: Runtime>(
    webview: Webview<R>,
    dir: String,
    id: String,
    device: Option<String>,
    signals: Channel<RecordingSignal>,
) -> Result<()> {
    let app = webview.app_handle().clone();
    let owner = webview.label().to_string();
    let recorders = app.state::<Recorders<R>>();
    // Read on arrival: a page that reloads while this runs is gone by the
    // time it would record, and nobody could stop what it started.
    let page = recorders.lock().page(&owner);

    let folder = allowed_folder(&webview, &dir)?;
    takes::check_id(&id).map_err(RecorderError::refused)?;
    let audio = takes::audio_path(&id);
    let target = whispering_files::resolve(&folder, &audio)
        .map_err(|error| RecorderError::refused(error.to_string()))?;
    if std::fs::symlink_metadata(&target).is_ok() {
        return Err(RecorderError::refused(format!(
            "a file is already at {audio}"
        )));
    }
    let take = takes::take_path(&recorders.takes, &id);
    if std::fs::symlink_metadata(&take).is_ok() {
        return Err(RecorderError::refused(format!(
            "a take of {id} is already waiting at {}",
            take.display()
        )));
    }
    std::fs::create_dir_all(&recorders.takes).map_err(|error| {
        RecorderError::failed(format!(
            "{} could not be made: {error}",
            recorders.takes.display()
        ))
    })?;

    // Asked before any device is resolved, off the async runtime: a person
    // not yet asked answers a system prompt.
    let access = recorders.access;
    tauri::async_runtime::spawn_blocking(access)
        .await
        .map_err(|error| RecorderError::failed(error.to_string()))??;

    {
        let mut recorder = recorders.lock();
        if recorder.page(&owner) != page {
            return Err(RecorderError::not_recording(
                "the page that asked to record has gone",
            ));
        }
        let on_ended_app = app.clone();
        recorder.start(
            device.as_deref(),
            take,
            folder,
            id,
            owner,
            signals,
            Arc::new(move |id: &str, reason| end_recording_capture(&on_ended_app, id, reason)),
        )?;
    }
    refresh_capturing(&app);
    Ok(())
}

/// Stop the recording this window started, finish its take, and place it at
/// `recordings/<id>.webm` in its folder, never over a file there; answers
/// its id and how long it plays. Finishing writes the last second, the
/// Cues, and the length, so it takes the same few milliseconds for a
/// recording of any length. A take that cannot be placed stays in
/// `local/recording/`, and the refusal is `Unplaced`.
#[tauri::command]
#[specta::specta]
pub async fn stop<R: Runtime>(webview: Webview<R>) -> Result<StoppedRecording> {
    let app = webview.app_handle().clone();
    let stopped = app.state::<Recorders<R>>().lock().stop(webview.label());
    refresh_capturing(&app);
    stopped
}

/// Finish every take a quit or a crash left in `local/recording/` and place
/// it at `recordings/<id>.webm` in the folder `dir` (`allowed_folder`).
/// Answers each one placed (`recovered`), by id with how long it plays
/// (`durationMs`, so a page never reads the audio back to measure it), and
/// each one left (`unplaced`), by id with the take's absolute path: another
/// file is at its audio path, or it could not be finished or placed. A page
/// runs it when it opens its folder, and says what is unplaced. The take a
/// live recording is writing is left alone. Running it again places nothing
/// more.
///
/// First it removes the `.ep-*.save` files a crash left in the folder while
/// a copy to another volume was placing a file
/// (`whispering_files::clear_saves`); one a copy is still writing stays.
#[tauri::command]
#[specta::specta]
pub async fn recover<R: Runtime>(webview: Webview<R>, dir: String) -> Result<Recovery> {
    let folder = allowed_folder(&webview, &dir)?;
    let app = webview.app_handle().clone();
    let takes = app.state::<Recorders<R>>().takes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        match whispering_files::clear_saves(&folder) {
            Ok(0) => {}
            Ok(removed) => log::info!("Removed {removed} unfinished copies from the folder"),
            Err(error) => log::warn!("Unfinished copies in the folder were not removed: {error}"),
        }
        // Asked per take, under the recorder lock: a `start` holds that lock
        // from creating its take until the recording is held, so a take
        // listed here and live is always named.
        let held =
            |path: &std::path::Path| app.state::<Recorders<R>>().lock().held_path() == Some(path);
        takes::recover(&takes, &folder, held)
            .map_err(|error| RecorderError::failed(error.to_string()))
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
