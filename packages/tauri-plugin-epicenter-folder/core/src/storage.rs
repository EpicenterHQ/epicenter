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
//! - `.git` at the root is Git's, never listed and never named.
//! - `.epicenter` at the root holds the folder's unfinished writes
//!   (`state`). A file in `.epicenter/` is on its way somewhere: `saves/` is
//!   always safe to delete when no app runs, and `recordings/` may hold
//!   audio until the app opens once. It is a hidden path, so it is not the
//!   folder's data: a listing shows it and its reader skips it, no watcher
//!   reports it, and sync never commits it.
//!
//! `put` is the one change of a file. Its bytes are staged in a new file in
//! `.epicenter/saves` inside the root (`state::saves`), where the Bun store
//! stages too, and renamed over the path, so a reader and a crash see the
//! old file or the new one, and a new file never appears empty. Saving needs
//! no Git: it makes nothing beside the root, nothing in it but the files
//! saved and `.epicenter`, and never touches `.git`, whatever is there.
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
//! Unix the permission bits keep staged bytes from other accounts, before
//! publication or after a stopped save: `saves/` and `.epicenter` are
//! `0700` before anything is staged (`make_private`), and each staged file
//! is `0600` before its first byte. An access control entry the folder
//! passes on is kept: it is a grant the person made on their folder, and a
//! file another program makes there inherits it too. Replacing an existing
//! regular file keeps its permission bits (`keep_mode`); a new file is
//! `0600`. A staged file a stopped save left behind is removed once it is an
//! hour old (`sweep_scratch`).
//!
//! A save whose path is on another file system than `.epicenter` (a mount
//! point inside the folder) fails saying it cannot cross a mount point
//! (`rename_failure`): a rename cannot reach it, and nothing is copied
//! instead, so no half-written file appears there.
//!
//! A link another program swaps in between the check and the change is not
//! defended against; a page cannot make one.

use std::collections::BTreeSet;
use std::fs;
use std::io::{self, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, OnceLock, PoisonError};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use sha2::{Digest, Sha256};
use specta::Type;

use crate::paths::{path_problem, readable_path_problem};
use crate::state;

/// The folder's private Git directory, which no listing shows.
const PRIVATE_DIRECTORY: &str = ".git";

/// Why the directory at `directory` cannot be used, if it cannot: something
/// is there that is a link or not a directory. A link is never followed, so
/// nothing lands somewhere else.
fn directory_problem(directory: &Path) -> Option<String> {
    let kind = match fs::symlink_metadata(directory) {
        Ok(metadata) => metadata.file_type(),
        Err(cause) => {
            return Some(format!(
                "'{}' could not be inspected: {cause}",
                directory.display()
            ))
        }
    };
    if kind.is_dir() {
        return None;
    }
    Some(format!(
        "'{}' is {}, so nothing was saved through it. Remove it, then save again.",
        directory.display(),
        if kind.is_symlink() {
            "a symbolic link"
        } else {
            "not a directory"
        }
    ))
}

/// Why `.epicenter/saves` inside `root` cannot hold staged bytes, if it
/// cannot: `.epicenter` or `saves` is a link or not a directory.
fn saves_problem(root: &Path) -> Option<String> {
    directory_problem(&state::directory(root)).or_else(|| directory_problem(&state::saves(root)))
}

/// Make the directory at `directory` `0700` when missing; its parent must be
/// there. Refused when it is a link or not a directory.
fn make_directory(directory: &Path) -> Result<(), String> {
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    match builder.create(directory) {
        Ok(()) => {}
        Err(cause) if cause.kind() == ErrorKind::AlreadyExists => {}
        Err(cause) => {
            return Err(format!(
                "'{}' could not be made: {cause}",
                directory.display()
            ))
        }
    }
    match directory_problem(directory) {
        Some(problem) => Err(problem),
        None => Ok(()),
    }
}

/// `.epicenter` inside `root`, made `0700` when missing, and refused when it
/// is a link or not a directory, so staged bytes are never reached through
/// a link.
pub fn prepare_state_directory(root: &Path) -> Result<PathBuf, String> {
    let directory = state::directory(root);
    make_directory(&directory)?;
    Ok(directory)
}

/// `.epicenter/saves` inside `root`, private to this account with the
/// `.epicenter` holding it, as the Bun host makes both: each made `0700`
/// when missing, refused when it is a link or not a directory, and
/// tightened (`make_private`) when it is open to others, before anything is
/// staged.
fn prepare_saves(root: &Path) -> Result<PathBuf, String> {
    make_private(&prepare_state_directory(root)?)?;
    let saves = state::saves(root);
    make_directory(&saves)?;
    make_private(&saves)?;
    Ok(saves)
}

/// Leave the directory at `path` with permission bits for this account
/// alone (`0700`), or answer why it cannot be: it was made `0755`. The
/// mode is read and changed through the open directory, which must be the
/// entry `symlink_metadata` saw. A swapped link may be opened, but its
/// different identity is refused before permissions change. A directory
/// another account owns cannot be tightened. Windows has no such bits:
/// there the directory has the access its parent passes on.
#[cfg(unix)]
fn make_private(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let refused = |cause: &dyn std::fmt::Display| {
        format!(
            "'{}' could not be made private to this account, so nothing was staged there: {cause}",
            path.display()
        )
    };
    let seen = fs::symlink_metadata(path).map_err(|cause| refused(&cause))?;
    let directory = fs::File::open(path).map_err(|cause| refused(&cause))?;
    let opened = directory.metadata().map_err(|cause| refused(&cause))?;
    if !seen.is_dir()
        || !opened.is_dir()
        || (opened.dev(), opened.ino()) != (seen.dev(), seen.ino())
    {
        return Err(refused(&"it changed while it was checked"));
    }
    if opened.mode() & 0o077 != 0 {
        directory
            .set_permissions(fs::Permissions::from_mode(0o700))
            .map_err(|cause| refused(&cause))?;
        match directory.metadata() {
            Ok(tightened) if tightened.mode() & 0o077 == 0 => {}
            Ok(_) => return Err(refused(&"other accounts can still open it")),
            Err(cause) => return Err(refused(&cause)),
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn make_private(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// How old a staged file must be before `sweep_scratch` removes it, in
/// milliseconds. A save renames or
/// removes its staged file right after writing it, so one this old was left
/// by a save that stopped. Younger ones may belong to a save still running
/// in another process.
const STALE_SCRATCH_MS: u64 = 60 * 60 * 1000;

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
    /// A regular file whose bytes have this lowercase hexadecimal SHA-256.
    Sha256(String),
}

impl Expectation {
    /// The page's `expected` header: `absent`, or `sha256:` and a lowercase
    /// hexadecimal SHA-256. Each case has its own spelling, so a hash is
    /// never read as a keyword, nor a keyword as a hash.
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "absent" => Ok(Self::Absent),
            _ => match value.strip_prefix("sha256:") {
                Some(hash)
                    if hash.len() == 64
                        && hash
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) =>
                {
                    Ok(Self::Sha256(hash.to_string()))
                }
                _ => Err(format!(
                    "expected is {value:?}, not absent, or sha256: and a SHA-256"
                )),
            },
        }
    }
}

/// One file in a listing. Anything that is not a directory is a file here,
/// a link or a special entry included, none of them followed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct ListedFile {
    pub path: String,
    pub stamp: String,
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

/// Every file below `root`, `.git` at the root aside, without following a
/// link. Hidden files are listed, unfinished writes in `.epicenter`
/// included; whoever reads the listing skips them (`isHiddenPath`). A name
/// that is not text is left out. A directory below the root removed during
/// the walk is not listed: opening it, or reading its entries (macOS's
/// `readdir` answers `ENOENT` for one removed mid-read), says it is not
/// found. Only the root missing fails the listing that way.
pub fn list(root: &Path) -> Result<Vec<ListedFile>, StorageError> {
    fn visit(directory: &Path, prefix: &str, listing: &mut Vec<ListedFile>) -> io::Result<()> {
        for entry in fs::read_dir(directory)? {
            #[cfg(test)]
            let entry = tests::removed_mid_read(directory).map_or(entry, Err);
            let entry = entry?;
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if prefix.is_empty() && name == PRIVATE_DIRECTORY {
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
            match fs::symlink_metadata(&at) {
                Ok(metadata) => listing.push(ListedFile {
                    path,
                    stamp: stamp_of(&metadata)?,
                }),
                Err(cause) if cause.kind() == ErrorKind::NotFound => {}
                Err(cause) => return Err(cause),
            }
        }
        Ok(())
    }
    let mut listing = Vec::new();
    visit(root, "", &mut listing).map_err(|cause| io_error("", "list", cause))?;
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

/// A SHA-256 digest in lowercase hexadecimal, as the page writes one.
fn hex(digest: &[u8]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The lowercase hexadecimal SHA-256 of the file at `target`, streamed so a
/// large file is never held in memory.
fn file_sha256(target: &Path) -> io::Result<String> {
    let mut hasher = Sha256::new();
    io::copy(&mut fs::File::open(target)?, &mut hasher)?;
    Ok(hex(&hasher.finalize()))
}

/// Whether `target` holds what a put expects.
fn holds(target: &Path, expected: &Expectation) -> io::Result<bool> {
    let found = match fs::symlink_metadata(target) {
        Ok(metadata) => Some(metadata),
        Err(cause) if cause.kind() == ErrorKind::NotFound => None,
        Err(cause) => return Err(cause),
    };
    match (expected, found) {
        (Expectation::Absent, found) => Ok(found.is_none()),
        (Expectation::Sha256(hash), Some(metadata)) if metadata.is_file() => {
            Ok(file_sha256(target)? == *hash)
        }
        _ => Ok(false),
    }
}

/// A name for a new staged file, as `scratchName` in
/// `packages/folder/src/state.ts` makes one: its creation time in
/// milliseconds and a per-process counter in base 36, around this process's
/// id, so `sweep_scratch` reads its age, and sweeps what a stopped save of
/// the Bun store left too.
fn scratch_name(now_ms: u64) -> String {
    static ENGINE: OnceLock<String> = OnceLock::new();
    static STAGED: AtomicU64 = AtomicU64::new(0);
    let engine = ENGINE.get_or_init(|| {
        let mut seed = Sha256::new();
        seed.update(std::process::id().to_le_bytes());
        seed.update(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
                .to_le_bytes(),
        );
        seed.update((&STAGED as *const AtomicU64 as usize).to_le_bytes());
        hex(&seed.finalize()[..16])
    });
    let count = STAGED.fetch_add(1, Ordering::SeqCst);
    format!("{}-{engine}-{}", base36(now_ms), base36(count))
}

fn base36(mut value: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut digits = Vec::new();
    loop {
        digits.push(DIGITS[(value % 36) as usize]);
        value /= 36;
        if value == 0 {
            break;
        }
    }
    digits.reverse();
    String::from_utf8(digits).expect("base 36 digits are ASCII")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// A new, empty file in `.epicenter/saves` inside `root`, for bytes that
/// are renamed to their path once whole: `put` stages each save in one. Its
/// name is a scratch name (`scratch_name`), so one a stopped writer leaves
/// behind is removed once stale (`sweep_scratch`). It is made with
/// `create_new`, so nothing already at the name is written through, and
/// `0600`, so the permission bits keep it from other accounts before its
/// first byte. Whoever made it renames or removes it.
fn create_scratch(root: &Path) -> Result<(PathBuf, fs::File), String> {
    let scratch = prepare_saves(root)?.join(scratch_name(now_ms()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let file = options
        .open(&scratch)
        .map_err(|cause| format!("'{}' could not be staged: {cause}", scratch.display()))?;
    Ok((scratch, file))
}

/// What a move from `.epicenter` to the folder-relative `path` that failed
/// with `cause` says: a rename, or a `place`. A path on another file system
/// (a mount point inside the folder) is one no rename or hard link reaches
/// (`EXDEV`); nothing is copied instead, so nothing was written there, and
/// the message says so.
pub fn rename_failure(path: &str, cause: &io::Error) -> String {
    if cause.kind() == ErrorKind::CrossesDevices {
        return format!(
            "cannot save across a mount point: '{path}' is on another file system than the folder's {}, so nothing was written there",
            state::DIRECTORY
        );
    }
    cause.to_string()
}

/// Move the staged file at `staged` to `target` only where nothing is,
/// never replacing anything there, whatever appeared since a caller looked:
/// a hard link to `target`, which the system refuses when any entry has the
/// name, then the staged name removed. A file is never half there: the link
/// makes the whole file appear at once.
///
/// `AlreadyExists` when something is at `target`; the staged file stays. A
/// link an earlier move made before it was cut off, before it removed the
/// staged name, is this file at both names and counts as placed. Another
/// file system (`CrossesDevices`, which `rename_failure` words), and a
/// staged file or a target directory that is not there (`NotFound`), fail
/// as they are. Where the disk has no hard links
/// (FAT, exFAT, some network shares), the file is renamed only while nothing
/// is at `target`: there a writer racing that one check can be replaced.
///
/// `put` places a save that expects nothing at its path, and the recorder
/// places each recording, so neither replaces a file that appeared after
/// its check.
pub fn place(staged: &Path, target: &Path) -> io::Result<()> {
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
/// path holds what `expected` says. `Stale` when it does not, and nothing
/// changed; removing nothing that expects nothing has landed.
///
/// A new file must satisfy the portable rule (`path_problem`). An existing
/// nonportable name may be replaced or removed over the version read, never
/// made: a create of one is `InvalidPath`. HEAD can make a plain directory a
/// Git repository, so it stays private even when it exists.
///
/// A write refuses what cannot land before staging anything, stages the
/// bytes, then walks the path again (no link, every name stored as asked, as
/// `find` checks), checks what the path holds, makes a new file's missing
/// parent directories, and renames the staged bytes over the path. Within
/// this process, puts of one path take turns from that walk to the rename
/// or removal (`Turn`), so of two expecting one version exactly one lands.
/// Across processes nothing holds the path between the check and the
/// rename. A write expecting `Absent` is placed instead (`place`): something
/// that appeared after the check, in any process, is never replaced, and
/// the put is `Stale`. On every answer but
/// `Landed` nothing of the put is left: not the staged file, and not a
/// directory it made.
pub fn put(
    root: &Path,
    path: &str,
    bytes: Option<&[u8]>,
    expected: &Expectation,
) -> Result<PutOutcome, StorageError> {
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
            return Ok(if *expected == Expectation::Absent {
                PutOutcome::Landed
            } else {
                PutOutcome::Stale
            });
        }
        if !holds(&target, expected).map_err(|cause| failed(&cause))? {
            return Ok(PutOutcome::Stale);
        }
        fs::remove_file(&target).map_err(|cause| failed(&cause))?;
        return Ok(PutOutcome::Landed);
    };

    let found = landing()?;
    if let Found::UnderFile { ancestor } = found {
        return Err(StorageError::NotADirectory { path: ancestor });
    }
    let (scratch, mut file) = create_scratch(root).map_err(|message| failed(&message))?;
    let unstaged = |cause: io::Error| {
        failed(&format!(
            "'{}' could not be staged: {cause}",
            scratch.display()
        ))
    };
    if let Err(error) = file.write_all(bytes).map_err(unstaged) {
        drop(file);
        let _ = fs::remove_file(&scratch);
        return Err(error);
    }
    let published = (|| -> Result<PutOutcome, StorageError> {
        let _turn = Turn::take(&target);
        // Staging took time: walk and check again right before the rename.
        if let Found::UnderFile { ancestor } = landing()? {
            return Err(StorageError::NotADirectory { path: ancestor });
        }
        if !holds(&target, expected).map_err(|cause| failed(&cause))? {
            return Ok(PutOutcome::Stale);
        }
        keep_mode(&target, &scratch).map_err(|cause| failed(&cause))?;
        let made = make_parents(root, &names[..names.len() - 1]).map_err(|cause| failed(&cause))?;
        let placing = *expected == Expectation::Absent;
        let moved = if placing {
            place(&scratch, &target)
        } else {
            fs::rename(&scratch, &target)
        };
        if let Err(cause) = moved {
            remove_made(&made);
            // Something appeared at the path after the check, and stays.
            if placing && cause.kind() == ErrorKind::AlreadyExists {
                return Ok(PutOutcome::Stale);
            }
            return Err(failed(&rename_failure(path, &cause)));
        }
        Ok(PutOutcome::Landed)
    })();
    drop(file);
    if !matches!(published, Ok(PutOutcome::Landed)) {
        let _ = fs::remove_file(&scratch);
    }
    published
}

/// Whether the staged file `name` was made more than an hour before
/// `now_ms`. A name no host made is never stale.
pub fn is_stale_scratch(name: &str, now_ms: u64) -> bool {
    let parts: Vec<&str> = name.split('-').collect();
    let [time, engine, count] = parts.as_slice() else {
        return false;
    };
    let base36 = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_digit() || byte.is_ascii_lowercase())
    };
    let engine_id = engine.len() == 32
        && engine
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if !base36(time) || !engine_id || !base36(count) {
        return false;
    }
    // `Number.isSafeInteger` in the page: at most 2^53 - 1.
    const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
    match u64::from_str_radix(time, 36) {
        Ok(created) if created <= MAX_SAFE_INTEGER => now_ms
            .checked_sub(created)
            .is_some_and(|age| age > STALE_SCRATCH_MS),
        _ => false,
    }
}

/// Remove the staged files in `.epicenter/saves` inside `root` that a
/// stopped save left more than an hour before `now_ms`: regular files whose
/// names a stager made (`is_stale_scratch`). Younger ones may belong to a
/// save still running in another process; any other file, a directory, or a
/// link stays. A `saves` or `.epicenter` that is a link or not a directory
/// is left alone, and what cannot be removed stays: it is inert. Nothing
/// else in the root is touched: not `.git`, and never `recordings/`, whose
/// audio waits for the recorder's recovery.
pub fn sweep_scratch(root: &Path, now_ms: u64) {
    if saves_problem(root).is_some() {
        return;
    }
    let Ok(entries) = fs::read_dir(state::saves(root)) else {
        return;
    };
    for entry in entries.flatten() {
        let is_file = entry.file_type().is_ok_and(|kind| kind.is_file());
        let stale = entry
            .file_name()
            .to_str()
            .is_some_and(|name| is_stale_scratch(name, now_ms));
        if is_file && stale {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// `sweep_scratch` as of now.
pub fn sweep_stale_scratch(root: &Path) {
    sweep_scratch(root, now_ms());
}

#[cfg(test)]
#[path = "storage_tests.rs"]
mod tests;
