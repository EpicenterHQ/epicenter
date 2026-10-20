//! Machine-local folder choices in `<AppData>/folders.json`.
//!
//! Both the desktop and CLI read the same object and take the exclusive
//! SQLite lock `.folders.json.epicenter-save-lock` before read/change/replace.
//! Older path arrays are read without writing, then converted on a real change.

use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use epicenter_folder_core::lock::{SaveLock, SAVE_LOCK_WAIT};
use serde::{Deserialize, Serialize};
use tauri_plugin_epicenter_folder::Directory;

pub const FILE: &str = "folders.json";
/// The initial location only. A selected folder is identified by its stored path.
pub const DEFAULT_EPICENTER_FOLDER: &str = "so.epicenter";

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FoldersConfig {
    /// None until Settings or a connection write selects the initial folder.
    pub epicenter: Option<String>,
    pub folders: Vec<String>,
}

pub fn file(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE)
}

/// Read without creating anything. An absent file has no selected records folder.
pub fn read(data_dir: &Path) -> Result<FoldersConfig, String> {
    let path = file(data_dir);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(FoldersConfig::default()),
        Err(error) => return Err(format!("{} could not be read: {error}", path.display())),
        Ok(stats) if !stats.file_type().is_file() => {
            return Err(unsupported(&path, "it is not a regular file"))
        }
        Ok(_) => {}
    }
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(FoldersConfig::default()),
        Err(error) => return Err(format!("{} could not be read: {error}", path.display())),
    };
    parse(&bytes).map_err(|reason| unsupported(&path, &reason))
}

/// The selected records location, or the initial default before selection.
pub fn epicenter_path(data_dir: &Path, folder_dir: &Path) -> Result<PathBuf, String> {
    Ok(read(data_dir)?
        .epicenter
        .map(PathBuf::from)
        .unwrap_or_else(|| folder_dir.join(DEFAULT_EPICENTER_FOLDER)))
}

/// Select the initial records folder under the config lock. A stored selection
/// must exist: moving it never silently creates an empty replacement.
pub fn open_epicenter(data_dir: &Path, folder_dir: &Path) -> Result<Directory, String> {
    update(data_dir, |config| {
        if let Some(path) = &config.epicenter {
            return Directory::existing(Path::new(path))
                .map_err(|error| format!("The Epicenter data folder could not be opened: {error}. Repair its path in folders.json."));
        }
        let directory = Directory::create(&folder_dir.join(DEFAULT_EPICENTER_FOLDER))
            .map_err(|error| error.to_string())?;
        config.epicenter = Some(
            directory
                .root()
                .to_str()
                .ok_or("The Epicenter data folder path is not UTF-8.")?
                .to_string(),
        );
        Ok(directory)
    })
}

/// Add a shortcut once, preserving the selected records folder.
pub fn add(data_dir: &Path, directory: &str) -> Result<(), String> {
    update(data_dir, |config| {
        if !config.folders.iter().any(|path| path == directory) {
            config.folders.push(directory.to_string());
        }
        Ok(())
    })
}

/// Forget only the exact shortcut, even when the directory no longer exists.
pub fn forget(data_dir: &Path, directory: &str) -> Result<(), String> {
    update(data_dir, |config| {
        config.folders.retain(|path| path != directory);
        Ok(())
    })
}

fn update<T>(
    data_dir: &Path,
    change: impl FnOnce(&mut FoldersConfig) -> Result<T, String>,
) -> Result<T, String> {
    let path = file(data_dir);
    fs::create_dir_all(data_dir).map_err(|error| not_saved(&path, &error.to_string()))?;
    let _turn =
        SaveLock::acquire(&path, SAVE_LOCK_WAIT).map_err(|reason| not_saved(&path, &reason))?;
    let mut config = read(data_dir)?;
    let before = config.clone();
    let answer = change(&mut config)?;
    if config == before {
        return Ok(answer);
    }
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?
    );
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
    Ok(answer)
}

fn parse(bytes: &[u8]) -> Result<FoldersConfig, String> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|error| format!("it is not valid JSON ({error})"))?;
    // Named migration: existing desktop installations stored just the shortcuts.
    if value.is_object() && (value.get("epicenter").is_none() || value.get("folders").is_none()) {
        return Err("expected epicenter and folders fields".to_string());
    }
    let config = if value.is_array() {
        FoldersConfig {
            epicenter: None,
            folders: serde_json::from_value(value).map_err(|error| error.to_string())?,
        }
    } else {
        serde_json::from_value::<FoldersConfig>(value).map_err(|error| error.to_string())?
    };
    if config
        .epicenter
        .as_ref()
        .is_some_and(|path| !Path::new(path).is_absolute())
    {
        return Err("epicenter must be an absolute folder path or null".to_string());
    }
    Ok(config)
}

fn unsupported(path: &Path, reason: &str) -> String {
    format!("{} was left unchanged because {reason}. Repair folders.json to use folder configuration again.", path.display())
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
    fn selection_survives_shortcut_changes_and_a_missing_selection_is_never_recreated() {
        let data = data_dir();
        let root = data_dir();
        let selected = root.path().join("My setup");
        fs::create_dir(&selected).unwrap();
        fs::write(
            file(data.path()),
            serde_json::to_vec(&FoldersConfig {
                epicenter: Some(selected.to_str().unwrap().into()),
                folders: vec![],
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            open_epicenter(data.path(), root.path()).unwrap().root(),
            dunce::canonicalize(&selected).unwrap()
        );
        add(data.path(), "/other/folder").unwrap();
        forget(data.path(), "/other/folder").unwrap();
        assert_eq!(
            read(data.path()).unwrap().epicenter.as_deref(),
            selected.to_str()
        );
        fs::remove_dir(&selected).unwrap();
        assert!(open_epicenter(data.path(), root.path()).is_err());
        assert!(!selected.exists());
        assert!(!root.path().join(DEFAULT_EPICENTER_FOLDER).exists());
    }

    #[test]
    fn first_settings_open_selects_the_default_without_losing_shortcuts() {
        let data = data_dir();
        let root = data_dir();
        add(data.path(), "/other/folder").unwrap();
        let directory = open_epicenter(data.path(), root.path()).unwrap();
        let config = read(data.path()).unwrap();
        assert_eq!(config.epicenter.as_deref(), directory.root().to_str());
        assert_eq!(config.folders, ["/other/folder"]);
    }

    /// The real CLI waits on a native holder and reads after acquiring the
    /// lock, preserving a native change made while it was waiting.
    #[test]
    fn cli_and_native_writers_share_the_lock_and_preserve_each_others_fields() {
        use std::process::{Command, Stdio};
        let data = data_dir();
        let root = data_dir();
        let selected = root.path().join("My setup");
        fs::create_dir(&selected).unwrap();
        let added = root.path().join("Notes");
        fs::create_dir(&added).unwrap();
        let mut config = FoldersConfig {
            epicenter: Some(selected.to_str().unwrap().into()),
            folders: vec![],
        };
        fs::write(file(data.path()), serde_json::to_vec(&config).unwrap()).unwrap();
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
        config.folders.push("/native/shortcut".into());
        fs::write(file(data.path()), serde_json::to_vec(&config).unwrap()).unwrap();
        drop(held);
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        let saved = read(data.path()).unwrap();
        assert_eq!(saved.epicenter, config.epicenter);
        assert_eq!(saved.folders, ["/native/shortcut", added.to_str().unwrap()]);
        forget(data.path(), "/native/shortcut").unwrap();
        assert_eq!(
            read(data.path()).unwrap().folders,
            [added.to_str().unwrap()]
        );
    }

    #[test]
    fn an_absent_list_is_empty_and_reading_it_creates_nothing() {
        let data = data_dir();
        assert_eq!(read(data.path()).unwrap().folders, Vec::<String>::new());
        assert!(!file(data.path()).exists());
    }

    #[test]
    fn adding_twice_remembers_one_entry_without_selecting_a_records_folder() {
        let data = data_dir();
        add(data.path(), "/Users/me/Notes").unwrap();
        add(data.path(), "/Users/me/Notes").unwrap();
        add(data.path(), "/Users/me/Vault").unwrap();
        assert_eq!(read(data.path()).unwrap().epicenter, None);
        assert_eq!(
            read(data.path()).unwrap().folders,
            ["/Users/me/Notes", "/Users/me/Vault"]
        );
    }

    #[test]
    fn forgetting_needs_no_directory_and_an_absent_entry_writes_nothing() {
        let data = data_dir();
        add(data.path(), "/gone/away").unwrap();
        forget(data.path(), "/gone/away").unwrap();
        assert!(read(data.path()).unwrap().folders.is_empty());

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
            read(data.path()).unwrap().folders,
            ["relative/notes", "/a/b/", "/Users/me/Notes"]
        );
        forget(data.path(), "relative/notes").unwrap();
        assert_eq!(
            read(data.path()).unwrap().folders,
            ["/a/b/", "/Users/me/Notes"]
        );
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
        let mut paths = read(data.path()).unwrap().folders;
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
        assert_eq!(read(data.path()).unwrap().folders, ["/Users/me/Notes"]);
        assert!(data
            .path()
            .join(".folders.json.epicenter-save-lock")
            .is_file());
    }
}
