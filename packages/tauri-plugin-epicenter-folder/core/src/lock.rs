//! Two locks per folder directory, each a file beside it, across processes.
//!
//! - `RootLock`, on `.<name>.epicenter-lock`: one desktop shell per folder,
//!   held from the folder's first grant until the shell shuts down.
//! - `SaveLock`, on `.<name>.epicenter-save-lock`: one save at a time, held
//!   only across one save's check and rename (or removal), by the shell and
//!   by the Bun host (`@epicenter/folder/bun`) alike, so a save from the
//!   `epicenter` CLI and a save from a window never interleave between the
//!   check and the change (ADR-0562). It waits for the other holder, up to
//!   `SAVE_LOCK_WAIT`.
//!
//! Each lock is an exclusive SQLite transaction on its file, which `rusqlite`
//! and Bun's `bun:sqlite` both take. SQLite holds it with an operating-system
//! file lock (`fcntl` on Unix, `LockFileEx` on Windows), which the system
//! releases when the process ends, however it ends. There is no stale lock to
//! detect and nothing to recover after a forced kill. The transaction writes
//! nothing, so no journal is left behind. The files themselves are never
//! deleted, so a live holder's lock is never removed by anyone.
//!
//! Operating-system file locks are unreliable on some network filesystems; a
//! folder there is not protected by either.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, ErrorCode};

/// How long a save waits for another process's save to the same folder
/// before it gives up. A holder keeps the lock only across one check, which
/// hashes the file, and one rename. The Bun host waits as long.
pub const SAVE_LOCK_WAIT: Duration = Duration::from_secs(10);

/// The file beside `root` named `.<name><suffix>`.
fn sibling(root: &Path, suffix: &str) -> Result<PathBuf, String> {
    let (Some(parent), Some(name)) = (root.parent(), root.file_name()) else {
        return Err(format!(
            "The folder at {} has no parent directory to hold its lock.",
            root.display()
        ));
    };
    let mut file = std::ffi::OsString::from(".");
    file.push(name);
    file.push(suffix);
    Ok(parent.join(file))
}

/// Where the cross-process lock for a canonical root lives: a sibling, outside
/// the folder's files.
pub fn lock_path(root: &Path) -> Result<PathBuf, String> {
    sibling(root, ".epicenter-lock")
}

/// Where the save lock for a canonical root lives, beside the root lock.
pub fn save_lock_path(root: &Path) -> Result<PathBuf, String> {
    sibling(root, ".epicenter-save-lock")
}

/// Refuse a lock path that is a symbolic link or anything other than a regular
/// file, before it is opened, so the lock is never taken on a database
/// somewhere else. Checked once; it does not defend against a later swap.
pub fn verify_lock_path(root: &Path) -> Result<PathBuf, String> {
    verify(root, lock_path(root)?, "locked", "open the folder again")
}

fn verify(root: &Path, path: PathBuf, verb: &str, then: &str) -> Result<PathBuf, String> {
    match fs::symlink_metadata(&path) {
        Err(cause) if cause.kind() == ErrorKind::NotFound => Ok(path),
        Err(cause) => Err(format!(
            "The folder at {} could not be {verb}: {} could not be inspected: {cause}",
            root.display(),
            path.display()
        )),
        Ok(stats) if stats.file_type().is_file() => Ok(path),
        Ok(stats) => Err(format!(
            "The folder at {} could not be {verb}: {} is {}. Remove it, then {then}.",
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

/// Whether SQLite refused a transaction because another connection holds it.
fn is_busy(cause: &rusqlite::Error) -> bool {
    matches!(
        cause,
        rusqlite::Error::SqliteFailure(error, _)
            if matches!(error.code, ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    )
}

/// Open the lock database at `path` and begin an exclusive transaction,
/// waiting up to `wait` for another holder.
fn begin_exclusive(path: &Path, wait: Duration) -> Result<Connection, rusqlite::Error> {
    let connection = Connection::open(path)?;
    connection.busy_timeout(wait)?;
    connection.execute_batch("BEGIN EXCLUSIVE")?;
    Ok(connection)
}

/// End the transaction and close, which releases the operating-system lock.
fn release(connection: Connection) {
    let _ = connection.execute_batch("ROLLBACK");
    let _ = connection.close();
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LockError {
    /// Another process holds the folder.
    Busy {
        root: PathBuf,
    },
    Failed {
        message: String,
    },
}

/// The held lock. Dropping it releases the folder to the next process.
#[derive(Debug)]
pub struct RootLock {
    connection: Option<Connection>,
    path: PathBuf,
}

impl RootLock {
    /// Take the lock for a canonical root, or refuse at once.
    pub fn acquire(root: &Path) -> Result<Self, LockError> {
        let failed = |message: String| LockError::Failed { message };
        let path = verify_lock_path(root).map_err(failed)?;
        // Refuse immediately; waiting would only delay telling the person.
        match begin_exclusive(&path, Duration::ZERO) {
            Ok(connection) => Ok(Self {
                connection: Some(connection),
                path,
            }),
            Err(cause) if is_busy(&cause) => Err(LockError::Busy {
                root: root.to_path_buf(),
            }),
            Err(cause) => Err(failed(format!(
                "The folder at {} could not be locked: {cause}",
                root.display()
            ))),
        }
    }

    /// The lock file, beside the directory it guards.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for RootLock {
    fn drop(&mut self) {
        if let Some(connection) = self.connection.take() {
            release(connection);
        }
    }
}

/// One save's hold on a folder, across processes. Dropping it lets the next
/// save, from this process or another, check and change the folder.
#[derive(Debug)]
pub struct SaveLock {
    connection: Option<Connection>,
}

impl SaveLock {
    /// Take the save lock for a canonical root, waiting up to `wait` for a
    /// save in another process to finish. A save that still finds it held
    /// changes nothing and says so.
    pub fn acquire(root: &Path, wait: Duration) -> Result<Self, String> {
        let path = verify(root, save_lock_path(root)?, "saved to", "save again")?;
        match begin_exclusive(&path, wait) {
            Ok(connection) => Ok(Self {
                connection: Some(connection),
            }),
            Err(cause) if is_busy(&cause) => Err(format!(
                "Nothing was saved to the folder at {}: another program held its save lock ({}) for more than {} seconds. Save again; if it keeps happening, quit the other program.",
                root.display(),
                path.display(),
                wait.as_secs_f64()
            )),
            Err(cause) => Err(format!(
                "Nothing was saved to the folder at {}: its save lock ({}) could not be taken: {cause}",
                root.display(),
                path.display()
            )),
        }
    }
}

impl Drop for SaveLock {
    fn drop(&mut self) {
        if let Some(connection) = self.connection.take() {
            release(connection);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    #[test]
    fn a_second_acquisition_is_busy_until_the_first_is_dropped() {
        let temp = TempDir::new("lock");
        let root = temp.folder("notes");
        let held = RootLock::acquire(&root).expect("first acquisition");
        assert_eq!(
            held.path().file_name().unwrap().to_str(),
            Some(".notes.epicenter-lock")
        );
        assert_eq!(
            RootLock::acquire(&root).unwrap_err(),
            LockError::Busy { root: root.clone() }
        );
        drop(held);
        RootLock::acquire(&root).expect("the lock is free again");
    }

    #[test]
    fn the_save_lock_is_its_own_file_and_a_second_save_waits_for_the_first() {
        let temp = TempDir::new("save-lock");
        let root = temp.folder("notes");
        // The shell's folder lock does not keep out a save.
        let _folder = RootLock::acquire(&root).expect("folder lock");
        let held = SaveLock::acquire(&root, Duration::ZERO).expect("first save");
        assert!(temp.path().join(".notes.epicenter-save-lock").is_file());

        let refused = SaveLock::acquire(&root, Duration::from_millis(50)).unwrap_err();
        assert!(refused.contains("Nothing was saved"), "{refused}");
        assert!(refused.contains(".notes.epicenter-save-lock"), "{refused}");

        // A waiting save takes the lock as soon as the holder lets go.
        let waiter = {
            let root = root.clone();
            std::thread::spawn(move || {
                let started = std::time::Instant::now();
                SaveLock::acquire(&root, SAVE_LOCK_WAIT).map(|_| started.elapsed())
            })
        };
        std::thread::sleep(Duration::from_millis(100));
        drop(held);
        let waited = waiter.join().unwrap().expect("the waiter takes the lock");
        assert!(waited >= Duration::from_millis(50), "{waited:?}");
        assert!(waited < SAVE_LOCK_WAIT, "{waited:?}");
        // The transaction wrote nothing, so SQLite left no journal beside it.
        assert!(!temp.path().join(".notes.epicenter-save-lock-journal").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_symbolic_link_at_the_save_lock_path_is_refused_before_it_is_opened() {
        let temp = TempDir::new("save-lock-link");
        let root = temp.folder("notes");
        let elsewhere = temp.path().join("elsewhere.sqlite");
        std::os::unix::fs::symlink(&elsewhere, temp.path().join(".notes.epicenter-save-lock"))
            .unwrap();
        let message = SaveLock::acquire(&root, Duration::ZERO).unwrap_err();
        assert!(message.contains("is a symbolic link"), "{message}");
        assert!(!elsewhere.exists(), "the link target was never created");
    }

    #[cfg(unix)]
    #[test]
    fn a_symbolic_link_at_the_lock_path_is_refused_before_it_is_opened() {
        let temp = TempDir::new("lock-link");
        let root = temp.folder("notes");
        let elsewhere = temp.path().join("elsewhere.sqlite");
        std::os::unix::fs::symlink(&elsewhere, temp.path().join(".notes.epicenter-lock")).unwrap();
        let LockError::Failed { message } = RootLock::acquire(&root).unwrap_err() else {
            panic!("a linked lock path is not a busy folder");
        };
        assert!(message.contains("is a symbolic link"), "{message}");
        assert!(!elsewhere.exists(), "the link target was never created");
    }

    #[test]
    fn a_directory_at_the_lock_path_is_refused() {
        let temp = TempDir::new("lock-dir");
        let root = temp.folder("notes");
        std::fs::create_dir(temp.path().join(".notes.epicenter-lock")).unwrap();
        let LockError::Failed { message } = RootLock::acquire(&root).unwrap_err() else {
            panic!("a directory at the lock path is not a busy folder");
        };
        assert!(message.contains("not a regular file"), "{message}");
    }
}
