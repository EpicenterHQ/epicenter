//! Ordinary files in a native folder.
//!
//! The Rust owner's counterpart of the folder engine's directory file storage
//! (`packages/folder/src/directory-handle.ts`). Current files are the source. A replacement hashes the
//! current bytes and replaces them only when they match the SHA-256 the caller
//! captured; this is a best-effort check, not an operating-system-wide
//! compare-and-swap against other programs. Creation and moves use hard links,
//! which fail rather than overwrite an existing destination. A write stages
//! its bytes in a scratch file under `.git/epicenter/scratch` first.
//!
//! A replacement checks the expected hash again, then exchanges the scratch
//! file with the file at the path in one system call (`files/exchange.rs`).
//! The exchange requires the file to exist at that moment, so a replacement
//! never puts back a file another program removed, however late the removal:
//! the outcome is `NotFound`, or `Conflict` when a hash was expected. Bytes
//! another program wrote between the second check and the exchange are still
//! displaced. Apple platforms, Linux, and Android exchange; a filesystem
//! there that cannot is an `Io` failure and nothing is written. An overwrite
//! renames on every platform; it may create the file.
//!
//! The exchange is the only operation on the path. What it displaced lands
//! in scratch: a regular file is removed. Anything else (a directory, a
//! link, a pipe, or an entry that cannot be inspected) is kept where it is,
//! and the outcome is a `Partial` whose write is both applied and failed,
//! with an `Io` error naming where the entry was kept. Nothing tries to put
//! it back: by then the path may hold a third program's bytes.
//!
//! Windows, and every other target without an exchange, has no replacement
//! here until a mechanism that requires the file at publication is proven:
//! the exchange fails as `Unsupported` before touching either path, the
//! staged copy is removed, and the outcome is an `Io` failure naming the
//! platform, with nothing written. Nothing retries it. Creation, reads,
//! overwrites, moves, and removals are unchanged by this repair; none is
//! verified on Windows. Whether
//! this crate builds or runs for Windows has not been checked here.
//!
//! A multi-file batch applies ordered steps. When a step fails, the result
//! reports which steps reached the folder; nothing is rolled back.
//!
//! Nothing here serializes batches. The folder owner applies one batch at a
//! time, so every window's saves check against what the previous one left.

use std::fs;
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;

use crate::paths::{ancestors, path_problem};

#[cfg(all(test, unix))]
mod entries_tests;
mod exchange;

#[cfg(test)]
thread_local! {
    /// Runs just before a read opens the path it inspected, on the reading
    /// thread, with that absolute path: another program's swap.
    pub(crate) static BEFORE_READ: std::cell::RefCell<Option<Box<dyn Fn(&Path)>>> =
        std::cell::RefCell::new(None);
    /// Runs just before a replacement's exchange, on the thread applying it,
    /// with the absolute path it replaces: another program's last move.
    pub(crate) static BEFORE_EXCHANGE: std::cell::RefCell<Option<Box<dyn Fn(&Path)>>> =
        std::cell::RefCell::new(None);
    /// Runs just after a replacement's exchange succeeded, the same way.
    pub(crate) static AFTER_EXCHANGE: std::cell::RefCell<Option<Box<dyn Fn(&Path)>>> =
        std::cell::RefCell::new(None);
}

/// Lowercase hex SHA-256 of one file's exact bytes. Always computed here from
/// bytes, never accepted from a caller as the hash of new content.
pub fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct FileRead {
    pub bytes: Vec<u8>,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct ListedFile {
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Type)]
pub struct FileListing {
    /// Every entry that is not a directory, including files outside portable
    /// scope, symbolic links, and special entries, none of them followed. A
    /// read refuses what is not a regular file.
    pub files: Vec<ListedFile>,
    /// Every directory, including empty ones.
    pub directories: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Type)]
pub struct Children {
    pub files: Vec<String>,
    pub directories: Vec<String>,
}

/// One ordered step. `expected_sha256` is the hash the caller captured from a
/// read. The hash of new bytes is computed here, never accepted from the
/// caller.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileChange {
    /// Exclusive creation: the path must be absent.
    Create { path: String, bytes: Vec<u8> },
    /// The path must hold a file: a replacement never creates one. With
    /// `expected_sha256`, the current bytes must also hash to it.
    #[serde(rename_all = "camelCase")]
    Replace {
        path: String,
        bytes: Vec<u8>,
        #[serde(default)]
        expected_sha256: Option<String>,
    },
    /// A deliberate overwrite, whether or not the path holds a file.
    Overwrite { path: String, bytes: Vec<u8> },
    /// The file must exist. Without `expected_sha256` the removal is a
    /// deliberate unguarded one.
    #[serde(rename_all = "camelCase")]
    Remove {
        path: String,
        #[serde(default)]
        expected_sha256: Option<String>,
    },
    /// Moves exact bytes. The source must exist and the destination must be
    /// absent. Without `expected_sha256` the source bytes are not checked.
    #[serde(rename_all = "camelCase")]
    Move {
        from: String,
        to: String,
        #[serde(default)]
        expected_sha256: Option<String>,
    },
}

impl FileChange {
    fn paths(&self) -> Vec<&str> {
        match self {
            Self::Create { path, .. }
            | Self::Replace { path, .. }
            | Self::Overwrite { path, .. }
            | Self::Remove { path, .. } => vec![path],
            Self::Move { from, to, .. } => vec![from, to],
        }
    }

    /// The landed action this change reports: every kind of write is a write.
    pub fn step(&self) -> FileStep {
        match self {
            Self::Create { path, .. }
            | Self::Replace { path, .. }
            | Self::Overwrite { path, .. } => FileStep::Write { path: path.clone() },
            Self::Remove { path, .. } => FileStep::Remove { path: path.clone() },
            Self::Move { from, to, .. } => FileStep::Move {
                from: from.clone(),
                to: to.clone(),
            },
        }
    }
}

/// A step that reached, or failed to reach, the folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileStep {
    Write { path: String },
    Remove { path: String },
    Move { from: String, to: String },
}

impl FileStep {
    /// Every path this step touched.
    pub fn paths(&self) -> Vec<&str> {
        match self {
            Self::Write { path } | Self::Remove { path } => vec![path],
            Self::Move { from, to } => vec![from, to],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "name")]
pub enum FileError {
    InvalidPath {
        path: String,
        reason: String,
    },
    NotFound {
        path: String,
    },
    /// A creation target or a move destination already holds a file.
    Exists {
        path: String,
    },
    /// The current bytes do not hash to what the caller captured. A missing
    /// replace target has no `actual_sha256`.
    #[serde(rename_all = "camelCase")]
    Conflict {
        path: String,
        expected_sha256: String,
        actual_sha256: Option<String>,
    },
    NotAFile {
        path: String,
    },
    NotADirectory {
        path: String,
    },
    DirectoryNotEmpty {
        path: String,
    },
    Io {
        path: String,
        operation: String,
        cause: String,
    },
    Closed,
    /// The operation started and its outcome is unknown: it may have reached
    /// the folder. Look before trying again.
    Unconfirmed {
        path: String,
        operation: String,
        cause: String,
    },
    /// The caller has no session for this folder, or names another window's.
    Denied {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "name")]
pub enum ApplyError {
    /// A refusal before anything landed: nothing was written.
    Refused { error: FileError },
    /// The batch stopped partway. `applied` steps reached the folder; nothing
    /// was rolled back. `failed` did not complete, `notAttempted` never started.
    /// `failed` may be the rest of a step in `applied`: a move's source
    /// removal after its destination landed, or a replacement whose bytes
    /// landed but whose displaced entry was kept, the same write in both.
    #[serde(rename_all = "camelCase")]
    Partial {
        applied: Vec<FileStep>,
        failed: FileStep,
        error: FileError,
        not_attempted: Vec<FileStep>,
    },
    /// The batch started and its outcome is unknown: any of its steps may
    /// have reached the folder. Look before trying again.
    Unconfirmed {
        path: String,
        operation: String,
        cause: String,
    },
}

/// What occupies one literal path, as an incoming update sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Entry {
    Absent,
    File,
    Directory,
    /// Something no update writes to: another spelling of an existing entry,
    /// a symbolic link on the way, or a special file.
    Other(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Kind {
    File,
    Directory,
    Absent,
    /// No entry has the path's literal spelling, but the filesystem resolves
    /// that spelling to an entry of another name, as a case-insensitive or
    /// normalizing filesystem does. A read finds nothing at such a spelling;
    /// a change is refused.
    Aliased(Alias),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Alias {
    /// The existing entry's own spelling, from the root down to it, where it
    /// can be found.
    existing: Option<String>,
    /// Whether the path itself is the alias, rather than one of its
    /// directories.
    leaf: bool,
}

/// A change refused because its path, or a directory on the way, is another
/// spelling of an entry that exists.
fn aliased(path: &str, alias: &Alias) -> FileError {
    FileError::InvalidPath {
        path: path.to_string(),
        reason: match &alias.existing {
            Some(existing) => format!(
                "this filesystem resolves it to the existing '{existing}', which is spelled differently"
            ),
            None => "this filesystem resolves it to an existing entry spelled differently"
                .to_string(),
        },
    }
}

/// The name in `directory` of the entry `found` describes, for an alias
/// message. Unix identifies an entry by device and inode; elsewhere the name
/// is not looked for.
#[cfg(unix)]
fn spelled_as(directory: &Path, found: &fs::Metadata) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    fs::read_dir(directory).ok()?.flatten().find_map(|entry| {
        let stats = entry.metadata().ok()?;
        if stats.dev() == found.dev() && stats.ino() == found.ino() {
            entry.file_name().to_str().map(str::to_string)
        } else {
            None
        }
    })
}

#[cfg(not(unix))]
fn spelled_as(_directory: &Path, _found: &fs::Metadata) -> Option<String> {
    None
}

fn io(path: &str, operation: &str, cause: &io::Error) -> FileError {
    FileError::Io {
        path: path.to_string(),
        operation: operation.to_string(),
        cause: cause.to_string(),
    }
}

/// What a directory entry that is not a regular file is, for a message.
/// Only a successful exchange displaces an entry, so only targets with an
/// exchange (all Unix) ever inspect one; elsewhere this compiles unused in
/// practice and names only what the standard library can tell.
fn entry_kind(found: &fs::Metadata) -> &'static str {
    let kind = found.file_type();
    if kind.is_dir() {
        return "a directory";
    }
    if kind.is_symlink() {
        return "a symbolic link";
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        if kind.is_fifo() {
            return "a named pipe";
        }
        if kind.is_socket() {
            return "a socket";
        }
    }
    "a special file"
}

/// Open a file for reading without following a final symbolic link and
/// without waiting for a pipe's writer. Elsewhere, the standard open.
#[cfg(unix)]
fn open_unfollowed(path: &Path) -> io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
}

#[cfg(not(unix))]
fn open_unfollowed(path: &Path) -> io::Result<fs::File> {
    fs::File::open(path)
}

/// Whether an open failed because `O_NOFOLLOW` met a symbolic link.
fn is_link_refusal(cause: &io::Error) -> bool {
    #[cfg(unix)]
    {
        cause.raw_os_error() == Some(libc::ELOOP)
    }
    #[cfg(not(unix))]
    {
        let _ = cause;
        false
    }
}

fn invalid(path: &str) -> Result<(), FileError> {
    match path_problem(path) {
        None => Ok(()),
        Some(reason) => Err(FileError::InvalidPath {
            path: path.to_string(),
            reason: reason.to_string(),
        }),
    }
}

static SCRATCH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// File operations under one canonical root.
#[derive(Debug, Clone)]
pub struct Files {
    root: PathBuf,
    scratch: PathBuf,
}

impl Files {
    /// `root` is already canonical and its private Git layout verified.
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            scratch: root.join(".git").join("epicenter").join("scratch"),
        }
    }

    pub fn absolute(&self, path: &str) -> PathBuf {
        let mut absolute = self.root.clone();
        absolute.extend(path.split('/'));
        absolute
    }

    /// Verify each component's literal spelling and that nothing on the way is
    /// a symbolic link, so a case-insensitive filesystem cannot alias another
    /// name and a link cannot escape the folder. A component no entry spells
    /// exactly, but which the filesystem still resolves, is `Aliased`: the
    /// path is not absent there, it names another entry.
    fn verify_literal(&self, path: &str) -> Result<Kind, FileError> {
        let parts: Vec<&str> = path.split('/').collect();
        let mut directory = self.root.clone();
        for (index, name) in parts.iter().enumerate() {
            let entries = match fs::read_dir(&directory) {
                Ok(entries) => entries,
                Err(cause) if cause.kind() == ErrorKind::NotFound => return Ok(Kind::Absent),
                Err(cause) if cause.kind() == ErrorKind::NotADirectory => {
                    return Err(FileError::NotADirectory {
                        path: parts[..index].join("/"),
                    })
                }
                Err(cause) => return Err(io(path, "list the directory of", &cause)),
            };
            let mut spelled = false;
            let mut undecodable = false;
            for entry in entries {
                let entry = entry.map_err(|cause| io(path, "list the directory of", &cause))?;
                let found = entry.file_name();
                match found.to_str() {
                    Some(found) if found == *name => {
                        spelled = true;
                        break;
                    }
                    Some(_) => {}
                    // A listing spells this entry lossily; that spelling names
                    // no file, so a read must not report it absent.
                    None => undecodable |= found.to_string_lossy() == *name,
                }
            }
            if !spelled && undecodable {
                return Err(FileError::InvalidPath {
                    path: path.to_string(),
                    reason: "the name on disk is not UTF-8, so no folder path names it".to_string(),
                });
            }
            if !spelled {
                return match fs::symlink_metadata(directory.join(name)) {
                    Ok(found) => Ok(Kind::Aliased(Alias {
                        existing: spelled_as(&directory, &found).map(|existing| {
                            parts[..index]
                                .iter()
                                .copied()
                                .chain([existing.as_str()])
                                .collect::<Vec<_>>()
                                .join("/")
                        }),
                        leaf: index == parts.len() - 1,
                    })),
                    Err(cause) if cause.kind() == ErrorKind::NotFound => Ok(Kind::Absent),
                    Err(cause) => Err(io(path, "inspect", &cause)),
                };
            }
            let next = directory.join(name);
            let stats = match fs::symlink_metadata(&next) {
                Ok(stats) => stats,
                Err(cause) if cause.kind() == ErrorKind::NotFound => return Ok(Kind::Absent),
                Err(cause) => return Err(io(path, "inspect", &cause)),
            };
            let kind = stats.file_type();
            if kind.is_symlink() {
                return Err(FileError::InvalidPath {
                    path: path.to_string(),
                    reason: "the path passes through a symbolic link".to_string(),
                });
            }
            if index == parts.len() - 1 {
                if kind.is_dir() {
                    return Ok(Kind::Directory);
                }
                if kind.is_file() {
                    return Ok(Kind::File);
                }
                // A device, socket, or pipe: reading it could block forever.
                return Err(FileError::InvalidPath {
                    path: path.to_string(),
                    reason: "the path is not a regular file".to_string(),
                });
            }
            if !kind.is_dir() {
                return Err(FileError::NotADirectory {
                    path: parts[..=index].join("/"),
                });
            }
            directory = next;
        }
        Ok(Kind::Absent)
    }

    /// What a change finds at `path`. Another spelling of an existing entry,
    /// at the path or on the way to it, is refused before anything is
    /// written: the change would land on that entry under its own name.
    fn changeable(&self, path: &str) -> Result<Kind, FileError> {
        match self.verify_literal(path)? {
            Kind::Aliased(alias) => Err(aliased(path, &alias)),
            kind => Ok(kind),
        }
    }

    /// Like `changeable`, for a path that must be unoccupied: another
    /// spelling of an existing entry at the path itself occupies it.
    fn vacant_or_occupied(&self, path: &str) -> Result<Kind, FileError> {
        match self.verify_literal(path)? {
            Kind::Aliased(Alias { leaf: true, .. }) => Err(Self::exists(path)),
            Kind::Aliased(alias) => Err(aliased(path, &alias)),
            kind => Ok(kind),
        }
    }

    /// The bytes at exactly this spelling. Another spelling's entry is not
    /// this path's, so a read finds nothing there.
    fn read_current(&self, path: &str) -> Result<Option<FileRead>, FileError> {
        match self.verify_literal(path)? {
            Kind::Absent | Kind::Aliased(_) => return Ok(None),
            Kind::Directory => {
                return Err(FileError::NotAFile {
                    path: path.to_string(),
                })
            }
            Kind::File => {}
        }
        let absolute = self.absolute(path);
        #[cfg(test)]
        BEFORE_READ.with(|hook| {
            if let Some(hook) = hook.borrow().as_ref() {
                hook(&absolute);
            }
        });
        // Another program may have put a link or a pipe here since it was
        // inspected. The open neither follows the one nor waits on the other,
        // and the opened entry is checked again.
        let refused = |reason: &str| FileError::InvalidPath {
            path: path.to_string(),
            reason: reason.to_string(),
        };
        let mut file = match open_unfollowed(&absolute) {
            Ok(file) => file,
            Err(cause) if cause.kind() == ErrorKind::NotFound => return Ok(None),
            Err(cause) if is_link_refusal(&cause) => {
                return Err(refused("the path passes through a symbolic link"))
            }
            Err(cause) => return Err(io(path, "read", &cause)),
        };
        match file.metadata() {
            Ok(found) if found.is_file() => {}
            Ok(_) => return Err(refused("the path is not a regular file")),
            Err(cause) => return Err(io(path, "read", &cause)),
        }
        let mut bytes = Vec::new();
        if let Err(cause) = io::Read::read_to_end(&mut file, &mut bytes) {
            return Err(io(path, "read", &cause));
        }
        let sha256 = sha256(&bytes);
        Ok(Some(FileRead { bytes, sha256 }))
    }

    fn current_sha256(&self, path: &str) -> Result<Option<String>, FileError> {
        Ok(self.read_current(path)?.map(|read| read.sha256))
    }

    fn ensure_parent(&self, path: &str) -> Result<(), FileError> {
        for parent in ancestors(path) {
            match self.verify_literal(parent)? {
                // Creating it would put this path inside the other spelling.
                Kind::Aliased(alias) => return Err(aliased(parent, &alias)),
                Kind::Directory => {}
                Kind::File => {
                    return Err(FileError::NotADirectory {
                        path: parent.to_string(),
                    })
                }
                Kind::Absent => match fs::create_dir(self.absolute(parent)) {
                    Ok(()) => {}
                    Err(cause) if cause.kind() == ErrorKind::AlreadyExists => {}
                    Err(cause) => return Err(io(parent, "create", &cause)),
                },
            }
        }
        Ok(())
    }

    fn scratch_file(&self, bytes: &[u8]) -> io::Result<PathBuf> {
        fs::create_dir_all(&self.scratch)?;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let file = self.scratch.join(format!(
            "{nanos:x}-{}-{}",
            std::process::id(),
            SCRATCH_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let mut handle = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&file)?;
        if let Err(cause) = handle.write_all(bytes) {
            let _ = fs::remove_file(&file);
            return Err(cause);
        }
        Ok(file)
    }

    /// Refuse unless the bytes found hash to what the caller captured.
    fn expect(path: &str, expected: &str, actual: Option<String>) -> Result<(), FileError> {
        if actual.as_deref() == Some(expected) {
            return Ok(());
        }
        Err(FileError::Conflict {
            path: path.to_string(),
            expected_sha256: expected.to_string(),
            actual_sha256: actual,
        })
    }

    fn exists(path: &str) -> FileError {
        FileError::Exists {
            path: path.to_string(),
        }
    }

    /// Stage the bytes in scratch, publish them with `publish`, and drop the
    /// scratch file whichever way that went: the staged bytes, or nothing
    /// after a rename. A replacement settles its scratch file itself.
    fn stage(
        &self,
        path: &str,
        bytes: &[u8],
        publish: impl FnOnce(&Path) -> Result<(), FileError>,
    ) -> Result<(), FileError> {
        let temporary = self
            .scratch_file(bytes)
            .map_err(|cause| io(path, "stage bytes for", &cause))?;
        let published = publish(&temporary);
        let _ = fs::remove_file(&temporary);
        published
    }

    fn create(&self, path: &str, bytes: &[u8]) -> Result<(), FileError> {
        self.vacant_or_occupied(path)?;
        if self.read_current(path)?.is_some() {
            return Err(Self::exists(path));
        }
        self.ensure_parent(path)?;
        self.stage(path, bytes, |temporary| {
            // Exclusive creation: a link fails instead of replacing a newcomer.
            match fs::hard_link(temporary, self.absolute(path)) {
                Ok(()) => Ok(()),
                Err(cause) if cause.kind() == ErrorKind::AlreadyExists => Err(Self::exists(path)),
                Err(cause) => Err(io(path, "create", &cause)),
            }
        })
    }

    /// Refuse a replacement unless a file is at the path and, when the caller
    /// captured a hash, its bytes hash to it.
    fn replaceable(
        path: &str,
        expected: Option<&str>,
        actual: Option<String>,
    ) -> Result<(), FileError> {
        match expected {
            Some(expected) => Self::expect(path, expected, actual),
            None if actual.is_none() => Err(FileError::NotFound {
                path: path.to_string(),
            }),
            None => Ok(()),
        }
    }

    /// When the bytes land but what they displaced is kept, `landed` receives
    /// the write so the caller reports it instead of an ordinary error.
    fn replace(
        &self,
        path: &str,
        bytes: &[u8],
        expected: Option<&str>,
        landed: &mut Vec<FileStep>,
    ) -> Result<(), FileError> {
        self.changeable(path)?;
        Self::replaceable(path, expected, self.current_sha256(path)?)?;
        // The file, and so its parent, was just found: no parent is created,
        // which would only leave an empty directory behind if it went since.
        let temporary = self
            .scratch_file(bytes)
            .map_err(|cause| io(path, "stage bytes for", &cause))?;
        // Staging took time. Check again so the only unchecked window left is
        // this read to the exchange.
        let checked = self
            .current_sha256(path)
            .and_then(|actual| Self::replaceable(path, expected, actual));
        if let Err(error) = checked {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        self.publish_replacement(path, expected, &temporary, landed)
    }

    /// Put the staged file at `path` only if a file is there when it lands,
    /// and settle `temporary`. Until the one exchange succeeds it holds the
    /// staged bytes, removed on any failure. After it the write has landed
    /// and `temporary` holds whatever the path held: a regular file is
    /// removed; anything else, or an entry that cannot be inspected, stays
    /// exactly there, `landed` receives the write, and the `Io` error names
    /// where it is. Nothing touches the path again: another program may
    /// already have written there since.
    ///
    /// This is the only way a replacement publishes, on every target. Where
    /// there is no exchange, Windows included, the exchange fails before
    /// touching either path, the staged copy is removed, and the outcome is
    /// `Io` with nothing written.
    fn publish_replacement(
        &self,
        path: &str,
        expected: Option<&str>,
        temporary: &Path,
        landed: &mut Vec<FileStep>,
    ) -> Result<(), FileError> {
        let target = self.absolute(path);
        #[cfg(test)]
        BEFORE_EXCHANGE.with(|hook| {
            if let Some(hook) = hook.borrow().as_ref() {
                hook(&target);
            }
        });
        if let Err(cause) = exchange::exchange(temporary, &target) {
            // Nothing was exchanged: `temporary` holds only the staged bytes.
            let missing = cause.kind() == ErrorKind::NotFound;
            let staged = missing && fs::symlink_metadata(temporary).is_ok();
            let _ = fs::remove_file(temporary);
            if !missing {
                return Err(io(path, "replace", &cause));
            }
            // Either path may be the missing one; the staged file never moves.
            if !staged {
                return Err(io(path, "stage bytes for", &cause));
            }
            return Self::replaceable(path, expected, None);
        }
        #[cfg(test)]
        AFTER_EXCHANGE.with(|hook| {
            if let Some(hook) = hook.borrow().as_ref() {
                hook(&target);
            }
        });
        let found = match fs::symlink_metadata(temporary) {
            Ok(found) if found.file_type().is_file() => {
                let _ = fs::remove_file(temporary);
                return Ok(());
            }
            Ok(found) => format!("is {}, not a regular file", entry_kind(&found)),
            Err(cause) => format!("could not be inspected ({cause})"),
        };
        landed.push(FileStep::Write {
            path: path.to_string(),
        });
        Err(FileError::Io {
            path: path.to_string(),
            operation: "set aside what the replacement displaced from".to_string(),
            cause: format!(
                "The new bytes landed at '{path}', so the file there changed. What they displaced {found}, and it was left at '{}'. Inspect '{path}', and anything written there since, before restoring it.",
                temporary.display()
            ),
        })
    }

    fn overwrite(&self, path: &str, bytes: &[u8]) -> Result<(), FileError> {
        // A directory, a link, or another spelling at the path is refused; a
        // file there is replaced.
        self.changeable(path)?;
        self.read_current(path)?;
        self.ensure_parent(path)?;
        // A deliberate overwrite: create or replace, whatever is there.
        self.stage(path, bytes, |temporary| {
            fs::rename(temporary, self.absolute(path)).map_err(|cause| io(path, "replace", &cause))
        })
    }

    fn remove(&self, path: &str, expected: Option<&str>) -> Result<(), FileError> {
        let not_found = || FileError::NotFound {
            path: path.to_string(),
        };
        self.changeable(path)?;
        let found = self.current_sha256(path)?.ok_or_else(not_found)?;
        if let Some(expected) = expected {
            Self::expect(path, expected, Some(found))?;
        }
        match fs::remove_file(self.absolute(path)) {
            Ok(()) => Ok(()),
            Err(cause) if cause.kind() == ErrorKind::NotFound => Err(not_found()),
            Err(cause) => Err(io(path, "remove", &cause)),
        }
    }

    /// A move is two filesystem steps. When the destination link lands but
    /// retiring the source fails, `landed` receives the destination write so
    /// the caller reports it instead of an ordinary error.
    fn rename(
        &self,
        from: &str,
        to: &str,
        expected: Option<&str>,
        landed: &mut Vec<FileStep>,
    ) -> Result<(), FileError> {
        self.changeable(from)?;
        let found = self.current_sha256(from)?.ok_or(FileError::NotFound {
            path: from.to_string(),
        })?;
        if let Some(expected) = expected {
            Self::expect(from, expected, Some(found))?;
        }
        match self.vacant_or_occupied(to)? {
            Kind::Directory => {
                return Err(FileError::NotAFile {
                    path: to.to_string(),
                })
            }
            Kind::File => return Err(Self::exists(to)),
            // Another spelling there was refused as occupied above.
            Kind::Absent | Kind::Aliased(_) => {}
        }
        self.ensure_parent(to)?;
        if let Some(expected) = expected {
            // The destination checks took time; the link must carry the bytes checked.
            Self::expect(from, expected, self.current_sha256(from)?)?;
        }
        match fs::hard_link(self.absolute(from), self.absolute(to)) {
            Ok(()) => {}
            Err(cause) if cause.kind() == ErrorKind::AlreadyExists => {
                return Err(Self::exists(to));
            }
            Err(cause) => return Err(io(to, "move to", &cause)),
        }
        landed.push(FileStep::Write {
            path: to.to_string(),
        });
        // Both paths now hold the bytes; nothing is rolled back if this fails.
        fs::remove_file(self.absolute(from)).map_err(|cause| io(from, "retire", &cause))
    }

    fn step(&self, change: &FileChange, landed: &mut Vec<FileStep>) -> Result<(), FileError> {
        match change {
            FileChange::Create { path, bytes } => self.create(path, bytes),
            FileChange::Replace {
                path,
                bytes,
                expected_sha256,
            } => self.replace(path, bytes, expected_sha256.as_deref(), landed),
            FileChange::Overwrite { path, bytes } => self.overwrite(path, bytes),
            FileChange::Remove {
                path,
                expected_sha256,
            } => self.remove(path, expected_sha256.as_deref()),
            FileChange::Move {
                from,
                to,
                expected_sha256,
            } => self.rename(from, to, expected_sha256.as_deref(), landed),
        }
    }

    /// Refuse a batch naming any unusable path before one step runs.
    pub fn validate(changes: &[FileChange]) -> Result<(), FileError> {
        for change in changes {
            for path in change.paths() {
                invalid(path)?;
            }
        }
        Ok(())
    }

    /// Apply ordered steps. The caller holds the owner's file gate, so the
    /// steps run with no other batch of this owner between them.
    pub fn apply(&self, changes: &[FileChange]) -> Result<(), ApplyError> {
        Self::validate(changes).map_err(|error| ApplyError::Refused { error })?;
        let mut applied: Vec<FileStep> = Vec::new();
        for (index, change) in changes.iter().enumerate() {
            let mut landed = Vec::new();
            match self.step(change, &mut landed) {
                Ok(()) => applied.push(change.step()),
                Err(error) => {
                    // A move whose destination landed failed at retiring its source.
                    // A replacement whose bytes landed failed at settling what
                    // they displaced: its write is both applied and failed.
                    let failed = match change {
                        FileChange::Move { from, .. } if !landed.is_empty() => {
                            FileStep::Remove { path: from.clone() }
                        }
                        other => other.step(),
                    };
                    applied.extend(landed);
                    if applied.is_empty() {
                        return Err(ApplyError::Refused { error });
                    }
                    return Err(ApplyError::Partial {
                        applied,
                        failed,
                        error,
                        not_attempted: changes[index + 1..].iter().map(FileChange::step).collect(),
                    });
                }
            }
        }
        Ok(())
    }

    pub fn list(&self) -> Result<FileListing, FileError> {
        let mut listing = FileListing::default();
        let mut pending = vec![(self.root.clone(), String::new())];
        while let Some((directory, prefix)) = pending.pop() {
            let enumerate = |cause: io::Error| io("", "enumerate", &cause);
            for entry in fs::read_dir(&directory).map_err(enumerate)? {
                let entry = entry.map_err(enumerate)?;
                // A name that is not UTF-8 is listed by its lossy spelling,
                // which a read refuses.
                let name = entry.file_name().to_string_lossy().into_owned();
                if prefix.is_empty() && name == ".git" {
                    continue;
                }
                let path = format!("{prefix}{name}");
                let kind = entry.file_type().map_err(enumerate)?;
                if kind.is_dir() {
                    pending.push((entry.path(), format!("{path}/")));
                    listing.directories.push(path);
                } else {
                    // A link or special entry is listed so a read can refuse
                    // it; its size is its own, never its target's.
                    let size = entry.metadata().map_err(enumerate)?.len();
                    listing.files.push(ListedFile { path, size });
                }
            }
        }
        listing.files.sort_by(|a, b| a.path.cmp(&b.path));
        listing.directories.sort();
        Ok(listing)
    }

    pub fn children(&self, directory: &str) -> Result<Children, FileError> {
        if !directory.is_empty() {
            invalid(directory)?;
            match self.verify_literal(directory)? {
                Kind::Directory => {}
                Kind::Absent | Kind::Aliased(_) => {
                    return Err(FileError::NotFound {
                        path: directory.to_string(),
                    })
                }
                Kind::File => {
                    return Err(FileError::NotADirectory {
                        path: directory.to_string(),
                    })
                }
            }
        }
        let target = if directory.is_empty() {
            self.root.clone()
        } else {
            self.absolute(directory)
        };
        let list = |cause: io::Error| io(directory, "list", &cause);
        let mut children = Children::default();
        for entry in fs::read_dir(target).map_err(list)? {
            let entry = entry.map_err(list)?;
            // A name that is not UTF-8 is listed by its lossy spelling, and a
            // link or special entry is listed, so a read can refuse either.
            let name = entry.file_name().to_string_lossy().into_owned();
            if directory.is_empty() && name == ".git" {
                continue;
            }
            if entry.file_type().map_err(list)?.is_dir() {
                children.directories.push(name);
            } else {
                children.files.push(name);
            }
        }
        children.files.sort();
        children.directories.sort();
        Ok(children)
    }

    /// What is at exactly this spelling, for an incoming update's checks. A
    /// path below a file is absent; it cannot exist while the file does.
    pub(crate) fn entry(&self, path: &str) -> Result<Entry, FileError> {
        match self.verify_literal(path) {
            Ok(Kind::Absent) | Err(FileError::NotADirectory { .. }) => Ok(Entry::Absent),
            Ok(Kind::File) => Ok(Entry::File),
            Ok(Kind::Directory) => Ok(Entry::Directory),
            Ok(Kind::Aliased(alias)) => Ok(Entry::Other(match aliased(path, &alias) {
                FileError::InvalidPath { reason, .. } => reason,
                other => format!("{other:?}"),
            })),
            Err(FileError::InvalidPath { reason, .. }) => Ok(Entry::Other(reason)),
            Err(error) => Err(error),
        }
    }

    /// Every entry below `directory`, as folder paths: what is not a
    /// directory, and the directories, deepest first.
    pub(crate) fn beneath(&self, directory: &str) -> Result<(Vec<String>, Vec<String>), FileError> {
        let mut others = Vec::new();
        let mut directories = Vec::new();
        let mut pending = vec![directory.to_string()];
        while let Some(current) = pending.pop() {
            let list = |cause: io::Error| io(&current, "list", &cause);
            for entry in fs::read_dir(self.absolute(&current)).map_err(list)? {
                let entry = entry.map_err(list)?;
                let name = entry.file_name().to_string_lossy().into_owned();
                let path = format!("{current}/{name}");
                if entry.file_type().map_err(list)?.is_dir() {
                    directories.push(path.clone());
                    pending.push(path);
                } else {
                    others.push(path);
                }
            }
        }
        directories.sort_by_key(|path| std::cmp::Reverse(path.matches('/').count()));
        others.sort();
        Ok((others, directories))
    }

    pub fn read(&self, path: &str) -> Result<FileRead, FileError> {
        invalid(path)?;
        self.read_current(path)?.ok_or(FileError::NotFound {
            path: path.to_string(),
        })
    }

    pub fn mkdir(&self, path: &str) -> Result<(), FileError> {
        invalid(path)?;
        self.ensure_parent(&format!("{path}/x"))
    }

    pub fn rmdir(&self, path: &str) -> Result<(), FileError> {
        invalid(path)?;
        match self.changeable(path)? {
            Kind::Directory => {}
            // Another spelling was refused above.
            Kind::Absent | Kind::Aliased(_) => {
                return Err(FileError::NotFound {
                    path: path.to_string(),
                })
            }
            Kind::File => {
                return Err(FileError::NotADirectory {
                    path: path.to_string(),
                })
            }
        }
        match fs::remove_dir(self.absolute(path)) {
            Ok(()) => Ok(()),
            Err(cause)
                if matches!(
                    cause.kind(),
                    ErrorKind::DirectoryNotEmpty | ErrorKind::AlreadyExists
                ) =>
            {
                Err(FileError::DirectoryNotEmpty {
                    path: path.to_string(),
                })
            }
            Err(cause) => Err(io(path, "remove directory", &cause)),
        }
    }
}

/// Resolve the folder root once, refusing a path that is not a directory.
pub fn resolve_root(root: &Path) -> Result<PathBuf, String> {
    let resolved = fs::canonicalize(root).map_err(|cause| {
        format!(
            "The native folder root '{}' could not be resolved: {cause}",
            root.display()
        )
    })?;
    if !resolved.is_dir() {
        return Err(format!(
            "The native folder root '{}' is not a directory.",
            root.display()
        ));
    }
    Ok(resolved)
}

/// Refuse a root whose private Git state would send writes somewhere else:
/// `.git` as a symbolic link or a `gitdir:` file (a linked worktree or
/// submodule), and a linked `.git/epicenter` or scratch directory. Scratch
/// files are renamed into the folder, so they must live inside it.
///
/// This inspects the layout once, when the folder opens. It does not defend
/// against a program that swaps a link in afterward.
pub fn verify_layout(root: &Path) -> Result<(), String> {
    let mut current = root.to_path_buf();
    for (name, label) in [
        (".git", ".git"),
        ("epicenter", ".git/epicenter"),
        ("scratch", ".git/epicenter/scratch"),
    ] {
        current.push(name);
        let stats = match fs::symlink_metadata(&current) {
            Ok(stats) => stats,
            // Nothing below an absent directory exists yet; opening creates it.
            Err(cause) if cause.kind() == ErrorKind::NotFound => return Ok(()),
            Err(cause) => {
                return Err(format!(
                "The native folder '{}' cannot be opened: {label} could not be inspected: {cause}",
                root.display()
            ))
            }
        };
        let kind = stats.file_type();
        if kind.is_symlink() {
            return Err(format!(
                "The native folder '{}' cannot be opened: {label} is a symbolic link.",
                root.display()
            ));
        }
        if !kind.is_dir() {
            return Err(if name == ".git" {
                format!(
                    "The native folder '{}' cannot be opened: .git is a file that points at another Git directory.",
                    root.display()
                )
            } else {
                format!(
                    "The native folder '{}' cannot be opened: {label} is not a directory.",
                    root.display()
                )
            });
        }
    }
    Ok(())
}

/// Whether `root` already holds a Git repository of its own: a real `.git`
/// directory with `HEAD`, `objects`, and `refs`, as `git init`, `git clone`,
/// and a download leave it. An unborn branch counts; an empty or partial
/// `.git`, or none, does not. A link at `.git` is not a repository here
/// (`verify_layout` refuses it with its own reason). This reads directory
/// entries only; it is not a repository check beyond that.
pub fn has_repository(root: &Path) -> Result<bool, String> {
    let inspect = |path: &Path| match fs::symlink_metadata(path) {
        Ok(stats) => Ok(Some(stats.file_type())),
        Err(cause) if cause.kind() == ErrorKind::NotFound => Ok(None),
        Err(cause) => Err(format!(
            "{} could not be inspected: {cause}",
            path.display()
        )),
    };
    let git = root.join(".git");
    if !inspect(&git)?.is_some_and(|kind| kind.is_dir()) {
        return Ok(false);
    }
    Ok(
        inspect(&git.join("HEAD"))?.is_some_and(|kind| kind.is_file())
            && inspect(&git.join("objects"))?.is_some_and(|kind| kind.is_dir())
            && inspect(&git.join("refs"))?.is_some_and(|kind| kind.is_dir()),
    )
}

/// Where the cross-process lock for a canonical root lives: a sibling, outside
/// the folder's files. The same file the Bun hosts lock (`root-lock.ts`).
pub fn lock_path(root: &Path) -> Result<PathBuf, String> {
    let (Some(parent), Some(name)) = (root.parent(), root.file_name()) else {
        return Err(format!(
            "The folder at {} has no parent directory to hold its lock.",
            root.display()
        ));
    };
    let mut file = std::ffi::OsString::from(".");
    file.push(name);
    file.push(".epicenter-lock");
    Ok(parent.join(file))
}

/// Refuse a lock path that is a symbolic link or anything other than a regular
/// file, before it is opened, so the lock is never taken on a database
/// somewhere else. Checked once; it does not defend against a later swap.
pub fn verify_lock_path(root: &Path) -> Result<PathBuf, String> {
    let path = lock_path(root)?;
    match fs::symlink_metadata(&path) {
        Err(cause) if cause.kind() == ErrorKind::NotFound => Ok(path),
        Err(cause) => Err(format!(
            "The folder at {} could not be locked: {} could not be inspected: {cause}",
            root.display(),
            path.display()
        )),
        Ok(stats) if stats.file_type().is_file() => Ok(path),
        Ok(stats) => Err(format!(
            "The folder at {} could not be locked: {} is {}. Remove it, then open the folder again.",
            root.display(),
            path.display(),
            if stats.file_type().is_symlink() {
                "a symbolic link"
            } else {
                "not a regular file"
            }
        )),
    }
}
