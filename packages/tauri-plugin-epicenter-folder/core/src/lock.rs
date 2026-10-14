//! One holder per folder directory, across processes.
//!
//! The lock is an exclusive SQLite transaction on a file beside the directory,
//! so two desktop shells pointed at one directory exclude each other. SQLite
//! holds it with an operating-system file lock, which the system releases
//! when the process ends, however it ends. There is no stale
//! lock to detect and nothing to recover after a forced kill. The file itself
//! is never deleted, so a live holder's lock is never removed by anyone.
//!
//! Operating-system file locks are unreliable on some network filesystems; a
//! folder there is not protected by this.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, ErrorCode};

/// Where the cross-process lock for a canonical root lives: a sibling, outside
/// the folder's files.
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
        let describe = |cause: rusqlite::Error| {
            failed(format!(
                "The folder at {} could not be locked: {cause}",
                root.display()
            ))
        };
        let connection = Connection::open(&path).map_err(describe)?;
        // Refuse immediately; waiting would only delay telling the person.
        connection
            .busy_timeout(std::time::Duration::ZERO)
            .map_err(describe)?;
        match connection.execute_batch("BEGIN EXCLUSIVE") {
            Ok(()) => Ok(Self {
                connection: Some(connection),
                path,
            }),
            Err(rusqlite::Error::SqliteFailure(error, _))
                if matches!(
                    error.code,
                    ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked
                ) =>
            {
                Err(LockError::Busy {
                    root: root.to_path_buf(),
                })
            }
            Err(cause) => Err(describe(cause)),
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
            let _ = connection.execute_batch("ROLLBACK");
            let _ = connection.close();
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
