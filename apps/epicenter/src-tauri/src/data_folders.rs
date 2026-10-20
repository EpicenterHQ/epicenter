//! The data folders under the Epicenter folder root, as the Folders window
//! lists them (ADR-0535), and the editor window it opens on one.
//!
//! A data folder is a direct child of `folder_dir` that is a real directory,
//! not a link or a dot entry. The Folders window shows each by its
//! directory name and title, and opens none itself: it is a launcher. A
//! window that edits a listed folder is opened in trusted Rust, which
//! derives the path from `folder_dir` and the listed name again, checks it
//! is still a real direct child, and binds it to the window before the
//! WebView exists (`folder_windows`). No list of registered folders is kept:
//! the directory is the record.
//!
//! - Epicenter's selected records folder (`folders_config`) holds its AI
//!   connections. Settings binds it through `folders_config::open_epicenter`; only an
//!   unselected initial default is created. Under the folder root it is
//!   listed like any other folder, and its
//!   editor window may open it. No bundled app or handoff opens it, the app
//!   data, Settings' sibling staging directory, or a directory holding any
//!   of them (`overlaps_epicenter_files`).
//! - A listed folder's editor, `files:<digest>`, serves the Folders build's
//!   `/folders/editor/` route, which selects the editor's UI. It edits that
//!   one folder's files as text and is destroyed when it closes. A folder
//!   missing when it is opened is refused, never created.
//!
//! The shell watches the root (`watch_data_folders`) and tells the Folders
//! window when the listing may have changed, so it lists again.
//!
//! The reply carries directory names and titles, never paths.

use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, Debouncer, NoCache};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_epicenter_folder::Directory;

use crate::app_data::DesktopPaths;
use crate::{folder_windows, folders_config};
use crate::{BuiltInApp, DesktopAppHandle};

/// The optional declaration supplying a title while listing files.
const DECLARATION: &str = "epicenter.json";

/// Whether `directory` overlaps Epicenter's own files, so that neither a
/// bundled app nor a handoff may bind it: Settings' folder, its sibling save
/// staging directory, or the app data, anything inside them, or a directory
/// holding them. The folder root and its parents hold Settings' folder, so
/// they are refused while that root contains the selected records. The
/// listed-folder editor does not ask, and may open Settings' folder.
pub fn overlaps_epicenter_files(paths: &DesktopPaths, directory: &Directory) -> bool {
    let mut kept = vec![resolved(&paths.data_dir)];
    // Broken preferences must stay repairable without blocking unrelated
    // folder editors. Settings itself requires a readable selection.
    if let Ok(settings) = folders_config::epicenter_path(&paths.data_dir, &paths.folder_dir) {
        let settings = resolved(&settings);
        if let Ok(scratch) = epicenter_folder_core::storage::scratch_directory(&settings) {
            kept.push(resolved(&scratch));
        }
        kept.push(settings);
    }
    kept.iter().any(|path| overlaps(directory.root(), path))
}

/// Resolve each existing component and normalize missing components too. A
/// missing segment followed by `..` must still name the eventual directory:
/// the OS will create that segment before walking back through it.
fn resolved(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => {}
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

/// Compare containment even when the OS exposes one directory through two
/// absolute paths that canonicalization does not merge (for example a macOS
/// firmlink, or another casing on a disk that ignores case). A missing
/// protected leaf still has the lexical fallback above.
fn overlaps(candidate: &Path, protected: &Path) -> bool {
    candidate.starts_with(protected)
        || protected.starts_with(candidate)
        || candidate
            .ancestors()
            .any(|ancestor| same_file::is_same_file(ancestor, protected).unwrap_or(false))
        || protected
            .ancestors()
            .any(|ancestor| same_file::is_same_file(ancestor, candidate).unwrap_or(false))
}

/// One data folder the Folders window lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DataFolder {
    /// The directory's name under the Epicenter folder, which the Folders
    /// window passes back to open it. Never a path.
    pub name: String,
    /// `epicenter.json`'s `title` when it is a string, else the directory name.
    pub title: String,
    /// This is the selected folder Settings edits, independent of its name.
    pub epicenter: bool,
}

/// List the data folders under the Epicenter folder root.
///
/// Granted to the `folders` window alone. Off the main thread, since it
/// reads the disk.
#[tauri::command(async)]
#[specta::specta]
pub fn list_data_folders(app: DesktopAppHandle) -> Result<Vec<DataFolder>, String> {
    let paths = app.state::<DesktopPaths>();
    let epicenter = folders_config::epicenter_path(&paths.data_dir, &paths.folder_dir).ok();
    list_in(&paths.folder_dir, epicenter.as_deref())
}

/// The path of the data folder the Folders window listed as `name`: a real
/// directory directly under `folder_dir`, found again now. A name that is
/// not one directory entry, a dot entry, a link, or a directory that is gone
/// is refused, and nothing is made.
pub fn listed_folder(folder_dir: &Path, name: &str) -> Result<PathBuf, String> {
    let mut components = Path::new(name).components();
    let one_name = matches!(
        (components.next(), components.next()),
        (Some(Component::Normal(_)), None)
    );
    if !one_name || name.starts_with('.') || name.contains(['/', '\\', '\0']) {
        return Err("That folder is not in the list of folders.".to_string());
    }
    let path = folder_dir.join(name);
    // `symlink_metadata` does not follow a link, so a linked directory is
    // refused, as the listing skips one.
    if !fs::symlink_metadata(&path).is_ok_and(|stats| stats.is_dir()) {
        return Err(format!("The folder \"{name}\" is not there anymore."));
    }
    Ok(path)
}

/// The editor window for the listed folder `name`, bound to it.
fn listed_directory(folder_dir: &Path, name: &str) -> Result<Directory, String> {
    let path = listed_folder(folder_dir, name)?;
    let directory = Directory::existing(&path)
        .map_err(|error| format!("The folder \"{name}\" could not be opened: {error}"))?;
    Ok(directory)
}

/// Open the listed folder `name` in its own editor window, or reveal the one
/// already open on it. The page passes the name the listing gave it, never a
/// path; the shell finds the directory again and binds it to the window.
#[tauri::command]
#[specta::specta]
pub async fn open_folder_editor(handle: DesktopAppHandle, name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = handle.state::<DesktopPaths>();
        let directory = listed_directory(&paths.folder_dir, &name)?;
        folder_windows::open_editor(&handle, directory)
            .map(|_| ())
            .map_err(|error| format!("{error:#}"))
    })
    .await
    .map_err(|error| format!("the folder could not be opened: {error}"))?
}

pub(crate) fn list_in(
    folder_dir: &Path,
    epicenter: Option<&Path>,
) -> Result<Vec<DataFolder>, String> {
    let epicenter = epicenter.map(resolved);
    let entries = match fs::read_dir(folder_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("The Epicenter folder could not be read: {error}")),
    };
    let mut listed = Vec::new();
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        // `file_type` does not follow links, so a linked directory is skipped.
        let is_directory = entry.file_type().is_ok_and(|kind| kind.is_dir());
        if name.starts_with('.') || !is_directory {
            continue;
        }
        let declaration = entry.path().join(DECLARATION);
        let title = fs::symlink_metadata(&declaration)
            .ok()
            .filter(|stats| stats.is_file())
            .and_then(|_| fs::read_to_string(&declaration).ok())
            .as_deref()
            .and_then(declared_title)
            .unwrap_or_else(|| name.clone());
        listed.push(DataFolder {
            name,
            title,
            epicenter: epicenter
                .as_ref()
                .is_some_and(|selected| resolved(&entry.path()) == *selected),
        });
    }
    listed.sort_by_cached_key(|folder| (folder.title.to_lowercase(), folder.name.clone()));
    Ok(listed)
}

/// The event the Folders window hears when the listing may have changed. It
/// carries nothing: the window lists again. `DATA_FOLDERS_CHANGED` in
/// `src/folders/App.svelte` names it too.
pub const DATA_FOLDERS_CHANGED: &str = "epicenter://data-folders-changed";

/// How long the root's watcher waits for a burst of events to settle.
const LISTING_DEBOUNCE: Duration = Duration::from_millis(100);

/// The watch on the Epicenter folder root, kept in the app's state until
/// exit; dropping it stops the watch.
pub struct DataFoldersWatch {
    _debouncer: Debouncer<RecommendedWatcher, NoCache>,
}

/// Watch `folder_dir` and send `DATA_FOLDERS_CHANGED` to the Folders window
/// when what `list_in` reads may have changed: an entry directly under the
/// root, or a folder's optional `epicenter.json` title. The watch is recursive
/// because a declaration is one level down; every deeper change, such as a row saved
/// in a folder, is ignored. A rescan or a watch error is reported too. A
/// root that cannot be watched leaves the listing as the window last read it.
pub fn watch_data_folders<R: Runtime>(
    app: &AppHandle<R>,
    folder_dir: &Path,
    data_dir: &Path,
) -> Result<DataFoldersWatch, String> {
    let root = folder_dir.to_path_buf();
    let config = folders_config::file(data_dir);
    fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
    let app = app.clone();
    let mut debouncer = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
        LISTING_DEBOUNCE,
        None,
        move |result: DebounceEventResult| {
            let changed = match result {
                Ok(events) => events.iter().any(|debounced| {
                    debounced.need_rescan()
                        || (!matches!(debounced.kind, EventKind::Access(_))
                            && debounced
                                .paths
                                .iter()
                                .any(|path| changes_listing(&root, path) || *path == config))
                }),
                // Some events could not be delivered.
                Err(_) => true,
            };
            if changed {
                let _ = app.emit_to(BuiltInApp::Folders.id(), DATA_FOLDERS_CHANGED, ());
                let _ = app.emit_to(
                    BuiltInApp::Folders.id(),
                    crate::folder_opening::FOLDER_OPENINGS_CHANGED,
                    (),
                );
            }
        },
        NoCache,
        notify::Config::default().with_follow_symlinks(false),
    )
    .map_err(|cause| format!("'{}' could not be watched: {cause}", folder_dir.display()))?;
    debouncer
        .watch(folder_dir, RecursiveMode::Recursive)
        .map_err(|cause| format!("'{}' could not be watched: {cause}", folder_dir.display()))?;
    debouncer
        .watch(data_dir, RecursiveMode::NonRecursive)
        .map_err(|error| format!("{} could not be watched: {error}", data_dir.display()))?;
    Ok(DataFoldersWatch {
        _debouncer: debouncer,
    })
}

/// Whether a change at `path` can change the listing of `root`: the root
/// itself, an entry directly in it, or `epicenter.json` directly in one,
/// leaving out dot entries, which are never listed.
fn changes_listing(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let names: Vec<Component> = relative.components().collect();
    let listed = |name: &std::ffi::OsStr| !name.to_string_lossy().starts_with('.');
    match names.as_slice() {
        [] => true,
        [Component::Normal(entry)] => listed(entry),
        [Component::Normal(entry), Component::Normal(file)] => {
            listed(entry) && *file == DECLARATION
        }
        _ => false,
    }
}

/// `epicenter.json`'s `title`, when the text parses and it is a string.
fn declared_title(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    value.get("title")?.as_str().map(str::to_string)
}

#[cfg(test)]
mod tests {
    //! The listing over a real directory, and the editor window the folder
    //! plugin's real commands reach on the mock runtime.

    use crate::folders_config::DEFAULT_EPICENTER_FOLDER;
    use serde_json::{json, Value};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
    use tauri::utils::acl::ExecutionContext;
    use tauri::webview::InvokeRequest;
    use tauri::{App, WebviewWindow, WebviewWindowBuilder};
    use tauri_plugin_epicenter_folder::FolderExt;

    use super::*;

    struct Fixture {
        app: App<MockRuntime>,
        folder_dir: PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.app.folders().shutdown();
            let _ = fs::remove_dir_all(&self.folder_dir);
        }
    }

    impl Fixture {
        fn list(&self) -> Vec<DataFolder> {
            list_in(&self.folder_dir, None).unwrap()
        }

        /// What `open_folder_editor` does, with a mock window for the WebView.
        fn open_editor(&self, name: &str) -> Result<(String, bool), String> {
            let before = self.app.webview_windows().len();
            let window = folder_windows::open_editor(
                self.app.handle(),
                listed_directory(&self.folder_dir, name)?,
            )
            .map_err(|error| format!("{error:#}"))?;
            Ok((
                window.label().to_owned(),
                self.app.webview_windows().len() == before,
            ))
        }

        fn window(&self, label: &str) -> WebviewWindow<MockRuntime> {
            self.app.get_webview_window(label).expect("an open window")
        }
    }

    /// An app with the folder plugin over an empty folder root.
    fn fixture(label: &str) -> Fixture {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let folder_dir = std::env::temp_dir().join(format!(
            "epicenter-data-folders-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&folder_dir);
        fs::create_dir_all(&folder_dir).unwrap();
        let folder_dir = fs::canonicalize(folder_dir).unwrap();

        let mut context = mock_context(noop_assets());
        for command in tauri_plugin_epicenter_folder::COMMANDS {
            context.runtime_authority_mut().__allow_command(
                format!("plugin:epicenter-folder|{command}"),
                ExecutionContext::Local,
            );
        }
        let app = mock_builder()
            .plugin(tauri_plugin_epicenter_folder::init())
            .build(context)
            .expect("mock app");
        Fixture { app, folder_dir }
    }

    /// A data folder whose optional declaration supplies test metadata.
    fn data_folder(fixture: &Fixture, name: &str, declaration: &str) {
        let root = fixture.folder_dir.join(name);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(DECLARATION), declaration).unwrap();
    }

    fn invoke(
        window: &WebviewWindow<MockRuntime>,
        command: &str,
        args: Value,
    ) -> Result<Value, Value> {
        tauri::test::get_ipc_response(
            window,
            InvokeRequest {
                cmd: format!("plugin:epicenter-folder|{command}"),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize::<Value>().expect("a JSON response"))
    }

    /// Open the window's folder, then list its root's entry names.
    fn root_names(window: &WebviewWindow<MockRuntime>) -> Vec<String> {
        invoke(window, "open_folder", json!({}))
            .unwrap_or_else(|error| panic!("{} did not open: {error}", window.label()));
        let children = invoke(window, "read_folder_children", json!({ "directory": "" })).unwrap();
        let mut names: Vec<String> = ["files", "directories"]
            .iter()
            .flat_map(|kind| children[*kind].as_array().unwrap().clone())
            .map(|name| name.as_str().unwrap().to_string())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn the_folders_window_hears_a_new_data_folder() {
        use tauri::Listener;

        let fixture = fixture("watch");
        let window =
            WebviewWindowBuilder::new(&fixture.app, BuiltInApp::Folders.id(), Default::default())
                .build()
                .unwrap();
        let (heard, hearing) = std::sync::mpsc::channel();
        window.listen(DATA_FOLDERS_CHANGED, move |_| {
            let _ = heard.send(());
        });
        let _watch = watch_data_folders(
            fixture.app.handle(),
            &fixture.folder_dir,
            &fixture.folder_dir.join(".app-data"),
        )
        .unwrap();
        // The operating system may report the root's creation late; settle it.
        std::thread::sleep(Duration::from_millis(500));
        while hearing.try_recv().is_ok() {}

        data_folder(&fixture, "books", "{}");

        hearing
            .recv_timeout(Duration::from_secs(5))
            .expect("the Folders window hears the new folder");
    }

    #[test]
    fn the_launcher_hears_external_config_writes() {
        use tauri::Listener;
        let fixture = fixture("config-watch");
        let data = fixture.folder_dir.join(".app-data");
        let window =
            WebviewWindowBuilder::new(&fixture.app, BuiltInApp::Folders.id(), Default::default())
                .build()
                .unwrap();
        let (heard, hearing) = std::sync::mpsc::channel();
        window.listen(crate::folder_opening::FOLDER_OPENINGS_CHANGED, move |_| {
            let _ = heard.send(());
        });
        let _watch = watch_data_folders(fixture.app.handle(), &fixture.folder_dir, &data).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        while hearing.try_recv().is_ok() {}
        folders_config::add(&data, "/another/folder").unwrap();
        hearing
            .recv_timeout(Duration::from_secs(5))
            .expect("configuration writes refresh the launcher");
    }

    #[test]
    fn the_selected_directory_has_the_settings_role_regardless_of_its_name() {
        let fixture = fixture("renamed-settings");
        let data = fixture.folder_dir.join(".app-data");
        fs::create_dir(&data).unwrap();
        let selected = fixture.folder_dir.join("My setup");
        fs::create_dir(&selected).unwrap();
        fs::create_dir(fixture.folder_dir.join(DEFAULT_EPICENTER_FOLDER)).unwrap();
        fs::write(
            folders_config::file(&data),
            serde_json::to_vec(&folders_config::FoldersConfig {
                epicenter: Some(selected.to_str().unwrap().into()),
                folders: vec![],
            })
            .unwrap(),
        )
        .unwrap();
        let paths = DesktopPaths {
            data_dir: data,
            folder_dir: fixture.folder_dir.clone(),
        };
        assert_eq!(
            folders_config::open_epicenter(&paths.data_dir, &paths.folder_dir)
                .unwrap()
                .root(),
            selected
        );
        assert!(overlaps_epicenter_files(
            &paths,
            &Directory::existing(&selected).unwrap()
        ));
        assert!(!overlaps_epicenter_files(
            &paths,
            &Directory::existing(&fixture.folder_dir.join(DEFAULT_EPICENTER_FOLDER)).unwrap()
        ));
        let listed = list_in(&fixture.folder_dir, Some(&selected)).unwrap();
        assert!(
            listed
                .iter()
                .find(|folder| folder.name == "My setup")
                .unwrap()
                .epicenter
        );
        assert!(
            !listed
                .iter()
                .find(|folder| folder.name == DEFAULT_EPICENTER_FOLDER)
                .unwrap()
                .epicenter
        );
    }

    #[test]
    fn only_entries_under_the_root_and_their_declarations_change_the_listing() {
        let root = PathBuf::from("/home/Epicenter");
        for path in ["", "books", "books/epicenter.json", "loose.json"] {
            assert!(changes_listing(&root, &root.join(path)), "{path}");
        }
        for path in [
            "books/b1.md",
            "books/.git/HEAD",
            "books/nested/epicenter.json",
            ".books.epicenter-save-lock",
            ".hidden/epicenter.json",
        ] {
            assert!(!changes_listing(&root, &root.join(path)), "{path}");
        }
        assert!(!changes_listing(&root, Path::new("/elsewhere/books")));
    }

    #[test]
    fn lists_real_directories_without_requiring_epicenter_json() {
        let fixture = fixture("listing");
        data_folder(&fixture, "vault", "{}");
        // A directory without a declaration remains available.
        fs::create_dir_all(fixture.folder_dir.join("plain")).unwrap();
        // A dot directory, file, or lock file is not listed. An unusable
        // declaration does not hide the directory or supply a title.
        data_folder(&fixture, ".hidden", "{}");
        fs::write(fixture.folder_dir.join("loose.json"), "{}").unwrap();
        fs::write(fixture.folder_dir.join(".vault.epicenter-save-lock"), "").unwrap();
        fs::create_dir_all(fixture.folder_dir.join("odd").join(DECLARATION)).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            fixture.folder_dir.join("vault"),
            fixture.folder_dir.join("linked"),
        )
        .unwrap();

        assert_eq!(
            fixture.list(),
            [
                DataFolder {
                    name: "odd".into(),
                    title: "odd".into(),
                    epicenter: false
                },
                DataFolder {
                    name: "plain".into(),
                    title: "plain".into(),
                    epicenter: false
                },
                DataFolder {
                    name: "vault".into(),
                    title: "vault".into(),
                    epicenter: false
                },
            ]
        );
    }

    #[test]
    fn a_missing_root_lists_nothing() {
        let fixture = fixture("missing");
        fs::remove_dir_all(&fixture.folder_dir).unwrap();
        assert_eq!(fixture.list(), []);
    }

    #[test]
    fn titles_come_from_epicenter_json_when_it_names_one() {
        let fixture = fixture("titles");
        data_folder(
            &fixture,
            "reading",
            r#"{ "title": "Reading list", "tables": {} }"#,
        );
        data_folder(&fixture, "numbered", r#"{ "title": 7 }"#);
        data_folder(&fixture, "broken", "not json");
        data_folder(
            &fixture,
            DEFAULT_EPICENTER_FOLDER,
            r#"{ "title": "Epicenter" }"#,
        );

        let titles: Vec<(String, String)> = fixture
            .list()
            .into_iter()
            .map(|folder| (folder.name, folder.title))
            .collect();
        assert_eq!(
            titles,
            [
                ("broken".into(), "broken".into()),
                (DEFAULT_EPICENTER_FOLDER.into(), "Epicenter".into()),
                ("numbered".into(), "numbered".into()),
                ("reading".into(), "Reading list".into()),
            ]
        );
    }

    #[test]
    fn the_reply_names_no_path() {
        let fixture = fixture("no-path");
        data_folder(&fixture, "vault", "{}");
        data_folder(&fixture, "so.epicenter.capture", "{}");
        let reply = serde_json::to_string(&fixture.list()).unwrap();
        assert!(!reply.contains('/'), "{reply}");
        assert!(!reply.contains('\\'), "{reply}");
        assert!(
            !reply.contains(fixture.folder_dir.to_str().unwrap()),
            "{reply}"
        );
    }

    /// Choosing a listed folder opens a separate editor window bound to that
    /// folder alone; choosing it again reveals the same window.
    #[test]
    fn a_listed_folder_opens_in_its_own_editor_window_and_again_reveals_it() {
        let fixture = fixture("editor");
        data_folder(&fixture, "vault", "{}");
        fs::write(fixture.folder_dir.join("vault/notes.md"), "").unwrap();
        data_folder(&fixture, "books", "{}");

        let (vault, was_open) = fixture.open_editor("vault").unwrap();
        assert_eq!(was_open, false);
        assert!(vault.starts_with("files:"), "{vault}");
        let (books, _) = fixture.open_editor("books").unwrap();
        assert_ne!(vault, books);
        assert_eq!(fixture.open_editor("vault").unwrap(), (vault.clone(), true));

        assert_eq!(
            root_names(&fixture.window(&vault)),
            ["epicenter.json", "notes.md"]
        );
        assert_eq!(root_names(&fixture.window(&books)), ["epicenter.json"]);
        // The Folders window itself is bound to no folder.
        let launcher =
            WebviewWindowBuilder::new(&fixture.app, BuiltInApp::Folders.id(), Default::default())
                .build()
                .unwrap();
        assert_eq!(
            invoke(&launcher, "open_folder", json!({})).unwrap_err(),
            json!({ "name": "NotBound" })
        );
    }

    /// Epicenter's own folder is listed and may be edited in its editor
    /// window; Settings is bound to it too, made when it is missing.
    #[test]
    fn epicenters_own_folder_opens_in_settings_and_in_its_editor() {
        let fixture = fixture("epicenter");
        let paths = DesktopPaths {
            data_dir: fixture.folder_dir.join(".app-data"),
            folder_dir: fixture.folder_dir.clone(),
        };
        let settings = folders_config::open_epicenter(&paths.data_dir, &paths.folder_dir).unwrap();
        assert!(fixture.folder_dir.join(DEFAULT_EPICENTER_FOLDER).is_dir());
        assert!(overlaps_epicenter_files(&paths, &settings));
        fs::write(fixture.folder_dir.join("so.epicenter/notes.md"), "").unwrap();

        let home = fixture
            .app
            .folders()
            .bind_while_building("home", settings, || {
                Ok::<_, anyhow::Error>(
                    WebviewWindowBuilder::new(&fixture.app, "home", Default::default()).build()?,
                )
            })
            .unwrap();
        assert_eq!(root_names(&home), ["notes.md"]);
        let (editor, _) = fixture.open_editor(DEFAULT_EPICENTER_FOLDER).unwrap();
        assert_eq!(root_names(&fixture.window(&editor)), ["notes.md"]);
    }

    #[test]
    fn admission_protects_settings_staged_bytes_and_a_missing_parent_in_app_data() {
        let fixture = fixture("protected-sidecars");
        let scratch = fixture.folder_dir.join(".so.epicenter.epicenter-scratch");
        fs::create_dir(&scratch).unwrap();
        let private = fixture.folder_dir.join("private");
        fs::create_dir(&private).unwrap();
        let paths = DesktopPaths {
            data_dir: fixture.folder_dir.join("absent/../private"),
            folder_dir: fixture.folder_dir.clone(),
        };
        assert!(!fixture.folder_dir.join("absent").exists());

        for protected in [&scratch, &private] {
            let directory = Directory::existing(protected).unwrap();
            assert!(overlaps_epicenter_files(&paths, &directory));
        }
        let ordinary = fixture.folder_dir.join("ordinary");
        fs::create_dir(&ordinary).unwrap();
        let directory = Directory::existing(&ordinary).unwrap();
        assert!(!overlaps_epicenter_files(&paths, &directory));
    }

    /// A listed folder that is gone, a name that is not one directory entry,
    /// and a link are refused, and nothing is created.
    #[test]
    fn an_editor_opens_only_a_listed_folder_that_is_still_there() {
        let fixture = fixture("editor-refused");
        data_folder(&fixture, "vault", "{}");
        fixture.list();
        fs::remove_dir_all(fixture.folder_dir.join("vault")).unwrap();
        assert_eq!(
            fixture.open_editor("vault").unwrap_err(),
            "The folder \"vault\" is not there anymore."
        );
        assert!(!fixture.folder_dir.join("vault").exists());

        fs::write(fixture.folder_dir.join("loose.md"), "").unwrap();
        for name in [
            "", ".", "..", "../vault", "/tmp", "a/b", ".hidden", "loose.md",
        ] {
            assert!(fixture.open_editor(name).is_err(), "{name:?}");
        }
        #[cfg(unix)]
        {
            let elsewhere = fixture.folder_dir.with_file_name(format!(
                "{}-elsewhere",
                fixture.folder_dir.file_name().unwrap().to_string_lossy()
            ));
            fs::create_dir_all(&elsewhere).unwrap();
            std::os::unix::fs::symlink(&elsewhere, fixture.folder_dir.join("linked")).unwrap();
            assert!(fixture.open_editor("linked").is_err());
            fs::remove_dir_all(&elsewhere).unwrap();
        }
    }
}
