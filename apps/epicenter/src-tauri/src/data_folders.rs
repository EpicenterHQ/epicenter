//! The data folders under the Epicenter folder root, as the Folders window
//! opens them (ADR-0535).
//!
//! A data folder is a direct child of `folder_dir` that is a real directory,
//! not a link or a dot entry. The Folders window opens one with
//! `openFolder({ directory: id, tables: {} })`, so each listed
//! folder needs a scope that window may be granted:
//!
//! - An installed app's own folder is named by the app's id, and its scope is
//!   that id (ADR-0552). The shell registers it the first time the app is
//!   opened without a folder (`own_folder`), or the first time the listing
//!   finds a folder named by an installed app's id, whichever comes first,
//!   for the Folders window; opening the app permits its window too. Like
//!   each built-in app's folder before it, the first grant creates its
//!   directory when it is missing (`FolderConfig::new`). Both windows share
//!   the one scope and publish under the plugin's one mutex per root.
//! - Epicenter's own folder, `so.epicenter` (ADR-0539), is registered at
//!   setup for the Folders window and Settings, which hold its AI
//!   connections, and is listed under that scope. Settings runs Epicenter
//!   itself: the shell hands it `so.epicenter` as its folder. Its tables
//!   interpret the files there; opening publishes no declaration.
//! - Any other folder gets a scope of its own, `data:<directory name>`, the
//!   first time it is listed in a run, registered for the Folders window
//!   alone as a data folder (`FolderConfig::data`): the shell never creates
//!   its directory, and never gives it a repository of its own inside
//!   another repository's working tree. Listing again returns the same
//!   scope.
//!
//! A folder whose scope cannot be permitted or registered is left out of the
//! listing and logged; the others are still listed.
//!
//! The shell watches the root (`watch_data_folders`) and tells the Folders
//! window when the listing may have changed, so it lists again.
//!
//! The reply carries scope IDs and titles, never paths. The page learns a
//! folder's root from the plugin's grant, as every folder page does.

use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path};
use std::sync::Mutex;
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, Debouncer, NoCache};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_epicenter_folder::{
    FolderConfig, FolderExt, Folders, GrantError, ScopeConfig, WindowFolder,
};

use crate::app_data::DesktopPaths;
use crate::{BuiltInApp, DesktopAppHandle};

/// Epicenter's own folder: its AI connections (ADR-0539, ADR-0569). It is
/// named by Epicenter's id, as each app's folder is named by its id.
pub const EPICENTER_FOLDER: &str = "so.epicenter";

/// The windows that hold Epicenter's own folder.
const EPICENTER_FOLDER_WINDOWS: [BuiltInApp; 2] = [BuiltInApp::Folders, BuiltInApp::Home];

/// The file that makes a directory a data folder (ADR-0517).
const DECLARATION: &str = "epicenter.json";

/// Register Epicenter's own folder for the Folders window and Settings. Each
/// page runs `@epicenter/folder`'s own engine over its directory; the shell
/// grants it to the windows registered for it, and owns nothing else.
/// Settings runs Epicenter itself, so it is handed `so.epicenter` as its own
/// folder; the Folders window runs no app and opens folders by scope.
pub fn register_epicenter_folder(folders: &Folders, folder_dir: &Path) -> Result<(), String> {
    folders.register(ScopeConfig {
        scope: EPICENTER_FOLDER.into(),
        folder: FolderConfig::new(folder_dir.join(EPICENTER_FOLDER)),
        windows: EPICENTER_FOLDER_WINDOWS
            .iter()
            .map(|window| window.id().into())
            .collect(),
    })?;
    folders.hand(
        BuiltInApp::Home.id(),
        WindowFolder {
            app: EPICENTER_FOLDER.into(),
            folder: EPICENTER_FOLDER.into(),
        },
    );
    Ok(())
}

/// Let the window `label` of installed app `id` into `folder`, the scope it
/// opens, and into `so.epicenter`, whose `connections` table its AI commands
/// name (ADR-0557, ADR-0570), and hand it `folder`: the page opens the folder
/// `window_folder` answers it, never one its own URL names.
pub fn admit_installed_window(
    folders: &Folders,
    label: &str,
    id: &str,
    folder: &str,
) -> Result<(), GrantError> {
    folders.permit(folder, label)?;
    folders.permit(EPICENTER_FOLDER, label)?;
    folders.hand(
        label,
        WindowFolder {
            app: id.into(),
            folder: folder.into(),
        },
    );
    Ok(())
}

/// One data folder the Folders window can open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DataFolder {
    /// The scope to pass as `directory` to `openFolder`.
    pub id: String,
    /// `epicenter.json`'s `title` when it is a string, else the directory name.
    pub title: String,
}

/// The scopes this run registered under the root, by directory name: a data
/// folder's `data:<name>`, or an installed app's own folder's `<app-id>`.
#[derive(Default)]
pub struct DataFolderScopes(Mutex<BTreeMap<String, String>>);

impl DataFolderScopes {
    /// The directory name of the folder listed under `scope`: one this run
    /// registered, or Epicenter's own folder. Another window opens a listed
    /// folder by the scope the Folders window passed, never by a path.
    pub fn listed_name(&self, scope: &str) -> Option<String> {
        if scope == EPICENTER_FOLDER {
            return Some(EPICENTER_FOLDER.to_string());
        }
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .find(|(_, id)| id.as_str() == scope)
            .map(|(name, _)| name.clone())
    }
}

/// List the data folders under the Epicenter folder root, and let the Folders
/// window open each one.
///
/// Granted to the `folders` window alone. Every scope it returns is one that
/// window is registered or permitted for, so `openFolder({ directory: id,
/// tables: {} })` there
/// can be granted it. Off the main thread, since it reads the disk.
#[tauri::command(async)]
#[specta::specta]
pub fn list_data_folders(app: DesktopAppHandle) -> Result<Vec<DataFolder>, String> {
    let paths = app.state::<DesktopPaths>();
    list_in(
        &paths.folder_dir,
        &paths.apps_dir(),
        app.folders(),
        &app.state::<DataFolderScopes>(),
    )
}

/// The scope of installed app `id`'s own folder, `<folder_dir>/<id>`, which is
/// `id` itself, registered for the Folders window the first time it is asked
/// for. The app is handed it when it is opened without a folder (ADR-0552);
/// the first grant creates its directory.
pub fn own_folder(app: &DesktopAppHandle, id: &str) -> Result<String, String> {
    let folder_dir = &app.state::<DesktopPaths>().folder_dir;
    own_folder_in(folder_dir, app.folders(), &app.state::<DataFolderScopes>(), id)
}

fn own_folder_in(
    folder_dir: &Path,
    folders: &Folders,
    scopes: &DataFolderScopes,
    id: &str,
) -> Result<String, String> {
    let mut registered = scopes
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if registered.get(id).map(String::as_str) != Some(id) {
        // A folder listed before its app was installed has a data scope. The
        // app opens its folder by its id, so it gets its own scope over the
        // same directory, which later listings name instead. The data scope
        // stays registered, and both scopes publish under the one mutex the
        // plugin keeps per root (ADR-0568).
        register_own_folder(folders, folder_dir, id)?;
        registered.insert(id.to_string(), id.to_string());
    }
    Ok(id.to_string())
}

/// Register the scope `id` over `<folder_dir>/<id>` for the Folders window, as
/// an app's own folder, which the first grant creates when it is missing.
fn register_own_folder(folders: &Folders, folder_dir: &Path, id: &str) -> Result<(), String> {
    folders.register(ScopeConfig {
        scope: id.into(),
        folder: FolderConfig::new(folder_dir.join(id)),
        windows: vec![BuiltInApp::Folders.id().into()],
    })
}

pub(crate) fn list_in(
    folder_dir: &Path,
    apps_dir: &Path,
    folders: &Folders,
    scopes: &DataFolderScopes,
) -> Result<Vec<DataFolder>, String> {
    let window = BuiltInApp::Folders.id();
    let entries = match fs::read_dir(folder_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("The Epicenter folder could not be read: {error}")),
    };
    // Held across registration, so two listings at once register a folder once.
    let mut registered = scopes
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
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
        let root = entry.path();
        let declaration = root.join(DECLARATION);
        let title = fs::symlink_metadata(&declaration)
            .ok()
            .filter(|stats| stats.is_file())
            .and_then(|_| fs::read_to_string(&declaration).ok())
            .as_deref()
            .and_then(declared_title)
            .unwrap_or_else(|| name.clone());

        if name == EPICENTER_FOLDER {
            // Registered at setup for this window already.
            listed.push(DataFolder {
                id: EPICENTER_FOLDER.to_string(),
                title,
            });
            continue;
        }

        // Named by an installed app's id: that app's own folder, under the
        // app's scope, even when an earlier listing, before the app was
        // installed, registered it as `data:<name>`. That scope stays
        // registered; later listings and "Open in" name the app's.
        let installed = apps_dir.join(&name).is_dir();
        let id = match registered.get(&name) {
            Some(id) if !installed || id == &name => id.clone(),
            _ if installed => {
                if let Err(error) = register_own_folder(folders, folder_dir, &name) {
                    log::warn!("data folder '{name}' was not listed: {error}");
                    continue;
                }
                registered.insert(name.clone(), name.clone());
                name
            }
            Some(id) => id.clone(),
            None => {
                let id = format!("data:{name}");
                let folder = FolderConfig::data(root);
                if let Err(error) = folders.register(ScopeConfig {
                    scope: id.clone(),
                    folder,
                    windows: vec![window.into()],
                }) {
                    log::warn!("data folder '{name}' was not listed: {error}");
                    continue;
                }
                registered.insert(name, id.clone());
                id
            }
        };
        listed.push(DataFolder { id, title });
    }
    listed.sort_by_cached_key(|folder| (folder.title.to_lowercase(), folder.id.clone()));
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
) -> Result<DataFoldersWatch, String> {
    let root = folder_dir.to_path_buf();
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
                                .any(|path| changes_listing(&root, path)))
                }),
                // Some events could not be delivered.
                Err(_) => true,
            };
            if changed {
                let _ = app.emit_to(BuiltInApp::Folders.id(), DATA_FOLDERS_CHANGED, ());
            }
        },
        NoCache,
        notify::Config::default().with_follow_symlinks(false),
    )
    .map_err(|cause| format!("'{}' could not be watched: {cause}", folder_dir.display()))?;
    debouncer
        .watch(folder_dir, RecursiveMode::Recursive)
        .map_err(|cause| format!("'{}' could not be watched: {cause}", folder_dir.display()))?;
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
    //! The listing over a real directory, and the folder plugin's grant
    //! through Tauri's real invoke path on the mock runtime.

    use std::path::PathBuf;

    use serde_json::{json, Value};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
    use tauri::utils::acl::ExecutionContext;
    use tauri::webview::InvokeRequest;
    use tauri::{App, WebviewWindow, WebviewWindowBuilder};

    use super::*;

    struct Fixture {
        app: App<MockRuntime>,
        folder_dir: PathBuf,
        /// The installed apps' clones, in app data beside the folder root.
        apps_dir: PathBuf,
        scopes: DataFolderScopes,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.app.folders().shutdown();
            let _ = fs::remove_dir_all(&self.folder_dir);
            let _ = fs::remove_dir_all(&self.apps_dir);
        }
    }

    impl Fixture {
        fn list(&self) -> Vec<DataFolder> {
            list_in(
                &self.folder_dir,
                &self.apps_dir,
                self.app.folders(),
                &self.scopes,
            )
            .unwrap()
        }

        fn own_folder(&self, id: &str) -> String {
            own_folder_in(&self.folder_dir, self.app.folders(), &self.scopes, id).unwrap()
        }

        fn window(&self, label: &str) -> WebviewWindow<MockRuntime> {
            WebviewWindowBuilder::new(&self.app, label, Default::default())
                .build()
                .expect("mock window")
        }
    }

    /// An app with the folder plugin and Epicenter's own folder registered,
    /// over an empty folder root.
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
        register_epicenter_folder(app.folders(), &folder_dir).unwrap();
        let apps_dir = PathBuf::from(format!("{}-apps", folder_dir.display()));
        Fixture {
            app,
            folder_dir,
            apps_dir,
            scopes: DataFolderScopes::default(),
        }
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

    /// Grant `scope` to `window`, then list the root's entry names through it.
    fn granted_names(window: &WebviewWindow<MockRuntime>, scope: &str) -> Vec<String> {
        invoke(window, "grant_directory", json!({ "scope": scope }))
            .unwrap_or_else(|error| panic!("{} was not granted {scope}: {error}", window.label()));
        let children = invoke(
            window,
            "read_folder_children",
            json!({ "scope": scope, "directory": "" }),
        )
        .unwrap();
        let mut names: Vec<String> = ["files", "directories"]
            .iter()
            .flat_map(|kind| children[*kind].as_array().unwrap().clone())
            .map(|name| {
                name.as_str()
                    .unwrap_or_else(|| panic!("{name}"))
                    .to_string()
            })
            .collect();
        names.sort();
        names
    }

    #[test]
    fn the_folders_window_hears_a_new_data_folder() {
        use tauri::Listener;

        let fixture = fixture("watch");
        let window = fixture.window(BuiltInApp::Folders.id());
        let (heard, hearing) = std::sync::mpsc::channel();
        window.listen(DATA_FOLDERS_CHANGED, move |_| {
            let _ = heard.send(());
        });
        let _watch = watch_data_folders(fixture.app.handle(), &fixture.folder_dir).unwrap();
        // The operating system may report the root's creation late; settle it.
        std::thread::sleep(Duration::from_millis(500));
        while hearing.try_recv().is_ok() {}

        data_folder(&fixture, "books", "{}");

        hearing
            .recv_timeout(Duration::from_secs(5))
            .expect("the Folders window hears the new folder");
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
                DataFolder { id: "data:odd".into(), title: "odd".into() },
                DataFolder { id: "data:plain".into(), title: "plain".into() },
                DataFolder { id: "data:vault".into(), title: "vault".into() },
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

        let titles: Vec<(String, String)> = fixture
            .list()
            .into_iter()
            .map(|folder| (folder.id, folder.title))
            .collect();
        assert_eq!(
            titles,
            [
                ("data:broken".into(), "broken".into()),
                ("data:numbered".into(), "numbered".into()),
                ("data:reading".into(), "Reading list".into()),
            ]
        );
    }

    #[test]
    fn an_installed_apps_folder_is_listed_under_its_id() {
        let fixture = fixture("application");
        data_folder(&fixture, "so.epicenter.todos", r#"{ "title": "Todos" }"#);
        // Not installed: a data folder like any other.
        assert_eq!(fixture.list()[0].id, "data:so.epicenter.todos");

        let fixture = self::fixture("installed");
        data_folder(&fixture, "so.epicenter.todos", r#"{ "title": "Todos" }"#);
        fs::create_dir_all(fixture.apps_dir.join("so.epicenter.todos")).unwrap();
        assert_eq!(
            fixture.list(),
            [DataFolder {
                id: "so.epicenter.todos".into(),
                title: "Todos".into(),
            }]
        );
        // Listing again, and opening the app without a folder, keep the scope.
        assert_eq!(fixture.list()[0].id, "so.epicenter.todos");
        assert_eq!(fixture.own_folder("so.epicenter.todos"), "so.epicenter.todos");
    }

    #[test]
    fn epicenters_own_folder_is_listed_under_its_scope_for_both_windows() {
        let fixture = fixture("epicenter");
        data_folder(&fixture, EPICENTER_FOLDER, r#"{ "title": "Epicenter" }"#);
        fs::write(fixture.folder_dir.join("so.epicenter/notes.md"), "").unwrap();

        assert_eq!(
            fixture.list(),
            [DataFolder {
                id: EPICENTER_FOLDER.into(),
                title: "Epicenter".into(),
            }]
        );
        for label in ["folders", "home"] {
            assert_eq!(
                granted_names(&fixture.window(label), EPICENTER_FOLDER),
                ["epicenter.json", "notes.md"]
            );
        }
        assert!(invoke(
            &fixture.window("todos"),
            "grant_directory",
            json!({ "scope": EPICENTER_FOLDER })
        )
        .is_err());
    }

    #[test]
    fn settings_is_handed_epicenters_folder_and_the_folders_window_nothing() {
        let fixture = fixture("handed-built-in");
        assert_eq!(
            invoke(&fixture.window("home"), "window_folder", json!({})).unwrap(),
            json!({ "app": EPICENTER_FOLDER, "folder": EPICENTER_FOLDER })
        );
        assert_eq!(
            invoke(&fixture.window("folders"), "window_folder", json!({})).unwrap(),
            Value::Null
        );
    }

    /// An installed app's window is let into the folder it opens and into
    /// Epicenter's folder, and is handed the first with its app's id; its
    /// own folder is not one it may reach unless that is what it opens.
    #[test]
    fn an_installed_window_is_handed_the_folder_it_opens() {
        let fixture = fixture("handed-installed");
        data_folder(&fixture, "groceries", "{}");
        let id = fixture.list().remove(0).id;
        let label = "app:so_epicenter_todos:646174613a67726f636572696573";
        admit_installed_window(fixture.app.folders(), label, "so.epicenter.todos", &id)
            .unwrap();
        let todos = fixture.window(label);

        assert_eq!(
            invoke(&todos, "window_folder", json!({})).unwrap(),
            json!({ "app": "so.epicenter.todos", "folder": "data:groceries" })
        );
        assert_eq!(granted_names(&todos, &id), ["epicenter.json"]);
        fs::create_dir_all(fixture.folder_dir.join(EPICENTER_FOLDER)).unwrap();
        assert!(invoke(&todos, "grant_directory", json!({ "scope": EPICENTER_FOLDER })).is_ok());
        assert_eq!(fixture.own_folder("so.epicenter.todos"), "so.epicenter.todos");
        assert!(invoke(
            &todos,
            "grant_directory",
            json!({ "scope": "so.epicenter.todos" })
        )
        .is_err());
        // An unregistered folder is refused, and nothing is handed.
        let stray = "app:so_epicenter_todos:6e6f6e65";
        assert!(admit_installed_window(fixture.app.folders(), stray, "so.epicenter.todos", "none")
            .is_err());
        assert_eq!(
            invoke(&fixture.window(stray), "window_folder", json!({})).unwrap(),
            Value::Null
        );
    }

    #[test]
    fn another_folder_is_registered_once_and_keeps_its_scope() {
        let fixture = fixture("stable");
        data_folder(&fixture, "vault", "{}");
        let first = fixture.list();
        // A second registration of `data:vault` would leave it out.
        let second = fixture.list();
        assert_eq!(first, second);
        assert_eq!(first[0].id, "data:vault");
    }

    #[test]
    fn a_folder_that_cannot_be_registered_is_left_out_and_the_rest_are_listed() {
        let fixture = fixture("skipped");
        data_folder(&fixture, "vault", "{}");
        data_folder(&fixture, "notes", "{}");
        // Something else already registered `data:vault`, so this listing's
        // registration of it is refused.
        fixture
            .app
            .folders()
            .register(ScopeConfig {
                scope: "data:vault".into(),
                folder: FolderConfig::data(fixture.folder_dir.join("vault")),
                windows: vec!["elsewhere".into()],
            })
            .unwrap();

        let ids: Vec<String> = fixture.list().into_iter().map(|folder| folder.id).collect();
        assert_eq!(ids, ["data:notes"]);
    }

    #[test]
    fn a_data_folder_removed_after_listing_is_missing_not_recreated() {
        let fixture = fixture("removed");
        data_folder(&fixture, "vault", "{}");
        let folders = fixture.window("folders");
        let id = fixture.list().remove(0).id;
        fs::remove_dir_all(fixture.folder_dir.join("vault")).unwrap();

        let refused = invoke(&folders, "grant_directory", json!({ "scope": id })).unwrap_err();
        assert_eq!(refused["name"], "Missing");
        assert!(!fixture.folder_dir.join("vault").exists());
    }

    #[test]
    fn an_apps_own_folder_is_created_on_its_first_grant_and_shared_with_the_folders_window() {
        let fixture = fixture("own");
        let id = fixture.own_folder("so.epicenter.todos");
        assert_eq!(id, "so.epicenter.todos");
        // Asking again returns the one scope rather than registering another.
        assert_eq!(fixture.own_folder("so.epicenter.todos"), id);
        let label = "app:so_epicenter_todos";
        fixture.app.folders().permit(&id, label).unwrap();
        let todos = fixture.window(label);
        let folders = fixture.window("folders");

        assert!(!fixture.folder_dir.join(&id).exists());
        assert_eq!(granted_names(&todos, &id), Vec::<String>::new());
        assert!(fixture.folder_dir.join(&id).is_dir(), "the grant created it");
        fs::write(fixture.folder_dir.join(&id).join(DECLARATION), "{}").unwrap();
        fs::write(fixture.folder_dir.join(&id).join("one.md"), "one").unwrap();

        let listed = fixture.list();
        assert_eq!(listed[0].id, id);
        assert_eq!(granted_names(&folders, &id), ["epicenter.json", "one.md"]);
        // The app's window keeps its grant beside the Folders window's.
        assert_eq!(granted_names(&todos, &id), ["epicenter.json", "one.md"]);
    }

    /// The Folders window opens a folder under its data scope before the
    /// folder's app is installed; the app then opens it under its own scope
    /// in its own window, while the Folders window still holds it. Both are
    /// granted the one root, and later listings name the app's scope.
    #[test]
    fn a_folder_listed_before_its_app_was_installed_moves_to_the_apps_scope() {
        let fixture = fixture("listed-first");
        data_folder(&fixture, "so.epicenter.todos", "{}");
        assert_eq!(fixture.list()[0].id, "data:so.epicenter.todos");
        let folders = fixture.window("folders");
        assert_eq!(
            granted_names(&folders, "data:so.epicenter.todos"),
            ["epicenter.json"]
        );

        assert_eq!(fixture.own_folder("so.epicenter.todos"), "so.epicenter.todos");
        let label = "app:so_epicenter_todos";
        fixture
            .app
            .folders()
            .permit("so.epicenter.todos", label)
            .unwrap();
        let todos = fixture.window(label);
        assert_eq!(granted_names(&todos, "so.epicenter.todos"), ["epicenter.json"]);
        assert_eq!(fixture.list()[0].id, "so.epicenter.todos");
        assert_eq!(
            granted_names(&folders, "so.epicenter.todos"),
            ["epicenter.json"]
        );
    }

    /// A folder listed under its data scope before its app was installed is
    /// listed under the app's scope once the app is, without the app being
    /// opened first, so "Open in" hands the app its own folder.
    #[test]
    fn a_listing_after_the_app_is_installed_names_the_apps_scope() {
        let fixture = fixture("installed-later");
        data_folder(&fixture, "so.epicenter.todos", "{}");
        assert_eq!(fixture.list()[0].id, "data:so.epicenter.todos");

        fs::create_dir_all(fixture.apps_dir.join("so.epicenter.todos")).unwrap();
        assert_eq!(fixture.list()[0].id, "so.epicenter.todos");
        assert_eq!(fixture.list()[0].id, "so.epicenter.todos");
        assert_eq!(fixture.own_folder("so.epicenter.todos"), "so.epicenter.todos");
        let folders = fixture.window("folders");
        assert_eq!(
            granted_names(&folders, "so.epicenter.todos"),
            ["epicenter.json"]
        );
    }

    #[test]
    fn a_registered_data_folder_is_granted_to_the_folders_window_alone() {
        let fixture = fixture("data-grant");
        data_folder(&fixture, "vault", "{}");
        let folders = fixture.window("folders");
        let todos = fixture.window("todos");

        let id = fixture.list().remove(0).id;
        assert_eq!(granted_names(&folders, &id), ["epicenter.json"]);
        assert!(invoke(&todos, "grant_directory", json!({ "scope": id })).is_err());
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
}
