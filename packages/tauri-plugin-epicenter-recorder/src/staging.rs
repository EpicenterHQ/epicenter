//! Where a recording is written while it records, and how it reaches its own
//! path.
//!
//! A recording in progress lives in the folder's own state directory, at
//! `.epicenter/recording/<its folder-relative path>`, which no listing shows,
//! no watcher reports, and `epicenter init`'s `.gitignore` keeps out of
//! history. So `epicenter sync` never commits a half-written WAV, and nothing
//! reads one as the folder's audio. When it stops, `place` moves it to its
//! own path without replacing anything there; `wav::recover` repairs and
//! places what a quit or a crash left behind.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use epicenter_folder_core::page_files;
use epicenter_folder_core::storage::{prepare_state_directory, STATE_DIRECTORY};

/// The directory in a folder's `.epicenter` that recordings in progress are
/// written under.
const RECORDINGS: &str = "recording";

/// Where the recording of the folder-relative `relative` is written while it
/// records, as a path relative to the folder.
pub fn staged(relative: &str) -> String {
    format!("{STATE_DIRECTORY}/{RECORDINGS}/{relative}")
}

/// The checked full path the recording of `relative` is written to in
/// `root`, with its missing directories made. `.epicenter` is made private to
/// this account when missing and refused when it is a link; every name below
/// it is checked as a data path is.
pub fn prepare(root: &Path, relative: &str) -> Result<PathBuf, String> {
    prepare_state_directory(root)?;
    let staged = staged(relative);
    let path = page_files::data_path(root, &staged)?;
    if let Some((parent, _)) = staged.rsplit_once('/') {
        page_files::mkdir(root, &root.join(parent))?;
    }
    Ok(path)
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
