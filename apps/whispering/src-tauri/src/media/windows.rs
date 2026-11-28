//! Windows playback control via GSMTC (Global System Media Transport Controls,
//! `Windows.Media.Control`). Covers any app that registers a media session,
//! including Chromium/Firefox browsers (YouTube, web audio).
//!
//! The session token is the `SourceAppUserModelId` (AUMID). `pause_playing`
//! pauses every session whose `PlaybackStatus` is `Playing` and remembers its
//! AUMID; `resume` re-resolves those AUMIDs against the live session list and
//! plays the ones still present.
//!
//! Two footguns, both handled here:
//! - The `windows` crate does NOT initialize COM. We do all GSMTC work on a
//!   freshly spawned thread, init COM as MTA there, and uninitialize before the
//!   thread exits. Never on Tauri's UI/STA thread (would deadlock /
//!   `RPC_E_CHANGED_MODE`).
//! - WinRT async ops are resolved with `IAsyncOperation::join()` (the blocking
//!   wait), not `GetResults()` (which only reads an already-finished op).

use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus,
};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

pub async fn pause_playing() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(|| on_com_mta_thread(pause_playing_com))
        .await
        .map_err(|e| format!("Failed to pause playback: {e}"))?
}

pub async fn resume(sessions: Vec<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || on_com_mta_thread(move || resume_com(sessions)))
        .await
        .map_err(|e| format!("Failed to resume playback: {e}"))?
}

/// Run `f` on a dedicated thread that owns its COM apartment (MTA), so the
/// pooled tokio blocking threads and Tauri's UI thread are never touched.
fn on_com_mta_thread<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    std::thread::spawn(move || {
        let owns_com = unsafe { co_init_mta() };
        let result = f();
        if owns_com {
            // SAFETY: balanced with the successful CoInitializeEx above.
            unsafe { CoUninitialize() };
        }
        result
    })
    .join()
    .map_err(|_| "media COM worker thread panicked".to_string())
}

/// Returns whether we initialized COM (and therefore must uninitialize). On a
/// freshly spawned thread this always succeeds; the `RPC_E_CHANGED_MODE`
/// tolerance is defensive for any future thread reuse.
unsafe fn co_init_mta() -> bool {
    // 0x80010106: COM already initialized in a different apartment on this thread.
    const RPC_E_CHANGED_MODE: i32 = -2_147_417_850;
    let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
    if hr.0 >= 0 {
        // S_OK (we initialized) or S_FALSE (already MTA on this thread); either
        // way we hold a reference to balance with CoUninitialize.
        true
    } else {
        if hr.0 != RPC_E_CHANGED_MODE {
            log::warn!("CoInitializeEx(MTA) failed: 0x{:08X}", hr.0);
        }
        false
    }
}

fn pause_playing_com() -> Vec<String> {
    let mut paused = Vec::new();
    let Some(manager) = request_manager() else {
        return paused;
    };
    let sessions = match manager.GetSessions() {
        Ok(sessions) => sessions,
        Err(e) => {
            log::debug!("GSMTC GetSessions failed: {e}");
            return paused;
        }
    };
    for session in sessions {
        match pause_session_if_playing(&session) {
            Ok(Some(aumid)) => paused.push(aumid),
            Ok(None) => {}
            Err(e) => log::warn!("GSMTC pause failed: {e}"),
        }
    }
    paused
}

fn resume_com(aumids: Vec<String>) {
    if aumids.is_empty() {
        return;
    }
    let Some(manager) = request_manager() else {
        return;
    };
    let sessions = match manager.GetSessions() {
        Ok(sessions) => sessions,
        Err(e) => {
            log::debug!("GSMTC GetSessions failed: {e}");
            return;
        }
    };
    for session in sessions {
        if let Err(e) = resume_session_if_remembered(&session, &aumids) {
            log::warn!("GSMTC resume failed: {e}");
        }
    }
}

fn request_manager() -> Option<GlobalSystemMediaTransportControlsSessionManager> {
    let op = match GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
        Ok(op) => op,
        Err(e) => {
            // No session manager (e.g. running as a service/SYSTEM) -> no-op.
            log::debug!("GSMTC RequestAsync failed: {e}");
            return None;
        }
    };
    match op.join() {
        Ok(manager) => Some(manager),
        Err(e) => {
            log::debug!("GSMTC RequestAsync await failed: {e}");
            None
        }
    }
}

fn pause_session_if_playing(
    session: &GlobalSystemMediaTransportControlsSession,
) -> windows::core::Result<Option<String>> {
    let info = session.GetPlaybackInfo()?;
    if info.PlaybackStatus()? != GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing {
        return Ok(None);
    }
    let aumid = session.SourceAppUserModelId()?.to_string();
    // Dedicated pause, never the toggle, so we never start idle playback.
    if session.TryPauseAsync()?.join()? {
        Ok(Some(aumid))
    } else {
        // App declined the request (e.g. CanPause == false); not an error.
        log::debug!("GSMTC session {aumid} declined pause");
        Ok(None)
    }
}

fn resume_session_if_remembered(
    session: &GlobalSystemMediaTransportControlsSession,
    aumids: &[String],
) -> windows::core::Result<()> {
    let aumid = session.SourceAppUserModelId()?.to_string();
    // Safety rule: only ever play a session we personally paused.
    if !aumids.iter().any(|remembered| remembered == &aumid) {
        return Ok(());
    }
    session.TryPlayAsync()?.join()?;
    Ok(())
}
