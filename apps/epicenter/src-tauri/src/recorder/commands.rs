//! One-shot IPC for document-owned capture and app-local publication.
use crate::blobs::mint_wav_blob_id;
use crate::recorder::ended::{EndedReason, RecordingEndedEvent};
use crate::recorder::error::RecorderError;
use crate::recorder::recorder::{HostRecording, Recorder, Result};
use crate::recorder::sessions::StoppedRecording;
use log::{debug, warn};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_specta::Event;

/// Bring the tray's recording indicator up to date with the recorder.
///
/// Posted to the main thread, and it reads the recorder there rather than
/// carrying a flag from here. Both halves are load-bearing.
///
/// Reading at apply time is what keeps the indicator honest. Two commands
/// finishing at once used to hand the tray two booleans that could land in
/// either order, so a stop's stale `false` could overwrite a start's `true` and
/// leave the tray asserting something that had stopped being true. A closure
/// carrying no value cannot be stale.
///
/// Posting is what keeps it from deadlocking. `TrayIcon::set_icon` blocks until
/// the main thread runs it (`run_item_main_thread!` in tauri 2.11), and the main
/// thread takes the recorder mutex whenever a window is destroyed, so calling
/// the tray from a thread holding that mutex hangs the pair. Here the closure
/// takes the mutex on the main thread instead, where tauri runs both the task
/// and `set_icon` inline (`send_user_message` short-circuits when it is already
/// on the main thread), so a window-destroy handler refreshing the tray does not
/// wait on itself.
///
/// **The caller must have released the recorder lock.** The closure takes it,
/// and a caller still holding it would stall the main thread until it let go.
///
/// There is deliberately no companion state event. A window learns about every
/// ending it asked for from its own `stop`/`cancel` resolving, and the one
/// ending nobody asked for gets a targeted `RecordingEndedEvent` instead. A
/// broadcast of recorder state would be actively wrong: every other window
/// would watch a recording it does not own go idle and tear down its own.
fn refresh_recording_indicator(app: &AppHandle) {
    let app = app.clone();
    let posted = app.clone().run_on_main_thread(move || {
        let Some(recorder) = app.try_state::<Mutex<Recorder>>() else {
            return;
        };
        let Ok(recorder) = recorder.lock() else {
            return;
        };
        crate::shell::set_tray_recording_state(&app, recorder.is_capturing());
    });
    if let Err(error) = posted {
        warn!("Could not refresh the tray recording indicator: {error}");
    }
}

fn lock<'a>(
    recorder: &'a State<'_, Mutex<Recorder>>,
) -> Result<std::sync::MutexGuard<'a, Recorder>> {
    recorder
        .lock()
        .map_err(|e| RecorderError::failed(format!("Failed to lock recorder: {e}")))
}

#[tauri::command]
#[specta::specta]
pub async fn enumerate_recording_devices(
    recorder: State<'_, Mutex<Recorder>>,
) -> Result<Vec<String>> {
    debug!("Enumerating recording devices");
    lock(&recorder)?.enumerate_devices()
}

#[tauri::command]
#[specta::specta]
pub async fn register_recording_session(
    app_id: String,
    account: Option<crate::device_owner::AccountIdentity>,
    session_id: String,
    recorder: State<'_, Mutex<Recorder>>,
    window: WebviewWindow,
) -> Result<()> {
    lock(&recorder)?.register_session(window.label(), &session_id, &app_id, account)
}

/// Read only this document's live capture. No file or journal is recovered.
#[tauri::command]
#[specta::specta]
pub async fn current_recording(
    session_id: String,
    recorder: State<'_, Mutex<Recorder>>,
    window: WebviewWindow,
) -> Result<Option<HostRecording>> {
    let recorder = lock(&recorder)?;
    recorder.require_session(window.label(), &session_id)?;
    Ok(recorder.current(window.label()))
}

#[tauri::command]
#[specta::specta]
pub async fn resolve_recording_start(
    session_id: String,
    request_id: String,
    recorder: State<'_, Mutex<Recorder>>,
    window: WebviewWindow,
) -> Result<Option<HostRecording>> {
    lock(&recorder)?.resolve_start(window.label(), &session_id, &request_id)
}

#[tauri::command]
#[specta::specta]
pub async fn close_recording_session(
    session_id: String,
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
    window: WebviewWindow,
) -> Result<()> {
    lock(&recorder)?.close_session(window.label(), &session_id);
    refresh_recording_indicator(&app_handle);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn start_recording(
    device_identifier: Option<String>,
    session_id: String,
    request_id: String,
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
    window: WebviewWindow,
) -> Result<HostRecording> {
    let started = {
        let mut recorder = lock(&recorder)?;
        if let Some(current) = recorder.prepare_start(window.label(), &session_id, &request_id)? {
            return Ok(current);
        }
        let destination = recorder.session_destination(window.label(), &session_id)?;
        let audio_blob_id = mint_wav_blob_id()?;
        let started = recorder.start(
            device_identifier.as_deref(),
            &destination,
            audio_blob_id,
            window.label().into(),
            app_handle.clone(),
        )?;
        recorder.remember_start(
            window.label(),
            &session_id,
            &request_id,
            &started.audio_blob_id,
        );
        started
    };
    refresh_recording_indicator(&app_handle);
    Ok(started)
}

#[tauri::command]
#[specta::specta]
pub async fn stop_recording(
    audio_blob_id: String,
    session_id: String,
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
    window: WebviewWindow,
) -> Result<StoppedRecording> {
    let result = lock(&recorder)?.stop_session(window.label(), &session_id, &audio_blob_id);
    refresh_recording_indicator(&app_handle);
    result
}

#[tauri::command]
#[specta::specta]
pub async fn cancel_recording(
    audio_blob_id: String,
    session_id: String,
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
    window: WebviewWindow,
) -> Result<()> {
    let result = lock(&recorder)?.cancel_session(window.label(), &session_id, &audio_blob_id);
    refresh_recording_indicator(&app_handle);
    result
}

/// End a recording's capture because its stream died, and tell the owner why.
///
/// Not a command: the host calls this from the cpal error callback's thread.
/// Nobody asked for this ending, so unlike `stop` and `cancel` there is no call
/// to return through, which is the entire reason a targeted event exists at all.
///
/// # The captured audio survives, and the event does not carry it
///
/// The microphone is released and the recording stays exactly where it was:
/// holding the one recorder slot, owned by the same window, with its audio
/// intact. The owner claims it by calling `stop`, which finishes what was
/// captured before the stream died, or throws it away by calling `cancel`.
///
/// So [`RecordingEndedEvent`] is a signal and nothing more. It carries no audio,
/// no blob, and no result, because a second way to deliver a recording is a
/// second result channel to keep correct, and the owner already has the first
/// one. A live document that misses the event reconciles it through its
/// session-scoped `current_recording`; document departure discards capture.
pub fn end_recording_capture(app: &AppHandle, audio_blob_id: &str, reason: EndedReason) {
    let Some(recorder) = app.try_state::<Mutex<Recorder>>() else {
        return;
    };
    let owner_label = {
        let Ok(mut recorder) = recorder.lock() else {
            return;
        };
        // A no-op when the id is not the held recording or its capture already
        // ended: the stream error may have arrived after the owner started
        // another recording, and cpal may report the same failure more than
        // once.
        let Some(owner_label) = recorder.end_capture(audio_blob_id, reason) else {
            return;
        };
        owner_label
    };
    warn!("Recording {audio_blob_id} lost its capture ({reason:?}); owner={owner_label}");
    refresh_recording_indicator(app);
    // Dropped rather than propagated: the capture is already over and there is
    // nothing to repair here. The owner discovers the same ended recording on
    // its next `current_recording` either way, which is what makes this event
    // safe to lose.
    if let Err(error) = (RecordingEndedEvent {
        audio_blob_id: audio_blob_id.to_string(),
        reason,
    })
    .emit_to(app, &owner_label)
    {
        warn!("Failed to notify '{owner_label}' that {audio_blob_id} ended: {error}");
    }
}

/// Cancel whatever recording `owner_label` owns, because that window is gone.
///
/// Not a command: the host calls this from its window-destroyed hook. A
/// destroyed window can never stop or cancel its own recording, so leaving it
/// in flight would hold the one recorder slot until the process exits.
///
/// This runs on the main thread and joins the capture worker, which is safe for
/// two reasons worth stating, because both could quietly stop being true. The
/// wait is bounded: the worker checks its command channel every loop and
/// otherwise blocks for at most 20 ms on samples, so a cancel is noticed within
/// roughly that. And the worker's only main-thread interaction is
/// `Emitter::emit_to` for the mic level, which posts to the event loop without
/// waiting for it. That second point holds only while Tauri's `tracing` feature
/// is off: with it on, `eval_script` switches to a variant that blocks on a
/// reply from the main thread (`tauri-runtime-wry/src/lib.rs:1838-1851`), and a
/// worker emitting while the main thread joins it would deadlock. Nothing in
/// this dependency graph enables that feature; if something ever does, move
/// this call off the main thread.
pub fn cancel_recording_owned_by(app: &AppHandle, owner_label: &str) {
    let Some(recorder) = app.try_state::<Mutex<Recorder>>() else {
        return;
    };
    {
        let Ok(mut recorder) = recorder.lock() else {
            return;
        };
        recorder.close_document(owner_label);
    }
    refresh_recording_indicator(app);
}
