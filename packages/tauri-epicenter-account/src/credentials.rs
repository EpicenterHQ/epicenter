//! An app's credentials: one file, `credentials.json` at the top of the
//! app's AppData directory, readable and writable by the person alone (mode
//! `0600` on unix, ADR-0740). It holds every secret the shell keeps, as JSON
//! `{ name: value }`: the account's refresh token under `account:<origin>`
//! (`account`), and each connected endpoint's key under
//! `key:<connection id>` (`connection`). No page reads it: the folder plugin
//! refuses the path in the AppData root.
//!
//! The shell reads the file when a request needs a secret (the account's
//! refresh, a connection's fetch) and keeps nothing from it in memory; only
//! the access token it gets for the refresh token lives in this process.
//! Every write stages the whole file beside it and renames it over the old
//! one (`write_whole`), so a reader finds one version or the other.
//!
//! The path is known once the app runs: `manage` installs a plugin whose
//! setup resolves it from Tauri's `app_data_dir()`, the directory the folder
//! plugin names `Root::AppData`. A debug build started with
//! `EPICENTER_SECRETS_FILE=<path>` keeps its credentials in that file
//! instead, so tests and smoke runs never touch the person's. A release
//! build ignores the variable.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

/// The credentials file's name, at the top of the app's AppData directory.
pub const CREDENTIALS_FILE: &str = "credentials.json";

/// A store of named secrets. Reads and writes may block on the disk.
pub trait Secrets: Send + Sync {
    fn get(&self, name: &str) -> Result<Option<String>, String>;
    /// Save `value` under `name`, or remove the entry for `None`.
    fn set(&self, name: &str, value: Option<&str>) -> Result<(), String>;
}

/// Secrets held for one process only, for tests.
#[derive(Default)]
pub struct Memory(Mutex<HashMap<String, String>>);

impl Secrets for Memory {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(name).cloned())
    }

    fn set(&self, name: &str, value: Option<&str>) -> Result<(), String> {
        let mut entries = self.0.lock().unwrap();
        match value {
            Some(value) => entries.insert(name.to_string(), value.to_string()),
            None => entries.remove(name),
        };
        Ok(())
    }
}

/// The credentials file, at a path settled once the app runs (`resolve`).
#[derive(Default)]
pub struct Credentials {
    path: OnceLock<PathBuf>,
    /// Writes in this process take turns from the read to the rename.
    lock: Mutex<()>,
}

impl Credentials {
    /// The credentials file at `path`.
    pub fn at(path: impl Into<PathBuf>) -> Self {
        let credentials = Self::default();
        credentials.resolve(path.into());
        credentials
    }

    /// Settle where the file is; the first call wins. Staged copies a stopped
    /// write left beside it an hour or more ago are removed.
    pub fn resolve(&self, path: PathBuf) {
        sweep_staged(&path, SystemTime::now());
        let _ = self.path.set(path);
    }

    fn path(&self) -> Result<&Path, String> {
        self.path
            .get()
            .map(PathBuf::as_path)
            .ok_or_else(|| "This app's credentials file is not known yet.".to_string())
    }

    fn read(path: &Path) -> Result<BTreeMap<String, String>, String> {
        match fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text)
                .map_err(|error| format!("{} is not a credentials file: {error}", path.display())),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(error) => Err(format!("{} could not be read: {error}", path.display())),
        }
    }
}

impl Secrets for Credentials {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        let path = self.path()?;
        let _held = self.lock.lock().unwrap();
        Ok(Self::read(path)?.remove(name))
    }

    fn set(&self, name: &str, value: Option<&str>) -> Result<(), String> {
        let path = self.path()?;
        let _held = self.lock.lock().unwrap();
        let mut entries = Self::read(path)?;
        match value {
            Some(value) => entries.insert(name.to_string(), value.to_string()),
            None => entries.remove(name),
        };
        let text = serde_json::to_string_pretty(&entries).expect("credentials serialize");
        write_whole(path, text.as_bytes(), Access::Private)
            .map_err(|error| format!("{} could not be written: {error}", path.display()))
    }
}

/// Where this run keeps its credentials, for the app whose AppData directory
/// is `app_data`: `credentials.json` at its top, or, in a debug build
/// started with `EPICENTER_SECRETS_FILE`, that file.
pub fn path_in(app_data: &Path) -> PathBuf {
    if cfg!(debug_assertions) {
        if let Some(path) = std::env::var_os("EPICENTER_SECRETS_FILE").filter(|v| !v.is_empty()) {
            return PathBuf::from(path);
        }
    }
    app_data.join(CREDENTIALS_FILE)
}

/// Who may read a file the shell writes whole.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Access {
    /// The person alone: mode `0600` on unix.
    Private,
    /// Whatever the system gives a new file.
    Default,
}

/// A staged copy's name ends with this; it starts with `.` and the file's
/// name, so no watcher of the folder reports it.
const STAGED: &str = ".staged";

/// Write `bytes` as the whole of `path`: stage them in a new file beside it,
/// made with `access`, then rename it over `path`. Makes a missing parent.
pub(crate) fn write_whole(path: &Path, bytes: &[u8], access: Access) -> io::Result<()> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let directory = path
        .parent()
        .ok_or_else(|| io::Error::other("the path names no folder"))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| io::Error::other("the path names no file"))?;
    fs::create_dir_all(directory)?;
    let staged = directory.join(format!(
        ".{name}.{}-{}{STAGED}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if access == Access::Private {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let written = (|| {
        let mut file = options.open(&staged)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&staged, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&staged);
    }
    written
}

/// Remove the staged copies of `path` that a write stopped before its rename
/// left an hour or more before `now`: a copy of the credentials must not
/// outlive the write that made it.
fn sweep_staged(path: &Path, now: SystemTime) {
    let (Some(directory), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str()))
    else {
        return;
    };
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let prefix = format!(".{name}.");
    for entry in entries.flatten() {
        let Ok(entry_name) = entry.file_name().into_string() else {
            continue;
        };
        if !entry_name.starts_with(&prefix) || !entry_name.ends_with(STAGED) {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .is_ok_and(|modified| {
                now.duration_since(modified)
                    .is_ok_and(|age| age >= Duration::from_secs(60 * 60))
            });
        if stale {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Run disk work off the window thread.
pub(crate) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn staged_beside(path: &Path) -> Vec<String> {
        fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.unwrap().file_name().into_string().ok())
            .filter(|name| name.ends_with(STAGED))
            .collect()
    }

    #[test]
    fn the_file_keeps_entries_across_opens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CREDENTIALS_FILE);
        Credentials::at(&path)
            .set("key:openai", Some("sk-1"))
            .unwrap();
        Credentials::at(&path).set("account:x", Some("r")).unwrap();
        let reopened = Credentials::at(&path);
        assert_eq!(reopened.get("key:openai").unwrap().as_deref(), Some("sk-1"));
        reopened.set("key:openai", None).unwrap();
        assert_eq!(reopened.get("key:openai").unwrap(), None);
        assert_eq!(reopened.get("account:x").unwrap().as_deref(), Some("r"));
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&text).unwrap(),
            serde_json::json!({ "account:x": "r" })
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_the_persons_alone_and_replaced_whole() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app-data").join(CREDENTIALS_FILE);
        // A file someone left readable is replaced by one that is not.
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{}").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        let before = fs::metadata(&path).unwrap().ino();
        let credentials = Credentials::at(&path);
        credentials.set("key:a", Some("sk-1")).unwrap();
        let metadata = fs::metadata(&path).unwrap();
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        // Renamed over, never rewritten in place, and nothing staged is left.
        assert_ne!(metadata.ino(), before);
        assert!(staged_beside(&path).is_empty());
    }

    #[test]
    fn a_missing_file_holds_nothing_and_an_unresolved_one_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let credentials = Credentials::at(dir.path().join("missing").join(CREDENTIALS_FILE));
        assert_eq!(credentials.get("key:a").unwrap(), None);
        credentials.set("key:a", Some("sk-1")).unwrap();
        assert_eq!(credentials.get("key:a").unwrap().as_deref(), Some("sk-1"));
        let unresolved = Credentials::default();
        assert!(unresolved.get("key:a").is_err());
        assert!(unresolved.set("key:a", None).is_err());
    }

    #[test]
    fn a_file_that_does_not_read_is_refused_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CREDENTIALS_FILE);
        fs::write(&path, "not json").unwrap();
        let credentials = Credentials::at(&path);
        assert!(credentials.get("key:a").is_err());
        assert!(credentials.set("key:a", Some("sk-1")).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "not json");
    }

    #[test]
    fn a_stale_staged_copy_is_swept_and_a_fresh_one_kept() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CREDENTIALS_FILE);
        let staged = dir.path().join(format!(".{CREDENTIALS_FILE}.1-0{STAGED}"));
        fs::write(&staged, "{}").unwrap();
        fs::write(dir.path().join("other.staged"), "").unwrap();
        sweep_staged(&path, SystemTime::now());
        assert!(staged.exists());
        sweep_staged(&path, SystemTime::now() + Duration::from_secs(2 * 60 * 60));
        assert!(!staged.exists());
        assert!(dir.path().join("other.staged").exists());
    }

    #[test]
    fn the_file_is_at_the_top_of_app_data() {
        // Debug test builds honor `EPICENTER_SECRETS_FILE`; none is set here.
        if std::env::var_os("EPICENTER_SECRETS_FILE").is_none() {
            assert_eq!(
                path_in(Path::new("/data/so.epicenter.vocab")),
                Path::new("/data/so.epicenter.vocab/credentials.json")
            );
        }
    }
}
