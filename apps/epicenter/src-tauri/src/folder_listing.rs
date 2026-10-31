//! A derived, grouped launcher list. IDs name resolved directories, never
//! titles or grants; an opening rebuilds membership before admitting its row.

use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_epicenter_folder::Directory;

use crate::data_folders::{folder_title, list_in};
use crate::folder_opening::{remember_opened, FolderOpenings, OpenedFolder};
use crate::{folder_windows, DesktopAppHandle};
use epicenter_folder_core::{library, navigation};
use tauri_plugin_epicenter_folder::defaults::DesktopPaths;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum FolderGroup {
    Pinned,
    Library,
    Recent,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ListedFolder {
    pub id: String,
    pub title: String,
    /// Display only. Openings pass the ID and recheck current membership.
    pub path: String,
    pub group: FolderGroup,
    /// A pinned or library folder can also have a removable recent entry.
    pub recent: bool,
    pub protected: bool,
    pub default_for: Option<String>,
    pub temporary: bool,
    pub problem: Option<String>,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FolderListing {
    pub folders: Vec<ListedFolder>,
    pub library_name: String,
    pub problems: Vec<String>,
}

pub(crate) fn folder_id(path: &Path) -> String {
    let digest = Sha256::digest(path.as_os_str().as_encoded_bytes());
    format!("folder:{digest:x}")
}

fn same_directory(first: &Path, second: &Path) -> bool {
    first == second || same_file::is_same_file(first, second).unwrap_or(false)
}

fn same_reference(first: &str, second: &str) -> bool {
    first == second
        || same_directory(
            &library::resolved(Path::new(first)),
            &library::resolved(Path::new(second)),
        )
}

pub(crate) fn list(paths: &DesktopPaths, openings: &FolderOpenings) -> FolderListing {
    let mut result = FolderListing {
        folders: Vec::new(),
        library_name: paths
            .folder_dir
            .file_name()
            .unwrap_or(paths.folder_dir.as_os_str())
            .to_string_lossy()
            .into_owned(),
        problems: Vec::new(),
    };
    let saved = match navigation::read(&paths.data_dir) {
        Ok(saved) => saved,
        Err(problem) => {
            result.problems.push(problem);
            navigation::Navigation::default()
        }
    };
    let children = match list_in(&paths.folder_dir) {
        Ok(children) => children,
        Err(problem) => {
            result.problems.push(problem);
            Vec::new()
        }
    };
    let mut add = |path: &str, source: FolderGroup, temporary: bool| {
        let candidate = Path::new(path);
        let checked = (|| {
            if !candidate.is_absolute() {
                return Err("This is not an absolute folder path.".to_string());
            }
            let directory = Directory::existing(candidate).map_err(|error| error.to_string())?;
            library::check_editable_directory(&paths.data_dir, directory.root())?;
            Ok(directory)
        })();
        let identity = checked
            .as_ref()
            .map(|directory| directory.root().to_path_buf())
            .unwrap_or_else(|_| library::resolved(candidate));
        let Some(identity_text) = identity.to_str() else {
            return;
        };
        let index = result
            .folders
            .iter()
            .position(|folder| same_directory(Path::new(&folder.path), &identity));
        let index = match index {
            Some(index) => index,
            None => {
                result.folders.push(ListedFolder {
                    id: folder_id(&identity),
                    title: if checked.is_ok() {
                        folder_title(&identity)
                    } else {
                        candidate
                            .file_name()
                            .unwrap_or(candidate.as_os_str())
                            .to_string_lossy()
                            .into_owned()
                    },
                    path: identity_text.to_string(),
                    group: source,
                    recent: false,
                    protected: library::check_app_directory(
                        &paths.data_dir,
                        &paths.folder_dir,
                        &identity,
                    )
                    .is_err(),
                    default_for: None,
                    temporary: false,
                    problem: checked.as_ref().err().cloned(),
                });
                result.folders.len() - 1
            }
        };
        let folder = &mut result.folders[index];
        if checked.is_ok() {
            if folder.problem.is_some() {
                folder.title = folder_title(&identity);
            }
            folder.problem = None;
        }
        if source == FolderGroup::Recent {
            folder.recent = true;
            folder.temporary |= temporary;
        }
        // Pinned > Library > Recent, regardless of the spelling found first.
        if source == FolderGroup::Pinned
            || (source == FolderGroup::Library && folder.group == FolderGroup::Recent)
        {
            folder.group = source;
        }
    };
    for path in &saved.pins {
        add(path, FolderGroup::Pinned, false);
    }
    for child in children {
        if let Some(path) = child.to_str() {
            add(path, FolderGroup::Library, false);
        }
    }
    for path in &saved.recent {
        add(path, FolderGroup::Recent, false);
    }
    let temporary = openings.temporary();
    for path in &temporary {
        add(path, FolderGroup::Recent, true);
    }
    for folder in &mut result.folders {
        if folder.problem.is_some() {
            continue;
        }
        let path = Path::new(&folder.path);
        if let Some(default) = library::ALL
            .into_iter()
            .find(|default| same_directory(path, &default.path(&paths.folder_dir)))
        {
            folder.title = default.title.to_string();
            folder.default_for = Some(default.title.to_string());
        }
    }
    // Keep unsaved openings together in this-run MRU order, ahead of the
    // durable history. Names order the other groups.
    result
        .folders
        .sort_by_cached_key(|folder| match folder.group {
            FolderGroup::Pinned => (0, folder.title.to_lowercase(), folder.path.clone()),
            FolderGroup::Library => (1, folder.title.to_lowercase(), folder.path.clone()),
            FolderGroup::Recent => {
                let rank = temporary
                    .iter()
                    .position(|path| same_reference(path, &folder.path))
                    .unwrap_or_else(|| {
                        temporary.len()
                            + saved
                                .recent
                                .iter()
                                .position(|path| same_reference(path, &folder.path))
                                .unwrap_or(saved.recent.len())
                    });
                (2, format!("{rank:08}"), folder.path.clone())
            }
        });
    result
}

#[tauri::command(async)]
#[specta::specta]
pub fn list_data_folders(app: DesktopAppHandle) -> FolderListing {
    list(&app.state::<DesktopPaths>(), &app.state::<FolderOpenings>())
}

fn current_row(
    paths: &DesktopPaths,
    openings: &FolderOpenings,
    id: &str,
) -> Result<ListedFolder, String> {
    list(paths, openings)
        .folders
        .into_iter()
        .find(|folder| folder.id == id)
        .ok_or_else(|| "This folder is no longer in the list.".to_string())
}

pub(crate) fn listed_directory(
    paths: &DesktopPaths,
    openings: &FolderOpenings,
    id: &str,
) -> Result<Directory, String> {
    let folder = current_row(paths, openings, id)?;
    if let Some(problem) = folder.problem {
        return Err(problem);
    }
    let directory =
        Directory::existing(Path::new(&folder.path)).map_err(|error| error.to_string())?;
    if folder_id(directory.root()) != id {
        return Err("This folder changed while it was being opened. Choose it again.".into());
    }
    Ok(directory)
}

#[tauri::command]
#[specta::specta]
pub async fn open_folder_editor(app: DesktopAppHandle, id: String) -> Result<OpenedFolder, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = app.state::<DesktopPaths>();
        let openings = app.state::<FolderOpenings>();
        let directory = listed_directory(&paths, &openings, &id)?;
        folder_windows::open_editor(&app, directory.clone())
            .map_err(|error| format!("{error:#}"))?;
        Ok(remember_opened(&openings, &paths, &directory))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn change_reference<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    source: FolderGroup,
    add: bool,
) -> Result<(), String> {
    let paths = app.state::<DesktopPaths>();
    let openings = app.state::<FolderOpenings>();
    let folder = current_row(&paths, &openings, id)?;
    if add {
        listed_directory(&paths, &openings, id)?;
    }
    let target = folder.path;
    if add {
        navigation::pin(&paths.data_dir, &target, |entry| {
            same_reference(entry, &target)
        })?;
    } else {
        let list = if source == FolderGroup::Pinned {
            navigation::List::Pins
        } else {
            navigation::List::Recent
        };
        navigation::remove(&paths.data_dir, list, |entry| {
            same_reference(entry, &target)
        })?;
    }
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
pub fn pin_folder(app: DesktopAppHandle, id: String) -> Result<(), String> {
    change_reference(&app, &id, FolderGroup::Pinned, true)
}

#[tauri::command(async)]
#[specta::specta]
pub fn unpin_folder(app: DesktopAppHandle, id: String) -> Result<(), String> {
    change_reference(&app, &id, FolderGroup::Pinned, false)
}

#[tauri::command(async)]
#[specta::specta]
pub fn remove_recent_folder(app: DesktopAppHandle, id: String) -> Result<(), String> {
    change_reference(&app, &id, FolderGroup::Recent, false)?;
    let openings = app.state::<FolderOpenings>();
    for path in openings.temporary() {
        if folder_id(&library::resolved(Path::new(&path))) == id {
            openings.forget(&path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Fixture {
        _temp: tempfile::TempDir,
        paths: DesktopPaths,
        openings: FolderOpenings,
    }

    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(temp.path()).unwrap();
        let paths = DesktopPaths {
            data_dir: root.join("AppData"),
            folder_dir: root.join("Epicenter Dev"),
        };
        fs::create_dir_all(&paths.folder_dir).unwrap();
        fs::create_dir_all(&paths.data_dir).unwrap();
        Fixture {
            _temp: temp,
            paths,
            openings: FolderOpenings::default(),
        }
    }

    #[test]
    fn pins_library_and_recent_merge_by_directory_identity_in_precedence_order() {
        let f = fixture();
        let child = f.paths.folder_dir.join("Notes");
        let outside = f.paths.folder_dir.parent().unwrap().join("Outside");
        fs::create_dir(&child).unwrap();
        fs::create_dir(&outside).unwrap();
        navigation::pin(&f.paths.data_dir, child.to_str().unwrap(), |_| false).unwrap();
        navigation::record_opening(&f.paths.data_dir, outside.to_str().unwrap(), |_| false)
            .unwrap();
        navigation::record_opening(&f.paths.data_dir, child.to_str().unwrap(), |_| false).unwrap();
        navigation::pin(&f.paths.data_dir, &format!("{}/.", child.display()), |_| {
            false
        })
        .unwrap();
        let listed = list(&f.paths, &f.openings);
        assert_eq!(listed.library_name, "Epicenter Dev");
        assert_eq!(listed.folders.len(), 2);
        assert_eq!(listed.folders[0].group, FolderGroup::Pinned);
        assert!(listed.folders[0].recent);
        assert_eq!(listed.folders[1].group, FolderGroup::Recent);
        assert_eq!(listed.folders[1].path, outside.to_str().unwrap());
    }

    #[test]
    fn listing_reads_titles_and_defaults_without_creating_a_missing_default() {
        let f = fixture();
        let child = f.paths.folder_dir.join("Notes");
        fs::create_dir(&child).unwrap();
        fs::write(child.join("epicenter.json"), r#"{"title":"Field notes"}"#).unwrap();
        let listed = list(&f.paths, &f.openings);
        assert_eq!(listed.folders[0].title, "Field notes");
        assert_eq!(listed.folders[0].group, FolderGroup::Library);
        assert!(!f.paths.folder_dir.join(library::TODOS.id).exists());
        let default = f.paths.folder_dir.join(library::TODOS.id);
        fs::create_dir(&default).unwrap();
        let listed = list(&f.paths, &f.openings);
        let row = listed
            .folders
            .iter()
            .find(|row| row.path == default.to_str().unwrap())
            .unwrap();
        assert_eq!(row.title, "Todos");
        assert_eq!(row.default_for.as_deref(), Some("Todos"));
    }

    #[test]
    fn missing_and_protected_refs_cannot_open_but_remain_visible_for_removal() {
        let f = fixture();
        let missing = f.paths.folder_dir.parent().unwrap().join("Missing");
        navigation::pin(&f.paths.data_dir, missing.to_str().unwrap(), |_| false).unwrap();
        let records = f.paths.folder_dir.join(library::RECORDS.id);
        fs::create_dir(&records).unwrap();
        navigation::record_opening(
            &f.paths.data_dir,
            f.paths.data_dir.to_str().unwrap(),
            |_| false,
        )
        .unwrap();
        let listed = list(&f.paths, &f.openings);
        let missing_row = listed
            .folders
            .iter()
            .find(|row| row.path == missing.to_str().unwrap())
            .unwrap();
        assert!(missing_row.problem.is_some());
        assert!(listed_directory(&f.paths, &f.openings, &missing_row.id).is_err());
        let protected_row = listed
            .folders
            .iter()
            .find(|row| row.path == records.to_str().unwrap())
            .unwrap();
        assert!(protected_row.protected);
        let app_data_row = listed
            .folders
            .iter()
            .find(|row| row.path == f.paths.data_dir.to_str().unwrap())
            .unwrap();
        assert!(app_data_row.problem.is_some());
        assert!(listed_directory(&f.paths, &f.openings, &app_data_row.id).is_err());
        navigation::remove(&f.paths.data_dir, navigation::List::Pins, |_| true).unwrap();
        navigation::remove(&f.paths.data_dir, navigation::List::Recent, |_| true).unwrap();
        assert!(!list(&f.paths, &f.openings)
            .folders
            .iter()
            .any(|row| row.id == missing_row.id));
    }

    #[test]
    fn stale_ids_and_changed_roots_cannot_admit_old_membership() {
        let mut f = fixture();
        let first = f.paths.folder_dir.join("First");
        fs::create_dir(&first).unwrap();
        let id = list(&f.paths, &f.openings).folders[0].id.clone();
        f.paths.folder_dir = f.paths.folder_dir.parent().unwrap().join("New root");
        fs::create_dir(&f.paths.folder_dir).unwrap();
        assert!(listed_directory(&f.paths, &f.openings, &id).is_err());
        assert!(!list(&f.paths, &f.openings)
            .folders
            .iter()
            .any(|row| row.path == first.to_str().unwrap()));
    }
}
