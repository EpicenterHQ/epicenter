//! "Change…": the person picked another folder, and Whispering either moves
//! its recordings there or opens the folder they picked. It never merges two
//! folders.
//!
//! | `to` holds | Answer |
//! | --- | --- |
//! | `settings.md` or a `recordings` directory | `Opened`: nothing moves |
//! | nothing but hidden names, such as `.DS_Store` | `Moved`: every non-hidden top-level entry of `from` moves in |
//! | anything else | `Refused` |
//!
//! On one volume each entry moves by one rename that never replaces, and a
//! failure renames the moved ones back. Across volumes the whole tree is
//! copied in, each file beside its target and then renamed, each copy is
//! checked against its
//! original, size and bytes, and only then are the old files removed.

use std::fs::{self, File};
use std::io::{self, ErrorKind, Read};
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::beside::{sync_directory_of, through_temporary};
use crate::error::{FilesError, Result};
use crate::path::check_folder;

/// What a folder change did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Changed {
    /// The recordings moved from the old folder into the new one.
    Moved,
    /// The new folder is a Whispering folder already; it opens as it is,
    /// and the old folder stays where it was.
    Opened,
}

/// Whether `name` is hidden: it starts with a dot.
fn hidden(name: &std::ffi::OsStr) -> bool {
    name.to_string_lossy().starts_with('.')
}

/// Move Whispering's folder from `from` to `to`, or open `to` when it is a
/// Whispering folder already (the module's table).
pub fn change_folder(from: &Path, to: &Path) -> Result<Changed> {
    check_folder(from)?;
    check_folder(to)?;
    let to_real =
        fs::canonicalize(to).map_err(|error| FilesError::from_io(to.display(), &error))?;
    if !to_real.is_dir() {
        return Err(FilesError::refused(format!(
            "{} is not a folder",
            to.display()
        )));
    }
    let from_real = match fs::canonicalize(from) {
        Ok(real) => Some(real),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => return Err(FilesError::from_io(from.display(), &error)),
    };
    let from_compared = from_real.clone().unwrap_or_else(|| from.to_path_buf());
    if from_compared.starts_with(&to_real) || to_real.starts_with(&from_compared) {
        return Err(FilesError::refused(format!(
            "{} and {} are one folder or one holds the other",
            from.display(),
            to.display()
        )));
    }

    if is_whispering_folder(&to_real)? {
        return Ok(Changed::Opened);
    }
    let mut taken = Vec::new();
    for entry in read_dir(&to_real)? {
        let name = entry.file_name();
        if !hidden(&name) {
            taken.push(name.to_string_lossy().into_owned());
        }
    }
    if !taken.is_empty() {
        taken.sort();
        return Err(FilesError::refused(format!(
            "{} is neither empty nor a Whispering folder: it holds {}",
            to.display(),
            taken.join(", ")
        )));
    }

    let Some(from_real) = from_real else {
        return Ok(Changed::Moved);
    };
    let mut names: Vec<_> = read_dir(&from_real)?
        .into_iter()
        .map(|entry| entry.file_name())
        .filter(|name| !hidden(name))
        .collect();
    names.sort();
    move_entries(&from_real, &to_real, &names)?;
    Ok(Changed::Moved)
}

/// Whether `folder` holds `settings.md` or a `recordings` directory.
fn is_whispering_folder(folder: &Path) -> Result<bool> {
    let settings = folder.join("settings.md");
    let recordings = folder.join("recordings");
    let settings_there = match fs::symlink_metadata(&settings) {
        Ok(metadata) => !metadata.is_dir(),
        Err(error) if error.kind() == ErrorKind::NotFound => false,
        Err(error) => return Err(FilesError::from_io(settings.display(), &error)),
    };
    let recordings_there = match fs::symlink_metadata(&recordings) {
        Ok(metadata) => metadata.is_dir(),
        Err(error) if error.kind() == ErrorKind::NotFound => false,
        Err(error) => return Err(FilesError::from_io(recordings.display(), &error)),
    };
    Ok(settings_there || recordings_there)
}

fn read_dir(directory: &Path) -> Result<Vec<fs::DirEntry>> {
    fs::read_dir(directory)
        .and_then(|entries| entries.collect::<io::Result<Vec<_>>>())
        .map_err(|error| FilesError::from_io(directory.display(), &error))
}

/// Move each of `names` from `from` to `to`, one rename each; across
/// volumes, by [`copy_tree`]. A failed rename puts back what moved.
fn move_entries(from: &Path, to: &Path, names: &[std::ffi::OsString]) -> Result<()> {
    let mut moved: Vec<&std::ffi::OsString> = Vec::new();
    for name in names {
        match rename(&from.join(name), &to.join(name)) {
            Ok(()) => moved.push(name),
            Err(error) if crosses_devices(&error) && moved.is_empty() => {
                return copy_tree(from, to, names)
            }
            Err(error) => {
                for back in moved.iter().rev() {
                    if let Err(undo) = rename(&to.join(back), &from.join(back)) {
                        log::warn!(
                            "{} could not be moved back to {}: {undo}",
                            to.join(back).display(),
                            from.display()
                        );
                    }
                }
                return Err(FilesError::from_io(
                    format!("{} could not be moved", from.join(name).display()),
                    &error,
                ));
            }
        }
    }
    sync_directory_of(&to.join("x"));
    sync_directory_of(&from.join("x"));
    Ok(())
}

/// The regular files and directories under `names` in `from`, each as its
/// path relative to `from`, directories before what they hold. A link or
/// any other kind of entry is left where it is.
fn tree(from: &Path, names: &[std::ffi::OsString]) -> Result<(Vec<PathBuf>, Vec<PathBuf>)> {
    let (mut files, mut directories) = (Vec::new(), Vec::new());
    let mut pending: Vec<PathBuf> = names.iter().map(PathBuf::from).collect();
    while let Some(relative) = pending.pop() {
        let path = from.join(&relative);
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| FilesError::from_io(path.display(), &error))?;
        if metadata.is_dir() {
            for entry in read_dir(&path)? {
                pending.push(relative.join(entry.file_name()));
            }
            directories.push(relative);
        } else if metadata.is_file() {
            files.push(relative);
        } else {
            log::warn!("{} is not a file, so it stays", path.display());
        }
    }
    directories.sort();
    files.sort();
    Ok((files, directories))
}

/// Copy the tree under `names` from `from` into `to`, each file beside its
/// target first ([`copy_beside`]), check every copy against its original,
/// and only then remove the originals. A failure before that removes what was copied and leaves
/// `from` as it was.
fn copy_tree(from: &Path, to: &Path, names: &[std::ffi::OsString]) -> Result<()> {
    let (files, directories) = tree(from, names)?;
    let mut made: Vec<PathBuf> = Vec::new();
    let mut copied: Vec<PathBuf> = Vec::new();
    let copying = (|| -> Result<()> {
        for directory in &directories {
            let path = to.join(directory);
            fs::create_dir(&path).map_err(|error| FilesError::from_io(path.display(), &error))?;
            made.push(path);
        }
        for file in &files {
            let target = to.join(file);
            copy_beside(&from.join(file), &target)
                .map_err(|error| FilesError::from_io(target.display(), &error))?;
            copied.push(target);
        }
        for file in &files {
            if !same_contents(&from.join(file), &to.join(file))
                .map_err(|error| FilesError::from_io(to.join(file).display(), &error))?
            {
                return Err(FilesError::io(format!(
                    "the copy of {} does not match it",
                    from.join(file).display()
                )));
            }
        }
        Ok(())
    })();
    if let Err(error) = copying {
        for file in copied.iter().rev() {
            let _ = fs::remove_file(file);
        }
        for directory in made.iter().rev() {
            let _ = fs::remove_dir(directory);
        }
        return Err(error);
    }
    for file in &files {
        if let Err(error) = fs::remove_file(from.join(file)) {
            log::warn!(
                "{} was copied but not removed: {error}",
                from.join(file).display()
            );
        }
    }
    for directory in directories.iter().rev() {
        if let Err(error) = fs::remove_dir(from.join(directory)) {
            log::warn!(
                "{} was not removed: {error}",
                from.join(directory).display()
            );
        }
    }
    Ok(())
}

/// Whether the files `a` and `b` hold the same bytes.
fn same_contents(a: &Path, b: &Path) -> io::Result<bool> {
    if fs::metadata(a)?.len() != fs::metadata(b)?.len() {
        return Ok(false);
    }
    let (mut a, mut b) = (File::open(a)?, File::open(b)?);
    let (mut left, mut right) = (vec![0u8; 64 * 1024], vec![0u8; 64 * 1024]);
    loop {
        let read = a.read(&mut left)?;
        if read == 0 {
            return Ok(b.read(&mut right[..1])? == 0);
        }
        b.read_exact(&mut right[..read])?;
        if left[..read] != right[..read] {
            return Ok(false);
        }
    }
}

/// Copy `source` to a temporary file beside `target`, flush it, and rename
/// it into place, never over a file already there. `source` is left as it
/// is.
fn copy_beside(source: &Path, target: &Path) -> io::Result<()> {
    through_temporary(
        target,
        |file| io::copy(&mut File::open(source)?, file).map(|_| ()),
        |temporary| rename(temporary, target),
    )
}

/// Rename `from` to `to`, never over an entry already there: an existing
/// target answers `AlreadyExists`. A folder move renames this way.
fn rename(from: &Path, to: &Path) -> io::Result<()> {
    match rename_exclusive(from, to) {
        Err(error) if unsupported(&error) => rename_by_link(from, to),
        renamed => renamed,
    }
}

/// Whether `error` is a rename's refusal to cross volumes.
fn crosses_devices(error: &io::Error) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;

    struct Folders {
        _temp: tempfile::TempDir,
        from: PathBuf,
        to: PathBuf,
    }

    fn folders() -> Folders {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let (from, to) = (root.join("data"), root.join("picked"));
        fs::create_dir_all(from.join("recordings")).unwrap();
        fs::write(from.join("recordings/a.md"), b"note").unwrap();
        fs::write(from.join("recordings/a.webm"), b"audio").unwrap();
        fs::write(from.join("settings.md"), b"settings").unwrap();
        fs::write(from.join(".DS_Store"), b"").unwrap();
        fs::create_dir(&to).unwrap();
        Folders {
            _temp: temp,
            from,
            to,
        }
    }

    /// Every name in `directory`, hidden ones too, sorted.
    fn names_in(directory: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn tree_of(folder: &Path) -> Vec<(String, Vec<u8>)> {
        let (files, _) = tree(
            folder,
            &read_dir(folder)
                .unwrap()
                .into_iter()
                .map(|entry| entry.file_name())
                .collect::<Vec<_>>(),
        )
        .unwrap();
        files
            .into_iter()
            .map(|file| {
                (
                    file.to_string_lossy().into_owned(),
                    fs::read(folder.join(&file)).unwrap(),
                )
            })
            .collect()
    }

    #[test]
    fn an_empty_folder_receives_the_recordings() {
        let Folders { from, to, .. } = &folders();
        fs::write(to.join(".DS_Store"), b"").unwrap();
        assert_eq!(change_folder(from, to).unwrap(), Changed::Moved);
        assert_eq!(
            tree_of(to),
            [
                (".DS_Store".to_string(), b"".to_vec()),
                ("recordings/a.md".to_string(), b"note".to_vec()),
                ("recordings/a.webm".to_string(), b"audio".to_vec()),
                ("settings.md".to_string(), b"settings".to_vec()),
            ]
        );
        assert_eq!(
            tree_of(from),
            [(".DS_Store".to_string(), b"".to_vec())],
            "hidden names stay"
        );
        assert_eq!(serde_json::to_value(Changed::Moved).unwrap(), "moved");
    }

    #[test]
    fn a_whispering_folder_opens_and_nothing_moves() {
        for marker in ["settings.md", "recordings"] {
            let Folders { from, to, .. } = &folders();
            if marker == "recordings" {
                fs::create_dir(to.join("recordings")).unwrap();
            } else {
                fs::write(to.join("settings.md"), b"theirs").unwrap();
            }
            fs::write(to.join("other.txt"), b"x").unwrap();
            let before = tree_of(from);
            assert_eq!(
                change_folder(from, to).unwrap(),
                Changed::Opened,
                "{marker}"
            );
            assert_eq!(tree_of(from), before);
            assert_eq!(serde_json::to_value(Changed::Opened).unwrap(), "opened");
        }
    }

    #[test]
    fn any_other_folder_is_refused() {
        let Folders { from, to, .. } = &folders();
        fs::write(to.join("notes.txt"), b"mine").unwrap();
        let before = tree_of(from);
        assert!(matches!(
            change_folder(from, to),
            Err(FilesError::Refused { .. })
        ));
        assert_eq!(tree_of(from), before);
        assert_eq!(tree_of(to), [("notes.txt".to_string(), b"mine".to_vec())]);
    }

    #[test]
    fn a_folder_inside_the_other_or_the_same_is_refused() {
        let Folders { from, to, .. } = &folders();
        let inside = from.join("inner");
        fs::create_dir(&inside).unwrap();
        for (a, b) in [
            (from, from),
            (from, &inside),
            (to, &to.parent().unwrap().to_path_buf()),
        ] {
            assert!(
                matches!(change_folder(a, b), Err(FilesError::Refused { .. })),
                "{} -> {}",
                a.display(),
                b.display()
            );
        }
        assert!(matches!(
            change_folder(from, &to.join("missing")),
            Err(FilesError::NotFound { .. })
        ));
        assert!(matches!(
            change_folder(Path::new("relative"), to),
            Err(FilesError::Refused { .. })
        ));
    }

    /// The cross-volume path, taken directly: the copy is whole and checked
    /// before the originals go.
    #[test]
    fn the_cross_volume_copy_moves_the_tree_and_removes_the_originals() {
        let Folders { from, to, .. } = &folders();
        fs::create_dir_all(from.join("transcriptions/empty")).unwrap();
        let expected: Vec<_> = tree_of(from)
            .into_iter()
            .filter(|(name, _)| !name.starts_with('.'))
            .collect();
        let names: Vec<_> = ["recordings", "settings.md", "transcriptions"]
            .map(std::ffi::OsString::from)
            .to_vec();
        copy_tree(from, to, &names).unwrap();
        assert_eq!(tree_of(to), expected);
        assert!(to.join("transcriptions/empty").is_dir());
        assert_eq!(tree_of(from), [(".DS_Store".to_string(), b"".to_vec())]);
        assert!(!from.join("recordings").exists());
    }

    #[test]
    fn a_failed_copy_leaves_the_old_folder_and_removes_what_it_copied() {
        let Folders { from, to, .. } = &folders();
        // A file already at a target makes the copy fail midway.
        fs::create_dir(to.join("recordings")).unwrap();
        let before = tree_of(from);
        let names: Vec<_> = ["settings.md", "recordings"]
            .map(std::ffi::OsString::from)
            .to_vec();
        assert!(copy_tree(from, to, &names).is_err());
        assert_eq!(tree_of(from), before);
        assert!(to.join("recordings").is_dir(), "what was there stays");
        assert!(!to.join("settings.md").exists());
    }

    #[test]
    fn rename_never_replaces_and_keeps_the_source() {
        let temp = tempfile::tempdir().unwrap();
        let (a, b, target) = (
            temp.path().join("a"),
            temp.path().join("b"),
            temp.path().join("t"),
        );
        fs::write(&a, b"a").unwrap();
        fs::write(&b, b"b").unwrap();
        rename(&a, &target).unwrap();
        assert!(!a.exists(), "moved, not copied");
        assert_eq!(
            rename(&b, &target).unwrap_err().kind(),
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
        copy_beside(&source, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"take");
        assert_eq!(fs::read(&source).unwrap(), b"take");

        // A taken target refuses, and the folder is as it was.
        fs::write(&source, b"again").unwrap();
        assert_eq!(
            copy_beside(&source, &target).unwrap_err().kind(),
            ErrorKind::AlreadyExists
        );
        assert_eq!(fs::read(&target).unwrap(), b"take");
        assert_eq!(names_in(folder.path()), ["a.webm"]);

        // A source that is gone fails before anything reaches the folder.
        let missing = from.path().join("missing");
        assert!(copy_beside(&missing, &folder.path().join("b.webm")).is_err());
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
    fn same_contents_compares_sizes_and_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let (a, b, c) = (
            temp.path().join("a"),
            temp.path().join("b"),
            temp.path().join("c"),
        );
        fs::write(&a, vec![7u8; 200_000]).unwrap();
        fs::write(&b, vec![7u8; 200_000]).unwrap();
        let mut different = vec![7u8; 200_000];
        different[150_000] = 8;
        fs::write(&c, different).unwrap();
        assert!(same_contents(&a, &b).unwrap());
        assert!(!same_contents(&a, &c).unwrap());
        fs::write(&c, b"short").unwrap();
        assert!(!same_contents(&a, &c).unwrap());
    }
}
