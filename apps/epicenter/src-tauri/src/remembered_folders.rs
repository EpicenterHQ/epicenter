//! The folders this machine remembers: `<Epicenter app data>/folders.json`
//! (ADR-0641).
//!
//! The file is an optional JSON array of absolute directory paths, with no
//! IDs. An absent file is an empty list. Each entry is a shortcut a person
//! accepted, not a permission grant: the Folders window opens an entry only
//! through the same checks an opening request gets (`folder_opening`).
//!
//! Every change is one read, change, and whole-file replace, held under the
//! file's save lock, `.folders.json.epicenter-save-lock` beside it. That is
//! the lock every Epicenter folder save takes (`epicenter_folder_core::lock`),
//! an exclusive SQLite transaction that `bun:sqlite` takes too, so a CLI that
//! later writes this file can take turns with the desktop without a service.
//! The replace is a rename of a staged file, so a reader sees the old list or
//! the new one.
//!
//! Content that is not an array of strings, or a path that is not a regular
//! file, is reported and left byte-for-byte as it is: no change is written
//! over a format this build cannot preserve. A string that is not an absolute
//! path stays in the list; the Folders window shows it with its problem so it
//! can be forgotten. A change that changes nothing writes nothing.

use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use epicenter_folder_core::lock::{SaveLock, SAVE_LOCK_WAIT};

/// The list's file name in Epicenter's app data directory.
pub const FILE: &str = "folders.json";

/// Where the list lives for the app data directory `data_dir`.
pub fn file(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE)
}

/// The remembered paths, in the file's order. An absent file is empty.
pub fn read(data_dir: &Path) -> Result<Vec<String>, String> {
    let path = file(data_dir);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(unreadable(&path, &error.to_string())),
        Ok(stats) if !stats.file_type().is_file() => {
            return Err(unsupported(&path, "it is not a regular file"))
        }
        Ok(_) => {}
    }
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        // Removed between the two looks: as absent.
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(unreadable(&path, &error.to_string())),
    };
    parse(&bytes).map_err(|reason| unsupported(&path, &reason))
}

/// Remember `directory`. Already remembered, it changes nothing.
pub fn add(data_dir: &Path, directory: &str) -> Result<(), String> {
    update(data_dir, |paths| {
        if paths.iter().any(|path| path == directory) {
            return false;
        }
        paths.push(directory.to_string());
        true
    })
}

/// Forget every entry spelled `directory`, whether or not it still exists.
/// Not remembered, it changes nothing.
pub fn forget(data_dir: &Path, directory: &str) -> Result<(), String> {
    update(data_dir, |paths| {
        let before = paths.len();
        paths.retain(|path| path != directory);
        paths.len() != before
    })
}

/// Read the list, let `change` edit it, and replace the file whole when it
/// answers that it changed, all under the file's save lock.
fn update(data_dir: &Path, change: impl FnOnce(&mut Vec<String>) -> bool) -> Result<(), String> {
    let path = file(data_dir);
    fs::create_dir_all(data_dir).map_err(|error| not_saved(&path, &error.to_string()))?;
    let _turn =
        SaveLock::acquire(&path, SAVE_LOCK_WAIT).map_err(|error| not_saved(&path, &error))?;
    let mut paths = read(data_dir)?;
    if !change(&mut paths) {
        return Ok(());
    }
    let mut text = serde_json::to_string_pretty(&paths)
        .map_err(|error| not_saved(&path, &error.to_string()))?;
    text.push('\n');
    let mut staged = tempfile::Builder::new()
        .prefix(".folders.json.")
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

/// The paths in `bytes`, or why they are not a list this build can keep.
fn parse(bytes: &[u8]) -> Result<Vec<String>, String> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|error| format!("it is not valid JSON ({error})"))?;
    let serde_json::Value::Array(entries) = value else {
        return Err("it is not a JSON array of folder paths".to_string());
    };
    entries
        .into_iter()
        .map(|entry| match entry {
            serde_json::Value::String(path) => Ok(path),
            _ => Err("an entry is not a string".to_string()),
        })
        .collect()
}

fn unreadable(path: &Path, reason: &str) -> String {
    format!("{} could not be read: {reason}", path.display())
}

fn unsupported(path: &Path, reason: &str) -> String {
    format!(
        "{} was left unchanged because {reason}. Repair or remove it to remember folders again.",
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
        assert_eq!(read(data.path()).unwrap(), Vec::<String>::new());
        assert!(!file(data.path()).exists());
    }

    #[test]
    fn adding_twice_remembers_one_entry_as_a_plain_json_array() {
        let data = data_dir();
        add(data.path(), "/Users/me/Notes").unwrap();
        add(data.path(), "/Users/me/Notes").unwrap();
        add(data.path(), "/Users/me/Vault").unwrap();
        assert_eq!(
            fs::read_to_string(file(data.path())).unwrap(),
            "[\n  \"/Users/me/Notes\",\n  \"/Users/me/Vault\"\n]\n"
        );
        assert_eq!(
            read(data.path()).unwrap(),
            ["/Users/me/Notes", "/Users/me/Vault"]
        );
    }

    #[test]
    fn forgetting_needs_no_directory_and_an_absent_entry_writes_nothing() {
        let data = data_dir();
        add(data.path(), "/gone/away").unwrap();
        forget(data.path(), "/gone/away").unwrap();
        assert_eq!(fs::read_to_string(file(data.path())).unwrap(), "[]\n");

        let before = fs::metadata(file(data.path())).unwrap().modified().unwrap();
        forget(data.path(), "/never/there").unwrap();
        assert_eq!(
            fs::metadata(file(data.path())).unwrap().modified().unwrap(),
            before
        );
    }

    #[test]
    fn unsupported_contents_are_reported_and_left_byte_identical() {
        for contents in [
            &b"not json"[..],
            b"{\"paths\": []}",
            b"[\"/ok\", 7]",
            b"[{\"path\": \"/with/id\", \"id\": 1}]",
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

    /// Writers in turn lose no one's entry: each reads the list under the
    /// save lock that the last one released.
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

    /// Another process holding the lock (here, one held directly) delays a
    /// change rather than racing it.
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
        assert!(data
            .path()
            .join(".folders.json.epicenter-save-lock")
            .is_file());
    }
}
