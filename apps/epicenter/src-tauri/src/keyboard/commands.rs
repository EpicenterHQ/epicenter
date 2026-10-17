use tauri::State;

use super::{DictationCapability, TapController};

/// The current paste-at-cursor capability: whether a synthetic Cmd/Ctrl+V can
/// land (on macOS, whether the Accessibility grant is live and the tap is
/// healthy). A page reads it from this; it never probes the OS itself. The
/// Rust supervisor owns the value and the tap's lifecycle, so there is no `start`
/// command for the FE to call.
#[tauri::command]
#[specta::specta]
pub fn get_dictation_capability(controller: State<'_, TapController>) -> DictationCapability {
    controller.capability()
}

/// Tell the keyboard supervisor whether auto-paste-at-cursor is enabled. Paste
/// writes a synthetic Cmd/Ctrl+V through the macOS Accessibility grant the tap
/// watches, so the supervisor holds the tap whenever paste is on to track that
/// grant (and surface the notice when it is missing or stale). It is the only
/// reason to hold the tap (ADR-0117). The FE pushes this on startup and whenever
/// the output settings change. A no-op off macOS, where paste needs no grant.
#[tauri::command]
#[specta::specta]
pub fn set_auto_paste_enabled(controller: State<'_, TapController>, enabled: bool) {
    controller.set_auto_paste_enabled(enabled);
}
