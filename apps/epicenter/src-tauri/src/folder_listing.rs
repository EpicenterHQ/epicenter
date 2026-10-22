//! One derived launcher list. Root children, selected homes, bookmarks, and
//! this-run acceptances identify ordinary directories, not separate datasets.
//! Row IDs name a resolved directory; every opening rebuilds membership before
//! admitting it. Display names and app home keys never identify folder rows.

use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_epicenter_folder::Directory;

use crate::data_folders::{folder_title, list_in};
use crate::folder_opening::FolderOpenings;
use crate::{folder_windows, folders_config, DesktopAppHandle};
use epicenter_folder_core::homes::resolved;
use tauri_plugin_epicenter_folder::defaults::DesktopPaths;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ListedFolder {
    pub id: String,
    pub title: String,
    /// Display only. Opening passes the ID and rechecks current membership.
    pub path: String,
    /// Protected directories remain editable, but cannot open in ordinary apps.
    pub protected: bool,
    /// Display titles of apps whose ordinary launch uses this directory.
    pub homes: Vec<String>,
    /// Original shortcut spellings, removed together by Forget bookmark.
    pub bookmarks: Vec<String>,
    pub temporary: bool,
    pub problem: Option<String>,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FolderListing {
    pub folders: Vec<ListedFolder>,
    /// An unavailable source must not hide folders found through another one.
    pub problems: Vec<String>,
}

/// A deterministic native lookup key, never a display name or a folder grant.
pub(crate) fn folder_id(path: &Path) -> String {
    let digest = Sha256::digest(path.as_os_str().as_encoded_bytes());
    format!("folder:{digest:x}")
}

fn same_directory(first: &Path, second: &Path) -> bool {
    first == second || same_file::is_same_file(first, second).unwrap_or(false)
}

enum Source {
    Root(String),
    Home(String),
    Bookmark,
    Temporary,
}

pub(crate) fn list(paths: &DesktopPaths, openings: &FolderOpenings) -> FolderListing {
    let mut result = FolderListing {
        folders: Vec::new(),
        problems: Vec::new(),
    };
    let config = match folders_config::read(&paths.data_dir) {
        Ok(config) => config,
        Err(problem) => {
            result.problems.push(problem);
            Default::default()
        }
    };
    let records = folders_config::protected_records(&config, &paths.folder_dir);

    // Start with root children, so a folder's on-disk spelling wins over aliases.
    let children = match list_in(&paths.folder_dir) {
        Ok(children) => children,
        Err(problem) => {
            result.problems.push(problem);
            Vec::new()
        }
    };
    let mut add = |path: &str, source: Source| {
        let candidate = Path::new(path);
        let checked = (|| {
            if !candidate.is_absolute() {
                return Err("This is not an absolute folder path.".to_string());
            }
            let directory = Directory::existing(candidate).map_err(|error| error.to_string())?;
            folders_config::check_app_directory(&paths.data_dir, None, directory.root())?;
            Ok(directory)
        })();
        let identity = checked
            .as_ref()
            .map(|directory| directory.root().to_path_buf())
            .unwrap_or_else(|_| resolved(candidate));
        let Some(identity_text) = identity.to_str() else {
            return;
        };
        let existing = result
            .folders
            .iter()
            .position(|folder| same_directory(Path::new(&folder.path), &identity));
        let index = match existing {
            Some(index) => index,
            None => {
                let title = if checked.is_ok() {
                    match &source {
                        Source::Root(title) => title.clone(),
                        _ => folder_title(&identity),
                    }
                } else {
                    candidate
                        .file_name()
                        .unwrap_or(candidate.as_os_str())
                        .to_string_lossy()
                        .into_owned()
                };
                result.folders.push(ListedFolder {
                    id: folder_id(&identity),
                    title,
                    path: identity_text.to_string(),
                    protected: folders_config::check_app_directory(
                        &paths.data_dir,
                        records.as_deref(),
                        &identity,
                    )
                    .is_err(),
                    homes: Vec::new(),
                    bookmarks: Vec::new(),
                    temporary: false,
                    problem: checked.as_ref().err().cloned(),
                });
                result.folders.len() - 1
            }
        };
        let folder = &mut result.folders[index];
        // A broken alias must not disable a directory another current source admits.
        if checked.is_ok() {
            if folder.problem.is_some() {
                folder.title = folder_title(&identity);
            }
            folder.problem = None;
        }
        match source {
            Source::Root(_) => {}
            Source::Home(home) => {
                if !folder.homes.contains(&home) {
                    folder.homes.push(home);
                }
            }
            Source::Bookmark => {
                if !folder.bookmarks.iter().any(|entry| entry == path) {
                    folder.bookmarks.push(path.to_string());
                }
            }
            Source::Temporary => folder.temporary = true,
        }
    };
    for child in children {
        if let Some(path) = paths.folder_dir.join(child.name).to_str() {
            add(path, Source::Root(child.title));
        }
    }
    for (key, path) in &config.homes {
        let title = if key == folders_config::EPICENTER.key {
            "Epicenter".to_string()
        } else {
            crate::bundled_apps::BundledApp::ALL
                .into_iter()
                .find(|app| app.home().key == key)
                .map(|app| app.name())
                .unwrap_or(key)
                .to_string()
        };
        add(path, Source::Home(title));
    }
    for path in &config.folders {
        add(path, Source::Bookmark);
    }
    for path in openings.temporary() {
        add(&path, Source::Temporary);
    }
    for folder in &mut result.folders {
        folder.homes.sort();
    }
    result
        .folders
        .sort_by_cached_key(|folder| (folder.title.to_lowercase(), folder.path.clone()));
    result
}

#[tauri::command(async)]
#[specta::specta]
pub fn list_data_folders(app: DesktopAppHandle) -> FolderListing {
    list(&app.state::<DesktopPaths>(), &app.state::<FolderOpenings>())
}

/// Rebuild membership, then bind the very directory that passed validation.
pub(crate) fn listed_directory(
    paths: &DesktopPaths,
    openings: &FolderOpenings,
    id: &str,
) -> Result<Directory, String> {
    let folder = list(paths, openings)
        .folders
        .into_iter()
        .find(|folder| folder.id == id)
        .ok_or("This folder is no longer in the list.")?;
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
pub async fn open_folder_editor(app: DesktopAppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let directory = listed_directory(
            &app.state::<DesktopPaths>(),
            &app.state::<FolderOpenings>(),
            &id,
        )?;
        folder_windows::open_editor(&app, directory)
            .map(|_| ())
            .map_err(|error| format!("{error:#}"))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Forget all shortcuts represented by this row. Other sources keep it visible.
#[tauri::command(async)]
#[specta::specta]
pub fn forget_folder_bookmarks(app: DesktopAppHandle, id: String) -> Result<(), String> {
    forget_bookmarks(&app, &id)
}

pub(crate) fn forget_bookmarks<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    let paths = app.state::<DesktopPaths>();
    let openings = app.state::<FolderOpenings>();
    let folder = list(&paths, &openings)
        .folders
        .into_iter()
        .find(|folder| folder.id == id)
        .ok_or("This folder is no longer in the list.")?;
    for path in folder.bookmarks {
        folders_config::forget(&paths.data_dir, &path)?;
    }
    // Temporary acceptances can also be aliases of the same row.
    for path in openings.temporary() {
        if same_directory(&resolved(Path::new(&path)), Path::new(&folder.path)) {
            openings.forget(&path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use tauri::{
        test::{mock_builder, mock_context, noop_assets, MockRuntime},
        App,
    };
    use tauri_plugin_epicenter_folder::FolderExt;

    struct Fixture {
        app: App<MockRuntime>,
        paths: DesktopPaths,
        _temp: tempfile::TempDir,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.app.folders().shutdown();
        }
    }
    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let root = dunce::canonicalize(temp.path()).unwrap();
            let paths = DesktopPaths {
                folder_dir: root.join("Epicenter"),
                data_dir: root.join("app-data"),
            };
            fs::create_dir(&paths.folder_dir).unwrap();
            let app = mock_builder()
                .plugin(tauri_plugin_epicenter_folder::init())
                .manage(paths.clone())
                .manage(FolderOpenings::default())
                .build(mock_context(noop_assets()))
                .unwrap();
            Self {
                app,
                paths,
                _temp: temp,
            }
        }
        fn list(&self) -> FolderListing {
            list(&self.paths, &self.app.state::<FolderOpenings>())
        }
        fn directory(&self, relative: &str) -> PathBuf {
            let path = dunce::canonicalize(self._temp.path())
                .unwrap()
                .join(relative);
            fs::create_dir_all(&path).unwrap();
            path
        }
        fn home(&self, home: folders_config::Home, path: &Path) {
            folders_config::select_home(&self.paths.data_dir, &self.paths.folder_dir, home, path)
                .unwrap();
        }
        fn bookmark(&self, path: &Path) {
            folders_config::add(&self.paths.data_dir, path.to_str().unwrap()).unwrap();
        }
        fn open(&self, id: &str) -> Result<String, String> {
            let directory = listed_directory(&self.paths, &self.app.state::<FolderOpenings>(), id)?;
            folder_windows::open_editor(self.app.handle(), directory)
                .map(|window| window.label().to_owned())
                .map_err(|error| error.to_string())
        }
    }

    #[test]
    fn root_children_homes_and_bookmarks_merge_without_registering_another_folder() {
        let f = Fixture::new();
        let notes = f.directory("Epicenter/Notes");
        f.home(folders_config::TODOS, &notes);
        f.home(crate::bundled_apps::BundledApp::Capture.home(), &notes);
        f.bookmark(&notes);
        f.bookmark(&notes.join("."));
        let before = fs::read(folders_config::file(&f.paths.data_dir)).unwrap();
        let listing = f.list();
        assert!(listing.problems.is_empty());
        assert_eq!(listing.folders.len(), 1);
        let folder = &listing.folders[0];
        assert_eq!(folder.path, notes.to_str().unwrap());
        assert_eq!(folder.homes, ["Capture", "Todos"]);
        assert_eq!(folder.bookmarks.len(), 2);
        assert!(folder.problem.is_none());
        assert_eq!(
            fs::read(folders_config::file(&f.paths.data_dir)).unwrap(),
            before
        );
        assert_eq!(fs::read_dir(&notes).unwrap().count(), 0);
    }

    #[test]
    fn matching_names_are_distinct_and_outside_folders_open_in_editors_and_apps() {
        let f = Fixture::new();
        let first = f.directory("Work/Notes");
        let second = f.directory("Personal/Notes");
        f.home(folders_config::TODOS, &first);
        f.bookmark(&second);
        let folders = f.list().folders;
        assert_eq!(folders.len(), 2);
        assert_eq!(folders[0].title, folders[1].title);
        assert_ne!(folders[0].id, folders[1].id);
        for folder in folders {
            let editor = f.open(&folder.id).unwrap();
            assert_eq!(
                f.app.folders().bound(&editor).unwrap().root(),
                Path::new(&folder.path)
            );
            let app = crate::bundled_apps::open_on(
                f.app.handle(),
                crate::bundled_apps::BundledApp::Todos,
                crate::bundled_apps::AppFolder::Listed(folder.id),
            )
            .unwrap();
            assert_eq!(
                f.app.folders().bound(app.label()).unwrap().root(),
                Path::new(&folder.path)
            );
        }
        assert!(!f.paths.folder_dir.join("Todos").exists());
    }

    #[test]
    fn records_and_their_parent_remain_editable_but_cannot_open_in_apps() {
        let f = Fixture::new();
        let work = f.directory("Epicenter/Work");
        let records = f.directory("Epicenter/Work/records");
        f.home(folders_config::EPICENTER, &records);
        let listing = f.list();
        assert_eq!(listing.folders.len(), 2);
        for folder in listing.folders {
            assert!(folder.protected);
            assert!(folder.problem.is_none());
            let editor = f.open(&folder.id).unwrap();
            assert_eq!(
                f.app.folders().bound(&editor).unwrap().root(),
                Path::new(&folder.path)
            );
            assert!(crate::bundled_apps::open_on(
                f.app.handle(),
                crate::bundled_apps::BundledApp::Todos,
                crate::bundled_apps::AppFolder::Listed(folder.id),
            )
            .is_err());
        }
        assert!(work.exists());
    }

    #[test]
    fn hand_edited_records_cannot_admit_application_data_or_its_parent() {
        for parent in [false, true] {
            let f = Fixture::new();
            fs::create_dir_all(&f.paths.data_dir).unwrap();
            let selected = if parent {
                f.paths.data_dir.parent().unwrap()
            } else {
                &f.paths.data_dir
            };
            let config = folders_config::file(&f.paths.data_dir);
            let original = serde_json::to_vec(&serde_json::json!({
                "homes": {"epicenter": selected}, "folders": [],
            }))
            .unwrap();
            fs::write(&config, &original).unwrap();
            let folder = f
                .list()
                .folders
                .into_iter()
                .find(|folder| Path::new(&folder.path) == selected)
                .unwrap();
            assert!(folder.problem.is_some());
            assert!(folder.protected);
            assert!(f.open(&folder.id).is_err());
            assert!(f.app.webview_windows().is_empty());
            assert_eq!(fs::read(config).unwrap(), original);
        }
    }

    #[test]
    fn saved_homes_stay_visible_and_openable_when_the_root_changes() {
        let f = Fixture::new();
        let original = f.paths.open_home(folders_config::TODOS).unwrap();
        let id = f.list().folders[0].id.clone();
        let paths = DesktopPaths {
            folder_dir: f.directory("New root"),
            ..f.paths.clone()
        };
        let listing = list(&paths, &f.app.state::<FolderOpenings>());
        assert_eq!(listing.folders.len(), 1);
        assert_eq!(listing.folders[0].id, id);
        assert_eq!(
            listed_directory(&paths, &f.app.state::<FolderOpenings>(), &id).unwrap(),
            original
        );
        assert!(!paths.folder_dir.join("Todos").exists());
    }

    #[test]
    fn missing_homes_and_bookmarks_remain_one_unavailable_row_and_are_not_recreated() {
        let f = Fixture::new();
        let missing = f.directory("Code/Todos");
        f.home(folders_config::TODOS, &missing);
        f.bookmark(&missing);
        fs::remove_dir(&missing).unwrap();
        let folder = &f.list().folders[0];
        assert!(folder.problem.is_some());
        assert_eq!(folder.homes, ["Todos"]);
        assert_eq!(folder.bookmarks.len(), 1);
        assert!(f.open(&folder.id).is_err());
        forget_bookmarks(f.app.handle(), &folder.id).unwrap();
        let listing = f.list();
        assert_eq!(
            listing.folders.len(),
            1,
            "home keeps the missing folder visible"
        );
        assert!(listing.folders[0].bookmarks.is_empty());
        assert!(listing.folders[0].problem.is_some());
        assert!(!missing.exists());
    }

    #[test]
    fn forgetting_a_bookmark_keeps_the_home_root_and_open_window() {
        let f = Fixture::new();
        let notes = f.directory("Epicenter/Notes");
        f.home(folders_config::TODOS, &notes);
        f.bookmark(&notes);
        f.bookmark(&notes.join("."));
        let id = f.list().folders[0].id.clone();
        let editor = f.open(&id).unwrap();
        forget_bookmarks(f.app.handle(), &id).unwrap();
        let listing = f.list();
        assert_eq!(listing.folders.len(), 1);
        assert!(listing.folders[0].bookmarks.is_empty());
        assert_eq!(listing.folders[0].homes, ["Todos"]);
        assert_eq!(f.app.folders().bound(&editor).unwrap().root(), notes);
        assert_eq!(f.open(&id).unwrap(), editor);
    }

    #[test]
    fn forgotten_and_unlisted_ids_cannot_open_but_existing_windows_keep_their_bindings() {
        let f = Fixture::new();
        let notes = f.directory("Notes");
        assert!(f.open(&folder_id(&notes)).is_err());
        assert!(f.open(notes.to_str().unwrap()).is_err());
        f.bookmark(&notes);
        let id = f.list().folders[0].id.clone();
        let window = f.open(&id).unwrap();
        forget_bookmarks(f.app.handle(), &id).unwrap();
        assert!(f.list().folders.is_empty());
        assert!(f.open(&id).is_err());
        assert_eq!(f.app.folders().bound(&window).unwrap().root(), notes);
    }

    #[cfg(unix)]
    #[test]
    fn parent_aliases_merge_and_a_retargeted_alias_cannot_reuse_a_stale_id() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let notes = f.directory("Epicenter/Notes");
        let alias = f._temp.path().join("alias");
        symlink(&f.paths.folder_dir, &alias).unwrap();
        let shortcut = alias.join("Notes");
        f.bookmark(&shortcut);
        assert_eq!(f.list().folders.len(), 1);
        let id = f.list().folders[0].id.clone();
        fs::remove_file(&alias).unwrap();
        fs::create_dir_all(f.paths.data_dir.join("Notes")).unwrap();
        symlink(&f.paths.data_dir, &alias).unwrap();
        fs::remove_dir(&notes).unwrap();
        assert!(f.open(&id).is_err());
        let listing = f.list();
        assert_eq!(listing.folders.len(), 1);
        assert!(listing.folders[0].problem.is_some());
        assert!(f.app.webview_windows().is_empty());
    }

    #[test]
    fn a_broken_source_does_not_hide_folders_from_other_sources() {
        let f = Fixture::new();
        let notes = f.directory("Epicenter/Notes");
        fs::create_dir_all(&f.paths.data_dir).unwrap();
        let config = folders_config::file(&f.paths.data_dir);
        fs::write(&config, "needs repair").unwrap();
        assert_eq!(f.list().folders.len(), 1);
        assert_eq!(f.list().problems.len(), 1);
        assert_eq!(fs::read_to_string(&config).unwrap(), "needs repair");
        fs::remove_file(config).unwrap();
        let outside = f.directory("Outside");
        f.home(folders_config::TODOS, &outside);
        fs::remove_dir(notes).unwrap();
        fs::remove_dir(&f.paths.folder_dir).unwrap();
        fs::write(&f.paths.folder_dir, "occupied").unwrap();
        assert_eq!(f.list().folders.len(), 1);
        assert_eq!(f.list().problems.len(), 1);
    }
}
