//! The one place step: how a finished file reaches the folder.
//!
//! Every file on its way into the folder waits outside it, in `local/` in
//! the app's local data directory: a save in `local/.tmp/` (`stage`), a take
//! in `local/recording/`. [`place`] moves it in by one rename, so a listing,
//! a file syncer, or a home's checkpoint never sees a half-written file.
//!
//! When the folder is on another volume, where a rename cannot reach, the
//! place step copies the staged bytes to a temporary file beside the target
//! (`.ep-<random>.save`, a name the path rule never lists), syncs it,
//! renames that into place in the same mode, and only then removes the
//! staged file. A failure at any step loses nothing: the staged file stays,
//! and a temporary file left beside the target is removed where it can be.

use std::collections::hash_map::RandomState;
use std::fs::{self, File};
use std::hash::{BuildHasher, Hasher};
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::{FilesError, Result};
use crate::path::{make_parents, resolve};

/// Whether a placed file may replace one at its target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Rename over the target: a write replaces a file whole.
    Replace,
    /// Never replace: an existing target answers `AlreadyExists`. A take
    /// and a folder move place this way.
    New,
}

/// Place the finished file `staged` at the file `relative` in `folder`:
/// rule-checked, with its missing directories made, by [`place`]. Answers
/// the target's full path. A taken target in [`Mode::New`] is `Refused`.
/// The staged file stays wherever this fails.
pub fn place_into(staged: &Path, folder: &Path, relative: &str, mode: Mode) -> Result<PathBuf> {
    let target = resolve(folder, relative)?;
    make_parents(folder, relative)?;
    place(staged, &target, mode).map_err(|error| match error.kind() {
        ErrorKind::AlreadyExists => FilesError::refused(format!("a file is already at {relative}")),
        _ => FilesError::from_io(format!("{relative} could not be placed"), &error),
    })?;
    Ok(target)
}

/// Move `staged` to `target` by one rename in `mode`, then sync the
/// target's directory. Across volumes it copies beside the target first
/// ([`copy_across`]).
pub fn place(staged: &Path, target: &Path, mode: Mode) -> io::Result<()> {
    match rename(staged, target, mode) {
        Ok(()) => {
            sync_directory_of(target);
            Ok(())
        }
        Err(error) if crosses_devices(&error) => copy_across(staged, target, mode),
        Err(error) => Err(error),
    }
}

/// The cross-volume place: [`copy_beside`], then the staged file removed.
/// A staged file that cannot be removed once its copy is placed is
/// reported, not a failure: the file is in the folder.
pub fn copy_across(staged: &Path, target: &Path, mode: Mode) -> io::Result<()> {
    copy_beside(staged, target, mode)?;
    if let Err(error) = fs::remove_file(staged) {
        if error.kind() != ErrorKind::NotFound {
            log::warn!(
                "{} was placed at {} but could not be removed: {error}",
                staged.display(),
                target.display()
            );
        }
    }
    Ok(())
}

/// Copy `source` to a temporary file beside `target`, sync it, rename it
/// into place in `mode`, and sync the directory. `source` is left as it is.
/// A temporary file is removed when any step fails.
pub fn copy_beside(source: &Path, target: &Path, mode: Mode) -> io::Result<()> {
    let directory = target
        .parent()
        .ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "the target has no directory"))?;
    let temporary = directory.join(format!(".ep-{}.save", random(16)));
    let copied = (|| {
        let mut from = File::open(source)?;
        let mut to = File::options()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        io::copy(&mut from, &mut to)?;
        to.sync_all()?;
        drop(to);
        rename(&temporary, target, mode)
    })();
    match copied {
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

/// Write `bytes` to a new file `<local_tmp>/<random>`, sync it, and answer
/// its path: a save on its way into the folder. The directory is made if it
/// is missing.
pub fn stage(local_tmp: &Path, bytes: &[u8]) -> io::Result<PathBuf> {
    fs::create_dir_all(local_tmp)?;
    let path = local_tmp.join(random(16));
    let written = (|| {
        let mut file = File::options().write(true).create_new(true).open(&path)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    match written {
        Ok(()) => Ok(path),
        Err(error) => {
            let _ = fs::remove_file(&path);
            Err(error)
        }
    }
}

/// Remove everything in `local_tmp`, which holds only saves on their way,
/// each safe to delete. A missing directory is empty.
pub fn clear(local_tmp: &Path) -> io::Result<()> {
    let entries = match fs::read_dir(local_tmp) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let removed = if entry.file_type()?.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        match removed {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
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

/// `count` lowercase base 36 characters, distinct within one process and
/// unpredictable across processes.
pub(crate) fn random(count: usize) -> String {
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    static DRAWN: AtomicU64 = AtomicU64::new(0);
    let drawn = DRAWN.fetch_add(1, Ordering::SeqCst);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut out = String::with_capacity(count);
    let mut round = 0u64;
    while out.len() < count {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(drawn);
        hasher.write_u128(nanos);
        hasher.write_u32(std::process::id());
        hasher.write_u64(round);
        let mut value = hasher.finish();
        for _ in 0..8 {
            if out.len() == count {
                break;
            }
            out.push(char::from(ALPHABET[(value % 36) as usize]));
            value /= 36;
        }
        round += 1;
    }
    out
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
    fn new_never_replaces_and_keeps_the_staged_file() {
        let temp = tempfile::tempdir().unwrap();
        let (a, b, target) = (
            temp.path().join("a"),
            temp.path().join("b"),
            temp.path().join("t"),
        );
        fs::write(&a, b"a").unwrap();
        fs::write(&b, b"b").unwrap();
        place(&a, &target, Mode::New).unwrap();
        assert!(!a.exists(), "moved, not copied");
        assert_eq!(
            place(&b, &target, Mode::New).unwrap_err().kind(),
            ErrorKind::AlreadyExists
        );
        assert_eq!(fs::read(&target).unwrap(), b"a");
        assert_eq!(fs::read(&b).unwrap(), b"b", "the staged file stays");
    }

    #[test]
    fn replace_renames_over_the_target() {
        let temp = tempfile::tempdir().unwrap();
        let (a, target) = (temp.path().join("a"), temp.path().join("t"));
        fs::write(&target, b"old").unwrap();
        fs::write(&a, b"new").unwrap();
        place(&a, &target, Mode::Replace).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert!(!a.exists());
    }

    #[test]
    fn place_into_makes_directories_and_refuses_a_taken_target() {
        let folder = tempfile::tempdir().unwrap();
        let local = tempfile::tempdir().unwrap();
        let first = stage(local.path(), b"first").unwrap();
        let placed = place_into(&first, folder.path(), "recordings/a.webm", Mode::New).unwrap();
        assert_eq!(placed, folder.path().join("recordings/a.webm"));
        assert_eq!(fs::read(&placed).unwrap(), b"first");
        let second = stage(local.path(), b"second").unwrap();
        assert!(matches!(
            place_into(&second, folder.path(), "recordings/a.webm", Mode::New),
            Err(FilesError::Refused { .. })
        ));
        assert!(second.exists());
        assert!(matches!(
            place_into(&second, folder.path(), "../a.webm", Mode::Replace),
            Err(FilesError::Refused { .. })
        ));
        place_into(&second, folder.path(), "recordings/a.webm", Mode::Replace).unwrap();
        assert_eq!(fs::read(&placed).unwrap(), b"second");
        assert_eq!(names_in(&folder.path().join("recordings")), ["a.webm"]);
    }

    /// What `place` does when the rename cannot cross volumes, taken
    /// directly: the copy lands whole, nothing is left beside it, and the
    /// staged file goes only once it has.
    #[test]
    fn the_cross_volume_copy_places_then_removes_the_staged_file() {
        let local = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let staged = stage(local.path(), b"take").unwrap();
        let target = folder.path().join("a.webm");
        copy_across(&staged, &target, Mode::New).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"take");
        assert!(!staged.exists());
        assert_eq!(names_in(folder.path()), ["a.webm"]);

        // A taken target refuses in New mode, and the staged file and the
        // folder are as they were.
        let again = stage(local.path(), b"again").unwrap();
        assert_eq!(
            copy_across(&again, &target, Mode::New).unwrap_err().kind(),
            ErrorKind::AlreadyExists
        );
        assert_eq!(fs::read(&again).unwrap(), b"again");
        assert_eq!(fs::read(&target).unwrap(), b"take");
        assert_eq!(names_in(folder.path()), ["a.webm"], "no .ep-*.save left");

        copy_across(&again, &target, Mode::Replace).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"again");
        assert_eq!(names_in(folder.path()), ["a.webm"]);

        // A staged file that is gone fails before anything reaches the folder.
        let missing = local.path().join("missing");
        assert!(copy_across(&missing, &folder.path().join("b.webm"), Mode::New).is_err());
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
    fn stage_writes_a_new_file_and_clear_empties_the_directory() {
        let local = tempfile::tempdir().unwrap();
        let tmp = local.path().join(".tmp");
        let a = stage(&tmp, b"a").unwrap();
        let b = stage(&tmp, b"b").unwrap();
        assert_ne!(a, b);
        assert_eq!(fs::read(&a).unwrap(), b"a");
        fs::create_dir(tmp.join("left")).unwrap();
        clear(&tmp).unwrap();
        assert!(tmp.is_dir());
        assert!(names_in(&tmp).is_empty());
        clear(&local.path().join("missing")).unwrap();
    }
}
