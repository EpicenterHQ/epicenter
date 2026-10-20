//! Todos, which Epicenter bundles, opened on one local folder per window.
//!
//! Epicenter builds Todos' installed page from `apps/todos` into
//! `dist/todos/`, and the scheme serves it at `/todos/` beside its own pages.
//! Opening it clones no repository and reads no `epicenter.app.json`, and no
//! account, approval, or Git step is on the way. The Folders window calls
//! `open_todos`; the shell permits the window into its folder and hands it
//! that folder in trusted Rust before the WebView exists; the page calls
//! `openFolder({ tables })`, which asks the folder plugin for that assignment
//! (`window_folder`) and is granted it.
//!
//! - Open Todos: the fixed default, `<folder_dir>/Todos`, which the shell
//!   creates when it is missing and this run has not registered it. The name
//!   is this launch policy's choice, not one derived from an app id. A
//!   default that was there and is removed later in the run is refused, not
//!   made again.
//! - Open in Todos: a folder the Folders window listed, named by its listed
//!   scope. It must already exist: a missing one is refused, never created,
//!   and never replaced by the default. Epicenter's own folder is refused.
//!
//! Todos adds no scope of its own. A directory is one entry in the folder
//! registry (`data_folders::scope_for_window`): the entry, with its root,
//! lock, and watch, that the Folders window opens the folder through. The
//! Todos window `todos:<name in hex>` is permitted into that entry by its
//! exact label. Other windows need their own grants, and the plugin refuses
//! the directory once it is gone. The page names no path.
//!
//! This sits beside the installed-app path (`installed_apps.rs`) until that
//! path is removed.

use std::fs;
use std::path::Path;
use std::sync::mpsc;

use anyhow::Context;
use tauri::Manager;
use tauri_plugin_epicenter_folder::{FolderExt, Folders, WindowFolder};

use crate::app_data::DesktopPaths;
use crate::data_folders::{scope_for_window, DataFolderScopes, EPICENTER_FOLDER};
use crate::DesktopAppHandle;

/// The directory below the pages directory that holds Todos' build, and the
/// first segment of the path the scheme serves it at.
pub const PAGE: &str = "todos";

/// Where every Todos window opens, whatever folder it was assigned. Its
/// navigation stays below this path.
pub const PATH: &str = "/todos/";

/// The fixed default folder under the authored folder root.
pub const DEFAULT_FOLDER: &str = "Todos";

/// The app `window_folder` names to a Todos window.
const APP: &str = "so.epicenter.todos";

/// Every Todos window's label starts with this; `capabilities/todos.json`
/// selects `todos:*`.
pub const WINDOW_PREFIX: &str = "todos:";

/// Open Todos on the fixed default folder, or with `folder`, on a folder the
/// Folders window listed under that scope. A window already open on the
/// folder is revealed.
#[tauri::command]
#[specta::specta]
pub async fn open_todos(app: DesktopAppHandle, folder: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = app.state::<DesktopPaths>();
        let listed = app.state::<DataFolderScopes>();
        let name = directory(&paths.folder_dir, &listed, folder.as_deref())?;
        let label = assign(
            app.folders(),
            &listed,
            &paths.folder_dir,
            &name,
            folder.is_none(),
        )?;
        open_window(&app, &label, &title(&name)).map_err(|error| format!("{error:#}"))
    })
    .await
    .map_err(|error| format!("the Todos window could not be opened: {error}"))?
}

/// The name of the directory under `folder_dir` that Todos opens: the fixed
/// default when `folder` is `None`, or the directory the Folders window
/// listed under the scope `folder`. Whether it is there is checked by
/// `assign`, under the registry's lock.
fn directory(
    folder_dir: &Path,
    listed: &DataFolderScopes,
    folder: Option<&str>,
) -> Result<String, String> {
    let Some(scope) = folder else {
        return Ok(default_name(folder_dir, listed));
    };
    let name = listed
        .listed_name(scope)
        .ok_or_else(|| "That folder is not in the list of folders.".to_string())?;
    // A case-insensitive disk names one directory by every casing.
    if name.eq_ignore_ascii_case(EPICENTER_FOLDER) {
        return Err("Epicenter's own folder cannot be opened in Todos.".to_string());
    }
    Ok(name)
}

/// The name the default folder has on disk. A case-insensitive disk that
/// already holds it as `todos` lists it as `todos`, and the window and scope
/// are named by the listed spelling, so the default is one directory with one
/// window, not two. An exact `Todos` always wins, so a case-sensitive disk
/// keeps its two directories apart.
fn default_name(folder_dir: &Path, listed: &DataFolderScopes) -> String {
    let Ok(entries) = fs::read_dir(folder_dir) else {
        return listed
            .known_name_like(DEFAULT_FOLDER)
            .unwrap_or_else(|| DEFAULT_FOLDER.to_string());
    };
    let mut spelled = None;
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if name == DEFAULT_FOLDER {
            return name;
        }
        if name.eq_ignore_ascii_case(DEFAULT_FOLDER) {
            spelled = Some(name);
        }
    }
    // Another spelling is the same directory only where the disk resolves it
    // from the default's name.
    match spelled {
        Some(name) if fs::symlink_metadata(folder_dir.join(DEFAULT_FOLDER)).is_ok() => name,
        Some(_) => DEFAULT_FOLDER.to_string(),
        None => listed
            .known_name_like(DEFAULT_FOLDER)
            .unwrap_or_else(|| DEFAULT_FOLDER.to_string()),
    }
}

/// Permit the Todos window of directory `name` into that directory's registry
/// entry, and hand it the entry's scope, before the window exists. Answers
/// the window's label. A second open of the same directory reuses both.
/// `fixed_default` lets a first open make the directory (`scope_for_window`).
fn assign(
    folders: &Folders,
    listed: &DataFolderScopes,
    folder_dir: &Path,
    name: &str,
    fixed_default: bool,
) -> Result<String, String> {
    let label = window_label(name);
    let scope = scope_for_window(folders, folder_dir, listed, name, fixed_default)?;
    folders
        .permit(&scope, &label)
        .map_err(|error| format!("The folder \"{name}\" could not be opened: {error:?}"))?;
    folders.hand(
        &label,
        WindowFolder {
            app: APP.into(),
            folder: scope,
        },
    );
    Ok(label)
}

/// The label of the Todos window on directory `name`: one window per folder.
/// A label may hold only letters, digits, `-`, `/`, `:`, and `_`, so the name
/// is spelled in hex.
fn window_label(name: &str) -> String {
    let mut label = WINDOW_PREFIX.to_string();
    for byte in name.bytes() {
        label.push_str(&format!("{byte:02x}"));
    }
    label
}

fn title(name: &str) -> String {
    if name == DEFAULT_FOLDER {
        "Todos".to_string()
    } else {
        format!("Todos: {name}")
    }
}

/// Open the Todos window `label`, already assigned its folder, at `PATH`, or
/// reveal it when it is open. The window is destroyed when it closes.
fn open_window(app: &DesktopAppHandle, label: &str, title: &str) -> anyhow::Result<()> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let window_app = app.clone();
    let label = label.to_string();
    let title = title.to_string();
    app.run_on_main_thread(move || {
        let result = match window_app.get_webview_window(&label) {
            Some(window) => {
                crate::focus(window);
                Ok(())
            }
            None => crate::create_app_window(&window_app, &label, &title, PATH).map(crate::focus),
        };
        let _ = sender.send(result);
    })
    .context("schedule the Todos window on the main thread")?;
    receiver
        .recv()
        .context("the main thread stopped before opening the window")?
}

#[cfg(test)]
mod tests {
    //! The assignment through the folder plugin's real commands on the mock
    //! runtime, as the Todos page calls them when it opens its folder.

    use std::path::PathBuf;

    use serde_json::{json, Value};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
    use tauri::utils::acl::ExecutionContext;
    use tauri::webview::InvokeRequest;
    use tauri::{App, WebviewWindow, WebviewWindowBuilder};

    use tauri_plugin_epicenter_folder::GrantError;

    use super::*;
    use crate::data_folders::{list_in, register_epicenter_folder};

    struct Fixture {
        app: App<MockRuntime>,
        folder_dir: PathBuf,
        listed: DataFolderScopes,
        _temporary: tempfile::TempDir,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.app.folders().shutdown();
        }
    }

    impl Fixture {
        /// List the folder root as the Folders window does, by scope and title.
        fn list(&self) -> Vec<(String, String)> {
            list_in(
                &self.folder_dir,
                &self.folder_dir.join("no-installed-apps"),
                self.app.folders(),
                &self.listed,
            )
            .unwrap()
            .into_iter()
            .map(|folder| (folder.id, folder.title))
            .collect()
        }

        /// What `open_todos` does before it makes the window.
        fn open(&self, folder: Option<&str>) -> Result<String, String> {
            let name = directory(&self.folder_dir, &self.listed, folder)?;
            assign(
                self.app.folders(),
                &self.listed,
                &self.folder_dir,
                &name,
                folder.is_none(),
            )
        }

        fn window(&self, label: &str) -> WebviewWindow<MockRuntime> {
            WebviewWindowBuilder::new(&self.app, label, Default::default())
                .build()
                .expect("mock window")
        }

        /// A data folder with one todo in it.
        fn folder_with_todo(&self, name: &str, id: &str) -> PathBuf {
            let root = self.folder_dir.join(name);
            fs::create_dir_all(root.join("todos")).unwrap();
            fs::write(
                root.join("todos").join(format!("{id}.md")),
                format!("---\ntitle: {id}\n---\n"),
            )
            .unwrap();
            root
        }
    }

    fn fixture() -> Fixture {
        let temporary = tempfile::tempdir().unwrap();
        let folder_dir = fs::canonicalize(temporary.path())
            .unwrap()
            .join("Epicenter");
        fs::create_dir_all(&folder_dir).unwrap();

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
        Fixture {
            app,
            folder_dir,
            listed: DataFolderScopes::default(),
            _temporary: temporary,
        }
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

    /// What the Todos page's `openFolder({ tables })` does: ask which folder
    /// the window was handed, then be granted it. Answers the scope and the
    /// granted root.
    fn open_assigned(window: &WebviewWindow<MockRuntime>) -> (String, String) {
        let handed = invoke(window, "window_folder", json!({})).unwrap();
        assert_eq!(handed["app"], APP);
        let scope = handed["folder"].as_str().unwrap().to_string();
        let granted = invoke(window, "grant_directory", json!({ "scope": scope })).unwrap();
        (scope, granted["root"].as_str().unwrap().to_string())
    }

    fn todo_files(window: &WebviewWindow<MockRuntime>, scope: &str) -> Value {
        invoke(
            window,
            "read_folder_children",
            json!({ "scope": scope, "directory": "todos" }),
        )
        .unwrap()["files"]
            .clone()
    }

    /// Two existing folders, each opened in its own window of the one Todos
    /// page: each window is handed and granted its own root, and neither is
    /// granted the other's.
    #[test]
    fn two_listed_folders_open_in_one_todos_page_each_granted_alone() {
        let fixture = fixture();
        let a = fixture.folder_with_todo("A", "milk");
        let b = fixture.folder_with_todo("B", "eggs");
        assert_eq!(
            fixture.list(),
            [
                ("data:A".to_string(), "A".to_string()),
                ("data:B".to_string(), "B".to_string()),
            ]
        );

        let label_a = fixture.open(Some("data:A")).unwrap();
        let label_b = fixture.open(Some("data:B")).unwrap();
        assert_ne!(label_a, label_b);
        for label in [&label_a, &label_b] {
            assert!(label.starts_with(WINDOW_PREFIX), "{label}");
        }
        let window_a = fixture.window(&label_a);
        let window_b = fixture.window(&label_b);

        let (scope_a, root_a) = open_assigned(&window_a);
        let (scope_b, root_b) = open_assigned(&window_b);
        assert_eq!(root_a, a.to_str().unwrap());
        assert_eq!(root_b, b.to_str().unwrap());
        assert_eq!(todo_files(&window_a, &scope_a), json!(["milk.md"]));
        assert_eq!(todo_files(&window_b, &scope_b), json!(["eggs.md"]));

        for (window, other) in [(&window_a, &scope_b), (&window_b, &scope_a)] {
            let refused = invoke(window, "grant_directory", json!({ "scope": other })).unwrap_err();
            assert_eq!(refused["name"], "WindowNotPermitted", "{other}");
        }
        // Opening A again reuses its window and scope.
        assert_eq!(fixture.open(Some("data:A")).unwrap(), label_a);
        assert_eq!(open_assigned(&window_a), (scope_a, root_a));
    }

    /// A listed folder that is gone is refused: nothing is created in its
    /// place, and the default is not opened instead.
    #[test]
    fn a_missing_listed_folder_is_refused_without_creating_it_or_the_default() {
        let fixture = fixture();
        fixture.folder_with_todo("A", "milk");
        fixture.list();
        fs::remove_dir_all(fixture.folder_dir.join("A")).unwrap();

        let refused = fixture.open(Some("data:A")).unwrap_err();
        assert_eq!(refused, "The folder \"A\" is not there anymore.");
        assert!(!fixture.folder_dir.join("A").exists());
        assert!(!fixture.folder_dir.join(DEFAULT_FOLDER).exists());
        assert_eq!(fixture.app.folders().handed(&window_label("A")), None);

        // A scope the Folders window never listed, and a path, open nothing.
        for unlisted in ["data:B", "todos:A", "/tmp", "../A", ""] {
            assert!(fixture.open(Some(unlisted)).is_err(), "{unlisted}");
        }
        assert!(!fixture.folder_dir.join(DEFAULT_FOLDER).exists());
    }

    #[test]
    fn epicenters_own_folder_is_not_handed_to_todos() {
        let fixture = fixture();
        let refused = fixture.open(Some(EPICENTER_FOLDER)).unwrap_err();
        assert_eq!(refused, "Epicenter's own folder cannot be opened in Todos.");
        assert_eq!(
            fixture
                .app
                .folders()
                .handed(&window_label(EPICENTER_FOLDER)),
            None
        );
    }

    /// A folder removed after its window was assigned it is refused at the
    /// grant, as a data folder, rather than made again.
    #[test]
    fn an_assigned_folder_removed_later_is_missing_not_recreated() {
        let fixture = fixture();
        fixture.folder_with_todo("A", "milk");
        fixture.list();
        let window = fixture.window(&fixture.open(Some("data:A")).unwrap());
        fs::remove_dir_all(fixture.folder_dir.join("A")).unwrap();

        let refused = invoke(&window, "grant_directory", json!({ "scope": "data:A" })).unwrap_err();
        assert_eq!(refused["name"], "Missing");
        assert!(!fixture.folder_dir.join("A").exists());
    }

    /// Open Todos makes the fixed default when it is missing, and the window
    /// is granted that directory, empty.
    #[test]
    fn the_missing_default_folder_is_created_and_granted() {
        let fixture = fixture();
        let default = fixture.folder_dir.join(DEFAULT_FOLDER);
        assert!(!default.exists());

        let label = fixture.open(None).unwrap();
        assert!(default.is_dir());
        let window = fixture.window(&label);
        let (scope, root) = open_assigned(&window);
        assert_eq!(scope, "data:Todos");
        assert_eq!(root, default.to_str().unwrap());
        assert_eq!(fs::read_dir(&default).unwrap().count(), 0);

        // Opening it again reuses the window and its scope.
        assert_eq!(fixture.open(None).unwrap(), label);
        // The listing shows the default as an ordinary data folder, and
        // Open in Todos on it opens the same window.
        assert!(fixture
            .list()
            .contains(&("data:Todos".to_string(), "Todos".to_string())));
        assert_eq!(fixture.open(Some("data:Todos")).unwrap(), label);
    }

    #[test]
    fn a_removed_default_is_not_recreated_in_the_same_run() {
        let fixture = fixture();
        let label = fixture.open(None).unwrap();
        let window = fixture.window(&label);
        open_assigned(&window);
        let default = fixture.folder_dir.join(DEFAULT_FOLDER);
        fs::remove_dir(&default).unwrap();

        assert_eq!(
            fixture.open(None).unwrap_err(),
            "The folder \"Todos\" is not there anymore."
        );
        assert!(!default.exists());
        let refused =
            invoke(&window, "grant_directory", json!({ "scope": "data:Todos" })).unwrap_err();
        assert_eq!(refused["name"], "Missing");
    }

    /// The default is not a link the shell would follow out of the root.
    #[cfg(unix)]
    #[test]
    fn a_linked_default_folder_is_refused() {
        let fixture = fixture();
        let elsewhere = fixture.folder_dir.with_file_name("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, fixture.folder_dir.join(DEFAULT_FOLDER)).unwrap();
        assert!(fixture.open(None).is_err());
    }

    /// Opening a listed folder in Todos adds the Todos window to the entry
    /// the Folders window already uses, not a second scope over the same
    /// directory: both windows are granted the same root under `data:A`, and
    /// the registry holds no `todos:` scope.
    #[test]
    fn a_todos_window_shares_the_folders_windows_registry_entry() {
        let fixture = fixture();
        let a = fixture.folder_with_todo("A", "milk");
        fixture.list();
        let label = fixture.open(Some("data:A")).unwrap();

        let registry = fixture.app.folders();
        assert_eq!(
            registry.handed(&label),
            Some(WindowFolder {
                app: APP.into(),
                folder: "data:A".into(),
            })
        );
        let folders = fixture.window("folders");
        let todos = fixture.window(&label);
        assert_eq!(
            invoke(&folders, "window_folder", json!({})).unwrap(),
            Value::Null
        );
        let from_folders = invoke(&folders, "grant_directory", json!({ "scope": "data:A" }));
        let (scope, root) = open_assigned(&todos);
        assert_eq!(scope, "data:A");
        assert_eq!(root, a.to_str().unwrap());
        assert_eq!(from_folders.unwrap()["root"], root.as_str());
        // Listing again, and opening again, add no scope and no window.
        fixture.list();
        assert_eq!(fixture.open(Some("data:A")).unwrap(), label);
        assert_eq!(
            registry.permit("todos:A", &label),
            Err(GrantError::UnknownScope {
                scope: "todos:A".into()
            })
        );
        // Granted `data:A` alone: not Epicenter's own folder.
        let refused = invoke(
            &todos,
            "grant_directory",
            json!({ "scope": EPICENTER_FOLDER }),
        )
        .unwrap_err();
        assert_eq!(refused["name"], "WindowNotPermitted");
    }

    /// Open Todos before the Folders window ever listed the default makes it
    /// under the scope the listing then reports, not a second one.
    #[test]
    fn the_default_opened_before_listing_is_the_listings_scope() {
        let fixture = fixture();
        let label = fixture.open(None).unwrap();
        assert_eq!(
            fixture.app.folders().handed(&label).unwrap().folder,
            "data:Todos"
        );
        assert_eq!(
            fixture.list(),
            [("data:Todos".to_string(), "Todos".to_string())]
        );
        let folders = fixture.window("folders");
        let granted = invoke(
            &folders,
            "grant_directory",
            json!({ "scope": "data:Todos" }),
        );
        assert_eq!(
            granted.unwrap()["root"],
            fixture.folder_dir.join(DEFAULT_FOLDER).to_str().unwrap()
        );
    }

    /// A default the listing found and that was removed is refused, not made
    /// again, even though Open Todos never opened it.
    #[test]
    fn a_listed_default_removed_before_open_todos_is_not_recreated() {
        let fixture = fixture();
        fixture.folder_with_todo(DEFAULT_FOLDER, "milk");
        fixture.list();
        fs::remove_dir_all(fixture.folder_dir.join(DEFAULT_FOLDER)).unwrap();
        assert_eq!(
            fixture.open(None).unwrap_err(),
            "The folder \"Todos\" is not there anymore."
        );
        assert!(!fixture.folder_dir.join(DEFAULT_FOLDER).exists());
    }

    /// The default is one directory with one window whatever its spelling on
    /// a case-insensitive disk, where the listing names it as it is stored.
    #[test]
    fn the_default_takes_the_spelling_the_directory_has() {
        let fixture = fixture();
        assert_eq!(
            default_name(&fixture.folder_dir, &fixture.listed),
            DEFAULT_FOLDER
        );
        fs::create_dir(fixture.folder_dir.join("todos")).unwrap();
        let insensitive = fixture.folder_dir.join(DEFAULT_FOLDER).exists();
        assert_eq!(
            default_name(&fixture.folder_dir, &fixture.listed),
            if insensitive { "todos" } else { DEFAULT_FOLDER }
        );
        if insensitive {
            let listed = fixture.list();
            assert_eq!(listed, [("data:todos".to_string(), "todos".to_string())]);
            let label = fixture.open(None).unwrap();
            assert_eq!(label, window_label("todos"));
            assert_eq!(fixture.open(Some("data:todos")).unwrap(), label);
        }
        // An exact `Todos` wins where both exist.
        if !insensitive {
            fs::create_dir(fixture.folder_dir.join(DEFAULT_FOLDER)).unwrap();
            assert_eq!(
                default_name(&fixture.folder_dir, &fixture.listed),
                DEFAULT_FOLDER
            );
        }
    }

    #[test]
    fn a_case_variant_default_removed_after_open_is_not_recreated() {
        let fixture = fixture();
        fs::create_dir(fixture.folder_dir.join("todos")).unwrap();
        if !fixture.folder_dir.join(DEFAULT_FOLDER).exists() {
            return; // This filesystem distinguishes the names.
        }
        fixture.list();
        let label = fixture.open(None).unwrap();
        assert_eq!(label, window_label("todos"));
        fs::remove_dir(fixture.folder_dir.join("todos")).unwrap();
        assert_eq!(
            fixture.open(None).unwrap_err(),
            "The folder \"todos\" is not there anymore."
        );
        assert!(!fixture.folder_dir.join(DEFAULT_FOLDER).exists());
    }

    /// No window but the one assigned a folder is handed or granted it,
    /// except the Folders window, which holds the entry already: not another
    /// Todos window, and not an installed app's window.
    #[test]
    fn no_other_window_is_handed_or_granted_a_todos_folder() {
        let fixture = fixture();
        fixture.folder_with_todo("A", "milk");
        fixture.list();
        fixture.open(Some("data:A")).unwrap();

        let other_todos = window_label("B");
        for label in [
            "home",
            other_todos.as_str(),
            "app:so_epicenter_todos",
            "app:so_epicenter_todos:646174613a41",
        ] {
            let window = fixture.window(label);
            assert_eq!(
                invoke(&window, "window_folder", json!({})).unwrap(),
                if label == "home" {
                    json!({ "app": "so.epicenter", "folder": "so.epicenter" })
                } else {
                    Value::Null
                },
                "{label}"
            );
            let refused =
                invoke(&window, "grant_directory", json!({ "scope": "data:A" })).unwrap_err();
            assert_eq!(refused["name"], "WindowNotPermitted", "{label}");
        }
    }

    #[test]
    fn a_window_label_is_one_folder_and_a_valid_label() {
        for (name, label) in [
            ("Todos", "todos:546f646f73"),
            ("My notes", "todos:4d79206e6f746573"),
        ] {
            let made = window_label(name);
            assert_eq!(made, label);
            assert!(made
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '/' | ':' | '_')));
        }
        assert_ne!(window_label("a"), window_label("b"));
        assert_eq!(title(DEFAULT_FOLDER), "Todos");
        assert_eq!(title("Groceries"), "Todos: Groceries");
    }
}
