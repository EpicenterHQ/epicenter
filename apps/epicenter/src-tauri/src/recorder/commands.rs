//! The recording command surface: the whole thing an application can reach.
//!
//! `start`, `stop`, `cancel`, `current`, and device enumeration. There is no
//! session to open or close, no lease object, and no handle: the host owns the
//! one recorder, and a recording is named by the blob id `start` returns.
//!
//! Every lifecycle command takes an injected `WebviewWindow`. Tauri supplies it
//! from the invoking window and specta renders it as nothing at all (its
//! `FunctionArg::to_datatype` returns `None`, `tauri/src/lib.rs:1130`), so the
//! caller's identity costs zero TypeScript surface and cannot be spoofed from
//! JS: window labels are assigned in Rust and the frontend never supplies one.
//!
//! Ownership here is resource correctness, not isolation. ADR-0179 grants an
//! admitted app broad same-origin and device authority on purpose; what these
//! rules prevent is one window destroying, stopping, or collecting the blob of
//! a recording another window started.

use crate::blobs::{mint_blob_id, BlobDestination};
use crate::recorder::ended::{EndedReason, RecordingEndedEvent};
use crate::recorder::error::RecorderError;
use crate::recorder::recorder::{HostRecording, Recorder, Result};
use log::{debug, info, warn};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_specta::Event;

/// What `stop_recording` hands back: the committed blob's id and the two facts
/// only the host can state exactly.
///
/// Both are computed here rather than in JS, where they used to be a wall-clock
/// subtraction and a follow-up `stat` round trip. Wall clock measures how long
/// the user held the button, which is not the same as how much audio the blob
/// contains, and it had no answer at all after a reload.
///
/// Both are `u32` because the blob is a RIFF WAV and RIFF states its own sizes
/// in 32 bits: the staged writer already refuses anything larger. So `u32` is
/// the format's real bound rather than a convenient cap, and it renders in
/// TypeScript as a plain `number` (specta widens `f64` to `number | null` to
/// leave room for NaN, a value neither of these can hold).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StoppedRecording {
    pub audio_blob_id: String,
    /// Exact duration of the committed audio: the file's own sample count over
    /// the rate it was captured at. This is the blob's length rather than how
    /// long the button was held, so a sub-second clip padded at finalize reports
    /// the padded duration, which is what the file actually holds.
    pub duration_ms: u32,
    /// Exact length of the published file on disk.
    pub byte_length: u32,
}

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

/// Start recording, returning the blob id the recording will be published
/// under and the microphone it opened.
///
/// The id exists before its blob does: `stop` publishes the blob under it and
/// `cancel` burns it with no blob ever written. The host mints it so ownership
/// is decided here rather than asserted by a caller.
///
/// `device_identifier` is optional; `None` records from the system default, and
/// a name that is no longer present falls back to the default rather than
/// failing. Either way `device` reports what actually opened, so the caller
/// never has to enumerate devices just to discover what it got. Fails with
/// `Busy` when another window is already recording.
#[tauri::command]
#[specta::specta]
pub async fn start_recording(
    device_identifier: Option<String>,
    destination: BlobDestination,
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
    window: WebviewWindow,
) -> Result<HostRecording> {
    let owner_label = window.label().to_string();
    let audio_blob_id = mint_blob_id()?;
    info!(
        "Starting recording: id={audio_blob_id}, owner={owner_label}, device={device_identifier:?}",
    );

    let started = {
        let mut recorder = lock(&recorder)?;
        recorder.start(
            device_identifier.as_deref(),
            audio_blob_id,
            owner_label,
            app_handle.clone(),
            destination,
        )?
    };
    refresh_recording_indicator(&app_handle);
    Ok(started)
}

/// Stop the recording named by `audio_blob_id`, publish its blob, and report
/// the committed audio.
///
/// Restricted to the window that started it: only the owner can turn its
/// recording into bytes it can then read. A caller that names a recording which
/// has already ended, is not the live one, or belongs to another window gets
/// `NotRecording`, which makes an idempotent stop (push-to-talk releasing after
/// its recording was already supplanted) a clean typed no-op.
#[tauri::command]
#[specta::specta]
pub async fn stop_recording(
    audio_blob_id: String,
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
    window: WebviewWindow,
) -> Result<StoppedRecording> {
    info!("Stopping recording {audio_blob_id}");
    let finalized = {
        let mut recorder = lock(&recorder)?;
        // The whole worker round trip happens under this lock, on purpose. The
        // worker still holds an open cpal stream until it answers, so a `start`
        // admitted in the meantime would open a second microphone against a
        // recorder that is supposed to have exactly one. What the lock does not
        // cover is publication, which is the slow part.
        recorder.stop(&audio_blob_id, window.label())
    };
    // Refreshed whether or not the stop succeeded, because the two disagree: an
    // ownership refusal leaves the recording running while a successful stop
    // ends it, and the closure reads the recorder rather than trusting either.
    refresh_recording_indicator(&app_handle);
    let finalized = finalized?;

    // A failure here loses the recording. There is nothing to retry against
    // (the staged file is deleted with the error and the slot is already free),
    // so it surfaces as an error rather than pretending a blob exists.
    let recorded = finalized.publish()?;

    info!(
        "Recording stopped: id={audio_blob_id}, {} ms, {} bytes",
        recorded.duration_ms, recorded.byte_length
    );
    Ok(StoppedRecording {
        audio_blob_id,
        duration_ms: recorded.duration_ms,
        byte_length: recorded.byte_length,
    })
}

/// Cancel the recording named by `audio_blob_id`, discarding its audio.
///
/// Owner-only, and it produces nothing: the minted blob id is burnt and no blob
/// is ever written under it. The host cancels by another route entirely (the
/// owner window being destroyed, wired in `lib.rs`), which needs no command and
/// therefore no grant.
#[tauri::command]
#[specta::specta]
pub async fn cancel_recording(
    audio_blob_id: String,
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
    window: WebviewWindow,
) -> Result<()> {
    info!("Cancelling recording {audio_blob_id}");
    let cancelled = {
        let mut recorder = lock(&recorder)?;
        recorder.cancel(&audio_blob_id, window.label())
    };
    refresh_recording_indicator(&app_handle);
    cancelled
}

/// The recording this window owns, or `null`.
///
/// Reload does not destroy a window, so a window that reloads mid-recording
/// still owns that recording and would otherwise have no way to name it. This
/// is the only reason the single recorder cannot wedge until the owner window
/// is destroyed.
///
/// A pure read, and the same shape `start` returns, so a recovered recording is
/// not a different kind of thing from a freshly started one: the caller learns
/// which microphone it opened without having been the one that opened it, and
/// learns from `endedReason` whether that microphone is still running. A
/// recording whose capture died while the JS was gone is found here and stopped
/// like any other, which publishes what it captured.
#[tauri::command]
#[specta::specta]
pub async fn current_recording(
    recorder: State<'_, Mutex<Recorder>>,
    window: WebviewWindow,
) -> Result<Option<HostRecording>> {
    debug!("Reading the current recording for {}", window.label());
    Ok(lock(&recorder)?.current(window.label()))
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
/// intact. The owner claims it by calling `stop`, which publishes what was
/// captured before the stream died, or throws it away by calling `cancel`.
///
/// So [`RecordingEndedEvent`] is a signal and nothing more. It carries no audio,
/// no blob, and no result, because a second way to deliver a recording is a
/// second result channel to keep correct, and the owner already has the first
/// one. It is also best-effort: a window that misses the event (it was reloading,
/// it was gone, the emit failed) finds the same ended recording through
/// `current_recording` and resolves it identically.
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
        if let Some(audio_blob_id) = recorder.cancel_owned_by(owner_label) {
            info!("Window '{owner_label}' was destroyed; cancelled recording {audio_blob_id}");
        }
    }
    refresh_recording_indicator(app);
}
