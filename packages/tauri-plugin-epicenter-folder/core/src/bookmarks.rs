//! Folders this machine remembers in `<AppData>/bookmarks.json`: a JSON
//! array of path strings, kept as written.
//!
//! Native shells and the CLI (`packages/cli/src/bookmarks.ts`) read the same
//! array and take the exclusive SQLite lock `.bookmarks.json.epicenter-save-lock`
//! across each read, change, and atomic replace, so no writer loses another's
//! entry. A bookmark is a shortcut, never a permission or an app default.
//! Contents in any other shape are reported and left byte for byte; an
//! earlier build's `folders.json` is never read.

use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use crate::lock::{SaveLock, SAVE_LOCK_WAIT};

pub const FILE: &str = "bookmarks.json";

pub fn file(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE)
}

/// Read without creating anything. An absent file holds no bookmarks.
pub fn read(data_dir: &Path) -> Result<Vec<String>, String> {
    let path = file(data_dir);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("{} could not be read: {error}", path.display())),
        Ok(stats) if !stats.file_type().is_file() => {
            return Err(unsupported(&path, "it is not a regular file"))
        }
        Ok(_) => {}
    }
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("{} could not be read: {error}", path.display())),
    };
    serde_json::from_slice::<Vec<String>>(&bytes)
        .map_err(|error| unsupported(&path, &format!("it is not a JSON array of paths ({error})")))
}

/// Remember `directory` once, as spelled.
pub fn add(data_dir: &Path, directory: &str) -> Result<(), String> {
    update(data_dir, |bookmarks| {
        if !bookmarks.iter().any(|path| path == directory) {
            bookmarks.push(directory.to_string());
        }
    })
}

/// Forget only the exact entry, even when the directory no longer exists.
pub fn forget(data_dir: &Path, directory: &str) -> Result<(), String> {
    update(data_dir, |bookmarks| {
        bookmarks.retain(|path| path != directory)
    })
}

/// Read, change, and replace under the shared lock. An unchanged list
/// writes nothing.
fn update(data_dir: &Path, change: impl FnOnce(&mut Vec<String>)) -> Result<(), String> {
    let path = file(data_dir);
    fs::create_dir_all(data_dir).map_err(|error| not_saved(&path, &error.to_string()))?;
    let _turn =
        SaveLock::acquire(&path, SAVE_LOCK_WAIT).map_err(|reason| not_saved(&path, &reason))?;
    let mut bookmarks = read(data_dir)?;
    let before = bookmarks.clone();
    change(&mut bookmarks);
    if bookmarks == before {
        return Ok(());
    }
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(&bookmarks).map_err(|error| error.to_string())?
    );
    let mut staged = tempfile::Builder::new()
        .prefix(".bookmarks.json.")
        .suffix(".staged")
        .tempfile_in(data_dir)
        .map_err(|error| not_saved(&path, &error.to_string()))?;
    staged
        .write_all(text.as_bytes())
        .and_then(|()| staged.as_file().sync_all())
        .map_err(|error| not_saved(&path, &error.to_string()))?;
    staged
        .persist(&path)
        .map_err(|error| not_saved(&path, &error.error.to_string()))?;
    Ok(())
}

fn unsupported(path: &Path, reason: &str) -> String {
    format!(
        "{} was left unchanged because {reason}. Repair it to change bookmarks again.",
        path.display()
    )
}

fn not_saved(path: &Path, reason: &str) -> String {
    format!("{} was not updated: {reason}", path.display())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn an_absent_list_is_empty_and_reading_it_creates_nothing() {
        let data = data_dir();
        let missing = data.path().join("not-yet");
        assert_eq!(read(&missing).unwrap(), Vec::<String>::new());
        assert!(!missing.exists());
    }

    #[test]
    fn adding_twice_remembers_one_entry_in_order() {
        let data = data_dir();
        add(data.path(), "/Users/me/Notes").unwrap();
        add(data.path(), "/Users/me/Notes").unwrap();
        add(data.path(), "/Users/me/Vault").unwrap();
        assert_eq!(
            read(data.path()).unwrap(),
            ["/Users/me/Notes", "/Users/me/Vault"]
        );
        assert!(data
            .path()
            .join(".bookmarks.json.epicenter-save-lock")
            .is_file());
    }

    #[test]
    fn forgetting_needs_no_directory_and_an_absent_entry_writes_nothing() {
        let data = data_dir();
        add(data.path(), "/gone/away").unwrap();
        forget(data.path(), "/gone/away").unwrap();
        assert!(read(data.path()).unwrap().is_empty());
        let before = fs::read(file(data.path())).unwrap();
        let modified = fs::metadata(file(data.path())).unwrap().modified().unwrap();
        forget(data.path(), "/never/there").unwrap();
        assert_eq!(fs::read(file(data.path())).unwrap(), before);
        assert_eq!(
            fs::metadata(file(data.path())).unwrap().modified().unwrap(),
            modified
        );
    }

    /// Strings that are not absolute paths are kept as written, so another
    /// writer's entry survives this one's change, and stay forgettable.
    #[test]
    fn entries_this_build_would_not_accept_survive_a_change() {
        let data = data_dir();
        fs::write(file(data.path()), "[\"relative/notes\", \"/a/b/\"]").unwrap();
        add(data.path(), "/Users/me/Notes").unwrap();
        assert_eq!(
            read(data.path()).unwrap(),
            ["relative/notes", "/a/b/", "/Users/me/Notes"]
        );
        forget(data.path(), "relative/notes").unwrap();
        assert_eq!(read(data.path()).unwrap(), ["/a/b/", "/Users/me/Notes"]);
    }

    #[test]
    fn unsupported_contents_are_reported_and_left_byte_identical() {
        for contents in [
            &b"not json"[..],
            b"{\"homes\": {}, \"folders\": []}",
            b"{\"folders\": [\"/ok\"]}",
            b"[\"/ok\", 7]",
            b"[{\"path\": \"/with/id\"}]",
            b"\xff\xfe",
        ] {
            let data = data_dir();
            fs::write(file(data.path()), contents).unwrap();
            let problem = read(data.path()).unwrap_err();
            assert!(problem.contains("left unchanged"), "{problem}");
            assert!(add(data.path(), "/Users/me/Notes").is_err());
            assert!(forget(data.path(), "/ok").is_err());
            assert_eq!(fs::read(file(data.path())).unwrap(), contents);
        }
    }

    #[test]
    fn an_unreadable_list_is_reported_and_kept() {
        let data = data_dir();
        fs::create_dir(file(data.path())).unwrap();
        assert!(read(data.path()).is_err());
        assert!(add(data.path(), "/Users/me/Notes").is_err());
        assert!(file(data.path()).is_dir());
    }

    /// An earlier build's list is neither read nor migrated nor changed.
    #[test]
    fn folders_json_is_never_read_or_touched() {
        let data = data_dir();
        let old = data.path().join("folders.json");
        let contents = r#"{"homes":{"epicenter":"/records"},"folders":["/old/shortcut"]}"#;
        fs::write(&old, contents).unwrap();
        assert!(read(data.path()).unwrap().is_empty());
        add(data.path(), "/new/shortcut").unwrap();
        assert_eq!(read(data.path()).unwrap(), ["/new/shortcut"]);
        assert_eq!(fs::read_to_string(&old).unwrap(), contents);
    }

    /// Writers in turn lose no one's entry: each reads the list under the
    /// lock that the last one released.
    #[test]
    fn concurrent_writers_keep_every_update() {
        let data = data_dir();
        let threads: Vec<_> = (0..8)
            .map(|index| {
                let data = data.path().to_path_buf();
                std::thread::spawn(move || add(&data, &format!("/folder/{index}")).unwrap())
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let mut paths = read(data.path()).unwrap();
        paths.sort();
        assert_eq!(
            paths,
            (0..8)
                .map(|index| format!("/folder/{index}"))
                .collect::<Vec<_>>()
        );
    }

    /// The real CLI waits on a native holder and reads after acquiring the
    /// lock, preserving a native change made while it was waiting.
    #[test]
    fn cli_and_native_writers_share_the_lock_and_preserve_each_others_entries() {
        use std::process::{Command, Stdio};
        let data = data_dir();
        let root = data_dir();
        let added = root.path().join("Notes");
        fs::create_dir(&added).unwrap();
        let held = SaveLock::acquire(&file(data.path()), SAVE_LOCK_WAIT).unwrap();
        let mut child = Command::new("bun")
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/cli/src/bin.ts"))
            .args(["folders", "add"])
            .arg(&added)
            .arg("--json")
            .env("EPICENTER_DATA_DIR", data.path())
            .env("EPICENTER_FOLDER_DIR", root.path())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(
            child.try_wait().unwrap().is_none(),
            "CLI waits for the native lock"
        );
        fs::write(file(data.path()), "[\"/native/shortcut\"]").unwrap();
        drop(held);
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            read(data.path()).unwrap(),
            ["/native/shortcut", added.to_str().unwrap()]
        );
        forget(data.path(), "/native/shortcut").unwrap();
        assert_eq!(read(data.path()).unwrap(), [added.to_str().unwrap()]);
        assert!(!data.path().join("folders.json").exists());
    }

    /// Another holder of the lock delays a change rather than racing it.
    #[test]
    fn a_change_waits_for_another_holder_of_the_lock() {
        let data = data_dir();
        let held = SaveLock::acquire(&file(data.path()), SAVE_LOCK_WAIT).unwrap();
        let writer = {
            let data = data.path().to_path_buf();
            std::thread::spawn(move || add(&data, "/Users/me/Notes"))
        };
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(!file(data.path()).exists(), "the writer waited");
        drop(held);
        writer.join().unwrap().unwrap();
        assert_eq!(read(data.path()).unwrap(), ["/Users/me/Notes"]);
    }
}
