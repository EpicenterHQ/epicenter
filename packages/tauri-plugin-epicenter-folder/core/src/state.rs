//! Where a folder's unfinished writes live: `.epicenter/` at its root.
//!
//! A file in `.epicenter/` is on its way somewhere. It finishes (moves to its
//! real path), or the next open recovers or removes it. Each kind of
//! unfinished write has a part named for the operation that owns it:
//!
//! - `saves/`: a save's bytes waiting to be renamed over its target, and a
//!   stopped recording being encoded before it is placed. Always safe to
//!   delete when no app runs; opening a folder removes stale ones
//!   (`storage::sweep_scratch`).
//! - `recordings/<target path>`: a desktop recording, from its first sample
//!   until it stops or the next open recovers it. It may hold audio until
//!   the app opens once, so nothing sweeps it.
//!
//! `.epicenter` is a hidden path, so it is never a folder's data: no
//! watcher reports it and `epicenter sync` never commits it. This module is
//! the one place Rust spells the layout; `state.ts` in `@epicenter/folder`
//! is the other, and `fixtures/state-layout.json` holds both to it. A new
//! kind of unfinished write gets its own part here, never from its caller.

use std::path::{Path, PathBuf};

/// The directory at the top of a folder that holds its unfinished writes.
pub const DIRECTORY: &str = ".epicenter";

/// The part of `DIRECTORY` where a save stages its bytes.
pub const SAVES: &str = "saves";

/// The part of `DIRECTORY` where a desktop recording is written while it
/// records, at its own folder-relative path.
pub const RECORDINGS: &str = "recordings";

/// `.epicenter` inside `root`.
pub fn directory(root: &Path) -> PathBuf {
    root.join(DIRECTORY)
}

/// `.epicenter/saves` inside `root`: on the root's own file system, so a
/// staged save's rename over its path is one step.
pub fn saves(root: &Path) -> PathBuf {
    directory(root).join(SAVES)
}

/// The folder-relative path the recording of the folder-relative `stem`
/// (its path without an extension) is written to while it records:
/// `.epicenter/recordings/<stem>.wav`.
pub fn recording(stem: &str) -> String {
    format!("{}.wav", recordings_under(stem))
}

/// The folder-relative directory the recordings in progress under the
/// folder-relative directory `under` are in: `.epicenter/recordings/<under>`.
pub fn recordings_under(under: &str) -> String {
    format!("{DIRECTORY}/{RECORDINGS}/{under}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Layout {
        directory: String,
        saves: String,
        recordings: String,
        saves_directory: String,
        recording_paths: Vec<RecordingPath>,
    }

    #[derive(serde::Deserialize)]
    struct RecordingPath {
        stem: String,
        path: String,
    }

    /// The layout `state.test.ts` reads too, so both languages build the
    /// same paths.
    #[test]
    fn the_layout_follows_the_shared_fixture() {
        let layout: Layout =
            serde_json::from_str(include_str!("../../fixtures/state-layout.json")).unwrap();
        assert_eq!(DIRECTORY, layout.directory);
        assert_eq!(SAVES, layout.saves);
        assert_eq!(RECORDINGS, layout.recordings);
        let root = Path::new("/folder");
        assert_eq!(saves(root), root.join(&layout.saves_directory));
        assert!(!layout.recording_paths.is_empty());
        for example in &layout.recording_paths {
            assert_eq!(recording(&example.stem), example.path, "{}", example.stem);
        }
    }
}
