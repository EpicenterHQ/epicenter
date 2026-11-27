//! Pause and resume system media playback around recording.
//!
//! The page calls `pause_playback` as a take starts and `resume_playback` as
//! it ends (`platform/media/`), trading opaque `String` session tokens:
//! `pause_playback` returns a token for each session it paused, and the frontend
//! hands that same set back to `resume_playback`. Token contents are
//! platform-private (macOS output-active bundle ids, Windows AUMIDs, Linux MPRIS
//! bus names) and the frontend never interprets them.
//!
//! Recording never waits on, and never fails because of, playback control: both
//! commands are infallible across IPC and the caller fires and forgets. Platform
//! failures are logged on the Rust side, never surfaced to the frontend (which
//! has no recovery for them). One platform module is compiled per target;
//! unsupported targets are silent no-ops.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

/// Pause every system media session currently playing. Returns one opaque token
/// per session paused, to hand back to `resume_playback`. Pausing is gated to
/// never *start* playback: only sessions observed playing are touched, and the
/// dedicated pause command (never a play/pause toggle) is sent.
#[tauri::command]
pub async fn pause_playback() -> Vec<String> {
    // Infallible across IPC: recording never waits on, nor fails because of,
    // playback control, and the frontend has no recovery for a pause failure.
    // A platform failure is logged here (the cause belongs in the Rust log, not
    // the wire) and reported as "paused nothing", so the resume side has no
    // token to act on.
    #[cfg(target_os = "macos")]
    let result = macos::pause_playing().await;
    #[cfg(target_os = "windows")]
    let result = windows::pause_playing().await;
    #[cfg(target_os = "linux")]
    let result = linux::pause_playing().await;
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    let result: Result<Vec<String>, String> = Ok(Vec::new());

    result.unwrap_or_else(|err| {
        log::warn!("pause_playback failed, leaving system playback untouched: {err}");
        Vec::new()
    })
}

/// Resume the sessions named by `sessions`, which must be tokens returned by a
/// prior `pause_playback`. A session that vanished, was already resumed by the
/// user, or can't be resumed is silently skipped. Safety rule: we only ever send
/// *play* to a session we personally paused.
#[tauri::command]
pub async fn resume_playback(sessions: Vec<String>) {
    // Infallible across IPC, mirroring `pause_playback`: a resume failure is not
    // something the frontend can act on, so the cause is logged here rather than
    // returned.
    #[cfg(target_os = "macos")]
    let result = macos::resume(sessions).await;
    #[cfg(target_os = "windows")]
    let result = windows::resume(sessions).await;
    #[cfg(target_os = "linux")]
    let result = linux::resume(sessions).await;
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    let result: Result<(), String> = {
        let _ = sessions;
        Ok(())
    };

    if let Err(err) = result {
        log::warn!("resume_playback failed: {err}");
    }
}
