// The app-owned Tauri command names, in one place.
//
// Two consumers that must agree: `build.rs` declares them to the Tauri manifest
// (which is what makes `allow-<command>` permissions exist at all), and the
// crate's tests check the capability files and the generated bindings against
// the same list. Keeping one list is what lets those checks be meaningful
// rather than comparing a hand-copy to itself.
//
// `build.rs` pulls this in with `include!`, so it cannot drift from the crate.

/// The commands every build registers in its typed page API.
pub const COMMANDS: &[&str] = &[
    "open_home",
    "start_at_login",
    "set_start_at_login",
    // The Folders window's Git, for an import (`git.rs`).
    "choose_repository",
    "git_run",
    "git_scratch",
    "git_scratch_remove",
    "git_lfs_object",
    "git_hand_over",
];

/// The sign-in's commands (`epicenter_account::COMMANDS`), which the shell
/// registers beside the typed API: the page's side is `createTauriAuth`, not
/// the generated bindings. A test holds this list to the crate's.
pub const ACCOUNT_COMMANDS: &[&str] = &[
    "account_sign_in",
    "account_sign_out",
    "account_fetch",
    "account_fetch_cancel",
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
