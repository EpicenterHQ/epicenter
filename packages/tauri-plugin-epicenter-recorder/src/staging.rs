//! Where a recording is written while it records, and how it reaches its own
//! path.
//!
//! A recording in progress is a WAV among the folder's unfinished writes,
//! at `.epicenter/recordings/<its folder-relative path>.wav` (`pending`,
//! from `state::recording`): a hidden path, which no watcher reports and
//! `epicenter sync` never commits, so nothing reads a half-written recording
//! as the folder's audio.
//!
//! When it stops, `settle` encodes the WAV to Opus in WebM (`opus::encode`)
//! in a scratch file in the folder's `.epicenter/saves` (`encode_scratch`),
//! places that at `<path>.webm` without replacing anything there (`place`),
//! and only then removes the WAV. A stop whose path something took meanwhile
//! leaves the WAV; recovery places what it settles beside a taken path
//! (`sweep`). A quit or a crash before then leaves the WAV, which
//! `wav::recover` repairs and settles the same way the next time the folder
//! opens, and at most a scratch file, which the folder removes once it is an
//! hour old (`storage::sweep_scratch`, which never reads `recordings/`). A
//! WAV that cannot be encoded is placed itself, at `<path>.wav`: no audio is
//! lost to an encoder.
//!
//! Where these files are is `pending`, `pending_under`, and
//! `encode_scratch`, each from the folder core's `state`; nothing else here
//! names a directory.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use epicenter_folder_core::page_files;
use epicenter_folder_core::paths::path_problem;
use epicenter_folder_core::state;
use epicenter_folder_core::storage::{create_scratch, prepare_state_directory};

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
/// directory `under` in `root`: each WAV's full path and the stem it is the
/// recording of. A link is never followed, and only paths the shared path
/// rule accepts are visited. Nothing pending is nothing.
pub fn pending_under(root: &Path, under: &str) -> Result<Vec<(PathBuf, String)>, String> {
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
                .rsplit_once('.')
                .filter(|(_, extension)| extension.eq_ignore_ascii_case("wav"))
                .map(|(stem, _)| stem.to_string());
            if let (true, Some(stem)) = (metadata.is_file(), stem) {
                found.push((path, stem));
            }
        }
    }
    Ok(found)
}

/// A new scratch file in `root`'s `.epicenter/saves` to encode a recording
/// into: on the folder's own file system, so it can be linked to its path,
/// and named so that one a crash leaves behind is removed once stale.
fn encode_scratch(root: &Path) -> Result<(PathBuf, fs::File), String> {
    create_scratch(root)
}

/// What `settle` does when another file holds the recording's path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WhenTaken {
    /// Fail, leaving the WAV pending: a stop, whose page named the path.
    Refuse,
    /// Place it at the first free `<stem>-recovered[-n]` name beside it:
    /// recovery, so nothing stays pending forever.
    PlaceBeside,
}

/// Where `settle` put a recording.
#[derive(Debug, PartialEq, Eq)]
pub struct Settled {
    /// The folder-relative path of its audio.
    pub path: String,
    /// False when a file with the same bytes was already there, which the
    /// recording is a copy of: nothing new was placed.
    pub placed: bool,
    /// Why it is a WAV, when it could not be encoded.
    pub unencoded: Option<String>,
}

/// Turn the finalized WAV at `pending`, the recording of `stem` in `root`,
/// into its file in the folder: Opus in WebM at `<stem>.webm`, then remove
/// the WAV. A WAV that cannot be encoded is placed itself, at `<stem>.wav`.
/// A path another file holds is never replaced (`when_taken`); one holding
/// the same bytes is this recording, placed by a settle cut off before it
/// removed the WAV, and the WAV is only removed.
///
/// On an error the WAV is where it was, for the next `wav::recover`.
pub fn settle(
    root: &Path,
    pending: &Path,
    stem: &str,
    when_taken: WhenTaken,
) -> Result<Settled, String> {
    let wav = format!("{stem}.wav");
    if same_bytes(pending, &page_files::data_path(root, &wav)?).unwrap_or(false) {
        remove(pending)?;
        return Ok(Settled {
            path: wav,
            placed: false,
            unencoded: None,
        });
    }
    // A scratch file that cannot be made is an encode that cannot run: the
    // WAV is placed either way, so a recording is never stranded pending.
    let encoded =
        encode_scratch(root).and_then(|(scratch, file)| match crate::opus::encode(pending, file) {
            Ok(_) => Ok(scratch),
            Err(reason) => {
                let _ = fs::remove_file(&scratch);
                Err(reason)
            }
        });
    let scratch = match encoded {
        Ok(scratch) => scratch,
        Err(reason) => {
            let (path, placed) = sweep(root, pending, &wav, when_taken)?;
            return Ok(Settled {
                path,
                placed,
                unencoded: Some(reason),
            });
        }
    };
    let (path, placed) = match sweep(root, &scratch, &format!("{stem}.webm"), when_taken) {
        Ok(swept) => swept,
        Err(error) => {
            let _ = fs::remove_file(&scratch);
            return Err(error);
        }
    };
    // Its new name reaches the disk before the WAV's goes.
    sync_directory_of(&root.join(&path));
    // The recording is in place; a WAV left behind encodes to the same
    // bytes, so the next recovery removes it as a copy.
    if let Err(error) = remove(pending) {
        log::warn!("{path} is in place, but its WAV was not removed: {error}");
    }
    Ok(Settled {
        path,
        placed,
        unencoded: None,
    })
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

/// Remove the file at `path`; one already gone is not a failure.
fn remove(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("remove {}: {error}", path.display())),
    }
}

/// How many `-recovered` names `sweep` tries beside a taken path.
const RECOVERED_NAMES: usize = 100;

/// Move the file at `staged` to the folder-relative `relative` in `root`,
/// making its missing directories, each checked as a data path, and answer
/// where it is and whether it was placed. When something is at `relative`
/// already, it is never replaced: a staged file with the same bytes is a
/// copy of it and is removed (not placed); anything else is refused, or for
/// `PlaceBeside` goes to the first free `<stem>-recovered.<ext>`,
/// `<stem>-recovered-2.<ext>`, and so on, so no recording is stranded in
/// `.epicenter`, which sync never commits.
fn sweep(
    root: &Path,
    staged: &Path,
    relative: &str,
    when_taken: WhenTaken,
) -> Result<(String, bool), String> {
    let (parent, name) = relative.rsplit_once('/').unwrap_or(("", relative));
    if !parent.is_empty() {
        page_files::mkdir(root, &root.join(parent))?;
    }
    let (stem, extension) = name.rsplit_once('.').unwrap_or((name, ""));
    let beside = match when_taken {
        WhenTaken::Refuse => 0,
        WhenTaken::PlaceBeside => RECOVERED_NAMES,
    };
    for attempt in 0..=beside {
        let candidate = match attempt {
            0 => name.to_string(),
            1 => format!("{stem}-recovered.{extension}"),
            n => format!("{stem}-recovered-{n}.{extension}"),
        };
        let candidate = if parent.is_empty() {
            candidate
        } else {
            format!("{parent}/{candidate}")
        };
        let target = page_files::data_path(root, &candidate)?;
        match place(staged, &target) {
            Ok(()) => return Ok((candidate, true)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if same_bytes(staged, &target).map_err(|error| error.to_string())? {
                    fs::remove_file(staged).map_err(|error| error.to_string())?;
                    return Ok((candidate, false));
                }
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Err(match when_taken {
        WhenTaken::Refuse => format!("a file is already at {relative}"),
        WhenTaken::PlaceBeside => {
            format!("{relative} and the next {RECOVERED_NAMES} names beside it are taken")
        }
    })
}

/// Whether the files at `a` and `b` hold the same bytes.
fn same_bytes(a: &Path, b: &Path) -> io::Result<bool> {
    if fs::metadata(a)?.len() != fs::metadata(b)?.len() {
        return Ok(false);
    }
    Ok(fs::read(a)? == fs::read(b)?)
}

/// Move the file at `staged` to `target`, never replacing anything there:
/// a hard link to `target`, which fails when a name is already there, then
/// the staged name removed. A link already made by an earlier move that
/// stopped before the removal counts as placed. Where the disk has no hard
/// links, the file is renamed only while nothing is at `target`.
pub fn place(staged: &Path, target: &Path) -> io::Result<()> {
    match fs::hard_link(staged, target) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            if !same_file(staged, target)? {
                return Err(error);
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Err(error),
        Err(_) => {
            if fs::symlink_metadata(target).is_ok() {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "a file is already there",
                ));
            }
            return fs::rename(staged, target);
        }
    }
    fs::remove_file(staged)
}

/// Whether `a` and `b` are one file.
fn same_file(a: &Path, b: &Path) -> io::Result<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let (a, b) = (fs::symlink_metadata(a)?, fs::symlink_metadata(b)?);
        Ok((a.dev(), a.ino()) == (b.dev(), b.ino()))
    }
    #[cfg(not(unix))]
    {
        let _ = (a, b);
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_staged_file_is_placed_and_its_staged_name_removed() {
        let directory = tempfile::tempdir().unwrap();
        let staged = directory.path().join("staged.wav");
        let target = directory.path().join("a.wav");
        fs::write(&staged, b"audio").unwrap();
        place(&staged, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"audio");
        assert!(!staged.exists());
    }

    #[test]
    fn placing_never_replaces_a_file_already_there() {
        let directory = tempfile::tempdir().unwrap();
        let staged = directory.path().join("staged.wav");
        let target = directory.path().join("a.wav");
        fs::write(&staged, b"audio").unwrap();
        fs::write(&target, b"kept").unwrap();
        let refused = place(&staged, &target).unwrap_err();
        assert_eq!(refused.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&target).unwrap(), b"kept");
        assert_eq!(fs::read(&staged).unwrap(), b"audio");
    }

    /// A move that stopped after the link and before the removal is
    /// finished: the second name is the same file.
    #[cfg(unix)]
    #[test]
    fn a_move_cut_off_after_its_link_is_finished() {
        let directory = tempfile::tempdir().unwrap();
        let staged = directory.path().join("staged.wav");
        let target = directory.path().join("a.wav");
        fs::write(&staged, b"audio").unwrap();
        fs::hard_link(&staged, &target).unwrap();
        place(&staged, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"audio");
        assert!(!staged.exists());
    }
}
