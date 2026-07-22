use crate::recorder::capture::{stage_capture, StagedRecordingCapture};
use crate::recorder::error::RecorderError;
use crate::recorder::recorder::{Recorder, Result};
use log::{debug, info, warn};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

const RECORDER_STATE_CHANGED: &str = "recorder:state-changed";

#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "UPPERCASE")]
enum RecordingState {
    Idle,
    Recording,
}

fn emit_recording_state(app: &AppHandle, state: RecordingState) {
    crate::shell::set_tray_recording_state(app, matches!(state, RecordingState::Recording));
    if let Err(e) = app.emit(RECORDER_STATE_CHANGED, state) {
        warn!(
            "Failed to emit {} = {:?}: {}",
            RECORDER_STATE_CHANGED, state, e
        );
    }
}

#[tauri::command]
#[specta::specta]
pub async fn enumerate_recording_devices(
    recorder: State<'_, Mutex<Recorder>>,
) -> Result<Vec<String>> {
    debug!("Enumerating recording devices");
    let recorder = recorder
        .lock()
        .map_err(|e| RecorderError::failed(format!("Failed to lock recorder: {e}")))?;
    recorder.enumerate_devices()
}

#[tauri::command]
#[specta::specta]
pub async fn init_recording_session(
    device_identifier: String,
    recording_id: String,
    sample_rate: Option<u32>,
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
) -> Result<()> {
    info!(
        "Initializing recording session: device={device_identifier}, id={recording_id}, sample_rate={sample_rate:?}",
    );

    {
        let mut recorder = recorder
            .lock()
            .map_err(|e| RecorderError::failed(format!("Failed to lock recorder: {e}")))?;
        recorder.init_session(
            device_identifier,
            recording_id,
            sample_rate,
            app_handle.clone(),
        )?;
    }
    // init_session calls close_session internally as cleanup. If the previous
    // session was actively recording, that transition is silent at the domain
    // layer; emit IDLE here so the JS state never diverges from reality.
    emit_recording_state(&app_handle, RecordingState::Idle);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn start_recording(
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
) -> Result<()> {
    info!("Starting recording");
    {
        let mut recorder = recorder
            .lock()
            .map_err(|e| RecorderError::failed(format!("Failed to lock recorder: {e}")))?;
        recorder.start_recording()?;
    }
    emit_recording_state(&app_handle, RecordingState::Recording);
    Ok(())
}

/// Stop the recorder and durably stage a WAV for record-owner admission.
///
/// JS receives only an opaque capture id and byte length, never raw PCM or a
/// filesystem path. The staged artifact remains until the Bun owner admits it.
#[tauri::command]
#[specta::specta]
pub async fn stop_recording(
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
) -> Result<StagedRecordingCapture> {
    info!("Stopping recording");
    let samples = {
        let mut recorder = recorder
            .lock()
            .map_err(|e| RecorderError::failed(format!("Failed to lock recorder: {e}")))?;
        recorder
            .session_id()
            .ok_or_else(|| RecorderError::failed("no active recording session at stop"))?;
        recorder.stop_recording()?
    };

    let capture_result = crate::timing::measure("stop.wav_stage+fsync", || {
        stage_capture(&app_handle, &samples)
    });
    // The recorder has already consumed the worker's samples and transitioned
    // out of recording. Publish that state even when durable staging fails.
    emit_recording_state(&app_handle, RecordingState::Idle);
    let capture = capture_result?;
    info!(
        "Recording stopped: capture_id={}, byte_length={}",
        capture.capture_id, capture.byte_length
    );
    Ok(capture)
}

#[tauri::command]
#[specta::specta]
/// Cancel the active recording without creating a staged capture.
pub async fn cancel_recording(
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
) -> Result<()> {
    info!("Cancelling recording");
    {
        let mut recorder = recorder
            .lock()
            .map_err(|e| RecorderError::failed(format!("Failed to lock recorder: {e}")))?;
        recorder.cancel_recording()?;
    }
    emit_recording_state(&app_handle, RecordingState::Idle);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn close_recording_session(
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
) -> Result<()> {
    info!("Closing recording session");
    {
        let mut recorder = recorder
            .lock()
            .map_err(|e| RecorderError::failed(format!("Failed to lock recorder: {e}")))?;
        recorder.close_session()?;
    }
    emit_recording_state(&app_handle, RecordingState::Idle);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn get_current_recording_id(
    recorder: State<'_, Mutex<Recorder>>,
) -> Result<Option<String>> {
    debug!("Getting current recording ID");
    let recorder = recorder
        .lock()
        .map_err(|e| RecorderError::failed(format!("Failed to lock recorder: {e}")))?;
    Ok(recorder.get_current_recording_id())
}
