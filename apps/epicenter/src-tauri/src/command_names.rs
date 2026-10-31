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
    "get_active_model",
    "open_home",
    "folder_query",
    "synced_folders",
    "add_synced_folder",
    "accept_folder_setup",
    "dismiss_folder_setup",
    "clone_synced_folder",
    "sync_folder_now",
    "forget_synced_folder",
    "open_synced_folder",
    "folder_sharing",
    "share_folder",
    "unshare_folder",
    "restart_sync_service",
    "auth_login",
    "auth_status",
    "auth_logout",
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
