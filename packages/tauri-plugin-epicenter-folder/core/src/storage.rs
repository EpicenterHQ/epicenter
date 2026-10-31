//! A desktop page's folder storage: one function per method of the folder
//! engine's `FolderStorage` (`packages/folder/src/boundary.ts`), each one IPC
//! command (ADR-0581).
//!
//! A page names folder-relative paths. New paths pass `paths::path_problem`;
//! a save may replace or remove an existing structurally safe name that only
//! some disks hold, but never make one. Every path
//! is literal, as in the Bun
//! directory storage (`directory-store.ts`), whose outcomes these match:
//!
//! - a symbolic link is never followed, and a path through one is refused;
//! - on a disk that ignores case or Unicode normalization, `plan.md` can
//!   reach `Plan.md`. A name stored under another spelling is another entry:
//!   a read finds nothing there, and a change refuses to land on it;
//! - `.git` at the root is Git's, never listed and never named.
//!
//! A path with a hidden segment is not the folder's data (`isHiddenPath` in
//! `@epicenter/definition`): no contract claims it, and no watcher reports
//! it. Unfinished files use that rule. Each is a hidden sibling of where it
//! lands, `.<name>.epicenter-pending` (`pending_name`): a staged save is
//! `.<scratch name>.epicenter-pending`, and a recording in progress is
//! `.<id>.wav.epicenter-pending`. Listings show them like any hidden file,
//! and `epicenter sync` never commits one.
//!
//! `put` is the one change of a file. Its bytes are staged in a new file
//! beside the path (`scratch_sibling`), as the Bun host stages, and renamed
//! over it: the rename stays in one directory, so it is one step even where
//! another file system is mounted inside the folder, and a reader and a
//! crash see the old file or the new one, and a new file never appears
//! empty. Saving needs no Git: it makes nothing beside the root, nothing in
//! it but the files saved, their directories, and for the moment of a save
//! its staged sibling, and never touches `.git`, whatever is there.
//!
//! The version check (what the path holds, against what the page read)
//! runs right before the rename or the removal, with no lock across the
//! two: another program that saves in that instant can be overwritten.
//! External editors never took a lock anyway, and Git history keeps every
//! version sync committed (ADR-0562, ADR-0568). On Unix no other account can
//! read staged bytes, before publication or after a stopped save: each
//! staged file is created `0600` (`create_private`). On macOS it also has no
//! access control entry (`without_acl`), such as an `everyone allow read`
//! its directory passes on, or the save is refused before its first byte.
//! The file carries such an entry for the few microseconds between its
//! creation and that removal, so an account the person granted an
//! inheritable entry on a data directory could open it then and keep
//! reading. Windows has no such bits: a staged file there has the access its
//! directory passes on, and Explorer shows it, since a leading dot does not
//! hide a name. Replacing an existing regular file keeps its permission
//! bits (`keep_mode`); a new file is `0600`. A staged file a stopped save
//! left behind is removed once it is an hour old (`sweep_scratch`).
//!
//! A link another program swaps in between the check and the change is not
//! defended against; a page cannot make one.

use std::fs;
use std::io::{self, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use sha2::{Digest, Sha256};
use specta::Type;

use crate::paths::{path_problem, readable_path_problem};

/// The folder's private Git directory, which no listing shows.
const PRIVATE_DIRECTORY: &str = ".git";

/// The end of an unfinished file's name: `.<name>.epicenter-pending`. Namespaced,
/// so a person's own hidden files are never mistaken for one.
const PENDING_SUFFIX: &str = ".epicenter-pending";

/// The hidden name an unfinished `name` is written under, beside where it
/// lands: `.<name>.epicenter-pending`. A staged save is `name` = a scratch
/// name (`scratch_name`); a recording in progress is `name` = its file's
/// own name (`<id>.wav`).
pub fn pending_name(name: &str) -> String {
    format!(".{name}{PENDING_SUFFIX}")
}

/// The name an unfinished file stands for: `name` from
/// `.<name>.epicenter-pending` (`pending_name`), or `None` for any other
/// file name.
pub fn unfinished_name(file_name: &str) -> Option<&str> {
    file_name
        .strip_prefix('.')?
        .strip_suffix(PENDING_SUFFIX)
        .filter(|name| !name.is_empty())
}

/// A path for new staged bytes in `directory`, beside where they land: a
/// fresh scratch name made pending (`pending_name(scratch_name(..))`), so
/// `sweep_scratch` can tell its age and a rename to the destination stays
/// in one directory, on one file system.
pub fn scratch_sibling(directory: &Path) -> PathBuf {
    directory.join(pending_name(&scratch_name(now_ms())))
}

/// Make a new file at `path`, readable only by this account before its
/// first byte: created exclusively (`create_new`, so nothing already there,
/// a link included, is written through), `0600` on Unix, and on macOS with
/// no access control entry its directory passed on (`without_acl`), or
/// removed again and refused. Between the create and the removal of such an
/// entry, a few microseconds, an account the directory's entry names could
/// open the still-empty file and keep reading it as bytes arrive.
pub fn create_private(path: &Path) -> io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let file = options.open(path)?;
    if let Err(cause) = without_acl(&file) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(io::Error::new(
            cause.kind(),
            format!(
                "it could not be made private to this account, so nothing was written to it: {cause}"
            ),
        ));
    }
    Ok(file)
}

/// On macOS, remove every access control entry on the open `file`, or
/// answer why it cannot be done. Mode bits do not limit an entry: one a
/// parent passes on, such as `everyone allow read`, lets other accounts
/// read a `0600` file. The entries are read and removed through the open
/// file, so they are its own. Other systems need nothing here: a Linux
/// default ACL is masked by the group bits of a `0700` or `0600` mode.
#[cfg(target_os = "macos")]
fn without_acl(file: &fs::File) -> io::Result<()> {
    use std::ffi::{c_int, c_void};
    use std::os::unix::io::AsRawFd;
    // `<sys/acl.h>`, in libSystem.
    const ACL_TYPE_EXTENDED: c_int = 0x0000_0100;
    const ACL_FIRST_ENTRY: c_int = 0;
    extern "C" {
        fn acl_get_fd_np(fd: c_int, kind: c_int) -> *mut c_void;
        fn acl_get_entry(acl: *mut c_void, entry_id: c_int, entry: *mut *mut c_void) -> c_int;
        fn acl_init(count: c_int) -> *mut c_void;
        fn acl_set_fd_np(fd: c_int, acl: *mut c_void, kind: c_int) -> c_int;
        fn acl_free(object: *mut c_void) -> c_int;
    }
    let fd = file.as_raw_fd();
    let has_entries = || -> io::Result<bool> {
        // SAFETY: `fd` is open for as long as `file` is borrowed, and the
        // list returned is freed once, after its last use.
        unsafe {
            let acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
            if acl.is_null() {
                let cause = io::Error::last_os_error();
                return match cause.kind() {
                    ErrorKind::NotFound => Ok(false),
                    _ => Err(cause),
                };
            }
            let mut entry = std::ptr::null_mut();
            let found = acl_get_entry(acl, ACL_FIRST_ENTRY, &mut entry) == 0;
            acl_free(acl);
            Ok(found)
        }
    };
    if !has_entries()? {
        return Ok(());
    }
    // SAFETY: as above; the empty list is freed once, after it is set.
    unsafe {
        let empty = acl_init(0);
        if empty.is_null() {
            return Err(io::Error::last_os_error());
        }
        let set = acl_set_fd_np(fd, empty, ACL_TYPE_EXTENDED);
        let cause = io::Error::last_os_error();
        acl_free(empty);
        if set != 0 {
            return Err(cause);
        }
    }
    if has_entries()? {
        return Err(io::Error::other(
            "an access control list still lets other accounts open it",
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn without_acl(_file: &fs::File) -> io::Result<()> {
    Ok(())
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
    /// The operation failed, and changed nothing.
    Io {
        path: String,
        operation: String,
        message: String,
    },
}

/// What a `put` did: changed the file, or found the path holding something
/// other than what the page expected and changed nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PutOutcome {
    Landed { stamp: Option<String> },
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

/// What a `put` expects at its path when it lands: `Expectation` in
/// `boundary.ts`. `Any` is never stale.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expectation {
    /// Nothing at all is there.
    Absent,
    /// A regular file is there, whatever its bytes.
    Present,
    /// A regular file whose bytes have this lowercase hexadecimal SHA-256.
    Sha256(String),
    /// Whatever is there.
    Any,
}

impl Expectation {
    /// The page's `expected` header: `any`, `absent`, `present`, or
    /// `sha256:` and a lowercase hexadecimal SHA-256. Each case has its own
    /// spelling, so a hash is never read as a keyword, nor a keyword as a
    /// hash.
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "any" => Ok(Self::Any),
            "absent" => Ok(Self::Absent),
            "present" => Ok(Self::Present),
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
                    "expected is {value:?}, not any, absent, present, or sha256: and a SHA-256"
                )),
            },
        }
    }
}

/// One file in a listing: `ListedFile` in `boundary.ts`. Anything that is
/// not a directory is a file here, a link or a special entry included, none
/// of them followed.
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

/// Every file below `root`, `.git` at the root aside, hidden ones and
/// unfinished ones included, without following a link. A name that is not
/// text is left out.
pub fn list(root: &Path) -> Result<Vec<ListedFile>, StorageError> {
    fn visit(directory: &Path, prefix: &str, listing: &mut Vec<ListedFile>) -> io::Result<()> {
        let entries = match fs::read_dir(directory) {
            Err(cause) if !prefix.is_empty() && cause.kind() == ErrorKind::NotFound => {
                return Ok(())
            }
            result => result?,
        };
        for entry in entries {
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
                visit(&at, &format!("{path}/"), listing)?;
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
    if *expected == Expectation::Any {
        return Ok(true);
    }
    let found = match fs::symlink_metadata(target) {
        Ok(metadata) => Some(metadata),
        Err(cause) if cause.kind() == ErrorKind::NotFound => None,
        Err(cause) => return Err(cause),
    };
    match (expected, found) {
        (Expectation::Absent, found) => Ok(found.is_none()),
        (Expectation::Present, Some(metadata)) => Ok(metadata.is_file()),
        (Expectation::Sha256(hash), Some(metadata)) if metadata.is_file() => {
            Ok(file_sha256(target)? == *hash)
        }
        _ => Ok(false),
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
/// theirs, not this call's. On failure the ones made are removed again.
fn make_parents(root: &Path, names: &[&str]) -> io::Result<Vec<PathBuf>> {
    let mut made = Vec::new();
    let mut at = root.to_path_buf();
    for name in names {
        at.push(name);
        let failure = match fs::create_dir(&at) {
            Ok(()) => {
                made.push(at.clone());
                continue;
            }
            Err(cause) if cause.kind() == ErrorKind::AlreadyExists => {
                match fs::symlink_metadata(&at) {
                    Ok(metadata) if metadata.is_dir() => continue,
                    Ok(_) => cause,
                    Err(inspected) => inspected,
                }
            }
            Err(cause) => cause,
        };
        remove_made(&made);
        return Err(failure);
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

/// Move the file at `staged` to `target`, never replacing anything there:
/// a hard link to `target`, which the file system refuses with
/// `AlreadyExists` when a name is already there, then the staged name
/// removed. The check and the move are one step, so of two writers placing
/// at one path, exactly one lands. A link already made by an earlier move
/// that stopped before the removal counts as placed, and a staged name that
/// cannot be removed after the link is a second name of the placed file,
/// which the move still made. Where the disk has no hard links, the file is
/// renamed only while nothing is at `target`, with no lock between that
/// check and the rename. A put expecting nothing at its path lands this
/// way, and so does a finished recording.
pub fn place(staged: &Path, target: &Path) -> io::Result<()> {
    match fs::hard_link(staged, target) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            if !same_file(staged, target)? {
                return Err(error);
            }
        }
        Err(error) if error.kind() == ErrorKind::NotFound => return Err(error),
        Err(_) => {
            if fs::symlink_metadata(target).is_ok() {
                return Err(io::Error::new(
                    ErrorKind::AlreadyExists,
                    "a file is already there",
                ));
            }
            return fs::rename(staged, target);
        }
    }
    let _ = fs::remove_file(staged);
    Ok(())
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

/// Publish `bytes` at `path`, or remove its file for `None`, only while the
/// path holds what `expected` says. `Stale` when it does not, and nothing
/// changed; `Any` is never stale, and removing nothing that may be absent
/// has landed.
///
/// A new file must satisfy the portable rule (`path_problem`). An existing
/// nonportable name may be replaced or removed, never made: a write
/// expecting `Any` there lands only while a file is there, and is
/// `InvalidPath` otherwise. HEAD can make a plain directory a Git
/// repository, so it stays private even when it exists.
///
/// A write refuses what cannot land before staging anything, makes a new
/// file's missing parent directories, stages the bytes beside the path
/// (`scratch_sibling`), then walks the path again (no link, every name
/// stored as asked, as `find` checks), checks what the path holds, and
/// renames the staged bytes over the path. Nothing holds the path between
/// that check and the rename, except for a new file (`Absent`): it is
/// placed (`place`), whose hard link refuses a name already there, so of
/// two writers creating one path exactly one lands. On every answer but `Landed` nothing of the
/// put is left: the staged file is removed, then each directory it made
/// that is still empty.
pub fn put(
    root: &Path,
    path: &str,
    bytes: Option<&[u8]>,
    expected: &Expectation,
) -> Result<PutOutcome, StorageError> {
    let nonportable = admit(path).err();
    if let Some(refused) = &nonportable {
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
            return Err(refused.clone());
        }
    }
    // A write that may make a nonportable name must find its file there.
    let requires_file = nonportable.is_some() && bytes.is_some() && *expected == Expectation::Any;
    let present = Expectation::Present;
    let expected = if requires_file { &present } else { expected };
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
        if !matches!(landing()?, Found::File { .. }) {
            return Ok(
                if matches!(expected, Expectation::Absent | Expectation::Any) {
                    PutOutcome::Landed { stamp: None }
                } else {
                    PutOutcome::Stale
                },
            );
        }
        if !holds(&target, expected).map_err(|cause| failed(&cause))? {
            return Ok(PutOutcome::Stale);
        }
        fs::remove_file(&target).map_err(|cause| failed(&cause))?;
        return Ok(PutOutcome::Landed { stamp: None });
    };

    let found = landing()?;
    if let Found::UnderFile { ancestor } = found {
        return Err(StorageError::NotADirectory { path: ancestor });
    }
    if let Some(refused) = nonportable.as_ref().filter(|_| requires_file) {
        if !matches!(found, Found::File { .. }) {
            return Err(refused.clone());
        }
    }
    // The staged sibling keeps a directory this made from being pruned
    // while the put runs.
    let made = make_parents(root, &names[..names.len() - 1]).map_err(|cause| failed(&cause))?;
    let staged = scratch_sibling(target.parent().expect("a folder path is below the root"));
    let published = (|| -> Result<PutOutcome, StorageError> {
        let unstaged = |cause: io::Error| {
            failed(&format!(
                "'{}' could not be staged: {cause}",
                staged.display()
            ))
        };
        let mut file = create_private(&staged).map_err(unstaged)?;
        file.write_all(bytes).map_err(unstaged)?;
        let staged_stamp = file
            .metadata()
            .and_then(|metadata| stamp_of(&metadata))
            .map_err(unstaged)?;
        // Staging took time: walk and check again right before the rename.
        if let Found::UnderFile { ancestor } = landing()? {
            return Err(StorageError::NotADirectory { path: ancestor });
        }
        if !holds(&target, expected).map_err(|cause| failed(&cause))? {
            return match &nonportable {
                Some(refused) if requires_file => Err(refused.clone()),
                _ => Ok(PutOutcome::Stale),
            };
        }
        keep_mode(&target, &staged).map_err(|cause| failed(&cause))?;
        if *expected == Expectation::Absent {
            match place(&staged, &target) {
                Ok(()) => {}
                Err(cause) if cause.kind() == ErrorKind::AlreadyExists => {
                    return Ok(PutOutcome::Stale)
                }
                Err(cause) => return Err(failed(&cause)),
            }
        } else {
            fs::rename(&staged, &target).map_err(|cause| failed(&cause))?;
        }
        let after_rename = file
            .metadata()
            .ok()
            .and_then(|metadata| stamp_of(&metadata).ok());
        let stamp = after_rename
            .filter(|stamp| *stamp == staged_stamp)
            .unwrap_or(staged_stamp);
        Ok(PutOutcome::Landed { stamp: Some(stamp) })
    })();
    if !matches!(published, Ok(PutOutcome::Landed { .. })) {
        let _ = fs::remove_file(&staged);
        remove_made(&made);
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

/// Remove the staged files a stopped save left anywhere below `root` more
/// than an hour before `now_ms`: regular files named
/// `.<scratch name>.epicenter-pending` whose scratch name a stager made
/// (`is_stale_scratch`), in one walk that follows no link and never enters
/// `.git`. Younger ones may belong to a save still running in another
/// process. Any other file stays: a recording in progress
/// (`.<id>.wav.epicenter-pending`) never has a scratch name, nor does
/// anything a person named. What cannot be read or removed stays: it is
/// inert.
pub fn sweep_scratch(root: &Path, now_ms: u64) {
    let mut directories = vec![root.to_path_buf()];
    while let Some(directory) = directories.pop() {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name();
            if kind.is_dir() && !name.eq_ignore_ascii_case(PRIVATE_DIRECTORY) {
                directories.push(entry.path());
                continue;
            }
            let stale = name
                .to_str()
                .and_then(unfinished_name)
                .is_some_and(|scratch| is_stale_scratch(scratch, now_ms));
            if kind.is_file() && stale {
                let _ = fs::remove_file(entry.path());
            }
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
