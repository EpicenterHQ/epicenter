//! A desktop page's folder storage: one function per method of the page's
//! device store (`DeviceStore` in `packages/folder/src/device/store.ts`),
//! each one IPC command (ADR-0581). This is the strict folder host: the Bun
//! store (`device/node-store.ts`) is a plain store over `node:fs`, and only
//! this one answers the edge cases below (`storage_outcomes.json`).
//!
//! A page names folder-relative paths. New paths pass `paths::path_problem`;
//! a save may replace or remove an existing structurally safe name that only
//! some disks hold, but never make one. Every path is literal:
//!
//! - a symbolic link is never followed, and a path through one is refused;
//! - on a disk that ignores case or Unicode normalization, `plan.md` can
//!   reach `Plan.md`. A name stored under another spelling is another entry:
//!   a read finds nothing there, and a change refuses to land on it;
//! - `.git` at the root is Git's, never listed and never named;
//! - a reserved name (`state::is_reserved`), a save or a recording in
//!   progress, is never listed and never put. `.epicenter` at the root, which
//!   an older build left (`sweep`), is not listed either; its files can be
//!   read and removed, so the page can import them.
//!
//! A folder holds only its content (ADR-0822). `put` is the one change of a
//! file. Its bytes are staged in a new file beside the path, under a
//! reserved name (`state::staged_name`), and renamed over the path, so a
//! reader and a crash see the old file or the new one, and a new file never
//! appears empty. Saving needs no Git: it makes nothing beside the root,
//! nothing in it but the files saved and their directories, and never
//! touches `.git`, whatever is there.
//!
//! The version check (what the path holds, against what the page read)
//! runs right before the rename or the removal. Within this process, puts
//! of one path take turns from the check to the rename or removal (`Turn`),
//! so two saves over one version never both land. Across processes no lock
//! spans the two: another program that saves in that instant can be
//! overwritten. A save that expects nothing at its path is placed
//! (`place`), which never replaces what appeared there after the check,
//! whoever made it, and is `Stale` instead. The recorder places its
//! recordings the same way. External editors never took a lock anyway, and
//! Git history keeps every version sync committed (ADR-0568, ADR-0702). On
//! Unix each staged file is `0600` before its first byte, so the permission
//! bits keep staged bytes from other accounts. An access control entry the
//! folder passes on is kept: it is a grant the person made on their folder,
//! and a file another program makes there inherits it too. Replacing an
//! existing regular file keeps its permission bits (`keep_mode`); a new file
//! is `0600`. A staged file a stopped save left behind is removed once it is
//! an hour old (`sweep`).
//!
//! A link another program swaps in between the check and the change is not
//! defended against; a page cannot make one.

use std::collections::BTreeSet;
use std::fs;
use std::io::{self, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, PoisonError};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use specta::Type;

use crate::paths::{path_problem, readable_path_problem};
use crate::state;

/// The folder's private Git directory, which no listing shows.
const PRIVATE_DIRECTORY: &str = ".git";

/// Why a storage call answered no. The page's store (`device/tauri-store.ts`)
/// reads `NotFound` as no file there and any other as `Unavailable`; the
/// names say why to a person reading it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "name")]
pub enum StorageError {
    /// The path is not one a folder admits, passes through a link, or names
    /// an entry stored under another spelling.
    InvalidPath { path: String, reason: String },
    /// No file, or no directory, is at the path.
    NotFound { path: String },
    /// A directory is at the path, where a file was asked for.
    NotAFile { path: String },
    /// A file is at the path (or at an ancestor of it), where a directory
    /// was asked for.
    NotADirectory { path: String },
    /// The operation failed, and changed nothing.
    Io {
        path: String,
        operation: String,
        message: String,
    },
}

/// What a `put` did: changed the file, or found the path holding something
/// other than what the page expected and changed nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum PutOutcome {
    Landed,
    Stale,
}

/// What a put answers the page: the stamp of the file that
/// landed (empty for a removal), which names an attachment's version, or
/// `stale` when the path held something else and nothing changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Landing {
    Landed(String),
    Stale,
}

/// Whether a listing names the file at `path` by the Git blob id of its
/// bytes (a note, `.md` in any case, a hidden file, or the folder's contract,
/// `epicenter.json` at its root, which is stored as it is) rather than by its
/// stamp (an attachment, whose version the page derives from its hash,
/// cached by that stamp): the opposite of `storedWithLfs` in
/// `@epicenter/definition`, held to it by `fixtures/path-rules.json`.
pub fn versioned_by_content(path: &str) -> bool {
    (path.len() >= 3 && path[path.len() - 3..].eq_ignore_ascii_case(".md"))
        || crate::paths::is_hidden_path(path)
        || path == CONTRACT_PATH
}

/// The folder's contract, at its root: stored as it is, never as a pointer.
pub const CONTRACT_PATH: &str = "epicenter.json";

/// The bytes and stamp of one opened file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRead {
    pub bytes: Vec<u8>,
    pub stamp: String,
}

/// Decimal fields retain nanoseconds and file identifiers across JSON IPC.
fn stamp_of(metadata: &fs::Metadata) -> io::Result<String> {
    let modified = metadata.modified()?;
    let nanos = match modified.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_nanos() as i128,
        Err(error) => -(error.duration().as_nanos() as i128),
    };
    let mut stamp = format!("v1:{}:{nanos}", metadata.len());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.ino() != 0 {
            stamp.push_str(&format!(":{}:{}", metadata.dev(), metadata.ino()));
        }
    }
    Ok(stamp)
}

/// What a `put` expects at its path when it lands, the version its writer
/// read: `DeviceExpectation` in `packages/folder/src/device/store.ts`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expectation {
    /// Nothing at all is there: a create.
    Absent,
    /// A regular file whose bytes have this Git blob id (ADR-0808): a note's
    /// version, or a hidden file's.
    Blob(String),
    /// A regular file whose stamp (`stamp_of`) is this: an attachment's
    /// version, which names it without reading its bytes.
    Stamp(String),
    /// Whatever regular file is there, or nothing: a replacement by the
    /// path's only writer, such as the shell writing this computer's
    /// settings.
    Any,
}

impl Expectation {
    /// The page's `expected` header: `absent`, `blob:` and a lowercase
    /// hexadecimal Git blob id, or `stamp:` and a stamp. Each case has its own
    /// spelling, so a hash is never read as a keyword, nor a keyword as a
    /// hash.
    pub fn parse(value: &str) -> Result<Self, String> {
        if let Some(stamp) = value.strip_prefix("stamp:") {
            if stamp.starts_with("v1:") {
                return Ok(Self::Stamp(stamp.to_string()));
            }
        }
        match value {
            "absent" => Ok(Self::Absent),
            "any" => Ok(Self::Any),
            _ => match value.strip_prefix("blob:") {
                Some(hash)
                    if hash.len() == 40
                        && hash
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) =>
                {
                    Ok(Self::Blob(hash.to_string()))
                }
                _ => Err(format!(
                    "expected is {value:?}, not absent, any, blob: and a Git blob id, or stamp: and a stamp"
                )),
            },
        }
    }
}

/// One regular file in a listing: its version as the page names it (a
/// note's or hidden file's Git blob id, an attachment's stamp:
/// `versioned_by_content`), and its
/// size in bytes.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct ListedFile {
    pub path: String,
    pub version: String,
    pub size: f64,
}

fn io_error(path: &str, operation: &str, message: impl std::fmt::Display) -> StorageError {
    StorageError::Io {
        path: path.to_string(),
        operation: operation.to_string(),
        message: message.to_string(),
    }
}

fn link_refusal(path: &str) -> StorageError {
    StorageError::InvalidPath {
        path: path.to_string(),
        reason: "the path passes through a symbolic link".to_string(),
    }
}

fn occupied(path: &str) -> StorageError {
    StorageError::InvalidPath {
        path: path.to_string(),
        reason: "another entry occupies this name".to_string(),
    }
}

/// Refuse a path the folder engine would refuse (`pathProblem`).
fn admit(path: &str) -> Result<(), StorageError> {
    match path_problem(path) {
        None => Ok(()),
        Some(reason) => Err(StorageError::InvalidPath {
            path: path.to_string(),
            reason: reason.to_string(),
        }),
    }
}

fn full(root: &Path, path: &str) -> PathBuf {
    path.split('/')
        .fold(root.to_path_buf(), |full, name| full.join(name))
}

/// Whether nothing is at `target` now, so a failure there reads as absent.
fn absent(target: &Path) -> bool {
    matches!(fs::symlink_metadata(target), Err(cause) if cause.kind() == ErrorKind::NotFound)
}

/// What a literal folder path names on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Found {
    File {
        size: u64,
    },
    /// Neither a file, a directory, nor a link: a socket or a device.
    Other,
    Directory,
    Absent,
    /// One of its names is stored under another spelling.
    Occupied,
    /// It passes through, or is, a symbolic link.
    Link,
    /// `ancestor` is not a directory, so nothing can be below it.
    UnderFile {
        ancestor: String,
    },
}

/// Walk `path` from `root` one name at a time without following a link.
/// Every name the walk passed as a file or directory must be stored with
/// exactly the spelling asked for, or the path is `Occupied`.
fn find(root: &Path, path: &str) -> io::Result<Found> {
    if path.is_empty() {
        return Ok(Found::Directory);
    }
    let names: Vec<&str> = path.split('/').collect();
    let mut at = root.to_path_buf();
    // How many leading names are files or directories whose spelling counts.
    let mut spelled = 0;
    let mut found = Found::Absent;
    for (index, name) in names.iter().enumerate() {
        at.push(name);
        let metadata = match fs::symlink_metadata(&at) {
            Ok(metadata) => metadata,
            Err(cause) if cause.kind() == ErrorKind::NotFound => break,
            Err(cause) => return Err(cause),
        };
        let kind = metadata.file_type();
        let last = index + 1 == names.len();
        let ancestor = || names[..=index].join("/");
        if kind.is_symlink() {
            found = Found::Link;
            break;
        }
        if !kind.is_file() && !kind.is_dir() {
            found = if last {
                Found::Other
            } else {
                Found::UnderFile {
                    ancestor: ancestor(),
                }
            };
            break;
        }
        spelled = index + 1;
        if last {
            found = if kind.is_dir() {
                Found::Directory
            } else {
                Found::File {
                    size: metadata.len(),
                }
            };
            break;
        }
        if !kind.is_dir() {
            found = Found::UnderFile {
                ancestor: ancestor(),
            };
            break;
        }
    }
    if !spelled_as_stored(root, &names[..spelled])? {
        return Ok(Found::Occupied);
    }
    Ok(found)
}

/// Whether each of `names`, which exist below `root` as files or
/// directories with no link among them, is stored with exactly that
/// spelling.
fn spelled_as_stored(root: &Path, names: &[&str]) -> io::Result<bool> {
    if names.is_empty() {
        return Ok(true);
    }
    #[cfg(any(target_os = "macos", target_os = "ios", windows))]
    return spelled_by_resolving(root, names);
    #[cfg(not(any(target_os = "macos", target_os = "ios", windows)))]
    return spelled_by_listing(root, names);
}

/// Resolving the path answers each name's stored spelling where the system
/// does: macOS's `realpath` and Windows' final path name both do. No name
/// is a link, so resolving follows none.
#[cfg_attr(
    not(any(target_os = "macos", target_os = "ios", windows)),
    allow(dead_code)
)]
fn spelled_by_resolving(root: &Path, names: &[&str]) -> io::Result<bool> {
    let resolved = fs::canonicalize(full(root, &names.join("/")))?;
    let stored: Vec<_> = resolved.components().rev().take(names.len()).collect();
    Ok(stored.len() == names.len()
        && stored
            .iter()
            .rev()
            .zip(names)
            .all(|(stored, name)| stored.as_os_str() == std::ffi::OsStr::new(name)))
}

/// Listing each parent finds whether a name is stored as asked, on any
/// system; Linux's `realpath` answers the spelling it was given.
#[cfg_attr(any(target_os = "macos", target_os = "ios", windows), allow(dead_code))]
fn spelled_by_listing(root: &Path, names: &[&str]) -> io::Result<bool> {
    let mut parent = root.to_path_buf();
    for name in names {
        let mut stored = false;
        for entry in fs::read_dir(&parent)? {
            if entry?.file_name() == std::ffi::OsStr::new(name) {
                stored = true;
                break;
            }
        }
        if !stored {
            return Ok(false);
        }
        parent.push(name);
    }
    Ok(true)
}

/// Every regular file at or below each of `under` (a directory or a file
/// path; empty is the whole root), `.git` and an older build's `.epicenter`
/// at the root aside, and never a reserved name (`state::is_reserved`, a
/// save or a recording in progress) at any depth, without following a link,
/// each with its version (`versioned_by_content`: a note or a hidden file is
/// read and hashed as a Git blob, an attachment named by its stamp) and
/// size. Other hidden files are listed; whoever reads the listing skips them
/// (`isHiddenPath`). A name that is not text
/// is left out, and so is a path asked for that is not readable or passes
/// through a link. A file or directory removed during the walk is not
/// listed: opening it, or reading its entries (macOS's `readdir` answers
/// `ENOENT` for one removed mid-read), says it is not found. Only the root
/// missing fails the listing that way.
pub fn list(root: &Path, under: &[String]) -> Result<Vec<ListedFile>, StorageError> {
    fn describe(at: &Path, path: String) -> io::Result<Option<ListedFile>> {
        let metadata = match fs::symlink_metadata(at) {
            Ok(metadata) => metadata,
            Err(cause) if cause.kind() == ErrorKind::NotFound => return Ok(None),
            Err(cause) => return Err(cause),
        };
        if !metadata.is_file() {
            return Ok(None);
        }
        let version = if versioned_by_content(&path) {
            match crate::blob::file_blob_id(at) {
                Ok(hash) => hash,
                Err(cause) if cause.kind() == ErrorKind::NotFound => return Ok(None),
                Err(cause) => return Err(cause),
            }
        } else {
            stamp_of(&metadata)?
        };
        Ok(Some(ListedFile {
            path,
            version,
            size: metadata.len() as f64,
        }))
    }
    fn visit(directory: &Path, prefix: &str, listing: &mut Vec<ListedFile>) -> io::Result<()> {
        for entry in fs::read_dir(directory)? {
            #[cfg(test)]
            let entry = tests::removed_mid_read(directory).map_or(entry, Err);
            let entry = entry?;
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            // Git's state, what an older build kept at the root
            // (`.epicenter`), and a write in progress are never a folder's
            // files.
            if prefix.is_empty() && (name == PRIVATE_DIRECTORY || name == state::DIRECTORY) {
                continue;
            }
            if state::is_reserved_name(&name) {
                continue;
            }
            let path = format!("{prefix}{name}");
            let at = entry.path();
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                match visit(&at, &format!("{path}/"), listing) {
                    Err(cause) if cause.kind() == ErrorKind::NotFound => {}
                    result => result?,
                }
                continue;
            }
            if let Some(file) = describe(&at, path)? {
                listing.push(file);
            }
        }
        Ok(())
    }
    fn within(path: &str, other: &str) -> bool {
        other.is_empty() || path == other || path.starts_with(&format!("{other}/"))
    }
    let walk = |listing: &mut Vec<ListedFile>| -> io::Result<()> {
        for prefix in under {
            // A path below another one asked for is walked once, with it.
            if under
                .iter()
                .any(|other| other != prefix && within(prefix, other))
            {
                continue;
            }
            if prefix.is_empty() {
                visit(root, "", listing)?;
                continue;
            }
            if readable_path_problem(prefix).is_some() || state::is_reserved(prefix) {
                continue;
            }
            match find(root, prefix)? {
                Found::Directory => {
                    match visit(&full(root, prefix), &format!("{prefix}/"), listing) {
                        Err(cause) if cause.kind() == ErrorKind::NotFound => {}
                        result => result?,
                    }
                }
                Found::File { .. } => {
                    if let Some(file) = describe(&full(root, prefix), prefix.clone())? {
                        listing.push(file);
                    }
                }
                _ => {}
            }
        }
        Ok(())
    };
    let mut listing = Vec::new();
    walk(&mut listing).map_err(|cause| io_error("", "list", cause))?;
    Ok(listing)
}

/// The bytes of the regular file at `path`.
pub fn read(root: &Path, path: &str) -> Result<FileRead, StorageError> {
    if let Some(reason) = readable_path_problem(path) {
        return Err(StorageError::InvalidPath {
            path: path.to_string(),
            reason: reason.to_string(),
        });
    }
    let target = full(root, path);
    let read = || -> io::Result<Result<FileRead, StorageError>> {
        Ok(match find(root, path)? {
            Found::Link => Err(link_refusal(path)),
            Found::Directory => Err(StorageError::NotAFile {
                path: path.to_string(),
            }),
            Found::Other => Err(StorageError::InvalidPath {
                path: path.to_string(),
                reason: "it is not a regular file and is not followed".to_string(),
            }),
            Found::File { .. } => {
                let mut file = fs::File::open(&target)?;
                let metadata = file.metadata()?;
                if !metadata.is_file() {
                    return Ok(Err(StorageError::NotAFile {
                        path: path.to_string(),
                    }));
                }
                let stamp = stamp_of(&metadata)?;
                let mut bytes = Vec::new();
                file.read_to_end(&mut bytes)?;
                Ok(FileRead { bytes, stamp })
            }
            _ => Err(StorageError::NotFound {
                path: path.to_string(),
            }),
        })
    };
    read().unwrap_or_else(|cause| {
        Err(if absent(&target) {
            StorageError::NotFound {
                path: path.to_string(),
            }
        } else {
            io_error(path, "read", cause)
        })
    })
}

/// Whether `target` holds what a put expects.
fn holds(target: &Path, expected: &Expectation) -> io::Result<bool> {
    let found = match fs::symlink_metadata(target) {
        Ok(metadata) => Some(metadata),
        Err(cause) if cause.kind() == ErrorKind::NotFound => None,
        Err(cause) => return Err(cause),
    };
    match (expected, found) {
        (Expectation::Any, None) => Ok(true),
        (Expectation::Any, Some(metadata)) => Ok(metadata.is_file()),
        (Expectation::Absent, found) => Ok(found.is_none()),
        (Expectation::Blob(hash), Some(metadata)) if metadata.is_file() => {
            Ok(crate::blob::file_blob_id(target)? == *hash)
        }
        (Expectation::Stamp(stamp), Some(metadata)) if metadata.is_file() => {
            Ok(stamp_of(&metadata)? == *stamp)
        }
        _ => Ok(false),
    }
}

/// A new, empty file beside a target in `directory`, for bytes that are
/// renamed to their path once whole: `put` stages each save in one. Its name
/// is reserved (`state::staged_name`), so no listing or watcher describes
/// it, and one a stopped writer leaves behind is removed once stale
/// (`sweep`). It is made with `create_new`, so nothing already at the name is
/// written through, and `0600`, so the permission bits keep it from other
/// accounts before its first byte. It is on its target's file system, so the
/// rename is one step. Whoever made it renames or removes it.
fn create_staged(directory: &Path) -> Result<(PathBuf, fs::File), String> {
    let staged = directory.join(state::staged_name());
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let file = options
        .open(&staged)
        .map_err(|cause| format!("'{}' could not be staged: {cause}", staged.display()))?;
    Ok((staged, file))
}

/// Move the staged file at `staged` to `target` only where nothing is,
/// never replacing anything there, whatever appeared since a caller looked:
/// a rename the system refuses when any entry has the name
/// (`rename_exclusive`), so the whole file appears at once, at one name.
///
/// `AlreadyExists` when something is at `target`; the staged file stays.
/// Another file system (`CrossesDevices`), and a staged file or a target
/// directory that is not there (`NotFound`), fail as they are. A crash
/// leaves the file at one of its two names: still staged, for its caller to
/// place again or the sweep to remove, or placed.
///
/// Where the disk refuses that rename (`unsupported`: exFAT on macOS, which
/// FAT and APFS are not; a file system without the flag on Linux) or the
/// platform has none, the file is placed by a hard link instead
/// (`place_by_link`).
///
/// `put` places a save that expects nothing at its path, and the recorder
/// places each recording, so neither replaces a file that appeared after
/// its check.
pub fn place(staged: &Path, target: &Path) -> io::Result<()> {
    match rename_exclusive(staged, target) {
        Err(cause) if unsupported(&cause) => place_by_link(staged, target),
        moved => moved,
    }
}

/// `place` where there is no exclusive rename: a hard link to `target`,
/// which the system also refuses when any entry has the name, then the
/// staged name removed. The file once had two names, so on macOS a watcher
/// is never told when it is deleted until it is saved again (FSEvents does
/// not report removing a file that had a second name), which is why this is
/// only the fallback. A link an earlier move made before it was cut off,
/// before it removed the staged name, is this file at both names and
/// counts as placed. Where the disk has no hard links either (exFAT on
/// macOS has neither), the file is renamed only while nothing is at
/// `target`: there a writer racing that one check can be replaced.
fn place_by_link(staged: &Path, target: &Path) -> io::Result<()> {
    match fs::hard_link(staged, target) {
        Ok(()) => {}
        Err(cause) if cause.kind() == ErrorKind::AlreadyExists => {
            if !same_file(staged, target)? {
                return Err(cause);
            }
        }
        Err(cause)
            if matches!(
                cause.kind(),
                ErrorKind::NotFound | ErrorKind::CrossesDevices
            ) =>
        {
            return Err(cause);
        }
        Err(_) => {
            if !absent(target) {
                return Err(io::Error::new(
                    ErrorKind::AlreadyExists,
                    "a file is already there",
                ));
            }
            return fs::rename(staged, target);
        }
    }
    fs::remove_file(staged)
}

/// Rename `from` to `to` unless an entry has that name, in one call the
/// system makes atomic: `renamex_np` with `RENAME_EXCL` on macOS,
/// `renameat2` with `RENAME_NOREPLACE` on Linux. The disk may refuse the
/// flag (`unsupported`).
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
/// `MOVEFILE_REPLACE_EXISTING`, which never replaces an entry and never
/// copies across volumes.
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

/// `rename_exclusive` on a platform without one.
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn rename_exclusive(_: &Path, _: &Path) -> io::Result<()> {
    Err(ErrorKind::Unsupported.into())
}

/// Whether `rename_exclusive` failed because this disk or platform has no
/// exclusive rename, not because of the paths: Linux answers `EINVAL` for a
/// file system without the flag and `ENOSYS` for a kernel without the call,
/// macOS `ENOTSUP`.
fn unsupported(cause: &io::Error) -> bool {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let refused = [libc::EINVAL, libc::ENOSYS, libc::ENOTSUP, libc::EOPNOTSUPP]
        .map(Some)
        .contains(&cause.raw_os_error());
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let refused = false;
    refused || cause.kind() == ErrorKind::Unsupported
}

/// Whether `a` and `b` are one file: one device and inode, neither followed
/// when it is a link. Other platforms say no, so a link there is never
/// taken for the staged file.
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

/// The paths a put in this process is changing now, each from its check to
/// its rename or removal. A path is here only while a put holds its turn.
static BUSY: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());
/// Signalled whenever a put's turn ends.
static FREED: Condvar = Condvar::new();

/// A put's turn at its path: no other put in this process changes the path
/// until it drops. Across processes nothing waits; see `put`.
struct Turn(PathBuf);

impl Turn {
    /// Wait until no other put in this process holds `target`, then hold it.
    fn take(target: &Path) -> Self {
        let mut busy = BUSY.lock().unwrap_or_else(PoisonError::into_inner);
        while busy.contains(target) {
            busy = FREED.wait(busy).unwrap_or_else(PoisonError::into_inner);
        }
        busy.insert(target.to_path_buf());
        Self(target.to_path_buf())
    }
}

impl Drop for Turn {
    fn drop(&mut self) {
        BUSY.lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.0);
        FREED.notify_all();
    }
}

/// Why a put cannot land on what `find` found at `path`, if it cannot.
fn put_refusal(path: &str, found: &Found) -> Option<StorageError> {
    match found {
        Found::Link => Some(link_refusal(path)),
        Found::Directory => Some(StorageError::NotAFile {
            path: path.to_string(),
        }),
        Found::Occupied | Found::Other => Some(occupied(path)),
        _ => None,
    }
}

/// Make each missing directory of `names` below `root`, in order, and
/// answer the ones this call made. One another writer makes meanwhile is
/// theirs, not this call's.
fn make_parents(root: &Path, names: &[&str]) -> io::Result<Vec<PathBuf>> {
    let mut made = Vec::new();
    let mut at = root.to_path_buf();
    for name in names {
        at.push(name);
        match fs::create_dir(&at) {
            Ok(()) => made.push(at.clone()),
            Err(cause) if cause.kind() == ErrorKind::AlreadyExists => {
                if !fs::symlink_metadata(&at)?.is_dir() {
                    return Err(cause);
                }
            }
            Err(cause) => {
                remove_made(&made);
                return Err(cause);
            }
        }
    }
    Ok(made)
}

/// Remove the directories a put made, deepest first, stopping at the first
/// that is no longer empty: another writer put something in it.
fn remove_made(made: &[PathBuf]) {
    for directory in made.iter().rev() {
        if fs::remove_dir(directory).is_err() {
            return;
        }
    }
}

/// Give the staged file at `staged` the permission bits of the regular file
/// at `target`, when one is there, so replacing a file keeps it private
/// (`0600`) or executable. A new file keeps the staged file's own `0600`,
/// which it was made with. Only the read, write, and execute bits are
/// carried; setuid, setgid, and sticky never are. Called right after the
/// check of what `target` holds, so the mode is the one of the file the
/// rename replaces. Other platforms have no such bits to carry.
fn keep_mode(target: &Path, staged: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match fs::symlink_metadata(target) {
            Ok(existing) if existing.is_file() => fs::set_permissions(
                staged,
                fs::Permissions::from_mode(existing.permissions().mode() & 0o777),
            )?,
            Ok(_) => {}
            Err(cause) if cause.kind() == ErrorKind::NotFound => {}
            Err(cause) => return Err(cause),
        }
    }
    #[cfg(not(unix))]
    let _ = (target, staged);
    Ok(())
}

/// Publish `bytes` at `path`, or remove its file for `None`, only while the
/// path holds what `expected` says, answering the stamp of the file that
/// landed (empty for a removal). `Stale` when it does not, and nothing
/// changed; removing nothing that expects nothing has landed.
///
/// A new file must satisfy the portable rule (`path_problem`). An existing
/// nonportable name may be replaced or removed over the version read, never
/// made: a create of one is `InvalidPath`. HEAD can make a plain directory a
/// Git repository, so it stays private even when it exists. A reserved name
/// (`state::is_reserved`) is a save or a recording in progress, never the
/// page's: `InvalidPath`.
///
/// A write refuses what cannot land before staging anything, makes the
/// path's missing parent directories, stages the bytes beside the path
/// (`create_staged`), then walks the path again (no link, every name stored
/// as asked, as `find` checks), checks what the path holds, and renames the
/// staged bytes over the path. Within this process, puts of one path take
/// turns from that walk to the rename or removal (`Turn`), so of two
/// expecting one version exactly one lands. Across processes nothing holds
/// the path between the check and the rename. A write expecting `Absent` is
/// placed instead (`place`): something that appeared after the check, in any
/// process, is never replaced, and the put is `Stale`. On every answer but
/// `Landed` nothing of the put is left: not the staged file, and not a
/// directory it made, unless another writer put something in it.
pub fn put_landing(
    root: &Path,
    path: &str,
    bytes: Option<&[u8]>,
    expected: &Expectation,
) -> Result<Landing, StorageError> {
    if state::is_reserved(path) {
        return Err(StorageError::InvalidPath {
            path: path.to_string(),
            reason: "the name is reserved for a save or a recording in progress".to_string(),
        });
    }
    if let Err(refused) = admit(path) {
        if let Some(reason) = readable_path_problem(path).or_else(|| {
            path.split('/')
                .any(|part| part.eq_ignore_ascii_case("head"))
                .then_some(
                    "the path contains a segment named HEAD, which Git reads as a repository",
                )
        }) {
            return Err(StorageError::InvalidPath {
                path: path.to_string(),
                reason: reason.to_string(),
            });
        }
        if bytes.is_some() && *expected == Expectation::Absent {
            return Err(refused);
        }
    }
    let operation = if bytes.is_some() { "write" } else { "remove" };
    let failed = |cause: &dyn std::fmt::Display| io_error(path, operation, cause);
    // Where the change may land, or why it cannot.
    let landing = || -> Result<Found, StorageError> {
        let found = find(root, path).map_err(|cause| failed(&cause))?;
        match put_refusal(path, &found) {
            Some(refused) => Err(refused),
            None => Ok(found),
        }
    };
    let target = full(root, path);
    let names: Vec<&str> = path.split('/').collect();

    let Some(bytes) = bytes else {
        let _turn = Turn::take(&target);
        if !matches!(landing()?, Found::File { .. }) {
            return Ok(if matches!(expected, Expectation::Absent | Expectation::Any) {
                Landing::Landed(String::new())
            } else {
                Landing::Stale
            });
        }
        if !holds(&target, expected).map_err(|cause| failed(&cause))? {
            return Ok(Landing::Stale);
        }
        fs::remove_file(&target).map_err(|cause| failed(&cause))?;
        return Ok(Landing::Landed(String::new()));
    };

    if let Found::UnderFile { ancestor } = landing()? {
        return Err(StorageError::NotADirectory { path: ancestor });
    }
    // The staged file goes beside its target, so the directory it lands in
    // is made first, and removed again unless the put lands.
    let parents = &names[..names.len() - 1];
    let made = make_parents(root, parents).map_err(|cause| failed(&cause))?;
    let (staged, mut file) = match create_staged(&full_directory(root, parents)) {
        Ok(staged) => staged,
        Err(message) => {
            remove_made(&made);
            return Err(failed(&message));
        }
    };
    let unstaged = |cause: io::Error| {
        failed(&format!(
            "'{}' could not be staged: {cause}",
            staged.display()
        ))
    };
    // A rename or a placing keeps the staged file's stamp: it is what lands.
    let written = file
        .write_all(bytes)
        .and_then(|()| file.metadata())
        .and_then(|metadata| stamp_of(&metadata))
        .map_err(unstaged);
    let published = written.and_then(|stamp| {
        let _turn = Turn::take(&target);
        // Staging took time: walk and check again right before the rename.
        if let Found::UnderFile { ancestor } = landing()? {
            return Err(StorageError::NotADirectory { path: ancestor });
        }
        if !holds(&target, expected).map_err(|cause| failed(&cause))? {
            return Ok(Landing::Stale);
        }
        keep_mode(&target, &staged).map_err(|cause| failed(&cause))?;
        let placing = *expected == Expectation::Absent;
        let moved = if placing {
            place(&staged, &target)
        } else {
            fs::rename(&staged, &target)
        };
        match moved {
            Ok(()) => Ok(Landing::Landed(stamp)),
            // Something appeared at the path after the check, and stays.
            Err(cause) if placing && cause.kind() == ErrorKind::AlreadyExists => {
                Ok(Landing::Stale)
            }
            Err(cause) => Err(failed(&cause)),
        }
    });
    drop(file);
    if !matches!(published, Ok(Landing::Landed(_))) {
        let _ = fs::remove_file(&staged);
        remove_made(&made);
    }
    published
}

/// The directory `names` name below `root`.
fn full_directory(root: &Path, names: &[&str]) -> PathBuf {
    names
        .iter()
        .fold(root.to_path_buf(), |full, name| full.join(name))
}

/// `put_landing`, answering only whether the change landed.
pub fn put(
    root: &Path,
    path: &str,
    bytes: Option<&[u8]>,
    expected: &Expectation,
) -> Result<PutOutcome, StorageError> {
    Ok(match put_landing(root, path, bytes, expected)? {
        Landing::Landed(_) => PutOutcome::Landed,
        Landing::Stale => PutOutcome::Stale,
    })
}

#[cfg(test)]
#[path = "storage_tests.rs"]
mod tests;
