//! Machine-local folder choices in `<AppData>/folders.json`.
//!
//! Native shells and the CLI read the same object and take the exclusive
//! SQLite lock `.folders.json.epicenter-save-lock` before read/change/replace.
//! Previous shortcut arrays and records-only selections convert on a real change.

use std::collections::BTreeMap;
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use crate::directory::Directory;
use crate::lock::{SaveLock, SAVE_LOCK_WAIT};
use serde::{Deserialize, Serialize};

pub const FILE: &str = "folders.json";
/// The initial location only. A selected folder is identified by its stored path.
pub const DEFAULT_EPICENTER_FOLDER: &str = "so.epicenter";

/// A stable home key and the folder name suggested before first selection.
#[derive(Clone, Copy, Debug)]
pub struct Home {
    pub key: &'static str,
    pub folder_name: &'static str,
}

pub const EPICENTER: Home = Home {
    key: "epicenter",
    folder_name: DEFAULT_EPICENTER_FOLDER,
};
pub const TODOS: Home = Home {
    key: "todos",
    folder_name: "Todos",
};

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FoldersConfig {
    /// Canonical machine-local paths, selected on first use or explicitly.
    pub homes: BTreeMap<String, String>,
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

/// Read a home or its initial suggestion without creating anything.
pub fn home_path(data_dir: &Path, folder_dir: &Path, home: Home) -> Result<PathBuf, String> {
    Ok(path_in(&read(data_dir)?, folder_dir, home))
}

fn path_in(config: &FoldersConfig, folder_dir: &Path, home: Home) -> PathBuf {
    config
        .homes
        .get(home.key)
        .map(PathBuf::from)
        .unwrap_or_else(|| folder_dir.join(home.folder_name))
}

/// Protect selected records, or an existing legacy default that no saved app
/// home already claims. A later root cannot override an anchored selection.
pub fn protected_records(config: &FoldersConfig, folder_dir: &Path) -> Option<PathBuf> {
    if let Some(path) = config.homes.get(EPICENTER.key) {
        return Some(resolved(Path::new(path)));
    }
    let directory = Directory::existing(&folder_dir.join(EPICENTER.folder_name)).ok()?;
    check_namespace(directory.root()).ok()?;
    let footprint = directory_paths(directory.root()).ok()?;
    for path in config.homes.values() {
        let home = directory_paths(Path::new(path)).ok()?;
        if footprint
            .iter()
            .any(|path| home.iter().any(|home| overlaps(path, home)))
        {
            return None;
        }
    }
    Some(directory.root().to_path_buf())
}

/// Select the initial home under the shared lock. A selected missing home
/// fails rather than creating an empty replacement or choosing another root.
pub fn open_home(data_dir: &Path, folder_dir: &Path, home: Home) -> Result<Directory, String> {
    update(data_dir, |config| {
        if let Some(path) = config.homes.get(home.key) {
            validate_home(config, data_dir, folder_dir, home, Path::new(path))?;
            return Directory::existing(Path::new(path))
                .map_err(|error| format!("The {} home could not be opened: {error}. Locate it or change its home in folders.json.", home.folder_name));
        }
        let path = folder_dir.join(home.folder_name);
        validate_home(config, data_dir, folder_dir, home, &path)?;
        let directory = Directory::create(&path).map_err(|error| error.to_string())?;
        config.homes.insert(
            home.key.to_string(),
            directory
                .root()
                .to_str()
                .ok_or("The home folder path is not UTF-8.")?
                .to_string(),
        );
        Ok(directory)
    })
}

/// Select an existing directory. Files and existing window bindings stay put.
pub fn select_home(
    data_dir: &Path,
    folder_dir: &Path,
    home: Home,
    path: &Path,
) -> Result<Directory, String> {
    let directory = Directory::existing(path).map_err(|error| error.to_string())?;
    update(data_dir, |config| {
        validate_home(config, data_dir, folder_dir, home, directory.root())?;
        config.homes.insert(
            home.key.to_string(),
            directory
                .root()
                .to_str()
                .ok_or("The home folder path is not UTF-8.")?
                .to_string(),
        );
        Ok(directory)
    })
}

fn validate_home(
    config: &FoldersConfig,
    data_dir: &Path,
    folder_dir: &Path,
    home: Home,
    path: &Path,
) -> Result<(), String> {
    if home.key != EPICENTER.key {
        return check_app_directory(
            data_dir,
            protected_records(config, folder_dir).as_deref(),
            path,
        );
    }
    let candidate = directory_paths(path)?;
    check_namespace(&candidate[0])?;
    let data = resolved(data_dir);
    if candidate.iter().any(|path| overlaps(path, &data)) {
        return Err(
            "A home folder cannot overlap Epicenter's machine-local application data.".into(),
        );
    }
    for (key, other) in &config.homes {
        if key == EPICENTER.key {
            continue;
        }
        let other = directory_paths(Path::new(other))?;
        if candidate
            .iter()
            .any(|path| other.iter().any(|other| overlaps(path, other)))
        {
            return Err(format!(
                "Epicenter's records folder cannot overlap the {key} home."
            ));
        }
    }
    Ok(())
}

/// Saving also writes to a sibling staging directory. Admit both locations.
fn directory_paths(path: &Path) -> Result<[PathBuf; 2], String> {
    let root = resolved(path);
    let scratch = resolved(&crate::storage::scratch_directory(&root)?);
    Ok([root, scratch])
}

fn check_namespace(root: &Path) -> Result<(), String> {
    if root.components().any(|component| {
        let name = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        name.starts_with('.') && name.ends_with(".epicenter-scratch")
    }) {
        return Err("Save staging directories cannot be opened as authored folders.".into());
    }
    Ok(())
}

/// Admit an app home or one-time launch by the same protected-folder rule.
/// Callers with unreadable configuration may omit records so unrelated folder
/// editors remain available for repair; application data stays protected.
pub fn check_app_directory(
    data_dir: &Path,
    records: Option<&Path>,
    path: &Path,
) -> Result<(), String> {
    let candidate = directory_paths(path)?;
    check_namespace(&candidate[0])?;
    let mut protected = vec![resolved(data_dir)];
    if let Some(records) = records {
        protected.extend(directory_paths(records)?);
    }
    if candidate
        .iter()
        .any(|candidate| protected.iter().any(|path| overlaps(candidate, path)))
    {
        return Err(
            "This folder holds Epicenter's own files, so it cannot be opened in an app.".into(),
        );
    }
    Ok(())
}

/// Resolve existing ancestors and normalize missing components too.
pub fn resolved(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                result.pop();
            }
            std::path::Component::CurDir => {}
            _ => {
                result.push(component.as_os_str());
                if let Ok(canonical) = dunce::canonicalize(&result) {
                    result = canonical;
                }
            }
        }
    }
    result
}

/// Compare containment including alternative OS spellings of one directory.
fn overlaps(candidate: &Path, protected: &Path) -> bool {
    candidate.starts_with(protected)
        || protected.starts_with(candidate)
        || candidate
            .ancestors()
            .any(|path| same_file::is_same_file(path, protected).unwrap_or(false))
        || protected
            .ancestors()
            .any(|path| same_file::is_same_file(path, candidate).unwrap_or(false))
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
    // Named migrations: shortcut arrays, then the records-only selection.
    let config = if value.is_array() {
        FoldersConfig {
            homes: BTreeMap::new(),
            folders: serde_json::from_value(value).map_err(|error| error.to_string())?,
        }
    } else if value.get("epicenter").is_some() {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Legacy {
            epicenter: Option<String>,
            folders: Vec<String>,
        }
        let legacy: Legacy = serde_json::from_value(value).map_err(|error| error.to_string())?;
        FoldersConfig {
            homes: legacy
                .epicenter
                .map(|path| (EPICENTER.key.to_string(), path))
                .into_iter()
                .collect(),
            folders: legacy.folders,
        }
    } else {
        serde_json::from_value::<FoldersConfig>(value).map_err(|error| error.to_string())?
    };
    if config
        .homes
        .values()
        .any(|path| !Path::new(path).is_absolute())
    {
        return Err("each home must be an absolute folder path".to_string());
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

    /// The CLI consumes these same cases, including root changes, links,
    /// occupied destinations, and records overlapping another app's home.
    #[cfg(unix)]
    #[test]
    fn records_allocation_matches_the_shared_cli_cases() {
        #[derive(Deserialize)]
        struct Case {
            name: String,
            data: Option<String>,
            root: String,
            homes: BTreeMap<String, String>,
            #[serde(default)]
            directories: Vec<String>,
            #[serde(default)]
            files: Vec<String>,
            #[serde(default)]
            links: BTreeMap<String, String>,
            allowed: bool,
        }
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../../fixtures/home-allocation.json")).unwrap();
        for case in cases {
            let temp = tempfile::tempdir().unwrap();
            let base = dunce::canonicalize(temp.path()).unwrap();
            let data = base.join(case.data.as_deref().unwrap_or("machine"));
            let root = base.join(&case.root);
            fs::create_dir_all(&data).unwrap();
            for directory in &case.directories {
                fs::create_dir_all(base.join(directory)).unwrap();
            }
            for file in &case.files {
                let path = base.join(file);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, "keep").unwrap();
            }
            for (alias, target) in &case.links {
                let path = base.join(alias);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::os::unix::fs::symlink(base.join(target), path).unwrap();
            }
            let homes: BTreeMap<String, String> = case
                .homes
                .iter()
                .map(|(key, path)| (key.clone(), base.join(path).to_str().unwrap().to_string()))
                .collect();
            let mut expected = FoldersConfig {
                homes,
                folders: vec!["relative/keep".into()],
            };
            let original = serde_json::to_vec(&expected).unwrap();
            fs::write(file(&data), &original).unwrap();
            let candidate = path_in(&expected, &root, EPICENTER);
            let existed = candidate.exists();
            let opened = open_home(&data, &root, EPICENTER);
            assert_eq!(opened.is_ok(), case.allowed, "{}: {opened:?}", case.name);
            if case.allowed {
                let canonical = dunce::canonicalize(&candidate).unwrap();
                assert_eq!(opened.unwrap().root(), canonical);
                expected
                    .homes
                    .insert(EPICENTER.key.into(), canonical.to_str().unwrap().into());
                assert_eq!(read(&data).unwrap(), expected, "{}", case.name);
            } else {
                assert_eq!(fs::read(file(&data)).unwrap(), original, "{}", case.name);
                assert_eq!(candidate.exists(), existed, "{}", case.name);
            }
            for path in &case.files {
                assert_eq!(
                    fs::read_to_string(base.join(path)).unwrap(),
                    "keep",
                    "{}",
                    case.name
                );
            }
        }
    }

    #[test]
    fn every_home_uses_one_selection_rule_and_root_changes_do_not_redirect_it() {
        let data = data_dir();
        let root = data_dir();
        let changed_root = root.path().join("Code");
        for home in [TODOS, EPICENTER] {
            let original = open_home(data.path(), root.path(), home).unwrap();
            assert_eq!(
                open_home(data.path(), &changed_root, home).unwrap(),
                original
            );
            assert!(!changed_root.exists());
            let chosen = root.path().join(format!("different-{}", home.key));
            fs::create_dir(&chosen).unwrap();
            let selected = select_home(data.path(), root.path(), home, &chosen).unwrap();
            assert_eq!(
                open_home(data.path(), &changed_root, home).unwrap(),
                selected
            );
            assert_ne!(original, selected);
            assert!(original.root().is_dir());
            fs::remove_dir(&chosen).unwrap();
            assert!(open_home(data.path(), root.path(), home).is_err());
            assert!(!chosen.exists());
        }
        assert_eq!(read(data.path()).unwrap().homes.len(), 2);
    }

    #[test]
    fn concurrent_first_launches_with_different_roots_select_one_home() {
        let data = data_dir();
        let root = data_dir();
        let gate = std::sync::Arc::new(std::sync::Barrier::new(2));
        let threads: Vec<_> = ["first", "second"]
            .into_iter()
            .map(|name| {
                let data = data.path().to_path_buf();
                let root = root.path().join(name);
                let gate = gate.clone();
                std::thread::spawn(move || {
                    gate.wait();
                    open_home(&data, &root, TODOS).unwrap()
                })
            })
            .collect();
        let opened: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(opened[0], opened[1]);
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn a_later_root_inside_a_saved_app_home_does_not_reserve_unselected_records() {
        let data = data_dir();
        let root = data_dir();
        let original = open_home(data.path(), root.path(), TODOS).unwrap();
        let changed_root = original.root().join("nested");
        assert_eq!(
            open_home(data.path(), &changed_root, TODOS).unwrap(),
            original
        );
        assert!(open_home(data.path(), &changed_root, EPICENTER).is_err());
        assert!(!changed_root.exists());
        assert!(!read(data.path()).unwrap().homes.contains_key(EPICENTER.key));
        // Even an existing conventional name under the new root cannot
        // supersede the saved app's intent. Allocating records there still fails.
        let suggestion = changed_root.join(EPICENTER.folder_name);
        fs::create_dir_all(&suggestion).unwrap();
        fs::write(suggestion.join("keep.md"), "keep").unwrap();
        assert_eq!(
            open_home(data.path(), &changed_root, TODOS).unwrap(),
            original
        );
        assert!(open_home(data.path(), &changed_root, EPICENTER).is_err());
        assert_eq!(
            fs::read_to_string(suggestion.join("keep.md")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn an_unselected_legacy_records_directory_stays_protected_without_rewriting_config() {
        let data = data_dir();
        let root = data_dir();
        let records = root.path().join(EPICENTER.folder_name);
        fs::create_dir_all(&records).unwrap();
        fs::write(records.join("keep.md"), "keep").unwrap();
        fs::write(file(data.path()), "[]").unwrap();
        assert!(select_home(data.path(), root.path(), TODOS, &records).is_err());
        let config = read(data.path()).unwrap();
        let protected = protected_records(&config, root.path()).unwrap();
        assert!(check_app_directory(data.path(), Some(&protected), &records).is_err());
        assert_eq!(fs::read_to_string(file(data.path())).unwrap(), "[]");
        assert_eq!(fs::read_to_string(records.join("keep.md")).unwrap(), "keep");
        // A disjoint invalid saved choice must not erase the legacy protection.
        fs::write(
            file(data.path()),
            serde_json::to_vec(&FoldersConfig {
                homes: [(
                    "todos".into(),
                    root.path()
                        .join("elsewhere/.old.epicenter-scratch")
                        .to_str()
                        .unwrap()
                        .into(),
                )]
                .into(),
                folders: vec![],
            })
            .unwrap(),
        )
        .unwrap();
        let before = fs::read(file(data.path())).unwrap();
        assert!(select_home(
            data.path(),
            root.path(),
            Home {
                key: "capture",
                folder_name: "Capture"
            },
            &records
        )
        .is_err());
        assert_eq!(fs::read(file(data.path())).unwrap(), before);
    }

    #[test]
    fn ordinary_homes_and_one_time_launches_cannot_use_staging_roots_or_descendants() {
        let data = data_dir();
        let root = data_dir();
        open_home(data.path(), root.path(), TODOS).unwrap();
        let before = fs::read(file(data.path())).unwrap();
        let capture = Home {
            key: "capture",
            folder_name: "Capture",
        };
        for name in [
            ".Todos.epicenter-scratch",
            ".Todos.epicenter-scratch/nested",
            ".Todos.EPICENTER-SCRATCH",
        ] {
            let staging = root.path().join(name);
            fs::create_dir_all(&staging).unwrap();
            assert!(select_home(data.path(), root.path(), capture, &staging).is_err());
            assert!(check_app_directory(data.path(), None, &staging).is_err());
            assert_eq!(fs::read(file(data.path())).unwrap(), before);
        }
    }

    #[test]
    fn app_and_records_homes_protect_each_others_staging_in_both_selection_orders() {
        for records_first in [false, true] {
            let data = data_dir();
            let root = data_dir();
            let initial = root
                .path()
                .join(if records_first { "Records" } else { "Todos" });
            let staging = crate::storage::scratch_directory(&initial).unwrap();
            fs::create_dir_all(&initial).unwrap();
            fs::create_dir_all(&staging).unwrap();
            let (first, second) = if records_first {
                (EPICENTER, TODOS)
            } else {
                (TODOS, EPICENTER)
            };
            let first_path = &initial;
            let second_path = &staging;
            select_home(data.path(), root.path(), first, first_path).unwrap();
            let before = fs::read(file(data.path())).unwrap();
            assert!(select_home(data.path(), root.path(), second, second_path).is_err());
            assert_eq!(fs::read(file(data.path())).unwrap(), before);
            // One-time native launches obey the same root and staging rule.
            assert!(check_app_directory(data.path(), None, &staging).is_err());
        }
    }

    #[test]
    fn an_apps_staging_directory_cannot_be_application_data() {
        let root = data_dir();
        let todo = root.path().join("Todos");
        let data = crate::storage::scratch_directory(&todo).unwrap();
        fs::create_dir_all(&todo).unwrap();
        fs::create_dir_all(&data).unwrap();
        assert!(select_home(&data, root.path(), TODOS, &todo).is_err());
        assert!(check_app_directory(&data, None, &todo).is_err());
        assert!(!file(&data).exists());
    }

    #[test]
    fn legacy_records_migrate_only_on_a_real_change_and_all_homes_survive_shortcut_writes() {
        let data = data_dir();
        let root = data_dir();
        let records = root.path().join("My setup");
        fs::create_dir(&records).unwrap();
        let legacy = serde_json::to_vec(
            &serde_json::json!({"epicenter": records, "folders": ["relative/keep"]}),
        )
        .unwrap();
        fs::write(file(data.path()), &legacy).unwrap();
        assert_eq!(
            home_path(data.path(), root.path(), EPICENTER).unwrap(),
            records
        );
        assert_eq!(fs::read(file(data.path())).unwrap(), legacy);
        open_home(data.path(), root.path(), TODOS).unwrap();
        add(data.path(), "/another/shortcut").unwrap();
        let config = read(data.path()).unwrap();
        assert_eq!(config.homes[EPICENTER.key], records.to_str().unwrap());
        assert!(config.homes.contains_key(TODOS.key));
        assert_eq!(config.folders, ["relative/keep", "/another/shortcut"]);
        assert!(
            serde_json::from_slice::<serde_json::Value>(&fs::read(file(data.path())).unwrap())
                .unwrap()
                .get("epicenter")
                .is_none()
        );
    }

    #[test]
    fn occupied_invalid_and_protected_destinations_never_allocate_an_alternative() {
        let data = data_dir();
        let root = data_dir();
        let occupied = root.path().join(TODOS.folder_name);
        fs::write(&occupied, "keep").unwrap();
        assert!(open_home(data.path(), root.path(), TODOS).is_err());
        assert_eq!(fs::read_to_string(&occupied).unwrap(), "keep");
        assert!(!file(data.path()).exists());
        fs::remove_file(&occupied).unwrap();
        let records = open_home(data.path(), root.path(), EPICENTER).unwrap();
        for candidate in [records.root(), data.path(), root.path()] {
            assert!(select_home(data.path(), root.path(), TODOS, candidate).is_err());
        }
        let todo = open_home(data.path(), root.path(), TODOS).unwrap();
        assert!(select_home(data.path(), root.path(), EPICENTER, todo.root()).is_err());
        assert!(select_home(
            data.path(),
            root.path(),
            TODOS,
            &root.path().join("missing")
        )
        .is_err());
        assert!(!root.path().join("missing").exists());
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
                homes: [("epicenter".into(), selected.to_str().unwrap().into())].into(),
                folders: vec![],
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            open_home(data.path(), root.path(), EPICENTER)
                .unwrap()
                .root(),
            dunce::canonicalize(&selected).unwrap()
        );
        add(data.path(), "/other/folder").unwrap();
        forget(data.path(), "/other/folder").unwrap();
        assert_eq!(
            read(data.path())
                .unwrap()
                .homes
                .get("epicenter")
                .map(String::as_str),
            selected.to_str()
        );
        fs::remove_dir(&selected).unwrap();
        assert!(open_home(data.path(), root.path(), EPICENTER).is_err());
        assert!(!selected.exists());
        assert!(!root.path().join(DEFAULT_EPICENTER_FOLDER).exists());
    }

    #[test]
    fn first_settings_open_selects_the_default_without_losing_shortcuts() {
        let data = data_dir();
        let root = data_dir();
        add(data.path(), "/other/folder").unwrap();
        let directory = open_home(data.path(), root.path(), EPICENTER).unwrap();
        let config = read(data.path()).unwrap();
        assert_eq!(
            config.homes.get("epicenter").map(String::as_str),
            directory.root().to_str()
        );
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
            homes: [("epicenter".into(), selected.to_str().unwrap().into())].into(),
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
        assert_eq!(saved.homes, config.homes);
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
        assert_eq!(read(data.path()).unwrap().homes.get("epicenter"), None);
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
