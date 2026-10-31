//! The folder's save lock, `SaveLock`, a file inside the folder's own state
//! directory, `.epicenter/save-lock`: one save at a time, across processes, held
//! only across one save's check and rename (or removal), by every Epicenter
//! shell and by Bun (`@epicenter/folder/bun`) alike, so two saves never
//! interleave between the check and the change (ADR-0562, ADR-0568). It
//! waits for the other holder, up to `SAVE_LOCK_WAIT`.
//!
//! The lock is an exclusive SQLite transaction on its file, which `rusqlite`
//! and Bun's `bun:sqlite` both take. SQLite holds it with an operating-system
//! file lock (`fcntl`), which the system releases when the process ends,
//! however it ends. There is no stale lock to detect and nothing to recover
//! after a forced kill. The transaction writes nothing, so no journal is left
//! behind. The file itself is never deleted, so a live holder's lock is never
//! removed by anyone.
//!
//! Operating-system file locks are unreliable on some network filesystems; a
//! folder there is not protected.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, ErrorCode};

use crate::storage::{prepare_state_directory, STATE_DIRECTORY};

/// How long a save waits for another writer's save to the same folder
/// before it gives up. A holder keeps the lock only across one check, which
/// hashes the file, and one rename. The Bun host waits as long.
pub const SAVE_LOCK_WAIT: Duration = Duration::from_secs(10);

/// Where the save lock for a canonical root lives: `.epicenter/save-lock`
/// inside it, which no listing shows (`storage::STATE_DIRECTORY`).
pub fn save_lock_path(root: &Path) -> PathBuf {
    root.join(STATE_DIRECTORY).join("save-lock")
}

/// Refuse a lock path that is a symbolic link or anything other than a
/// regular file, before it is opened, so the lock is never taken on a
/// database somewhere else. Checked once; it does not defend against a later
/// swap.
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

/// One save's hold on a folder, across processes. Dropping it lets the next
/// save, from this process or another, check and change the folder.
#[derive(Debug)]
pub struct SaveLock {
    connection: Option<Connection>,
}

impl SaveLock {
    /// Take the save lock for a canonical root, waiting up to `wait` for a
    /// save from any participating writer to finish, after making
    /// `.epicenter` when it is missing. A save that still finds it held
    /// changes nothing and says so.
    pub fn acquire(root: &Path, wait: Duration) -> Result<Self, String> {
        prepare_state_directory(root).map_err(|problem| {
            format!(
                "Nothing was saved to the folder at {}: {problem}",
                root.display()
            )
        })?;
        let path = verify(root, save_lock_path(root), "saved to", "save again")?;
        match begin_exclusive(&path, wait) {
            Ok(connection) => Ok(Self {
                connection: Some(connection),
            }),
            Err(cause) if is_busy(&cause) => Err(format!(
                "Nothing was saved to the folder at {}: another writer held its save lock ({}) for more than {} seconds. Try saving again when the other save finishes.",
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

    /// The names directly in `directory`, sorted.
    fn names(directory: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn the_save_lock_is_its_own_file_and_a_second_save_waits_for_the_first() {
        let temp = TempDir::new("save-lock");
        let root = temp.folder("notes");
        let held = SaveLock::acquire(&root, Duration::ZERO).expect("first save");
        let lock = root.join(".epicenter/save-lock");
        assert!(lock.is_file());
        // The lock lives inside the folder; nothing is made beside it.
        assert_eq!(names(temp.path()), ["notes"]);

        let refused = SaveLock::acquire(&root, Duration::from_millis(50)).unwrap_err();
        assert!(refused.contains("Nothing was saved"), "{refused}");
        assert!(refused.contains(&lock.display().to_string()), "{refused}");

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
        assert_eq!(names(&root.join(".epicenter")), ["save-lock"]);
        assert_eq!(names(temp.path()), ["notes"]);
    }

    /// A missing `.epicenter` is made private to this account.
    #[cfg(unix)]
    #[test]
    fn a_missing_state_directory_is_made_private() {
        use std::os::unix::fs::PermissionsExt;
        let temp = TempDir::new("save-lock-state");
        let root = temp.folder("notes");
        drop(SaveLock::acquire(&root, Duration::ZERO).unwrap());
        let made = fs::symlink_metadata(root.join(".epicenter")).unwrap();
        assert!(made.is_dir());
        assert_eq!(made.permissions().mode() & 0o777, 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn a_symbolic_link_at_the_save_lock_path_is_refused_before_it_is_opened() {
        let temp = TempDir::new("save-lock-link");
        let root = temp.folder("notes");
        fs::create_dir(root.join(".epicenter")).unwrap();
        let elsewhere = temp.path().join("elsewhere.sqlite");
        std::os::unix::fs::symlink(&elsewhere, root.join(".epicenter/save-lock")).unwrap();
        let message = SaveLock::acquire(&root, Duration::ZERO).unwrap_err();
        assert!(message.contains("is a symbolic link"), "{message}");
        assert!(!elsewhere.exists(), "the link target was never created");
    }

    /// A link at `.epicenter` is never followed: the lock is not taken
    /// through it and nothing is made where it points.
    #[cfg(unix)]
    #[test]
    fn a_symbolic_link_at_the_state_directory_is_refused() {
        let temp = TempDir::new("save-lock-state-link");
        let root = temp.folder("notes");
        let elsewhere = temp.folder("elsewhere");
        std::os::unix::fs::symlink(&elsewhere, root.join(".epicenter")).unwrap();
        let message = SaveLock::acquire(&root, Duration::ZERO).unwrap_err();
        assert!(message.contains("is a symbolic link"), "{message}");
        assert!(names(&elsewhere).is_empty());
    }

    #[test]
    fn a_directory_at_the_save_lock_path_is_refused() {
        let temp = TempDir::new("save-lock-dir");
        let root = temp.folder("notes");
        fs::create_dir_all(root.join(".epicenter/save-lock")).unwrap();
        let message = SaveLock::acquire(&root, Duration::ZERO).unwrap_err();
        assert!(message.contains("not a regular file"), "{message}");
    }
}
