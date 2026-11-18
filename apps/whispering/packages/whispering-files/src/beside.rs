//! How a file is written in Whispering's folder (ADR-0962): at its own
//! path, or beside it and renamed over it, never anywhere else.
//!
//! [`replace`] writes a note or `settings.md` whole: the bytes go to a
//! hidden temporary file in the target's own directory (`.<name>.tmp`),
//! which is flushed and renamed over the target, so a reader finds the old
//! file or the new one, never part of one. The path rule refuses a hidden
//! name, so the temporary file is never listed or read. One a crash left
//! is removed when the folder opens ([`remove_leftovers`]).
//!
//! A rename stays in one directory, so it never crosses a disk. Only
//! "Change…" (`change.rs`) moves files between folders, and across disks it
//! copies each file beside its target first ([`copy_beside`]).

use std::fs::{self, File};
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};

use crate::path::is_file_name;

/// Whether a rename may replace a file at its target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Rename over the target: a write replaces a file whole.
    Replace,
    /// Never replace: an existing target answers `AlreadyExists`. A folder
    /// move renames this way.
    New,
}

/// The directories of the folder a temporary file is written in: the
/// folder itself (`settings.md`), `recordings/`, and `transcriptions/`.
const NOTE_DIRECTORIES: [&str; 3] = ["", "recordings", "transcriptions"];

const TEMPORARY_SUFFIX: &str = ".tmp";

/// The temporary file beside `target`: `.<name>.tmp` in its directory.
fn temporary_beside(target: &Path) -> io::Result<PathBuf> {
    let (Some(directory), Some(name)) = (target.parent(), target.file_name()) else {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "the target has no directory",
        ));
    };
    let mut temporary = std::ffi::OsString::from(".");
    temporary.push(name);
    temporary.push(TEMPORARY_SUFFIX);
    Ok(directory.join(temporary))
}

/// Whether `name` is a temporary file's name as [`temporary_beside`] makes
/// it: a dot, a file name the path rule accepts, then `.tmp`.
pub fn is_temporary_name(name: &str) -> bool {
    name.strip_prefix('.')
        .and_then(|rest| rest.strip_suffix(TEMPORARY_SUFFIX))
        .is_some_and(is_file_name)
}

/// Write `bytes` to the temporary file beside `target`, flush it, and run
/// `place` on it. A leftover at that name is removed first, never written
/// through, and the temporary file is removed when any step fails.
fn through_temporary(
    target: &Path,
    fill: impl FnOnce(&mut File) -> io::Result<()>,
    place: impl FnOnce(&Path) -> io::Result<()>,
) -> io::Result<()> {
    let temporary = temporary_beside(target)?;
    let written = (|| {
        match fs::remove_file(&temporary) {
            Err(error) if error.kind() != ErrorKind::NotFound => return Err(error),
            _ => {}
        }
        let mut file = File::options()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
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
pub fn replace(target: &Path, bytes: &[u8]) -> io::Result<()> {
    through_temporary(
        target,
        |file| file.write_all(bytes),
        |temporary| fs::rename(temporary, target),
    )
}

/// Copy `source` to the temporary file beside `target`, flush it, and
/// rename it into place in `mode`. `source` is left as it is.
pub fn copy_beside(source: &Path, target: &Path, mode: Mode) -> io::Result<()> {
    through_temporary(
        target,
        |file| io::copy(&mut File::open(source)?, file).map(|_| ()),
        |temporary| rename(temporary, target, mode),
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

/// Rename `from` to `to`, replacing a file there only in [`Mode::Replace`].
pub(crate) fn rename(from: &Path, to: &Path, mode: Mode) -> io::Result<()> {
    match mode {
        Mode::Replace => fs::rename(from, to),
        Mode::New => match rename_exclusive(from, to) {
            Err(error) if unsupported(&error) => rename_by_link(from, to),
            renamed => renamed,
        },
    }
}

/// Whether `error` is a rename's refusal to cross volumes.
pub(crate) fn crosses_devices(error: &io::Error) -> bool {
    #[cfg(unix)]
    if error.raw_os_error() == Some(libc_exdev()) {
        return true;
    }
    error.kind() == ErrorKind::CrossesDevices
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn libc_exdev() -> i32 {
    libc::EXDEV
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
fn libc_exdev() -> i32 {
    18
}

/// The exclusive rename where the disk has none: a hard link, then the old
/// name removed. A file at `to` is never replaced.
fn rename_by_link(from: &Path, to: &Path) -> io::Result<()> {
    match fs::hard_link(from, to) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            if !same_file(from, to)? {
                return Err(error);
            }
        }
        Err(error) if matches!(error.kind(), ErrorKind::NotFound) || crosses_devices(&error) => {
            return Err(error)
        }
        Err(_) => {
            if fs::symlink_metadata(to).is_ok() {
                return Err(io::Error::new(
                    ErrorKind::AlreadyExists,
                    "a file is already there",
                ));
            }
            return fs::rename(from, to);
        }
    }
    fs::remove_file(from)
}

/// Rename `from` to `to` unless an entry has that name: `renamex_np` with
/// `RENAME_EXCL` on macOS, `renameat2` with `RENAME_NOREPLACE` on Linux.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn rename_exclusive(from: &Path, to: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let terminated =
        |path: &Path| CString::new(path.as_os_str().as_bytes()).map_err(io::Error::from);
    let (from, to) = (terminated(from)?, terminated(to)?);
    // SAFETY: both are NUL-terminated paths that outlive the call.
    #[cfg(target_os = "macos")]
    let status = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    // SAFETY: as above; `AT_FDCWD` resolves the absolute paths as they are.
    #[cfg(target_os = "linux")]
    let status = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// `rename_exclusive` on Windows: `MoveFileExW` without
/// `MOVEFILE_REPLACE_EXISTING` or `MOVEFILE_COPY_ALLOWED`, which never
/// replaces an entry and never copies across volumes.
#[cfg(windows)]
fn rename_exclusive(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain([0])
            .collect::<Vec<u16>>()
    };
    let (from, to) = (wide(from), wide(to));
    // SAFETY: both are NUL-terminated paths that outlive the call.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn rename_exclusive(_: &Path, _: &Path) -> io::Result<()> {
    Err(ErrorKind::Unsupported.into())
}

/// Whether `rename_exclusive` failed because this disk or platform has no
/// exclusive rename, not because of the paths.
fn unsupported(error: &io::Error) -> bool {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let refused = [libc::EINVAL, libc::ENOSYS, libc::ENOTSUP, libc::EOPNOTSUPP]
        .map(Some)
        .contains(&error.raw_os_error());
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let refused = false;
    refused || error.kind() == ErrorKind::Unsupported
}

/// Whether `a` and `b` are one file, neither followed when it is a link.
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

/// Flush the directory holding `path`, so a name just made in it survives a
/// power loss. A directory that cannot be flushed is reported, not a
/// failure. Windows has no such call.
pub(crate) fn sync_directory_of(path: &Path) {
    #[cfg(unix)]
    if let Some(Ok(directory)) = path.parent().map(File::open) {
        if let Err(error) = directory.sync_all() {
            log::warn!("{} was not flushed: {error}", path.display());
        }
    }
    #[cfg(not(unix))]
    let _ = path;
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
        fs::write(folder.path().join(".a.md.tmp"), b"a crash left this").unwrap();
        replace(&target, b"second").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"second");
        assert_eq!(names_in(folder.path()), ["a.md"]);

        // A directory that is missing fails, and nothing is left.
        assert!(replace(&folder.path().join("missing/a.md"), b"x").is_err());
        assert_eq!(names_in(folder.path()), ["a.md"]);
    }

    /// A temporary name that is a link is removed, never written through.
    #[cfg(unix)]
    #[test]
    fn replace_never_writes_through_a_link_at_the_temporary_name() {
        let folder = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let theirs = outside.path().join("theirs");
        fs::write(&theirs, b"theirs").unwrap();
        std::os::unix::fs::symlink(&theirs, folder.path().join(".a.md.tmp")).unwrap();
        replace(&folder.path().join("a.md"), b"mine").unwrap();
        assert_eq!(fs::read(&theirs).unwrap(), b"theirs");
        assert_eq!(names_in(folder.path()), ["a.md"]);
    }

    #[test]
    fn new_never_replaces_and_keeps_the_source() {
        let temp = tempfile::tempdir().unwrap();
        let (a, b, target) = (
            temp.path().join("a"),
            temp.path().join("b"),
            temp.path().join("t"),
        );
        fs::write(&a, b"a").unwrap();
        fs::write(&b, b"b").unwrap();
        rename(&a, &target, Mode::New).unwrap();
        assert!(!a.exists(), "moved, not copied");
        assert_eq!(
            rename(&b, &target, Mode::New).unwrap_err().kind(),
            ErrorKind::AlreadyExists
        );
        assert_eq!(fs::read(&target).unwrap(), b"a");
        assert_eq!(fs::read(&b).unwrap(), b"b", "the source stays");
    }

    /// The copy "Change…" makes across disks, taken directly: it lands
    /// whole, leaves its source, and leaves nothing beside it.
    #[test]
    fn copy_beside_places_a_copy_and_leaves_nothing_beside_it() {
        let from = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let source = from.path().join("a.webm");
        fs::write(&source, b"take").unwrap();
        let target = folder.path().join("a.webm");
        copy_beside(&source, &target, Mode::New).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"take");
        assert_eq!(fs::read(&source).unwrap(), b"take");

        // A taken target refuses in New mode, and the folder is as it was.
        fs::write(&source, b"again").unwrap();
        assert_eq!(
            copy_beside(&source, &target, Mode::New).unwrap_err().kind(),
            ErrorKind::AlreadyExists
        );
        assert_eq!(fs::read(&target).unwrap(), b"take");
        assert_eq!(names_in(folder.path()), ["a.webm"]);

        // A source that is gone fails before anything reaches the folder.
        let missing = from.path().join("missing");
        assert!(copy_beside(&missing, &folder.path().join("b.webm"), Mode::New).is_err());
        assert_eq!(names_in(folder.path()), ["a.webm"]);
    }

    #[test]
    fn a_cross_device_error_is_recognized() {
        assert!(crosses_devices(&io::Error::from(ErrorKind::CrossesDevices)));
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        assert!(crosses_devices(&io::Error::from_raw_os_error(libc::EXDEV)));
        assert!(!crosses_devices(&io::Error::from(ErrorKind::NotFound)));
    }

    #[test]
    fn a_temporary_name_is_exactly_what_a_write_makes() {
        for name in [".a.md.tmp", ".settings.md.tmp", ".k3x9-a_2.webm.tmp"] {
            assert!(is_temporary_name(name), "{name}");
        }
        for name in [
            "a.md.tmp",
            ".a.md",
            ".tmp",
            "..tmp",
            ".a.b.md.tmp",
            ".a/b.md.tmp",
            ".DS_Store",
            ".a.md.tmp.md",
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
            folder.join(".settings.md.tmp"),
            recordings.join(".k3x9.md.tmp"),
            transcriptions.join(".q0w1.md.tmp"),
        ] {
            fs::write(leftover, b"half").unwrap();
        }
        let kept = [
            folder.join("settings.md"),
            folder.join(".DS_Store"),
            recordings.join("a.webm"),
            recordings.join(".a.b.md.tmp"),
            transcriptions.join("a.md"),
            other.join(".a.md.tmp"),
        ];
        for file in &kept {
            fs::write(file, b"kept").unwrap();
        }
        fs::create_dir(recordings.join(".dir.md.tmp")).unwrap();
        let target = outside.path().join("theirs");
        fs::write(&target, b"not the folder's").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, recordings.join(".link.md.tmp")).unwrap();

        assert_eq!(remove_leftovers(folder).unwrap(), 3);
        for file in &kept {
            assert_eq!(fs::read(file).unwrap(), b"kept", "{}", file.display());
        }
        assert!(recordings.join(".dir.md.tmp").is_dir());
        assert_eq!(fs::read(&target).unwrap(), b"not the folder's");
        #[cfg(unix)]
        assert!(fs::symlink_metadata(recordings.join(".link.md.tmp")).is_ok());
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
        let theirs = elsewhere.path().join(".a.md.tmp");
        fs::write(&theirs, b"theirs").unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), folder.path().join("recordings")).unwrap();
        assert_eq!(remove_leftovers(folder.path()).unwrap(), 0);
        assert!(theirs.exists());
    }
}
