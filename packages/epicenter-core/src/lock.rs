//! The round lock (ADR-0750): `<git common dir>/epicenter-sync.lock`, held
//! for a whole round so two programs never interleave a fetch from one with
//! a merge from the other. Git's own locks, such as `index.lock`, guard one
//! operation each.
//!
//! The TypeScript CLI takes the same file as an exclusive SQLite
//! transaction (`holdingFileLock` in `packages/cli/src/file-lock.ts`), and
//! both must exclude each other while both exist. SQLite's unix VFS locks a
//! database with `fcntl` record locks on fixed bytes past 1 GiB: the
//! pending byte at `0x40000000`, the reserved byte after it, and a 510-byte
//! shared range after that. The core takes an `fcntl` write lock on those
//! same 512 bytes, so either side finds the other's lock. `flock` would not
//! do: on Linux `flock` and `fcntl` locks are independent and never see
//! each other (on macOS they interact, which would hide the bug there).
//!
//! `fcntl` locks belong to a process, not a file handle: a second round in
//! the same process would be granted the lock again, and closing any handle
//! to the file drops it. So the core also keeps a set of the lock files this
//! process holds, and no other code in the process may open one.
//!
//! The lock writes nothing. The operating system releases it when the
//! holder exits, however it exits, so a killed round leaves nothing to clean
//! up.

use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::Error;

/// The lock file's name in the repository's common Git directory.
pub const LOCK_FILE: &str = "epicenter-sync.lock";

/// How long a round waits for another program's round, as `TURN_WAIT_MS`
/// in `packages/cli/src/sync/sync.ts` does.
pub const TURN_WAIT: Duration = Duration::from_secs(120);

/// SQLite's `PENDING_BYTE`, where its lock bytes start, and their count.
const SQLITE_LOCK_START: i64 = 0x4000_0000;
const SQLITE_LOCK_LEN: i64 = 512;

/// The lock files this process holds.
static HELD: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());

/// A held round lock; dropping it releases the lock.
pub struct RoundLock {
    path: PathBuf,
    file: Option<File>,
}

impl RoundLock {
    /// Take the round lock of the repository whose common Git directory is
    /// `git_dir`, waiting up to `wait` for another round to finish. A lock
    /// still held after `wait` is `Retry`; nothing was changed.
    pub fn acquire(git_dir: &Path, wait: Duration) -> Result<RoundLock, Error> {
        let path = git_dir.join(LOCK_FILE);
        match fs::symlink_metadata(&path) {
            Ok(meta) if !meta.file_type().is_file() => {
                return Err(Error::stopped(format!(
                    "{} is not a regular file, so it cannot be locked. Remove it, then sync again.",
                    path.display()
                )))
            }
            _ => {}
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)?;
        // One name per file, however the repository was reached.
        let path = fs::canonicalize(&path)?;
        let deadline = Instant::now() + wait;
        let mut pause = Duration::from_millis(1);
        loop {
            if claim(&path) {
                match try_lock(&file) {
                    Ok(true) => {
                        return Ok(RoundLock {
                            path,
                            file: Some(file),
                        })
                    }
                    Ok(false) => release_claim(&path),
                    Err(e) => {
                        release_claim(&path);
                        return Err(e.into());
                    }
                }
            }
            if Instant::now() >= deadline {
                return Err(Error::retry(format!(
                    "another sync of this folder ran for more than {} seconds; nothing was changed.",
                    wait.as_secs()
                )));
            }
            std::thread::sleep(pause);
            pause = (pause * 2).min(Duration::from_millis(25));
        }
    }
}

impl Drop for RoundLock {
    fn drop(&mut self) {
        // Closing the only handle releases the `fcntl` lock.
        drop(self.file.take());
        release_claim(&self.path);
    }
}

/// Mark `path` held by this process; false when a round here holds it.
fn claim(path: &Path) -> bool {
    let mut held = HELD.lock().unwrap_or_else(|e| e.into_inner());
    held.insert(path.to_path_buf())
}

fn release_claim(path: &Path) {
    let mut held = HELD.lock().unwrap_or_else(|e| e.into_inner());
    held.remove(path);
}

/// An `fcntl` write lock on SQLite's lock bytes; false when another process holds any of them.
#[cfg(unix)]
fn try_lock(file: &File) -> std::io::Result<bool> {
    use std::os::fd::AsRawFd;
    // SAFETY: a zeroed `flock` is a valid value; every field the call reads is set below.
    let mut record: libc::flock = unsafe { std::mem::zeroed() };
    record.l_type = libc::F_WRLCK as _;
    record.l_whence = libc::SEEK_SET as _;
    record.l_start = SQLITE_LOCK_START as _;
    record.l_len = SQLITE_LOCK_LEN as _;
    // SAFETY: the descriptor is open for the life of `file`, and `record` outlives the call.
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETLK, &record) } == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::EAGAIN) | Some(libc::EACCES) => Ok(false),
        _ => Err(error),
    }
}

/// Windows: the whole file, which covers SQLite's lock bytes. Unverified
/// against the CLI there; the CLI does not yet ship on Windows.
#[cfg(not(unix))]
fn try_lock(file: &File) -> std::io::Result<bool> {
    match file.try_lock() {
        Ok(()) => Ok(true),
        Err(std::fs::TryLockError::WouldBlock) => Ok(false),
        Err(std::fs::TryLockError::Error(e)) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_round_in_the_same_process_waits_then_retries() {
        let dir = tempfile::tempdir().unwrap();
        let held = RoundLock::acquire(dir.path(), Duration::ZERO).unwrap();
        let error = RoundLock::acquire(dir.path(), Duration::from_millis(20))
            .err()
            .expect("the lock is held");
        assert_eq!(error.status, crate::Status::Retry);
        drop(held);
        RoundLock::acquire(dir.path(), Duration::ZERO).unwrap();
    }

    #[test]
    fn a_waiting_round_takes_the_lock_once_it_is_released() {
        let dir = tempfile::tempdir().unwrap();
        let held = RoundLock::acquire(dir.path(), Duration::ZERO).unwrap();
        let path = dir.path().to_path_buf();
        let waiter =
            std::thread::spawn(move || RoundLock::acquire(&path, Duration::from_secs(10)).is_ok());
        std::thread::sleep(Duration::from_millis(50));
        drop(held);
        assert!(waiter.join().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_place_of_the_lock_file_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("/dev/null", dir.path().join(LOCK_FILE)).unwrap();
        let error = RoundLock::acquire(dir.path(), Duration::ZERO)
            .err()
            .expect("refused");
        assert_eq!(error.status, crate::Status::Stopped);
    }
}
