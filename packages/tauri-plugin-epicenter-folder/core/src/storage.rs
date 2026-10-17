//! A desktop page's folder storage: one function per method of the folder
//! engine's `FolderStorage` (`packages/folder/src/boundary.ts`), each one IPC
//! command (ADR-0581).
//!
//! A page names folder-relative paths, the ones `paths::path_problem`
//! accepts, and never the root. Every path is literal, as in the Bun
//! directory storage (`directory-store.ts`), whose outcomes these match:
//!
//! - a symbolic link is never followed, and a path through one is refused;
//! - on a disk that ignores case or Unicode normalization, `plan.md` can
//!   reach `Plan.md`. A name stored under another spelling is another entry:
//!   a read finds nothing there, and a change refuses to land on it;
//! - `.git` at the root is Git's, never listed and never named.
//!
//! `put` is the one change of a file. Its bytes are staged in a new file
//! under `.git/epicenter/scratch` and renamed over the path, so a reader and
//! a crash see the old file or the new one, and a new file never appears
//! empty. Only the check of what the path holds and the rename (or the
//! removal) hold the folder's publishing turn (`registry::PageWork`), so no
//! other save through the shell, and no save by the Bun host, lands between
//! them. A staged file a stopped save left behind is removed once it is an
//! hour old (`sweep_scratch`).
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

use crate::page_files::{self, linked};
use crate::paths::path_problem;

/// The folder's private Git directory, which no listing shows.
const PRIVATE_DIRECTORY: &str = ".git";

/// Where `put` stages a file's bytes, the same directory the Bun host uses.
pub const SCRATCH_DIRECTORY: &str = ".git/epicenter/scratch";

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
    admit(path)?;
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

/// Remove the empty directory at `path`.
pub fn rmdir(root: &Path, path: &str) -> Result<(), StorageError> {
    admit(path)?;
    let target = full(root, path);
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
        if fs::read_dir(&target)?.next().is_some() {
            return Ok(Err(StorageError::DirectoryNotEmpty {
                path: path.to_string(),
            }));
        }
        fs::remove_dir(&target)?;
        Ok(Ok(()))
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

/// Publish `bytes` at `path`, or remove its file for `None`, only while the
/// path holds `if_match`: the SHA-256 of the file there, or `None` for
/// nothing there. `Stale` when it does not, and nothing changed.
///
/// `turn` takes the folder's publishing turn, which is held only across the
/// check and the rename or removal; a turn refused, such as a save lock
/// another process held too long, is `Io`, and nothing changed. A new
/// file's missing parent directories are made. The staged file is removed
/// whenever the save does not land.
pub fn put<Turn>(
    root: &Path,
    path: &str,
    bytes: Option<&[u8]>,
    if_match: Option<&str>,
    turn: impl FnOnce() -> Result<Turn, String>,
) -> Result<PutOutcome, StorageError> {
    admit(path)?;
    let operation = if bytes.is_some() { "write" } else { "remove" };
    let found = find(root, path).map_err(|cause| io_error(path, "write", cause))?;
    match found {
        Found::Link => return Err(link_refusal(path)),
        Found::Directory => {
            return Err(StorageError::NotAFile {
                path: path.to_string(),
            })
        }
        Found::Occupied | Found::Other => return Err(occupied(path)),
        _ => {}
    }
    let target = full(root, path);
    let names: Vec<String> = path.split('/').map(str::to_string).collect();
    // The folder's turn, and the path checked again under it.
    let checked = |held: Turn| -> Result<(Turn, bool), StorageError> {
        if linked(root, &names).map_err(|message| io_error(path, operation, message))? {
            return Err(link_refusal(path));
        }
        let holds = holds(&target, if_match).map_err(|cause| io_error(path, operation, cause))?;
        pause_after_check();
        Ok((held, holds))
    };

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
        let held = turn().map_err(|message| io_error(path, operation, message))?;
        let (_held, holds) = checked(held)?;
        if !holds {
            return Ok(PutOutcome::Stale);
        }
        fs::remove_file(&target).map_err(|cause| io_error(path, operation, cause))?;
        return Ok(PutOutcome::Landed);
    };

    if let Found::UnderFile { ancestor } = found {
        return Err(StorageError::NotADirectory { path: ancestor });
    }
    let scratch_directory = full(root, SCRATCH_DIRECTORY);
    let scratch = scratch_directory.join(scratch_name(now_ms()));
    let staged = (|| -> Result<(), String> {
        if let (Found::Absent, Some((parent, _))) = (&found, path.rsplit_once('/')) {
            page_files::mkdir(root, &full(root, parent))?;
        }
        page_files::mkdir(root, &scratch_directory)?;
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&scratch)
            .and_then(|mut file| file.write_all(bytes))
            .map_err(|cause| format!("'{}' could not be staged: {cause}", scratch.display()))
    })();
    if let Err(message) = staged {
        let _ = fs::remove_file(&scratch);
        return Err(io_error(path, operation, message));
    }
    let published = (|| -> Result<PutOutcome, StorageError> {
        let held = turn().map_err(|message| io_error(path, operation, message))?;
        let (_held, holds) = checked(held)?;
        if !holds {
            return Ok(PutOutcome::Stale);
        }
        fs::rename(&scratch, &target).map_err(|cause| io_error(path, operation, cause))?;
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

/// Remove the staged files under `root`'s scratch directory that a stopped
/// save left more than an hour before `now_ms`. Younger ones may belong to
/// a save still running in another process. A staging directory reached
/// through a link is left alone, and what cannot be removed stays: it is
/// inert.
pub fn sweep_scratch(root: &Path, now_ms: u64) {
    let names: Vec<String> = SCRATCH_DIRECTORY.split('/').map(str::to_string).collect();
    if !matches!(linked(root, &names), Ok(false)) {
        return;
    }
    let Ok(entries) = fs::read_dir(full(root, SCRATCH_DIRECTORY)) else {
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
