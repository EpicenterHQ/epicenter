//! A desktop page's folder storage: one function per method of the folder
//! engine's `FolderStorage` (`packages/folder/src/boundary.ts`), each one IPC
//! command (ADR-0581).
//!
//! A page names folder-relative paths. New paths pass `paths::path_problem`;
//! witnessed saves may repair existing structurally safe names. Every path
//! is literal, as in the Bun
//! directory storage (`directory-store.ts`), whose outcomes these match:
//!
//! - a symbolic link is never followed, and a path through one is refused;
//! - on a disk that ignores case or Unicode normalization, `plan.md` can
//!   reach `Plan.md`. A name stored under another spelling is another entry:
//!   a read finds nothing there, and a change refuses to land on it;
//! - `.git` at the root is Git's, never listed and never named.
//!
//! `put` is the one change of a file. Its bytes are staged in a new file in
//! `.<name>.epicenter-scratch` beside the root, where the Bun host stages
//! too, and renamed over the path, so a reader and a crash see the old file
//! or the new one, and a new file never appears empty. Saving needs no Git:
//! it makes nothing in the root but the files saved, and never touches
//! `.git`, whatever is there. Only the check of what the path holds and the
//! rename (or the removal) hold the folder's publishing turn
//! (`registry::PageWork`), so no other save through the shell, and no save
//! by the Bun host, lands between them. Replacing an existing regular file
//! keeps its permission bits (`keep_mode`). A staged file a stopped save left
//! behind is removed once it is an hour old (`sweep_scratch`).
//!
//! A link another program swaps in between the check and the change is not
//! defended against; a page cannot make one.

use std::fs;
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use serde::Serialize;
use sha2::{Digest, Sha256};
use specta::Type;

use crate::page_files;
use crate::paths::{path_problem, readable_path_problem};

/// The folder's private Git directory, which no listing shows.
const PRIVATE_DIRECTORY: &str = ".git";

/// Where `put` stages a file's bytes: `.<name>.epicenter-scratch` beside the
/// canonical `root`, the directory the Bun host stages in
/// (`scratchDirectory` in `@epicenter/folder`'s `native/directory.ts`). It
/// is on the parent's file system, so a root that is itself a mount point
/// cannot be saved to; its rename fails and changes nothing.
pub fn scratch_directory(root: &Path) -> Result<PathBuf, String> {
    let (Some(parent), Some(name)) = (root.parent(), root.file_name()) else {
        return Err(format!(
            "The folder at {} has no parent directory to stage its saves in.",
            root.display()
        ));
    };
    let mut directory = std::ffi::OsString::from(".");
    directory.push(name);
    directory.push(".epicenter-scratch");
    Ok(parent.join(directory))
}

/// Why the scratch directory at `scratch` cannot hold staged bytes, if it
/// cannot: something is there that is a link or not a directory. A link is
/// never followed, so staged bytes never land somewhere else.
fn scratch_problem(scratch: &Path) -> Option<String> {
    let kind = match fs::symlink_metadata(scratch) {
        Ok(metadata) => metadata.file_type(),
        Err(cause) => {
            return Some(format!(
                "'{}' could not be inspected: {cause}",
                scratch.display()
            ))
        }
    };
    if kind.is_dir() {
        return None;
    }
    Some(format!(
        "'{}' is {}, so nothing was staged there. Remove it, then save again.",
        scratch.display(),
        if kind.is_symlink() {
            "a symbolic link"
        } else {
            "not a directory"
        }
    ))
}

/// The scratch directory beside `root`, made when it is missing, and
/// refused when it is a link or not a directory.
fn prepare_scratch(root: &Path) -> Result<PathBuf, String> {
    let scratch = scratch_directory(root)?;
    match fs::create_dir(&scratch) {
        Ok(()) => {}
        Err(cause) if cause.kind() == ErrorKind::AlreadyExists => {}
        Err(cause) => {
            return Err(format!(
                "'{}' could not be made: {cause}",
                scratch.display()
            ))
        }
    }
    match scratch_problem(&scratch) {
        None => Ok(scratch),
        Some(problem) => Err(problem),
    }
}

/// How old a staged file must be before `sweep_scratch` removes it, in
/// milliseconds: `STALE_SCRATCH_MS` in `boundary.ts`. A save renames or
/// removes its staged file right after writing it, so one this old was left
/// by a save that stopped. Younger ones may belong to a save still running
/// in another process.
const STALE_SCRATCH_MS: u64 = 60 * 60 * 1000;

/// Why a storage call answered no. The names and fields are the page's
/// `FileError` (`packages/folder/src/errors.ts`), less the ones only the page
/// can know: whether a reply was lost (`Unconfirmed`) and whether the folder
/// is closed.
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
    /// The directory to remove holds something.
    DirectoryNotEmpty { path: String },
    /// The operation failed, and changed nothing. A save lock another
    /// process held too long is one.
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

/// One file in a listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct ListedFile {
    pub path: String,
    /// The size in bytes. Typed for the page as a plain `number`, which
    /// holds every size below 2^53 exactly; specta refuses a `u64` as such.
    #[specta(type = u32)]
    pub size: u64,
}

/// Every entry below a folder's root, `.git` aside: `FileListing` in
/// `boundary.ts`. Anything that is not a directory is a file here, a link
/// or a special entry included, none of them followed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Type)]
pub struct FileListing {
    pub files: Vec<ListedFile>,
    pub directories: Vec<String>,
}

/// A directory's immediate children by name: real subdirectories in
/// `directories`, every other entry in `files`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Type)]
pub struct Children {
    pub files: Vec<String>,
    pub directories: Vec<String>,
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

/// What a literal folder path names on disk: `Found` in `directory-store.ts`.
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

/// Every entry below `root`, `.git` at the root aside, without following a
/// link. A name that is not text is left out.
pub fn list(root: &Path) -> Result<FileListing, StorageError> {
    fn visit(directory: &Path, prefix: &str, listing: &mut FileListing) -> io::Result<()> {
        for entry in fs::read_dir(directory)? {
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
                listing.directories.push(path.clone());
                visit(&at, &format!("{path}/"), listing)?;
                continue;
            }
            match fs::symlink_metadata(&at) {
                Ok(metadata) => listing.files.push(ListedFile {
                    path,
                    size: metadata.len(),
                }),
                Err(cause) if cause.kind() == ErrorKind::NotFound => {}
                Err(cause) => return Err(cause),
            }
        }
        Ok(())
    }
    let mut listing = FileListing::default();
    visit(root, "", &mut listing).map_err(|cause| io_error("", "list", cause))?;
    Ok(listing)
}

/// The immediate children of `directory`, the root for `""`.
pub fn children(root: &Path, directory: &str) -> Result<Children, StorageError> {
    if !directory.is_empty() {
        admit(directory)?;
    }
    let listed = || -> io::Result<Result<Children, StorageError>> {
        match find(root, directory)? {
            Found::Link => return Ok(Err(link_refusal(directory))),
            Found::File { .. } | Found::Other => {
                return Ok(Err(StorageError::NotADirectory {
                    path: directory.to_string(),
                }))
            }
            Found::Directory => {}
            _ => {
                return Ok(Err(StorageError::NotFound {
                    path: directory.to_string(),
                }))
            }
        }
        let at = if directory.is_empty() {
            root.to_path_buf()
        } else {
            full(root, directory)
        };
        let mut children = Children::default();
        for entry in fs::read_dir(at)? {
            let entry = entry?;
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if directory.is_empty() && name == PRIVATE_DIRECTORY {
                continue;
            }
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                children.directories.push(name);
            } else {
                children.files.push(name);
            }
        }
        Ok(Ok(children))
    };
    listed().unwrap_or_else(|cause| Err(io_error(directory, "list", cause)))
}

/// The bytes of the regular file at `path`.
pub fn read(root: &Path, path: &str) -> Result<Vec<u8>, StorageError> {
    if let Some(reason) = readable_path_problem(path) {
        return Err(StorageError::InvalidPath {
            path: path.to_string(),
            reason: reason.to_string(),
        });
    }
    let target = full(root, path);
    let read = || -> io::Result<Result<Vec<u8>, StorageError>> {
        Ok(match find(root, path)? {
            Found::Link => Err(link_refusal(path)),
            Found::Directory => Err(StorageError::NotAFile {
                path: path.to_string(),
            }),
            Found::Other => Err(StorageError::InvalidPath {
                path: path.to_string(),
                reason: "it is not a regular file and is not followed".to_string(),
            }),
            Found::File { .. } => Ok(fs::read(&target)?),
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

/// Make the directory at `path` and any missing ancestors.
pub fn mkdir(root: &Path, path: &str) -> Result<(), StorageError> {
    admit(path)?;
    let made = || -> io::Result<Result<(), StorageError>> {
        Ok(match find(root, path)? {
            Found::Link => Err(link_refusal(path)),
            Found::UnderFile { ancestor } => Err(StorageError::NotADirectory { path: ancestor }),
            Found::File { .. } | Found::Other => Err(StorageError::NotADirectory {
                path: path.to_string(),
            }),
            Found::Occupied => Err(occupied(path)),
            Found::Absent => page_files::mkdir(root, &full(root, path))
                .map_err(|message| io_error(path, "create directory", message)),
            Found::Directory => Ok(()),
        })
    };
    made().unwrap_or_else(|cause| Err(io_error(path, "create directory", cause)))
}

/// Remove the empty directory at `path`, holding the folder's publishing
/// turn (`turn`) across the check and the removal, as a put does, so no
/// save that takes the turn lands in it between the two. A turn refused is
/// `Io`, and nothing changed; an entry that appeared in it is
/// `DirectoryNotEmpty`.
pub fn rmdir<Turn>(
    root: &Path,
    path: &str,
    turn: impl FnOnce() -> Result<Turn, String>,
) -> Result<(), StorageError> {
    admit(path)?;
    let target = full(root, path);
    let _held = turn().map_err(|message| io_error(path, "remove directory", message))?;
    let removed = || -> io::Result<Result<(), StorageError>> {
        match find(root, path)? {
            Found::Link => return Ok(Err(link_refusal(path))),
            Found::File { .. } | Found::Other => {
                return Ok(Err(StorageError::NotADirectory {
                    path: path.to_string(),
                }))
            }
            Found::Directory => {}
            _ => {
                return Ok(Err(StorageError::NotFound {
                    path: path.to_string(),
                }))
            }
        }
        pause_after_check();
        // `remove_dir` removes only an empty directory, whatever appeared
        // in it since the check.
        match fs::remove_dir(&target) {
            Err(cause) if cause.kind() == ErrorKind::DirectoryNotEmpty => {
                Ok(Err(StorageError::DirectoryNotEmpty {
                    path: path.to_string(),
                }))
            }
            removed => removed.map(Ok),
        }
    };
    removed().unwrap_or_else(|cause| {
        Err(if absent(&target) {
            StorageError::NotFound {
                path: path.to_string(),
            }
        } else {
            io_error(path, "remove directory", cause)
        })
    })
}

/// A SHA-256 digest in lowercase hexadecimal, as the page writes one.
fn hex(digest: &[u8]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The lowercase hexadecimal SHA-256 of the file at `target`, streamed so a
/// large file is never held in memory while the folder's turn is held.
fn file_sha256(target: &Path) -> io::Result<String> {
    let mut hasher = Sha256::new();
    io::copy(&mut fs::File::open(target)?, &mut hasher)?;
    Ok(hex(&hasher.finalize()))
}

/// Whether `target` holds what a put expects: no entry at all for `None`,
/// or a regular file whose bytes hash to `if_match`.
fn holds(target: &Path, if_match: Option<&str>) -> io::Result<bool> {
    let found = match fs::symlink_metadata(target) {
        Ok(metadata) => Some(metadata),
        Err(cause) if cause.kind() == ErrorKind::NotFound => None,
        Err(cause) => return Err(cause),
    };
    match (if_match, found) {
        (None, found) => Ok(found.is_none()),
        (Some(expected), Some(metadata)) if metadata.is_file() => {
            Ok(file_sha256(target)? == expected)
        }
        (Some(_), _) => Ok(false),
    }
}

/// A name for a new staged file, as `scratchName` in `boundary.ts` makes
/// one: its creation time in milliseconds and a per-process counter in base
/// 36, around this process's id, so `sweep_scratch` and the Bun host read
/// its age alike.
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

#[cfg(test)]
thread_local! {
    /// How long a test's put on this thread waits between checking its
    /// path and changing it, so a race test can show that the publishing
    /// turn, not luck, keeps another save out of that gap.
    pub(crate) static PAUSE_AFTER_CHECK: std::cell::Cell<std::time::Duration> =
        const { std::cell::Cell::new(std::time::Duration::ZERO) };
}

fn pause_after_check() {
    #[cfg(test)]
    std::thread::sleep(PAUSE_AFTER_CHECK.with(std::cell::Cell::get));
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
/// (`0600`) or executable. A new file keeps the staged file's own mode, made
/// under the process's umask. Only the read, write, and execute bits are
/// carried; setuid, setgid, and sticky never are. Called holding the
/// publishing turn, right after the check of what `target` holds, so the
/// mode is the one of the file the rename replaces. Other platforms have no
/// such bits to carry.
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
/// path holds `if_match`: the SHA-256 of the file there, or `None` for
/// nothing there. `Stale` when it does not, and nothing changed.
///
/// `turn` takes the folder's publishing turn. Held, the put walks the path
/// again (no link, every name stored as asked, as `find` checks), checks
/// what the path holds, then makes a new file's missing parent directories
/// and renames the staged bytes over the path, or removes the file. A turn
/// refused, such as a save lock another process held too long, is `Io`. On
/// every answer but `Landed` nothing of the put is left: not the staged
/// file, and not a directory it made.
pub fn put<Turn>(
    root: &Path,
    path: &str,
    bytes: Option<&[u8]>,
    if_match: Option<&str>,
    turn: impl FnOnce() -> Result<Turn, String>,
) -> Result<PutOutcome, StorageError> {
    // An existing nonportable name may be changed only with its exact file
    // witness. HEAD can make a plain directory a Git repository, so it stays
    // private even when it exists. A new file must satisfy the portable rule.
    if if_match.is_some() {
        if let Some(reason) = readable_path_problem(path).or_else(|| {
            path.split('/').any(|part| part.eq_ignore_ascii_case("head"))
                .then_some("the path contains a segment named HEAD, which Git reads as a repository")
        }) {
            return Err(StorageError::InvalidPath {
                path: path.to_string(),
                reason: reason.to_string(),
            });
        }
    } else {
        admit(path)?;
    }
    let operation = if bytes.is_some() { "write" } else { "remove" };
    let failed = |cause: &dyn std::fmt::Display| io_error(path, operation, cause);
    // Refuse what cannot land before staging anything.
    let found = find(root, path).map_err(|cause| io_error(path, "write", cause))?;
    if let Some(refused) = put_refusal(path, &found) {
        return Err(refused);
    }
    let target = full(root, path);
    let names: Vec<&str> = path.split('/').collect();

    let Some(bytes) = bytes else {
        if !matches!(found, Found::File { .. }) {
            return Ok(if if_match.is_none() {
                PutOutcome::Landed
            } else {
                PutOutcome::Stale
            });
        }
        if if_match.is_none() {
            return Ok(PutOutcome::Stale);
        }
        let _held = turn().map_err(|message| failed(&message))?;
        let found = find(root, path).map_err(|cause| failed(&cause))?;
        if let Some(refused) = put_refusal(path, &found) {
            return Err(refused);
        }
        let holds = matches!(found, Found::File { .. })
            && holds(&target, if_match).map_err(|cause| failed(&cause))?;
        pause_after_check();
        if !holds {
            return Ok(PutOutcome::Stale);
        }
        fs::remove_file(&target).map_err(|cause| failed(&cause))?;
        return Ok(PutOutcome::Landed);
    };

    if let Found::UnderFile { ancestor } = found {
        return Err(StorageError::NotADirectory { path: ancestor });
    }
    let scratch = prepare_scratch(root)
        .map_err(|message| failed(&message))?
        .join(scratch_name(now_ms()));
    let unstaged = |cause: io::Error| {
        failed(&format!(
            "'{}' could not be staged: {cause}",
            scratch.display()
        ))
    };
    // `create_new`, so nothing already at the name is written through.
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&scratch)
        .map_err(unstaged)?;
    if let Err(cause) = file.write_all(bytes) {
        drop(file);
        let _ = fs::remove_file(&scratch);
        return Err(unstaged(cause));
    }
    drop(file);
    let published = (|| -> Result<PutOutcome, StorageError> {
        let _held = turn().map_err(|message| failed(&message))?;
        let found = find(root, path).map_err(|cause| failed(&cause))?;
        if let Some(refused) = put_refusal(path, &found) {
            return Err(refused);
        }
        if let Found::UnderFile { ancestor } = found {
            return Err(StorageError::NotADirectory { path: ancestor });
        }
        let holds = holds(&target, if_match).map_err(|cause| failed(&cause))?;
        pause_after_check();
        if !holds {
            return Ok(PutOutcome::Stale);
        }
        keep_mode(&target, &scratch).map_err(|cause| failed(&cause))?;
        let made = make_parents(root, &names[..names.len() - 1]).map_err(|cause| failed(&cause))?;
        if let Err(cause) = fs::rename(&scratch, &target) {
            remove_made(&made);
            return Err(failed(&cause));
        }
        Ok(PutOutcome::Landed)
    })();
    if published != Ok(PutOutcome::Landed) {
        let _ = fs::remove_file(&scratch);
    }
    published
}

/// Whether the staged file `name` was made more than an hour before
/// `now_ms`: `isStaleScratch` in `boundary.ts`. A name no host made is
/// never stale.
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

/// Remove the staged files in the scratch directory beside `root` that a
/// stopped save left more than an hour before `now_ms`: regular files whose
/// names a stager made (`is_stale_scratch`). Younger ones may belong to a
/// save still running in another process; any other file, a directory, or a
/// link stays. A scratch directory that is a link or not a directory is left
/// alone, and what cannot be removed stays: it is inert. Nothing in the
/// root, `.git` included, is touched.
pub fn sweep_scratch(root: &Path, now_ms: u64) {
    let Ok(scratch) = scratch_directory(root) else {
        return;
    };
    if scratch_problem(&scratch).is_some() {
        return;
    }
    let Ok(entries) = fs::read_dir(&scratch) else {
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
