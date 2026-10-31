//! Where a recording is written while it records, and how it reaches its own
//! path.
//!
//! A recording in progress is the hidden sibling of its own path,
//! `<directory>/.<name>.epicenter-pending` (`pending`). A hidden path is not
//! the folder's data: no contract claims it, no watcher reports it, and
//! `epicenter sync` never commits an unfinished file. So nothing reads a
//! half-written WAV as the folder's audio, and its header rewrite, about
//! once a second, wakes no sync. When it stops, `storage::place` moves it to
//! its own path, within one directory, without replacing anything there;
//! `wav::recover` repairs and places what a quit or a crash left behind.

use epicenter_folder_core::storage::pending_name;

/// The folder-relative path the recording of the folder-relative
/// `relative` is written at while it records: its hidden sibling,
/// `.<name>.epicenter-pending` in the same directory.
pub fn pending(relative: &str) -> String {
    match relative.rsplit_once('/') {
        Some((directory, name)) => format!("{directory}/{}", pending_name(name)),
        None => pending_name(relative),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recording_is_written_beside_its_path_under_a_hidden_name() {
        assert_eq!(
            pending("recordings/1.wav"),
            "recordings/.1.wav.epicenter-pending"
        );
        assert_eq!(pending("1.wav"), ".1.wav.epicenter-pending");
    }
}
