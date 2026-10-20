// The app-owned Tauri command names, in one place.
//
// Two consumers that must agree: `build.rs` declares them to the Tauri manifest
// (which is what makes `allow-<command>` permissions exist at all), and the
// crate's tests check the capability files and the generated bindings against
// the same list. Keeping one list is what lets those checks be meaningful
// rather than comparing a hand-copy to itself.
//
// `build.rs` pulls this in with `include!`, so it cannot drift from the crate.

/// The commands every build registers: the page API.
pub const COMMANDS: &[&str] = &[
    "transcribe_audio_bytes",
    "list_inference_models",
    "get_active_model",
    "get_local_transcription_readiness",
    "open_home",
    "take_pending_home_section",
    "list_data_folders",
    "ai_send",
    "account_send",
    "ai_key_set",
    "ai_key_remove",
    "ai_key_state",
    "auth_login",
    "auth_status",
    "auth_logout",
    "open_bundled_app",
    "set_active_model",
    "get_unload_policy",
    "set_unload_policy",
    "list_models",
    "download_model",
    "reveal_model",
    "cancel_download",
];

/// The native dictation commands, registered only by a build with the
/// `dictation` feature. No capability grants them and no generated page
/// binding carries them (ADR-0555).
pub const DICTATION_COMMANDS: &[&str] = &[
    "write_text",
    "simulate_enter_keystroke",
    "prewarm_model",
    "pause_playback",
    "resume_playback",
    "set_auto_paste_enabled",
    "get_dictation_capability",
];
