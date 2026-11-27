//! macOS playback control: send system pause/resume commands through the private
//! MediaRemote framework, gating resume on a CoreAudio output-activity read.
//!
//! `MRMediaRemoteSendCommand(command, userInfo) -> Boolean` is synchronous (no
//! dispatch queue, no completion block), so it runs inline. We pass null
//! userInfo and the dedicated Pause (1) / Play (0) commands, never the play/pause
//! toggle, so we never start idle playback. The macOS 15.4 entitlement lockdown
//! gated only the now-playing *read*; the command path is unaffected
//! (LyricFever #94).
//!
//! Because that read is closed to us, MediaRemote alone can't tell what (or
//! whether anything) is playing, which is what a safe resume needs. CoreAudio's
//! process-object list fills that gap (see `audio`): on pause we record which
//! processes are genuinely producing output audio, and we only resume when that
//! set was non-empty. So we never restart something the user had already paused.
//! Resume itself is MediaRemote's single-target Play (the system now-playing
//! app); the remembered set is the *evidence* a resume is warranted, not an
//! address. On macOS before 14.4 the CoreAudio read is unavailable, the set is
//! always empty, and the feature degrades to pause-only.
//!
//! We resolve MediaRemote with `dlopen` rather than link it: it is a private
//! Apple framework, so a hard link would make the whole app fail to launch if a
//! future macOS removes it. dlopen degrades to a silent no-op instead, and
//! loading a system-signed framework needs no entitlement. (CoreAudio, being
//! public, is hard-linked in `audio`.)

mod audio;

use std::ffi::{c_char, c_int, c_void, CString};
use std::ptr;
use std::sync::OnceLock;

// `MRMediaRemoteCommandPlay` / `MRMediaRemoteCommandPause`. Stable across the
// reversed-header sources; we pass the integers directly.
const MR_COMMAND_PLAY: c_int = 0;
const MR_COMMAND_PAUSE: c_int = 1;
const RTLD_NOW: c_int = 2;
const MEDIA_REMOTE_PATH: &str =
    "/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote";

extern "C" {
    fn dlopen(filename: *const c_char, flag: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

type SendCommandFn = unsafe extern "C" fn(c_int, *const c_void) -> u8;

/// Pause the system now-playing app and arm resume for what was playing. Returns
/// the bundle ids CoreAudio saw producing output audio: a non-empty set is the
/// token that authorizes a later resume, an empty set keeps resume disarmed (the
/// safe floor — nothing was observed playing, or this macOS predates the read).
pub async fn pause_playing() -> Result<Vec<String>, String> {
    let Some(send_command) = send_command_fn() else {
        return Ok(Vec::new());
    };
    // Observe before we pause: what is genuinely producing output audio right
    // now? We arm resume only for what we see here.
    let playing = audio::output_active_bundle_ids();
    // The pause command is always safe to send: it never starts idle playback,
    // and is a no-op when nothing is playing. So we send it regardless of the
    // read (some players don't surface in CoreAudio), and let the read decide
    // only whether resume is armed.
    // SAFETY: `send_command` is the resolved MRMediaRemoteSendCommand; null
    // userInfo is valid for a plain command.
    let sent = unsafe { send_command(MR_COMMAND_PAUSE, ptr::null()) };
    if sent == 0 {
        log::debug!("MediaRemote pause command not accepted (nothing playing?)");
    }
    Ok(playing)
}

/// Resume what `pause_playing` armed. A non-empty `sessions` means we observed
/// real output audio at pause time, so a resume is warranted; we send the
/// single-target Play. An empty set (nothing was playing, or pre-14.4 macOS with
/// no read) is a no-op, so every stop/cancel/failed-start path can call blindly.
pub async fn resume(sessions: Vec<String>) -> Result<(), String> {
    if sessions.is_empty() {
        return Ok(());
    }
    let Some(send_command) = send_command_fn() else {
        return Ok(());
    };
    // SAFETY: resolved MRMediaRemoteSendCommand; null userInfo valid for a command.
    let sent = unsafe { send_command(MR_COMMAND_PLAY, ptr::null()) };
    if sent == 0 {
        log::debug!("MediaRemote play command not accepted on resume");
    }
    Ok(())
}

/// Resolve `MRMediaRemoteSendCommand` once. `None` when the framework or symbol
/// is unavailable (e.g. a future macOS removed it) -> the feature silently
/// no-ops and the app still runs (Tier 3).
fn send_command_fn() -> Option<SendCommandFn> {
    static SEND_COMMAND: OnceLock<Option<SendCommandFn>> = OnceLock::new();
    *SEND_COMMAND.get_or_init(|| unsafe {
        let path = CString::new(MEDIA_REMOTE_PATH).ok()?;
        let handle = dlopen(path.as_ptr(), RTLD_NOW);
        if handle.is_null() {
            log::debug!("MediaRemote framework unavailable");
            return None;
        }
        // The handle is intentionally never closed: the framework stays loaded
        // for the process lifetime, which is exactly what we want.
        let symbol = CString::new("MRMediaRemoteSendCommand").ok()?;
        let address = dlsym(handle, symbol.as_ptr());
        if address.is_null() {
            log::debug!("MRMediaRemoteSendCommand symbol not found");
            return None;
        }
        Some(std::mem::transmute::<*mut c_void, SendCommandFn>(address))
    })
}
