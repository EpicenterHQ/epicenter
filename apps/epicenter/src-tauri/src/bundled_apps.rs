//! The apps Epicenter bundles, each opened on one local folder per window.
//!
//! `BundledApp` is the closed table: Todos, Capture, Honeycrisp, and
//! Whispering. Each row names the app's page, built from `apps/<page>` into
//! `dist/<page>/` and served by the scheme at `/<page>/`; its fixed default
//! folder under `folder_dir`; the label its windows get, which selects their
//! capability; and whether its windows also reach Epicenter's own folder.
//! Opening one clones no repository and reads no `epicenter.app.json`, and no
//! account, approval, or Git step is on the way. The Folders window calls
//! `open_bundled_app`; the shell permits the window into its folder and hands
//! it that folder in trusted Rust before the WebView exists. Todos, Capture,
//! and Honeycrisp call `openFolder({ tables })`; Whispering asks
//! `window_folder` for the recorder's scope and passes it as `directory` to
//! the public native `openFolder`. The plugin grants the assigned directory.
//!
//! - Open an app: the fixed default, `<folder_dir>/<name>`, such as
//!   `<folder_dir>/Todos`, which the shell creates when it is missing. The
//!   name is this launch policy's choice, not one derived from an app id.
//! - Open in an app: a folder the Folders window listed, named by its listed
//!   scope. It must already exist: a missing one is refused, never created,
//!   and never replaced by the default. Epicenter's own folder is refused.
//!
//! An app adds no scope of its own. A directory is one entry in the folder
//! registry (`data_folders::scope_for_window`): the entry, with its root,
//! lock, and watch, that the Folders window opens the folder through. The
//! window `<page>:<name in hex>` is permitted into that entry by its exact
//! label. Whispering's window is also permitted into `so.epicenter`, already
//! registered at setup, because its AI connections are rows there; it still
//! is handed its own folder. Other windows need their own grants, and the
//! plugin refuses the directory once it is gone. The page names no path.
//!
//! A window is destroyed when it closes, as Tauri closes any window: no
//! handler hides it. The recorder finalizes a Whispering recording when its
//! window is destroyed.
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

/// An app Epicenter bundles. The page API names it by its page.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum BundledApp {
    Todos,
    Capture,
    Honeycrisp,
    Whispering,
}

impl BundledApp {
    pub const ALL: [Self; 4] = [
        Self::Todos,
        Self::Capture,
        Self::Honeycrisp,
        Self::Whispering,
    ];

    /// The app's source folder under `apps/`, the directory below the pages
    /// directory that holds its build, the first segment of the path the
    /// scheme serves it at, and the start of its windows' labels.
    pub const fn page(self) -> &'static str {
        match self {
            Self::Todos => "todos",
            Self::Capture => "capture",
            Self::Honeycrisp => "honeycrisp",
            Self::Whispering => "whispering",
        }
    }

    /// The app's name: its windows' title, and its fixed default folder under
    /// the authored folder root.
    pub const fn name(self) -> &'static str {
        match self {
            Self::Todos => "Todos",
            Self::Capture => "Capture",
            Self::Honeycrisp => "Honeycrisp",
            Self::Whispering => "Whispering",
        }
    }

    /// The app `window_folder` names to its windows.
    const fn id(self) -> &'static str {
        match self {
            Self::Todos => "so.epicenter.todos",
            Self::Capture => "so.epicenter.capture",
            Self::Honeycrisp => "so.epicenter.honeycrisp",
            Self::Whispering => "so.epicenter.whispering",
        }
    }

    /// The capability file, by identifier, whose `windows` select this app's
    /// labels: the folder plugin alone, or Whispering's own grant. Tauri
    /// matches labels to the files; the tests hold the files to this.
    #[cfg(test)]
    pub const fn capability(self) -> &'static str {
        match self {
            Self::Todos | Self::Capture | Self::Honeycrisp => "bundled-app",
            Self::Whispering => "whispering",
        }
    }

    /// Whether the app's windows are also permitted into `so.epicenter`,
    /// whose `connections` table its AI commands name (ADR-0557).
    const fn reaches_connections(self) -> bool {
        matches!(self, Self::Whispering)
    }

    /// Where every window of the app opens, whatever folder it was assigned.
    /// Its navigation stays below this path.
    pub fn path(self) -> String {
        format!("/{}/", self.page())
    }

    pub fn from_page(page: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|app| app.page() == page)
    }

    /// Every label of the app's windows starts with this; its capability
    /// selects `<page>:*`.
    pub fn window_prefix(self) -> String {
        format!("{}:", self.page())
    }

    /// The label of the app's window on directory `name`: one window per app
    /// and folder. A label may hold only letters, digits, `-`, `/`, `:`, and
    /// `_`, so the name is spelled in hex.
    pub(crate) fn window_label(self, name: &str) -> String {
        let mut label = self.window_prefix();
        for byte in name.bytes() {
            label.push_str(&format!("{byte:02x}"));
        }
        label
    }

    fn window_title(self, name: &str) -> String {
        if name == self.name() {
            self.name().to_string()
        } else {
            format!("{}: {name}", self.name())
        }
    }
}

/// Open bundled app `app` on its fixed default folder, or with `folder`, on a
/// folder the Folders window listed under that scope. A window already open
/// on the folder is revealed.
#[tauri::command]
#[specta::specta]
pub async fn open_bundled_app(
    handle: DesktopAppHandle,
    app: BundledApp,
    folder: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = handle.state::<DesktopPaths>();
        let listed = handle.state::<DataFolderScopes>();
        let name = directory(&paths.folder_dir, &listed, app, folder.as_deref())?;
        let label = assign(
            handle.folders(),
            &listed,
            &paths.folder_dir,
            app,
            &name,
            folder.is_none(),
        )?;
        open_window(&handle, &label, &app.window_title(&name), &app.path())
            .map_err(|error| format!("{error:#}"))
    })
    .await
    .map_err(|error| format!("the {} window could not be opened: {error}", app.name()))?
}

/// The name of the directory under `folder_dir` that `app` opens: its fixed
/// default when `folder` is `None`, or the directory the Folders window
/// listed under the scope `folder`. Whether it is there is checked by
/// `assign`, under the registry's lock.
fn directory(
    folder_dir: &Path,
    listed: &DataFolderScopes,
    app: BundledApp,
    folder: Option<&str>,
) -> Result<String, String> {
    let Some(scope) = folder else {
        return Ok(default_name(folder_dir, app.name()));
    };
    let name = listed
        .listed_name(scope)
        .ok_or_else(|| "That folder is not in the list of folders.".to_string())?;
    // A case-insensitive disk names one directory by every casing.
    if name.eq_ignore_ascii_case(EPICENTER_FOLDER) {
        return Err(format!(
            "Epicenter's own folder cannot be opened in {}.",
            app.name()
        ));
    }
    Ok(name)
}

/// The name the default folder `default` has on disk. A case-insensitive
/// disk that already holds `Todos` as `todos` lists it as `todos`, and the
/// window and scope are named by the listed spelling, so the default is one
/// directory with one window, not two. An exact `default` always wins, so a
/// case-sensitive disk keeps its two directories apart.
fn default_name(folder_dir: &Path, default: &str) -> String {
    let Ok(entries) = fs::read_dir(folder_dir) else {
        return default.to_string();
    };
    let mut spelled = None;
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if name == default {
            return name;
        }
        if name.eq_ignore_ascii_case(default) {
            spelled = Some(name);
        }
    }
    // Another spelling is the same directory only where the disk resolves it
    // from the default's name.
    match spelled {
        Some(name) if fs::symlink_metadata(folder_dir.join(default)).is_ok() => name,
        Some(_) => default.to_string(),
        None => default.to_string(),
    }
}

/// Permit `app`'s window on directory `name` into that directory's registry
/// entry, and Whispering's into `so.epicenter` too, and hand it the entry's
/// scope, before the window exists. Answers the window's label. A second
/// open of the same directory reuses both. `fixed_default` lets a first open
/// make the directory (`scope_for_window`).
fn assign(
    folders: &Folders,
    listed: &DataFolderScopes,
    folder_dir: &Path,
    app: BundledApp,
    name: &str,
    fixed_default: bool,
) -> Result<String, String> {
    let label = app.window_label(name);
    let scope = scope_for_window(folders, folder_dir, listed, name, fixed_default)?;
    folders
        .permit(&scope, &label)
        .map_err(|error| format!("The folder \"{name}\" could not be opened: {error:?}"))?;
    if app.reaches_connections() {
        folders.permit(EPICENTER_FOLDER, &label).map_err(|error| {
            format!(
                "{} could not reach Epicenter's AI connections: {error:?}",
                app.name()
            )
        })?;
    }
    folders.hand(
        &label,
        WindowFolder {
            app: app.id().into(),
            folder: scope,
        },
    );
    Ok(label)
}

/// Open the window `label`, already assigned its folder, at `path`, or
/// reveal it when it is open. The window is destroyed when it closes.
fn open_window(
    handle: &DesktopAppHandle,
    label: &str,
    title: &str,
    path: &str,
) -> anyhow::Result<()> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let window_app = handle.clone();
    let label = label.to_string();
    let title = title.to_string();
    let path = path.to_string();
    handle
        .run_on_main_thread(move || {
            let result = match window_app.get_webview_window(&label) {
                Some(window) => {
                    crate::focus(window);
                    Ok(())
                }
                None => {
                    crate::create_app_window(&window_app, &label, &title, &path).map(crate::focus)
                }
            };
            let _ = sender.send(result);
        })
        .context("schedule the app window on the main thread")?;
    receiver
        .recv()
        .context("the main thread stopped before opening the window")?
}

#[cfg(test)]
mod tests {
    //! The assignment through the folder plugin's real commands on the mock
    //! runtime, as each page calls them when it opens its folder.

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

    use super::BundledApp::{Capture, Honeycrisp, Todos, Whispering};

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

        /// What `open_bundled_app` does before it makes the window.
        fn open(&self, app: BundledApp, folder: Option<&str>) -> Result<String, String> {
            let name = directory(&self.folder_dir, &self.listed, app, folder)?;
            assign(
                self.app.folders(),
                &self.listed,
                &self.folder_dir,
                app,
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

    /// What `app`'s page does in `openFolder({ tables })`: ask which folder
    /// the window was handed, then be granted it. Answers the scope and the
    /// granted root.
    fn open_assigned(window: &WebviewWindow<MockRuntime>, app: BundledApp) -> (String, String) {
        let handed = invoke(window, "window_folder", json!({})).unwrap();
        assert_eq!(handed["app"], app.id());
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

    fn refusal(window: &WebviewWindow<MockRuntime>, scope: &str) -> Value {
        invoke(window, "grant_directory", json!({ "scope": scope })).unwrap_err()["name"].clone()
    }

    #[test]
    fn the_table_has_stable_pages_names_paths_and_capabilities() {
        let actual = BundledApp::ALL.map(|app| {
            (
                app.page(),
                app.name(),
                app.path(),
                app.window_prefix(),
                app.capability(),
            )
        });
        let row = |page: &'static str, name: &'static str, capability: &'static str| {
            (
                page,
                name,
                format!("/{page}/"),
                format!("{page}:"),
                capability,
            )
        };
        assert_eq!(
            actual,
            [
                row("todos", "Todos", "bundled-app"),
                row("capture", "Capture", "bundled-app"),
                row("honeycrisp", "Honeycrisp", "bundled-app"),
                row("whispering", "Whispering", "whispering"),
            ]
        );
        for app in BundledApp::ALL {
            assert_eq!(BundledApp::from_page(app.page()), Some(app));
            // The page API names the app by its page.
            assert_eq!(serde_json::to_value(app).unwrap(), json!(app.page()));
        }
        // Epicenter's own pages are not bundled apps.
        for page in ["home", "folders", "apps", "so.epicenter.todos", "Todos"] {
            assert_eq!(BundledApp::from_page(page), None, "{page}");
        }
        assert_eq!(
            BundledApp::ALL
                .iter()
                .filter(|app| app.reaches_connections())
                .collect::<Vec<_>>(),
            [&Whispering]
        );
    }

    /// Two existing folders, each opened in its own window of one page: each
    /// window is handed and granted its own root, and neither is granted the
    /// other's. Every bundled app assigns the same way.
    #[test]
    fn two_listed_folders_open_in_one_page_each_granted_alone() {
        for app in BundledApp::ALL {
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

            let label_a = fixture.open(app, Some("data:A")).unwrap();
            let label_b = fixture.open(app, Some("data:B")).unwrap();
            assert_ne!(label_a, label_b);
            for label in [&label_a, &label_b] {
                assert!(label.starts_with(&app.window_prefix()), "{label}");
            }
            let window_a = fixture.window(&label_a);
            let window_b = fixture.window(&label_b);

            let (scope_a, root_a) = open_assigned(&window_a, app);
            let (scope_b, root_b) = open_assigned(&window_b, app);
            assert_eq!(root_a, a.to_str().unwrap());
            assert_eq!(root_b, b.to_str().unwrap());
            assert_eq!(todo_files(&window_a, &scope_a), json!(["milk.md"]));
            assert_eq!(todo_files(&window_b, &scope_b), json!(["eggs.md"]));

            for (window, other) in [(&window_a, &scope_b), (&window_b, &scope_a)] {
                assert_eq!(
                    refusal(window, other),
                    "WindowNotPermitted",
                    "{app:?} {other}"
                );
            }
            // Opening A again reuses its window and scope.
            assert_eq!(fixture.open(app, Some("data:A")).unwrap(), label_a);
            assert_eq!(open_assigned(&window_a, app), (scope_a, root_a));
        }
    }

    /// Different apps on different folders are granted only their own; two
    /// apps on one folder are two windows on its one registry entry.
    #[test]
    fn each_apps_window_is_granted_its_own_folder_alone() {
        let fixture = fixture();
        let a = fixture.folder_with_todo("A", "milk");
        fixture.folder_with_todo("B", "eggs");
        fixture.list();

        let todos = fixture.window(&fixture.open(Todos, Some("data:A")).unwrap());
        let capture = fixture.window(&fixture.open(Capture, Some("data:B")).unwrap());
        let whispering = fixture.window(&fixture.open(Whispering, Some("data:A")).unwrap());
        assert_eq!(open_assigned(&todos, Todos).0, "data:A");
        assert_eq!(open_assigned(&capture, Capture).0, "data:B");
        let (scope, root) = open_assigned(&whispering, Whispering);
        assert_eq!(
            (scope.as_str(), root.as_str()),
            ("data:A", a.to_str().unwrap())
        );

        assert_eq!(refusal(&todos, "data:B"), "WindowNotPermitted");
        assert_eq!(refusal(&capture, "data:A"), "WindowNotPermitted");
        assert_eq!(refusal(&whispering, "data:B"), "WindowNotPermitted");
        // Opening Honeycrisp on B permits no window but its own.
        fixture.open(Honeycrisp, Some("data:B")).unwrap();
        assert_eq!(refusal(&todos, "data:B"), "WindowNotPermitted");
    }

    /// Whispering's window alone is permitted into `so.epicenter`, where its
    /// AI connections are rows, and it is still handed its own folder. No
    /// app's window is handed `so.epicenter`, and no other app's reaches it.
    #[test]
    fn whispering_alone_reaches_epicenters_connections() {
        let fixture = fixture();
        fixture.folder_with_todo("A", "milk");
        fixture.list();
        for app in BundledApp::ALL {
            for folder in [None, Some("data:A")] {
                let window = fixture.window(&fixture.open(app, folder).unwrap());
                let (scope, _) = open_assigned(&window, app);
                assert_ne!(scope, EPICENTER_FOLDER);
                let connections = invoke(
                    &window,
                    "grant_directory",
                    json!({ "scope": EPICENTER_FOLDER }),
                );
                match app {
                    Whispering => {
                        assert!(connections.is_ok(), "{connections:?}");
                    }
                    _ => assert_eq!(
                        connections.unwrap_err()["name"],
                        "WindowNotPermitted",
                        "{app:?}"
                    ),
                }
            }
        }
    }

    /// A listed folder that is gone is refused: nothing is created in its
    /// place, and the default is not opened instead.
    #[test]
    fn a_missing_listed_folder_is_refused_without_creating_it_or_the_default() {
        for app in BundledApp::ALL {
            let fixture = fixture();
            fixture.folder_with_todo("A", "milk");
            fixture.list();
            fs::remove_dir_all(fixture.folder_dir.join("A")).unwrap();

            let refused = fixture.open(app, Some("data:A")).unwrap_err();
            assert_eq!(refused, "The folder \"A\" is not there anymore.");
            assert!(!fixture.folder_dir.join("A").exists());
            assert!(!fixture.folder_dir.join(app.name()).exists());
            assert_eq!(fixture.app.folders().handed(&app.window_label("A")), None);

            // A scope the Folders window never listed, and a path, open nothing.
            for unlisted in ["data:B", "todos:A", "/tmp", "../A", ""] {
                assert!(fixture.open(app, Some(unlisted)).is_err(), "{unlisted}");
            }
            assert!(!fixture.folder_dir.join(app.name()).exists());
        }
    }

    #[test]
    fn epicenters_own_folder_is_handed_to_no_bundled_app() {
        let fixture = fixture();
        for app in BundledApp::ALL {
            let refused = fixture.open(app, Some(EPICENTER_FOLDER)).unwrap_err();
            assert_eq!(
                refused,
                format!("Epicenter's own folder cannot be opened in {}.", app.name())
            );
            assert_eq!(
                fixture
                    .app
                    .folders()
                    .handed(&app.window_label(EPICENTER_FOLDER)),
                None
            );
        }
    }

    /// A folder removed after its window was assigned it is refused at the
    /// grant, as a data folder, rather than made again.
    #[test]
    fn an_assigned_folder_removed_later_is_missing_not_recreated() {
        let fixture = fixture();
        fixture.folder_with_todo("A", "milk");
        fixture.list();
        let window = fixture.window(&fixture.open(Whispering, Some("data:A")).unwrap());
        fs::remove_dir_all(fixture.folder_dir.join("A")).unwrap();

        assert_eq!(refusal(&window, "data:A"), "Missing");
        assert!(!fixture.folder_dir.join("A").exists());
    }

    /// Opening an app makes its fixed default when it is missing, and the
    /// window is granted that directory, empty. Each app has its own.
    #[test]
    fn each_missing_default_folder_is_created_and_granted() {
        let fixture = fixture();
        for app in BundledApp::ALL {
            let default = fixture.folder_dir.join(app.name());
            assert!(!default.exists());

            let label = fixture.open(app, None).unwrap();
            assert!(default.is_dir());
            let window = fixture.window(&label);
            let (scope, root) = open_assigned(&window, app);
            assert_eq!(scope, format!("data:{}", app.name()));
            assert_eq!(root, default.to_str().unwrap());
            assert_eq!(fs::read_dir(&default).unwrap().count(), 0);

            // Opening it again reuses the window and its scope, and Open in
            // on the listed default opens the same window.
            assert_eq!(fixture.open(app, None).unwrap(), label);
            assert!(fixture
                .list()
                .contains(&(scope.clone(), app.name().to_string())));
            assert_eq!(fixture.open(app, Some(scope.as_str())).unwrap(), label);
        }
        assert_eq!(
            fixture
                .list()
                .into_iter()
                .map(|(id, _)| id)
                .collect::<Vec<_>>(),
            [
                "data:Capture",
                "data:Honeycrisp",
                "data:Todos",
                "data:Whispering"
            ]
        );
    }

    #[test]
    fn a_removed_default_is_recreated_when_opened_again() {
        for app in BundledApp::ALL {
            let fixture = fixture();
            let label = fixture.open(app, None).unwrap();
            let window = fixture.window(&label);
            open_assigned(&window, app);
            let default = fixture.folder_dir.join(app.name());
            fs::remove_dir(&default).unwrap();

            assert_eq!(fixture.open(app, None).unwrap(), label);
            assert!(default.is_dir());
            assert_eq!(fs::read_dir(&default).unwrap().count(), 0);
            open_assigned(&window, app);
        }
    }

    /// The default is not a link the shell would follow out of the root.
    #[cfg(unix)]
    #[test]
    fn a_linked_default_folder_is_refused() {
        let fixture = fixture();
        let elsewhere = fixture.folder_dir.with_file_name("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, fixture.folder_dir.join(Whispering.name())).unwrap();
        assert!(fixture.open(Whispering, None).is_err());
    }

    /// Opening a listed folder in an app adds its window to the entry the
    /// Folders window already uses, not a second scope over the same
    /// directory: both windows are granted the same root under `data:A`.
    #[test]
    fn an_apps_window_shares_the_folders_windows_registry_entry() {
        let fixture = fixture();
        let a = fixture.folder_with_todo("A", "milk");
        fixture.list();
        let label = fixture.open(Todos, Some("data:A")).unwrap();

        let registry = fixture.app.folders();
        assert_eq!(
            registry.handed(&label),
            Some(WindowFolder {
                app: Todos.id().into(),
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
        let (scope, root) = open_assigned(&todos, Todos);
        assert_eq!(scope, "data:A");
        assert_eq!(root, a.to_str().unwrap());
        assert_eq!(from_folders.unwrap()["root"], root.as_str());
        // Listing again, and opening again, add no scope and no window.
        fixture.list();
        assert_eq!(fixture.open(Todos, Some("data:A")).unwrap(), label);
        assert_eq!(
            registry.permit("todos:A", &label),
            Err(GrantError::UnknownScope {
                scope: "todos:A".into()
            })
        );
        assert_eq!(refusal(&todos, EPICENTER_FOLDER), "WindowNotPermitted");
    }

    /// Opening an app before the Folders window ever listed its default makes
    /// it under the scope the listing then reports, not a second one.
    #[test]
    fn the_default_opened_before_listing_is_the_listings_scope() {
        let fixture = fixture();
        let label = fixture.open(Capture, None).unwrap();
        assert_eq!(
            fixture.app.folders().handed(&label).unwrap().folder,
            "data:Capture"
        );
        assert_eq!(
            fixture.list(),
            [("data:Capture".to_string(), "Capture".to_string())]
        );
        let folders = fixture.window("folders");
        let granted = invoke(
            &folders,
            "grant_directory",
            json!({ "scope": "data:Capture" }),
        );
        assert_eq!(
            granted.unwrap()["root"],
            fixture.folder_dir.join("Capture").to_str().unwrap()
        );
    }

    /// The app's fixed default can be recreated after the listing saw it;
    /// a person-selected folder is still never recreated.
    #[test]
    fn a_listed_default_removed_before_opening_is_recreated() {
        let fixture = fixture();
        fixture.folder_with_todo(Honeycrisp.name(), "milk");
        fixture.list();
        fs::remove_dir_all(fixture.folder_dir.join(Honeycrisp.name())).unwrap();
        let label = fixture.open(Honeycrisp, None).unwrap();
        assert_eq!(label, Honeycrisp.window_label(Honeycrisp.name()));
        assert!(fixture.folder_dir.join(Honeycrisp.name()).is_dir());
        assert_eq!(
            fs::read_dir(fixture.folder_dir.join(Honeycrisp.name()))
                .unwrap()
                .count(),
            0
        );
    }

    /// The default is one directory with one window whatever its spelling on
    /// a case-insensitive disk, where the listing names it as it is stored.
    #[test]
    fn the_default_takes_the_spelling_the_directory_has() {
        let fixture = fixture();
        let default = || default_name(&fixture.folder_dir, Todos.name());
        assert_eq!(default(), "Todos");
        fs::create_dir(fixture.folder_dir.join("todos")).unwrap();
        let insensitive = fixture.folder_dir.join("Todos").exists();
        assert_eq!(default(), if insensitive { "todos" } else { "Todos" });
        if insensitive {
            let listed = fixture.list();
            assert_eq!(listed, [("data:todos".to_string(), "todos".to_string())]);
            let label = fixture.open(Todos, None).unwrap();
            assert_eq!(label, Todos.window_label("todos"));
            assert_eq!(fixture.open(Todos, Some("data:todos")).unwrap(), label);
        }
        // An exact `Todos` wins where both exist.
        if !insensitive {
            fs::create_dir(fixture.folder_dir.join("Todos")).unwrap();
            assert_eq!(default(), "Todos");
        }
    }

    #[test]
    fn a_case_variant_default_removed_after_open_uses_the_fixed_spelling() {
        let fixture = fixture();
        fs::create_dir(fixture.folder_dir.join("todos")).unwrap();
        if !fixture.folder_dir.join("Todos").exists() {
            return; // This filesystem distinguishes the names.
        }
        fixture.list();
        let label = fixture.open(Todos, None).unwrap();
        assert_eq!(label, Todos.window_label("todos"));
        fs::remove_dir(fixture.folder_dir.join("todos")).unwrap();
        let next = fixture.open(Todos, None).unwrap();
        assert_eq!(next, Todos.window_label("Todos"));
        assert!(fixture.folder_dir.join("Todos").is_dir());
    }

    /// No window but the ones assigned a folder is handed or granted it,
    /// except the Folders window, which holds the entry already: not another
    /// app's window on another folder, not Settings, and not an installed
    /// app's window.
    #[test]
    fn no_other_window_is_handed_or_granted_a_bundled_apps_folder() {
        let fixture = fixture();
        fixture.folder_with_todo("A", "milk");
        fixture.list();
        fixture.open(Whispering, Some("data:A")).unwrap();

        let other_folder = Todos.window_label("B");
        let other_app = Capture.window_label("A");
        for label in [
            "home",
            other_folder.as_str(),
            other_app.as_str(),
            "app:so_epicenter_whispering",
            "app:so_epicenter_whispering:646174613a41",
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
            assert_eq!(refusal(&window, "data:A"), "WindowNotPermitted", "{label}");
        }
    }

    #[test]
    fn a_window_label_is_one_app_and_folder_and_a_valid_label() {
        for (app, name, label) in [
            (Todos, "Todos", "todos:546f646f73"),
            (Todos, "My notes", "todos:4d79206e6f746573"),
            (Whispering, "My notes", "whispering:4d79206e6f746573"),
            (Capture, "A", "capture:41"),
            (Honeycrisp, "A", "honeycrisp:41"),
        ] {
            let made = app.window_label(name);
            assert_eq!(made, label);
            assert!(made
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '/' | ':' | '_')));
        }
        assert_ne!(Todos.window_label("a"), Todos.window_label("b"));
        assert_ne!(Todos.window_label("a"), Capture.window_label("a"));
        assert_eq!(Todos.window_title("Todos"), "Todos");
        assert_eq!(
            Whispering.window_title("Groceries"),
            "Whispering: Groceries"
        );
    }

    /// The build script builds every page in the table from its app's
    /// source, so a row cannot be served without a build.
    #[test]
    fn the_build_script_builds_every_bundled_page() {
        let script = include_str!("../../scripts/build-bundled-apps.ts");
        for app in BundledApp::ALL {
            assert!(
                script.contains(&format!("'{}'", app.page())),
                "build-bundled-apps.ts does not build {}",
                app.page()
            );
        }
    }
}
