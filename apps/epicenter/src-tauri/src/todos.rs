//! Todos, which Epicenter bundles, opened on one local folder per window.
//!
//! Epicenter builds Todos' installed page from `apps/todos` into
//! `dist/todos/`, and the scheme serves it at `/todos/` beside its own pages.
//! Opening it clones no repository and reads no `epicenter.app.json`, and no
//! account, approval, or Git step is on the way. The Folders window calls
//! `open_todos`; the shell assigns the window its folder in trusted Rust
//! before the WebView exists; the page calls `openFolder({ tables })`, which
//! asks the folder plugin for that assignment (`window_folder`) and is
//! granted it.
//!
//! - Open Todos: the fixed default, `<folder_dir>/Todos`, which the shell
//!   creates when it is missing. The name is this launch policy's choice, not
//!   one derived from an app id.
//! - Open in Todos: a folder the Folders window listed, named by its listed
//!   scope. It must already exist: a missing one is refused, never created,
//!   and never replaced by the default.
//!
//! Each directory gets its own scope, `todos:<name>`, registered as a data
//! folder (`FolderConfig::data`) for one window, `todos:<name in hex>`. The
//! plugin refuses that scope to every other window, and refuses the
//! directory once it is gone. The page names no path.
//!
//! This sits beside the installed-app path (`installed_apps.rs`) until that
//! path is removed.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::sync::{mpsc, Mutex};

use anyhow::Context;
use tauri::Manager;
use tauri_plugin_epicenter_folder::{FolderConfig, FolderExt, Folders, ScopeConfig, WindowFolder};

use crate::app_data::DesktopPaths;
use crate::data_folders::{DataFolderScopes, EPICENTER_FOLDER};
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

/// The directory names whose Todos scope this run registered.
#[derive(Default)]
pub struct TodosScopes(Mutex<BTreeSet<String>>);

/// Open Todos on the fixed default folder, or with `folder`, on a folder the
/// Folders window listed under that scope. A window already open on the
/// folder is revealed.
#[tauri::command]
#[specta::specta]
pub async fn open_todos(app: DesktopAppHandle, folder: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = app.state::<DesktopPaths>();
        let name = directory(
            &paths.folder_dir,
            &app.state::<DataFolderScopes>(),
            folder.as_deref(),
        )?;
        let label = assign(
            app.folders(),
            &app.state::<TodosScopes>(),
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
/// default when `folder` is `None`, created when it is missing, or the
/// directory the Folders window listed under the scope `folder`, which must
/// already be there.
fn directory(
    folder_dir: &Path,
    listed: &DataFolderScopes,
    folder: Option<&str>,
) -> Result<String, String> {
    let name = match folder {
        None => return Ok(DEFAULT_FOLDER.to_string()),
        Some(scope) => listed
            .listed_name(scope)
            .ok_or_else(|| "That folder is not in the list of folders.".to_string())?,
    };
    if name == EPICENTER_FOLDER {
        return Err("Epicenter's own folder cannot be opened in Todos.".to_string());
    }
    // `symlink_metadata` does not follow a link, so a linked directory is
    // refused, as the listing skips one.
    if !fs::symlink_metadata(folder_dir.join(&name)).is_ok_and(|stats| stats.is_dir()) {
        return Err(format!("The folder \"{name}\" is not there anymore."));
    }
    Ok(name)
}

/// Register the directory `name` under `folder_dir` as one Todos window's
/// folder, and hand that window its scope, before the window exists. Answers
/// the window's label. A second open of the same directory reuses both.
fn assign(
    folders: &Folders,
    registered: &TodosScopes,
    folder_dir: &Path,
    name: &str,
    fixed_default: bool,
) -> Result<String, String> {
    let label = window_label(name);
    let scope = format!("todos:{name}");
    let mut registered = registered
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !registered.contains(name) {
        if fixed_default {
            fs::create_dir_all(folder_dir.join(name))
                .map_err(|error| format!("The Todos folder could not be created: {error}"))?;
        }
        if !fs::symlink_metadata(folder_dir.join(name)).is_ok_and(|stats| stats.is_dir()) {
            return Err(format!("The folder \"{name}\" is not there anymore."));
        }
        folders.register(ScopeConfig {
            scope: scope.clone(),
            folder: FolderConfig::data(folder_dir.join(name)),
            windows: vec![label.clone()],
        })?;
        registered.insert(name.to_string());
    } else if !fs::symlink_metadata(folder_dir.join(name)).is_ok_and(|stats| stats.is_dir()) {
        return Err(format!("The folder \"{name}\" is not there anymore."));
    }
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

    use super::*;
    use crate::data_folders::{list_in, register_epicenter_folder};

    struct Fixture {
        app: App<MockRuntime>,
        folder_dir: PathBuf,
        listed: DataFolderScopes,
        registered: TodosScopes,
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
                &self.registered,
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
            registered: TodosScopes::default(),
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

        let refused =
            invoke(&window, "grant_directory", json!({ "scope": "todos:A" })).unwrap_err();
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
        assert_eq!(scope, "todos:Todos");
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
        let refused = invoke(
            &window,
            "grant_directory",
            json!({ "scope": "todos:Todos" }),
        )
        .unwrap_err();
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

    /// No window but the one assigned a folder is handed or granted it: not
    /// the Folders window, not another Todos window, and not an installed
    /// app's window.
    #[test]
    fn no_other_window_is_handed_or_granted_a_todos_folder() {
        let fixture = fixture();
        fixture.folder_with_todo("A", "milk");
        fixture.list();
        fixture.open(Some("data:A")).unwrap();

        let other_todos = window_label("B");
        for label in [
            "folders",
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
                invoke(&window, "grant_directory", json!({ "scope": "todos:A" })).unwrap_err();
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
