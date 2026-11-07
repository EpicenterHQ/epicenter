//! Where a recording is written while it records, how it reaches its own
//! path, and how one a crash cut off gets there.
//!
//! A recording in progress is a WebM beside its final path under a reserved
//! name: `<directory>/.ep-<random>-<base>.recording` for
//! `<directory>/<base>.webm` (`pending`, from the folder core's
//! `state::pending_recording`). No listing describes it, no watcher reports
//! it, and sync never sends it, so nothing reads a recording at a data
//! path before it is finished (ADR-0822). The name carries the final path,
//! so recovery after a crash knows where it goes.
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
//! An older build wrote a recording in progress to
//! `.epicenter/recordings/<its folder-relative stem>.webm`. `recover` still
//! finishes and places those, so a take such a build cut off is not lost;
//! opening the folder moves one over an hour old beside its final path (the
//! folder core's `sweep`).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use epicenter_folder_core::page_files;
use epicenter_folder_core::paths::path_problem;
use epicenter_folder_core::state;
use epicenter_folder_core::storage::place;
use serde::Serialize;

use crate::webm::{finish_cut_off, CutOff, OPUS_RATE};

/// The checked full path the recording of the folder-relative `stem` (its
/// path without an extension) is written to while it records in `root`:
/// beside `<stem>.webm` under a new reserved name
/// (`state::pending_recording`), with its missing directories made, each
/// checked as a data directory.
pub fn pending(root: &Path, stem: &str) -> Result<PathBuf, String> {
    let pending = state::pending_recording(stem);
    if let Some((parent, _)) = pending.rsplit_once('/') {
        page_files::mkdir(root, &root.join(parent))?;
    }
    page_files::data_path(root, &pending)
}

/// A recording a quit or a crash left: its full path, the stem it is the
/// recording of, and its folder-relative path.
struct Leftover {
    path: PathBuf,
    stem: String,
    pending: String,
}

/// Every recording a quit or a crash left pending under the folder-relative
/// directory `under` in `root`: each beside its final path under a reserved
/// name, and each an older build left in `.epicenter/recordings/<under>`. A
/// link is never followed, and only paths the shared path rule accepts are
/// visited. Nothing pending is nothing.
fn pending_under(root: &Path, under: &str) -> Result<Vec<Leftover>, String> {
    let mut found = Vec::new();
    for (path, relative) in files_under(root, under)? {
        let Some(stem) = state::recording_final(&relative)
            .and_then(|landing| landing.strip_suffix(".webm").map(str::to_string))
        else {
            continue;
        };
        found.push(Leftover {
            path,
            stem,
            pending: relative,
        });
    }
    let legacy = format!("{}/{}/", state::DIRECTORY, state::LEGACY_RECORDINGS);
    for (path, relative) in files_under(root, &format!("{legacy}{under}"))? {
        let stem = relative
            .strip_prefix(&legacy)
            .and_then(|stem| stem.strip_suffix(".webm"))
            .filter(|stem| !stem.ends_with('/'))
            .map(str::to_string);
        if let Some(stem) = stem {
            found.push(Leftover {
                path,
                stem,
                pending: relative,
            });
        }
    }
    Ok(found)
}

/// Every regular file at or below the folder-relative directory `under` in
/// `root`: each one's full path and folder-relative path. A link is never
/// followed, and only paths the shared path rule accepts are visited, so
/// nothing in `.git` is. A missing directory holds nothing.
fn files_under(root: &Path, under: &str) -> Result<Vec<(PathBuf, String)>, String> {
    let directory = page_files::data_path(root, under)?;
    let mut found = Vec::new();
    let mut directories: Vec<(PathBuf, String)> = vec![(directory, under.to_string())];
    while let Some((directory, relative)) = directories.pop() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                ) =>
            {
                continue
            }
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
            } else if metadata.is_file() {
                found.push((path, child));
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
/// replaced (`storage::place`), and the file stays.
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
        Err(error) => Err(PlaceError::Failed(error.to_string())),
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
    /// Where its audio is, finished: its folder-relative path, beside
    /// `path` under a reserved name (`.ep-<random>-<base>.recording`), or
    /// in `.epicenter/recordings` where an older build left it.
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
/// A leftover that holds no whole second holds no audio, and is deleted. A
/// leftover whose path holds another file is never deleted and never placed
/// beside it: nothing here can know the two are one recording, so it stays
/// pending, finished, and is answered among `unplaced` with where its audio
/// is, every time this runs, until a person moves one of the two.
///
/// `under` is checked as a data path is (`page_files::data_path`). A file
/// that cannot be finished or placed is reported and left where it is, so
/// one bad file does not hide the rest.
pub fn recover(root: &Path, under: &str, held: impl Fn(&Path) -> bool) -> Result<Recovery, String> {
    page_files::data_path(root, under)?;
    let mut recovery = Recovery::default();
    for leftover in pending_under(root, under)? {
        let Leftover {
            path: pending,
            stem,
            pending: relative,
        } = leftover;
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
                log::warn!("Kept the recording of {stem} at {relative}: another file is at {path}");
                recovery.unplaced.push(UnplacedRecording {
                    path,
                    pending: relative,
                });
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

    /// `path` below `root`, folder-relative.
    fn relative(root: &Path, path: &Path) -> String {
        path.strip_prefix(root)
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn a_pending_recording_waits_beside_its_path_under_a_reserved_name() {
        let directory = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(directory.path()).unwrap();
        let path = pending(&root, "recordings/2026/a").unwrap();
        let pending = relative(&root, &path);
        assert!(pending.starts_with("recordings/2026/.ep-"), "{pending}");
        assert!(state::is_reserved(&pending), "{pending}");
        assert_eq!(
            state::recording_final(&pending).as_deref(),
            Some("recordings/2026/a.webm")
        );
        assert!(root.join("recordings/2026").is_dir());
        assert!(!path.exists(), "the recorder creates the file");
        assert!(!root.join(state::DIRECTORY).exists());
    }

    #[test]
    fn recover_finishes_and_places_what_a_cut_left_pending_and_nothing_else() {
        let directory = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(directory.path()).unwrap();
        let a = pending(&root, "recordings/a").unwrap();
        let b = pending(&root, "recordings/2026/b").unwrap();
        let live = pending(&root, "recordings/live").unwrap();
        cut_off(&a, 2.5);
        cut_off(&b, 3.1);
        cut_off(&live, 2.5);
        fs::write(root.join("recordings/notes.txt"), b"not a recording").unwrap();
        fs::write(root.join("recordings/.ep-0123456789abcdef.save"), b"a save").unwrap();
        cut_off(&root.join("recordings/placed.webm"), 2.5);
        let placed_bytes = fs::read(root.join("recordings/placed.webm")).unwrap();
        // An older build's take, cut off.
        let legacy = root.join(".epicenter/recordings/recordings/old.webm");
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        cut_off(&legacy, 2.5);

        let live_bytes = fs::read(&live).unwrap();
        let recovery = recover(&root, "recordings", |path| path == live).unwrap();
        assert_eq!(
            recovery.recovered,
            [
                recovered("recordings/2026/b.webm", kept_ms(3.1)),
                recovered("recordings/a.webm", kept_ms(2.5)),
                recovered("recordings/old.webm", kept_ms(2.5)),
            ]
        );
        assert!(recovery.unplaced.is_empty());
        // 2.5 s cut off keeps its first two seconds, less the delay.
        assert_eq!(kept_ms(2.5), 1_994);
        assert_eq!(decoded(&root.join("recordings/a.webm")), 2 * 16_000 - 104);
        assert!(!a.exists(), "moved, not copied");
        assert!(!b.exists());
        assert!(!legacy.exists());
        assert_eq!(
            fs::read(&live).unwrap(),
            live_bytes,
            "a live recording is its writer's"
        );
        assert_eq!(
            fs::read(root.join("recordings/notes.txt")).unwrap(),
            b"not a recording"
        );
        assert_eq!(
            fs::read(root.join("recordings/.ep-0123456789abcdef.save")).unwrap(),
            b"a save"
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
    /// where its audio is, on every run. One that holds no whole second
    /// holds no audio, and is deleted.
    #[test]
    fn a_leftover_is_deleted_only_when_it_holds_no_audio() {
        let directory = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(directory.path()).unwrap();
        let taken = pending(&root, "recordings/taken").unwrap();
        cut_off(&taken, 2.5);
        fs::write(root.join("recordings/taken.webm"), b"theirs").unwrap();
        let empty = pending(&root, "recordings/empty").unwrap();
        cut_off(&empty, 0.5);

        let unplaced = UnplacedRecording {
            path: "recordings/taken.webm".to_string(),
            pending: relative(&root, &taken),
        };
        assert_eq!(
            recover(&root, "recordings", |_| false).unwrap(),
            Recovery {
                recovered: vec![],
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
        fs::create_dir_all(root.join("recordings")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        cut_off(&outside.join("x.webm"), 2.5);
        let bytes = fs::read(outside.join("x.webm")).unwrap();
        std::os::unix::fs::symlink(
            outside.join("x.webm"),
            root.join("recordings/.ep-k3j9x2ab-x.recording"),
        )
        .unwrap();
        std::os::unix::fs::symlink(&outside, root.join("recordings/linked")).unwrap();
        assert_eq!(
            recover(&root, "recordings", |_| false).unwrap(),
            Recovery::default()
        );
        assert_eq!(fs::read(outside.join("x.webm")).unwrap(), bytes);
        assert!(!root.join("recordings/x.webm").exists());

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
