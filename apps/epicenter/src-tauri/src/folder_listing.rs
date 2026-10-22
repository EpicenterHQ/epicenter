//! One derived launcher list. Root children, bookmarks, and this-run
//! acceptances identify ordinary directories, not separate datasets.
//! Row IDs name a resolved directory; every opening rebuilds membership before
//! admitting it. Display names and default titles never identify folder rows.
//! A row that is a library default, `<folder_dir>/<id>`, is titled by the
//! default's table title; listing never creates a missing default.

use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_epicenter_folder::Directory;

use crate::data_folders::{folder_title, list_in};
use crate::folder_opening::FolderOpenings;
use crate::{folder_windows, DesktopAppHandle};
use epicenter_folder_core::{bookmarks, library};
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
    /// The title of the app whose fixed default this directory is, if any.
    pub default_for: Option<String>,
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
    Bookmark,
    Temporary,
}

pub(crate) fn list(paths: &DesktopPaths, openings: &FolderOpenings) -> FolderListing {
    let mut result = FolderListing {
        folders: Vec::new(),
        problems: Vec::new(),
    };
    let saved = match bookmarks::read(&paths.data_dir) {
        Ok(saved) => saved,
        Err(problem) => {
            result.problems.push(problem);
            Vec::new()
        }
    };

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
                    protected: library::check_app_directory(
                        &paths.data_dir,
                        &paths.folder_dir,
                        &identity,
                    )
                    .is_err(),
                    default_for: None,
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
    for path in &saved {
        add(path, Source::Bookmark);
    }
    for path in openings.temporary() {
        add(&path, Source::Temporary);
    }
    // A default is known by directory identity, so another spelling of it on
    // a disk that ignores case is the same default. Missing rows are none.
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
        bookmarks::forget(&paths.data_dir, &path)?;
    }
    // Temporary acceptances can also be aliases of the same row.
    for path in openings.temporary() {
        if same_directory(
            &library::resolved(Path::new(&path)),
            Path::new(&folder.path),
        ) {
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
        fn bookmark(&self, path: &Path) {
            bookmarks::add(&self.paths.data_dir, path.to_str().unwrap()).unwrap();
        }
        fn row(&self, path: &Path) -> ListedFolder {
            self.list()
                .folders
                .into_iter()
                .find(|folder| Path::new(&folder.path) == path)
                .unwrap_or_else(|| panic!("{path:?} is not listed"))
        }
        fn open(&self, id: &str) -> Result<String, String> {
            let directory = listed_directory(&self.paths, &self.app.state::<FolderOpenings>(), id)?;
            folder_windows::open_editor(self.app.handle(), directory)
                .map(|window| window.label().to_owned())
                .map_err(|error| error.to_string())
        }
        fn open_in_todos(&self, id: String) -> Result<PathBuf, String> {
            let window = crate::bundled_apps::open_on(
                self.app.handle(),
                crate::bundled_apps::BundledApp::Todos,
                crate::bundled_apps::AppFolder::Listed(id),
            )?;
            Ok(self
                .app
                .folders()
                .bound(window.label())
                .unwrap()
                .root()
                .to_path_buf())
        }
    }

    #[test]
    fn root_children_and_bookmarks_merge_without_registering_another_folder() {
        let f = Fixture::new();
        let notes = f.directory("Epicenter/Notes");
        f.bookmark(&notes);
        f.bookmark(&notes.join("."));
        let before = fs::read(bookmarks::file(&f.paths.data_dir)).unwrap();
        let listing = f.list();
        assert!(listing.problems.is_empty());
        assert_eq!(listing.folders.len(), 1);
        let folder = &listing.folders[0];
        assert_eq!(folder.path, notes.to_str().unwrap());
        assert_eq!(folder.default_for, None);
        assert_eq!(folder.bookmarks.len(), 2);
        assert!(folder.problem.is_none());
        assert_eq!(
            fs::read(bookmarks::file(&f.paths.data_dir)).unwrap(),
            before
        );
        assert_eq!(fs::read_dir(&notes).unwrap().count(), 0);
    }

    /// Existing root defaults read as their apps and are deduplicated with a
    /// bookmark of them. A directory elsewhere with a default's name is an
    /// ordinary folder, and a missing default is neither listed nor made.
    #[test]
    fn root_defaults_have_readable_titles_and_outside_bookmarks_do_not() {
        let f = Fixture::new();
        let todos = f.paths.open_default(library::TODOS).unwrap();
        let records = f.paths.open_default(library::RECORDS).unwrap();
        let outside = f.directory("Elsewhere/so.epicenter.capture");
        f.bookmark(todos.root());
        f.bookmark(&outside);
        assert_eq!(f.list().folders.len(), 3);
        let todos_row = f.row(todos.root());
        assert_eq!(
            (todos_row.title.as_str(), todos_row.default_for.as_deref()),
            ("Todos", Some("Todos"))
        );
        assert!(!todos_row.protected);
        assert_eq!(todos_row.bookmarks.len(), 1);
        let records_row = f.row(records.root());
        assert_eq!(
            (
                records_row.title.as_str(),
                records_row.default_for.as_deref()
            ),
            ("Epicenter", Some("Epicenter"))
        );
        assert!(records_row.protected);
        let outside_row = f.row(&outside);
        assert_eq!(outside_row.title, "so.epicenter.capture");
        assert_eq!(outside_row.default_for, None);
        assert!(!f.paths.folder_dir.join(library::CAPTURE.id).exists());
        // An explicitly bookmarked outside directory opens in an app.
        assert_eq!(f.open_in_todos(outside_row.id).unwrap(), outside);
    }

    /// On a disk that ignores case, another spelling of a default is that
    /// default, by directory identity rather than by name.
    #[test]
    fn a_default_spelled_in_another_case_follows_the_disks_case_sensitivity() {
        let f = Fixture::new();
        let stored = f.directory("Epicenter/SO.EPICENTER.TODOS");
        let insensitive = f.paths.folder_dir.join(library::TODOS.id).exists();
        let row = f.row(&stored);
        if insensitive {
            assert_eq!(row.default_for.as_deref(), Some("Todos"));
            assert_eq!(row.title, "Todos");
        } else {
            assert_eq!(row.default_for, None);
            assert_eq!(row.title, "SO.EPICENTER.TODOS");
        }
    }

    #[test]
    fn matching_names_are_distinct_and_outside_folders_open_in_editors_and_apps() {
        let f = Fixture::new();
        let first = f.directory("Work/Notes");
        let second = f.directory("Personal/Notes");
        f.bookmark(&first);
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
            assert_eq!(f.open_in_todos(folder.id).unwrap(), Path::new(&folder.path));
        }
        assert!(!f.paths.folder_dir.join(library::TODOS.id).exists());
    }

    /// The records default and the root holding it stay editable but open in
    /// no app.
    #[test]
    fn records_and_the_root_remain_editable_but_cannot_open_in_apps() {
        let f = Fixture::new();
        let records = f.paths.open_default(library::RECORDS).unwrap();
        f.bookmark(&f.paths.folder_dir);
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
            assert!(f.open_in_todos(folder.id).is_err());
        }
        assert!(records.root().is_dir());
    }

    #[test]
    fn hand_edited_bookmarks_cannot_admit_application_data_or_its_parent() {
        for parent in [false, true] {
            let f = Fixture::new();
            fs::create_dir_all(&f.paths.data_dir).unwrap();
            let selected = if parent {
                f.paths.data_dir.parent().unwrap().to_path_buf()
            } else {
                f.paths.data_dir.clone()
            };
            f.bookmark(&selected);
            let original = fs::read(bookmarks::file(&f.paths.data_dir)).unwrap();
            let folder = f.row(&selected);
            assert!(folder.problem.is_some());
            assert!(folder.protected);
            assert!(f.open(&folder.id).is_err());
            assert!(f.app.webview_windows().is_empty());
            assert_eq!(
                fs::read(bookmarks::file(&f.paths.data_dir)).unwrap(),
                original
            );
        }
    }

    /// The list has no app-home source: a changed root lists its own
    /// children and the bookmarks, and an earlier root's default is
    /// neither listed nor touched.
    #[test]
    fn a_changed_root_lists_only_its_children_and_the_bookmarks() {
        let f = Fixture::new();
        let earlier = f.paths.open_default(library::TODOS).unwrap();
        let outside = f.directory("Outside");
        f.bookmark(&outside);
        let paths = DesktopPaths {
            folder_dir: f.directory("New root"),
            ..f.paths.clone()
        };
        let listing = list(&paths, &f.app.state::<FolderOpenings>());
        assert_eq!(listing.folders.len(), 1);
        assert_eq!(listing.folders[0].path, outside.to_str().unwrap());
        assert!(listed_directory(
            &paths,
            &f.app.state::<FolderOpenings>(),
            &folder_id(earlier.root())
        )
        .is_err());
        assert!(earlier.root().is_dir());
        assert!(!paths.folder_dir.join(library::TODOS.id).exists());
    }

    #[test]
    fn missing_bookmarks_remain_one_unavailable_row_and_are_not_recreated() {
        let f = Fixture::new();
        let missing = f.directory("Code/Todos");
        f.bookmark(&missing);
        f.bookmark(&missing.join("."));
        fs::remove_dir(&missing).unwrap();
        let folder = &f.list().folders[0];
        assert!(folder.problem.is_some());
        assert_eq!(folder.default_for, None);
        assert_eq!(folder.bookmarks.len(), 2);
        assert!(f.open(&folder.id).is_err());
        forget_bookmarks(f.app.handle(), &folder.id).unwrap();
        assert!(f.list().folders.is_empty());
        assert!(!missing.exists());
    }

    #[test]
    fn forgetting_a_bookmark_keeps_the_root_row_and_open_window() {
        let f = Fixture::new();
        let notes = f.directory("Epicenter/Notes");
        f.bookmark(&notes);
        f.bookmark(&notes.join("."));
        let id = f.list().folders[0].id.clone();
        let editor = f.open(&id).unwrap();
        forget_bookmarks(f.app.handle(), &id).unwrap();
        let listing = f.list();
        assert_eq!(listing.folders.len(), 1);
        assert!(listing.folders[0].bookmarks.is_empty());
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

    /// A broken bookmark list hides no root child, and an earlier build's
    /// `folders.json` is no source at all and stays as it was.
    #[test]
    fn a_broken_source_does_not_hide_folders_from_other_sources() {
        let f = Fixture::new();
        let notes = f.directory("Epicenter/Notes");
        fs::create_dir_all(&f.paths.data_dir).unwrap();
        let old = f.paths.data_dir.join("folders.json");
        let elsewhere = f.directory("Old home");
        let contents = serde_json::to_string(&serde_json::json!({
            "homes": { "todos": elsewhere }, "folders": [elsewhere],
        }))
        .unwrap();
        fs::write(&old, &contents).unwrap();
        let file = bookmarks::file(&f.paths.data_dir);
        fs::write(&file, "needs repair").unwrap();
        assert_eq!(f.list().folders.len(), 1);
        assert_eq!(f.list().problems.len(), 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "needs repair");
        fs::remove_file(&file).unwrap();
        assert!(f.list().problems.is_empty());
        let outside = f.directory("Outside");
        f.bookmark(&outside);
        fs::remove_dir(notes).unwrap();
        fs::remove_dir(&f.paths.folder_dir).unwrap();
        fs::write(&f.paths.folder_dir, "occupied").unwrap();
        assert_eq!(f.list().folders.len(), 1);
        assert_eq!(f.list().problems.len(), 1);
        assert_eq!(fs::read_to_string(&old).unwrap(), contents);
    }
}
