//! Where a recording is written while it records, how it reaches its own
//! path, and how one a crash cut off gets there.
//!
//! A recording in progress is a WebM among the folder's unfinished writes,
//! at `.epicenter/recordings/<its folder-relative path>.webm` (`pending`,
//! from `state::recording`): a hidden path, which no watcher reports and
//! `epicenter sync` never commits, so nothing reads a recording at a data
//! path before it is finished.
//!
//! Once it is finished in place, `place_recording` places it at
//! `<path>.webm` without replacing anything there (the folder core's
//! `storage::place`, which a save expecting nothing at its path uses too).
//! A quit or a crash before then leaves the pending file, which `recover`
//! finishes and places the next time the folder opens. A page calls it
//! before it lists, plays, or transcribes a recording (ADR-0542), and a
//! file it places is finished first, so nothing reads a cut-off one. A
//! recording whose path another file took is never deleted: it stays
//! pending, and `recover` answers where it is.
//!
//! Where these files are is `pending` and `pending_under`, each from the
//! folder core's `state`; nothing else here names a directory.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use epicenter_folder_core::page_files;
use epicenter_folder_core::paths::path_problem;
use epicenter_folder_core::state;
use epicenter_folder_core::storage::{place, prepare_state_directory, rename_failure};
use serde::Serialize;

use crate::webm::{finish_cut_off, CutOff, OPUS_RATE};

/// The checked full path the recording of the folder-relative `stem` (its
/// path without an extension) is written to while it records, in `root`
/// (`state::recording`), with its missing directories made. `.epicenter` is
/// made `0700` when missing and refused when it is a link; every name below
/// it is checked as a data path is.
pub fn pending(root: &Path, stem: &str) -> Result<PathBuf, String> {
    prepare_state_directory(root)?;
    let pending = state::recording(stem);
    let path = page_files::data_path(root, &pending)?;
    if let Some((parent, _)) = pending.rsplit_once('/') {
        page_files::mkdir(root, &root.join(parent))?;
    }
    Ok(path)
}

/// Every recording a quit or a crash left pending under the folder-relative
/// directory `under` in `root`: each file's full path and the stem it is the
/// recording of. A link is never followed, and only paths the shared path
/// rule accepts are visited. Nothing pending is nothing.
fn pending_under(root: &Path, under: &str) -> Result<Vec<(PathBuf, String)>, String> {
    let directory = page_files::data_path(root, &state::recordings_under(under))?;
    let mut found = Vec::new();
    let mut directories: Vec<(PathBuf, String)> = vec![(directory, under.to_string())];
    while let Some((directory, relative)) = directories.pop() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("'{relative}' could not be listed: {error}")),
        };
        for entry in entries {
            let entry =
                entry.map_err(|error| format!("'{relative}' could not be listed: {error}"))?;
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let child = format!("{relative}/{name}");
            if path_problem(&child).is_some() {
                continue;
            }
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if metadata.is_dir() {
                directories.push((path, child));
                continue;
            }
            let stem = child
                .strip_suffix(".webm")
                .filter(|stem| !stem.ends_with('/'));
            if let (true, Some(stem)) = (metadata.is_file(), stem) {
                found.push((path, stem.to_string()));
            }
        }
    }
    Ok(found)
}

/// Why `place_recording` did not place a recording.
#[derive(Debug, PartialEq, Eq)]
pub enum PlaceError {
    /// Another file is at the folder-relative path.
    Taken(String),
    /// The path is refused, or the disk refused.
    Failed(String),
}

/// Move the finished recording at `pending` to `<stem>.webm` in `root`,
/// making its missing directories, each checked as a data path, and answer
/// that folder-relative path. Something already at the path is never
/// replaced. A move a crash cut off between linking the path and removing
/// the pending name is finished (`storage::place`). A path across a mount
/// point inside the folder is refused (`rename_failure`), and the file
/// stays.
pub fn place_recording(root: &Path, pending: &Path, stem: &str) -> Result<String, PlaceError> {
    let relative = format!("{stem}.webm");
    if let Some((parent, _)) = relative.rsplit_once('/') {
        page_files::mkdir(root, &root.join(parent)).map_err(PlaceError::Failed)?;
    }
    let target = page_files::data_path(root, &relative).map_err(PlaceError::Failed)?;
    match place(pending, &target) {
        Ok(()) => {
            sync_directory_of(&target);
            Ok(relative)
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            Err(PlaceError::Taken(relative))
        }
        Err(error) => Err(PlaceError::Failed(rename_failure(&relative, &error))),
    }
}

/// Flush the directory holding `path` to the disk, so a name just made in
/// it survives a power loss; a directory that cannot be flushed is not a
/// failure. Windows has no such call.
fn sync_directory_of(path: &Path) {
    #[cfg(unix)]
    if let Some(Ok(directory)) = path.parent().map(fs::File::open) {
        if let Err(error) = directory.sync_all() {
            log::warn!("{} was not flushed: {error}", path.display());
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// What `recover` did with the recordings a quit or a crash left pending.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Recovery {
    /// Each recording finished and placed at its path, by path.
    pub recovered: Vec<RecoveredRecording>,
    /// Each recording finished but left pending, because another file is at
    /// its path, by path. Its audio stays where it is until a person moves
    /// one of the two.
    pub unplaced: Vec<UnplacedRecording>,
}

/// A recording `recover` placed: where its audio is, and how long it plays.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RecoveredRecording {
    /// Its folder-relative path: the path its page named plus `.webm`.
    pub path: String,
    /// How long it plays, to the nearest millisecond, as its file states.
    pub duration_ms: u32,
}

/// A recording `recover` did not place, because another file is at its path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UnplacedRecording {
    /// The folder-relative path it was not placed at: another file is there.
    pub path: String,
    /// Where its audio is: its folder-relative path under
    /// `.epicenter/recordings` (`state::recording`), finished.
    pub pending: String,
}

/// Finish and place every recording a quit or a crash left pending under
/// `under` in the folder at `root` (`pending_under`), skipping the one
/// `held` names: the file a live recording is still writing. `held` is
/// asked about each file once it is listed, right before it is touched, so
/// a recording that started after this began is never taken for a
/// leftover. Each is finished in place from its whole seconds
/// (`webm::finish_cut_off`) and placed at its path. Answers each recording
/// placed, by path, with how long it plays. A missing directory has nothing
/// to recover. Running it again changes nothing.
///
/// A leftover that is the file already at its path, one device and inode
/// (a move a crash cut off between linking the path and removing the
/// pending name), loses only its pending name: `storage::place` finishes
/// the move, and it is answered as placed. A leftover that holds no whole
/// second holds no audio, and is deleted. A leftover whose path holds
/// another file is never deleted and never placed beside it: nothing here
/// can know the two are one recording, so it stays pending, finished, and
/// is answered among `unplaced` with where its audio is, every time this
/// runs, until a person moves one of the two.
///
/// `under` is checked as a data path is (`page_files::data_path`). A file
/// that cannot be finished or placed is reported and left where it is, so
/// one bad file does not hide the rest.
pub fn recover(root: &Path, under: &str, held: impl Fn(&Path) -> bool) -> Result<Recovery, String> {
    page_files::data_path(root, under)?;
    let mut recovery = Recovery::default();
    for (pending, stem) in pending_under(root, under)? {
        if held(&pending) {
            continue;
        }
        let played = match finish_cut_off(&pending) {
            Ok(CutOff::Finished { played } | CutOff::Recovered { played }) => played,
            Ok(CutOff::Empty) => {
                log::info!("Removed the recording of {stem}: no audio reached it");
                remove(&pending);
                continue;
            }
            // Stopped and placed since it was listed.
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                log::warn!("Could not finish the recording of {stem}: {error}");
                continue;
            }
        };
        match place_recording(root, &pending, &stem) {
            Ok(path) => {
                log::info!("Recovered the recording of {stem} at {path}");
                recovery.recovered.push(RecoveredRecording {
                    path,
                    duration_ms: ((played * 1_000 + OPUS_RATE / 2) / OPUS_RATE) as u32,
                });
            }
            Err(PlaceError::Taken(path)) => {
                let pending = state::recording(&stem);
                log::warn!("Kept the recording of {stem} at {pending}: another file is at {path}");
                recovery.unplaced.push(UnplacedRecording { path, pending });
            }
            Err(PlaceError::Failed(error)) => {
                log::warn!("Could not place the recording of {stem}: {error}")
            }
        }
    }
    recovery.recovered.sort_by(|a, b| a.path.cmp(&b.path));
    recovery.unplaced.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(recovery)
}

/// Remove the file at `path`; one already gone is not a failure.
fn remove(path: &Path) {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => log::warn!("{} was not removed: {error}", path.display()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::opus::OpusRecording;

    /// The 16 kHz samples of a recording cut off after `seconds`, rounded to
    /// whole 20 ms packets, written at `path` and left as a crash leaves it.
    fn cut_off(path: &Path, seconds: f64) {
        let mut recording = OpusRecording::new(fs::File::create(path).unwrap()).unwrap();
        let samples = (seconds * 16_000.0) as usize / 320 * 320;
        recording.write(&vec![1_000i16; samples]).unwrap();
    }

    /// What a cut-off recording of `seconds` plays once recovered, in
    /// milliseconds: its whole seconds before the one held, less the
    /// encoder's 6.5 ms delay.
    fn kept_ms(seconds: f64) -> u32 {
        let packets = (seconds * 50.0) as u64;
        let whole = (packets - 1) / 50 * 50;
        (((whole * 960 - 312) * 1_000 + 24_000) / 48_000) as u32
    }

    fn recovered(path: &str, duration_ms: u32) -> RecoveredRecording {
        RecoveredRecording {
            path: path.to_string(),
            duration_ms,
        }
    }

    /// The samples the transcription decoder reads from the file at `path`.
    fn decoded(path: &Path) -> usize {
        tauri_plugin_epicenter_transcription::audio::decode_to_pcm16k_mono(&fs::read(path).unwrap())
            .unwrap()
            .len()
    }

    #[test]
    fn recover_finishes_and_places_what_a_cut_left_pending_and_nothing_else() {
        let directory = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(directory.path()).unwrap();
        let pending = root.join(state::recordings_under("recordings"));
        fs::create_dir_all(pending.join("2026")).unwrap();
        fs::create_dir_all(root.join("recordings")).unwrap();
        cut_off(&pending.join("a.webm"), 2.5);
        cut_off(&pending.join("2026/b.webm"), 3.1);
        cut_off(&pending.join("live.webm"), 2.5);
        fs::write(pending.join("notes.txt"), b"not a recording").unwrap();
        cut_off(&root.join("recordings/placed.webm"), 2.5);
        let placed_bytes = fs::read(root.join("recordings/placed.webm")).unwrap();

        let live = pending.join("live.webm");
        let live_bytes = fs::read(&live).unwrap();
        let recovery = recover(&root, "recordings", |path| path == live).unwrap();
        assert_eq!(
            recovery.recovered,
            [
                recovered("recordings/2026/b.webm", kept_ms(3.1)),
                recovered("recordings/a.webm", kept_ms(2.5)),
            ]
        );
        assert!(recovery.unplaced.is_empty());
        // 2.5 s cut off keeps its first two seconds, less the delay.
        assert_eq!(kept_ms(2.5), 1_994);
        assert_eq!(decoded(&root.join("recordings/a.webm")), 2 * 16_000 - 104);
        assert!(!pending.join("a.webm").exists(), "moved, not copied");
        assert!(!pending.join("2026/b.webm").exists());
        assert_eq!(
            fs::read(&live).unwrap(),
            live_bytes,
            "a live recording is its writer's"
        );
        assert_eq!(
            fs::read(pending.join("notes.txt")).unwrap(),
            b"not a recording"
        );
        assert_eq!(
            fs::read(root.join("recordings/placed.webm")).unwrap(),
            placed_bytes,
            "a file already at its path is not the recorder's to change"
        );

        assert_eq!(
            recover(&root, "recordings", |path| path == live).unwrap(),
            Recovery::default()
        );
        assert_eq!(
            recover(&root, "nothing-here", |_| false).unwrap(),
            Recovery::default()
        );
    }

    /// A leftover whose path holds another file is never deleted and never
    /// placed beside it: it stays pending, finished, and is answered with
    /// where its audio is, on every run. When the file there is the leftover
    /// itself, the move is finished and answered. One that holds no whole
    /// second holds no audio, and is deleted.
    #[test]
    fn a_leftover_is_deleted_only_when_it_holds_no_audio() {
        let directory = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(directory.path()).unwrap();
        let taken = pending(&root, "recordings/taken").unwrap();
        cut_off(&taken, 2.5);
        fs::create_dir_all(root.join("recordings")).unwrap();
        fs::write(root.join("recordings/taken.webm"), b"theirs").unwrap();
        let empty = pending(&root, "recordings/empty").unwrap();
        cut_off(&empty, 0.5);
        // A move cut off between linking its path and removing its pending
        // name: the same file at both.
        let linked = pending(&root, "recordings/linked").unwrap();
        cut_off(&linked, 2.5);
        finish_cut_off(&linked).unwrap();
        fs::hard_link(&linked, root.join("recordings/linked.webm")).unwrap();

        let unplaced = UnplacedRecording {
            path: "recordings/taken.webm".to_string(),
            pending: ".epicenter/recordings/recordings/taken.webm".to_string(),
        };
        assert_eq!(
            recover(&root, "recordings", |_| false).unwrap(),
            Recovery {
                recovered: vec![recovered("recordings/linked.webm", kept_ms(2.5))],
                unplaced: vec![unplaced.clone()],
            }
        );
        assert_eq!(root.join(&unplaced.pending), taken);
        assert_eq!(decoded(&taken), 2 * 16_000 - 104, "kept, and finished");
        assert_eq!(
            fs::read(root.join("recordings/taken.webm")).unwrap(),
            b"theirs"
        );
        assert!(!empty.exists());
        assert!(!root.join("recordings/empty.webm").exists());
        assert!(!linked.exists());
        assert_eq!(
            decoded(&root.join("recordings/linked.webm")),
            2 * 16_000 - 104
        );

        let finished = fs::read(&taken).unwrap();
        assert_eq!(
            recover(&root, "recordings", |_| false).unwrap(),
            Recovery {
                recovered: vec![],
                unplaced: vec![unplaced],
            },
            "answered again, until a person moves one of the two"
        );
        assert_eq!(fs::read(&taken).unwrap(), finished);
    }

    #[test]
    fn recover_refuses_a_directory_the_path_rule_refuses() {
        let directory = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(directory.path()).unwrap();
        for under in [".git", "../outside", "a/HEAD", ""] {
            assert!(recover(&root, under, |_| false).is_err(), "{under:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn recover_never_follows_a_link() {
        let directory = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(directory.path()).unwrap().join("folder");
        let outside = fs::canonicalize(directory.path()).unwrap().join("outside");
        let pending = root.join(state::recordings_under("recordings"));
        fs::create_dir_all(&pending).unwrap();
        fs::create_dir_all(&outside).unwrap();
        cut_off(&outside.join("x.webm"), 2.5);
        let bytes = fs::read(outside.join("x.webm")).unwrap();
        std::os::unix::fs::symlink(outside.join("x.webm"), pending.join("x.webm")).unwrap();
        std::os::unix::fs::symlink(&outside, pending.join("linked")).unwrap();
        assert_eq!(
            recover(&root, "recordings", |_| false).unwrap(),
            Recovery::default()
        );
        assert_eq!(fs::read(outside.join("x.webm")).unwrap(), bytes);
        assert!(!root.join("recordings").exists());

        std::os::unix::fs::symlink(&outside, root.join("linked-recordings")).unwrap();
        assert!(recover(&root, "linked-recordings", |_| false).is_err());
    }

    #[test]
    fn a_recording_is_placed_only_where_nothing_is() {
        let directory = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(directory.path()).unwrap();
        let first = pending(&root, "recordings/2026/a").unwrap();
        fs::write(&first, b"finished").unwrap();
        assert_eq!(
            place_recording(&root, &first, "recordings/2026/a"),
            Ok("recordings/2026/a.webm".to_string())
        );
        assert!(!first.exists());
        let second = pending(&root, "recordings/2026/a").unwrap();
        fs::write(&second, b"another").unwrap();
        assert_eq!(
            place_recording(&root, &second, "recordings/2026/a"),
            Err(PlaceError::Taken("recordings/2026/a.webm".to_string()))
        );
        assert_eq!(
            fs::read(root.join("recordings/2026/a.webm")).unwrap(),
            b"finished"
        );
        assert!(second.exists());
    }
}
