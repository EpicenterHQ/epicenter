//! How a file is written in Whispering's folder (ADR-0962): at its own
//! path, or beside it and renamed over it, never anywhere else.
//!
//! [`replace`] writes a note or `settings.md` whole: the bytes go to a
//! hidden temporary file in the target's own directory
//! (`.<name>.<random>.tmp`), which is flushed and renamed over the target,
//! so a reader finds the old file or the new one, never part of one. Each
//! write has a name of its own, so two writes to one target at once never
//! touch each other's file: the last rename wins, and each lands whole.
//! The path rule refuses a hidden name, so the temporary file is never
//! listed or read. One a crash left is removed when the folder opens
//! ([`remove_leftovers`]).
//!
//! A rename stays in one directory, so it never crosses a disk. Only
//! "Change…" (`change.rs`) moves files between folders, and across disks it
//! copies each file beside its target first, through the same temporary
//! file ([`through_temporary`]).

use std::collections::hash_map::RandomState;
use std::fs::{self, File};
use std::hash::{BuildHasher, Hasher};
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::path::is_file_name;

/// The directories of the folder a temporary file is written in: the
/// folder itself (`settings.md`), `recordings/`, and `transcriptions/`.
const NOTE_DIRECTORIES: [&str; 3] = ["", "recordings", "transcriptions"];

const TEMPORARY_SUFFIX: &str = ".tmp";
/// How many characters of a temporary file's name are its own.
const RANDOM_LENGTH: usize = 8;
const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";

/// `RANDOM_LENGTH` lowercase base 36 characters, distinct within one
/// process and unpredictable across processes.
fn random() -> String {
    static DRAWN: AtomicU64 = AtomicU64::new(0);
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(DRAWN.fetch_add(1, Ordering::Relaxed));
    hasher.write_u32(std::process::id());
    let mut value = hasher.finish();
    (0..RANDOM_LENGTH)
        .map(|_| {
            let character = char::from(ALPHABET[(value % 36) as usize]);
            value /= 36;
            character
        })
        .collect()
}

/// A temporary file beside `target` that no other write uses:
/// `.<name>.<random>.tmp` in its directory, created new, so nothing already
/// at a name (another write's file, or a link) is ever written through.
fn create_beside(target: &Path) -> io::Result<(PathBuf, File)> {
    let (Some(directory), Some(name)) = (target.parent(), target.file_name()) else {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "the target has no directory",
        ));
    };
    let mut attempts = 0;
    loop {
        let mut temporary = std::ffi::OsString::from(".");
        temporary.push(name);
        temporary.push(".");
        temporary.push(random());
        temporary.push(TEMPORARY_SUFFIX);
        let temporary = directory.join(temporary);
        match File::options()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => return Ok((temporary, file)),
            Err(error) if error.kind() == ErrorKind::AlreadyExists && attempts < 3 => {
                attempts += 1;
            }
            Err(error) => return Err(error),
        }
    }
}

/// Whether `name` is a temporary file's name as [`create_beside`] makes it:
/// a dot, a file name the path rule accepts, a dot, its own
/// `RANDOM_LENGTH` characters, then `.tmp`.
pub(crate) fn is_temporary_name(name: &str) -> bool {
    let Some(rest) = name
        .strip_prefix('.')
        .and_then(|rest| rest.strip_suffix(TEMPORARY_SUFFIX))
    else {
        return false;
    };
    let Some((target, own)) = rest.rsplit_once('.') else {
        return false;
    };
    own.len() == RANDOM_LENGTH
        && own.bytes().all(|byte| ALPHABET.contains(&byte))
        && is_file_name(target)
}

/// Write `bytes` to a temporary file of its own beside `target`, flush it,
/// and run `place` on it. The temporary file is removed when any step
/// fails.
pub(crate) fn through_temporary(
    target: &Path,
    fill: impl FnOnce(&mut File) -> io::Result<()>,
    place: impl FnOnce(&Path) -> io::Result<()>,
) -> io::Result<()> {
    let (temporary, mut file) = create_beside(target)?;
    let written = (|| {
        fill(&mut file)?;
        file.sync_all()?;
        drop(file);
        place(&temporary)
    })();
    match written {
        Ok(()) => {
            sync_directory_of(target);
            Ok(())
        }
        Err(error) => {
            if let Err(cleanup) = fs::remove_file(&temporary) {
                if cleanup.kind() != ErrorKind::NotFound {
                    log::warn!("{} was not removed: {cleanup}", temporary.display());
                }
            }
            Err(error)
        }
    }
}

/// Replace the file at `target` whole with `bytes`, through the temporary
/// file beside it. Its directory must exist.
pub(crate) fn replace(target: &Path, bytes: &[u8]) -> io::Result<()> {
    through_temporary(
        target,
        |file| file.write_all(bytes),
        |temporary| fs::rename(temporary, target),
    )
}

/// Remove the temporary files a crash left in `folder`: each regular file
/// named as [`is_temporary_name`] says, in the folder itself,
/// `recordings/`, or `transcriptions/`. A link is never followed or
/// removed, a directory that is a link is not looked in, and nothing else
/// is touched. Answers how many were removed. A missing directory holds
/// none.
///
/// It removes a temporary file a write is still using, so the caller runs
/// it before anything writes the folder: the shell, once per folder, before
/// its first file operation there.
pub fn remove_leftovers(folder: &Path) -> io::Result<usize> {
    let mut removed = 0;
    for relative in NOTE_DIRECTORIES {
        let directory = folder.join(relative);
        if !relative.is_empty() {
            match fs::symlink_metadata(&directory) {
                Ok(metadata) if metadata.is_dir() => {}
                Ok(_) => continue,
                Err(error) if error.kind() == ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            }
        }
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        for entry in entries {
            let entry = entry?;
            let leftover = entry.file_name().to_str().is_some_and(is_temporary_name);
            // `DirEntry::file_type` does not follow a link.
            if !leftover || !entry.file_type()?.is_file() {
                continue;
            }
            match fs::remove_file(entry.path()) {
                Ok(()) => removed += 1,
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
    }
    Ok(removed)
}

/// Flush the directory holding `path`, so a name just made in it survives a
/// power loss ([`sync_directory`]).
pub(crate) fn sync_directory_of(path: &Path) {
    if let Some(directory) = path.parent() {
        sync_directory(directory);
    }
}

/// Flush `directory`, so the names just made or removed in it survive a
/// power loss. A directory that cannot be flushed is reported, not a
/// failure. Windows has no such call.
pub(crate) fn sync_directory(directory: &Path) {
    #[cfg(unix)]
    if let Err(error) = File::open(directory).and_then(|opened| opened.sync_all()) {
        log::warn!("{} was not flushed: {error}", directory.display());
    }
    #[cfg(not(unix))]
    let _ = directory;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names_in(directory: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn replace_writes_beside_the_target_and_leaves_nothing_there() {
        let folder = tempfile::tempdir().unwrap();
        let target = folder.path().join("a.md");
        replace(&target, b"first").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"first");
        replace(&target, b"second").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"second");
        assert_eq!(names_in(folder.path()), ["a.md"]);

        // A directory that is missing fails, and nothing is left.
        assert!(replace(&folder.path().join("missing/a.md"), b"x").is_err());
        assert_eq!(names_in(folder.path()), ["a.md"]);
    }

    /// Two writes to one target at once each write a file of their own:
    /// whichever renames last wins, and the target is always one of them
    /// whole, never a mix or a part.
    #[test]
    fn two_writes_to_one_target_at_once_each_land_whole() {
        let folder = tempfile::tempdir().unwrap();
        let target = folder.path().join("a.md");
        let (first, second) = (vec![b'a'; 256 * 1024], vec![b'b'; 256 * 1024]);
        for _ in 0..50 {
            let start = std::sync::Barrier::new(2);
            std::thread::scope(|scope| {
                for bytes in [&first, &second] {
                    let (start, target) = (&start, &target);
                    scope.spawn(move || {
                        start.wait();
                        replace(target, bytes).unwrap();
                    });
                }
            });
            let landed = fs::read(&target).unwrap();
            assert!(landed == first || landed == second, "a mix landed");
            assert_eq!(names_in(folder.path()), ["a.md"]);
        }
    }

    /// A link at a temporary name is never written through or removed.
    #[cfg(unix)]
    #[test]
    fn replace_never_writes_through_a_link_beside_the_target() {
        let folder = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let theirs = outside.path().join("theirs");
        fs::write(&theirs, b"theirs").unwrap();
        std::os::unix::fs::symlink(&theirs, folder.path().join(".a.md.k3x9q0w1.tmp")).unwrap();
        replace(&folder.path().join("a.md"), b"mine").unwrap();
        assert_eq!(fs::read(&theirs).unwrap(), b"theirs");
        assert_eq!(fs::read(folder.path().join("a.md")).unwrap(), b"mine");
        assert_eq!(names_in(folder.path()), [".a.md.k3x9q0w1.tmp", "a.md"]);
    }

    #[test]
    fn a_temporary_name_is_exactly_what_a_write_makes() {
        for name in [
            ".a.md.k3x9q0w1.tmp",
            ".settings.md.00000000.tmp",
            ".k3x9-a_2.webm.zzzzzzzz.tmp",
        ] {
            assert!(is_temporary_name(name), "{name}");
        }
        for name in [
            "a.md.k3x9q0w1.tmp",
            ".a.md.tmp",
            ".a.md.k3x9q0w.tmp",
            ".a.md.k3x9q0w1x.tmp",
            ".a.md.K3X9Q0W1.tmp",
            ".a.md.k3x9-0w1.tmp",
            ".a.md",
            ".tmp",
            "..tmp",
            ".k3x9q0w1.tmp",
            ".a.b.md.k3x9q0w1.tmp",
            ".a/b.md.k3x9q0w1.tmp",
            ".DS_Store",
            ".a.md.k3x9q0w1.tmp.md",
        ] {
            assert!(!is_temporary_name(name), "{name}");
        }
    }

    /// What the folder opening removes: a temporary file a crash left in
    /// the folder, `recordings/`, or `transcriptions/`, and nothing else:
    /// not another hidden file, a note, a take, a link, a directory, what a
    /// link points at, or one in any other directory.
    #[test]
    fn remove_leftovers_removes_only_temporary_files() {
        let folder = tempfile::tempdir().unwrap();
        let folder = folder.path();
        let outside = tempfile::tempdir().unwrap();
        let (recordings, transcriptions, other) = (
            folder.join("recordings"),
            folder.join("transcriptions"),
            folder.join("other"),
        );
        for directory in [&recordings, &transcriptions, &other] {
            fs::create_dir(directory).unwrap();
        }
        for leftover in [
            folder.join(".settings.md.k3x9q0w1.tmp"),
            recordings.join(".k3x9.md.00000000.tmp"),
            transcriptions.join(".q0w1.md.abcdefgh.tmp"),
        ] {
            fs::write(leftover, b"half").unwrap();
        }
        let kept = [
            folder.join("settings.md"),
            folder.join(".DS_Store"),
            recordings.join("a.webm"),
            recordings.join(".a.md.tmp"),
            recordings.join(".a.b.md.k3x9q0w1.tmp"),
            transcriptions.join("a.md"),
            other.join(".a.md.k3x9q0w1.tmp"),
        ];
        for file in &kept {
            fs::write(file, b"kept").unwrap();
        }
        fs::create_dir(recordings.join(".dir.md.k3x9q0w1.tmp")).unwrap();
        let target = outside.path().join("theirs");
        fs::write(&target, b"not the folder's").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, recordings.join(".link.md.k3x9q0w1.tmp")).unwrap();

        assert_eq!(remove_leftovers(folder).unwrap(), 3);
        for file in &kept {
            assert_eq!(fs::read(file).unwrap(), b"kept", "{}", file.display());
        }
        assert!(recordings.join(".dir.md.k3x9q0w1.tmp").is_dir());
        assert_eq!(fs::read(&target).unwrap(), b"not the folder's");
        #[cfg(unix)]
        assert!(fs::symlink_metadata(recordings.join(".link.md.k3x9q0w1.tmp")).is_ok());
        assert_eq!(remove_leftovers(folder).unwrap(), 0);

        // A missing folder holds none.
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(remove_leftovers(&empty.path().join("missing")).unwrap(), 0);
    }

    /// A directory of the folder that is a link is not looked in.
    #[cfg(unix)]
    #[test]
    fn remove_leftovers_does_not_look_through_a_linked_directory() {
        let folder = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let theirs = elsewhere.path().join(".a.md.k3x9q0w1.tmp");
        fs::write(&theirs, b"theirs").unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), folder.path().join("recordings")).unwrap();
        assert_eq!(remove_leftovers(folder.path()).unwrap(), 0);
        assert!(theirs.exists());
    }
}
