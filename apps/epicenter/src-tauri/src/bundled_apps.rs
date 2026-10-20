//! The apps Epicenter bundles, each opened on one existing folder per window.
//!
//! `BundledApp` is the closed table: Todos, Capture, Honeycrisp, and
//! Whispering. Each row names the app's page, built from `apps/<page>` into
//! `dist/<page>/` and served by the scheme at `/<page>/`; its fixed default
//! folder under `folder_dir`; and the prefix of its windows' labels, which
//! selects their capability. Opening one clones, builds, and fetches
//! nothing, and no account, approval, or Git step is on the way.
//!
//! The shell decides the window's folder in trusted Rust and binds it to the
//! window before the WebView exists (`folder_windows`). The page calls
//! `openFolder({ tables })` and names no path: every folder command it sends
//! reaches the directory bound to its window.
//!
//! - Open an app: the fixed default, `<folder_dir>/<name>`, such as
//!   `<folder_dir>/Todos`, which the shell creates when it is missing. The
//!   name is this launch policy's choice, not one derived from an app id.
//! - Open a listed folder in an app: a direct child of `folder_dir` the
//!   Folders window listed, found again by its name. It must already exist.
//! - Choose a folder for an app: the native folder picker, in Rust. The
//!   chosen directory must exist and be a real directory; its parent may be
//!   a link.
//!
//! A folder that is missing, a file, or a link is refused, never created and
//! never replaced by the default. A folder that overlaps Epicenter's own
//! files is refused however it is reached: the selected records directory or
//! anything in it, its save staging directory, the app data, or a directory
//! holding any of these (`overlaps_epicenter_files`). Ordinary directories
//! outside those protected roots open. One app on one directory is one window:
//! opening it again reveals that window. Whispering's AI connections are rows of
//! the selected records folder, which its page reads and saves through two
//! commands by operation (`cli::whispering_connection_read` and `_set`),
//! never as a second folder.
//!
//! A window is destroyed when it closes, as Tauri closes any window: no
//! handler hides it. The recorder finalizes a Whispering recording when its
//! window is destroyed.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_epicenter_folder::Directory;

use crate::app_data::DesktopPaths;
use crate::data_folders::{listed_folder, overlaps_epicenter_files};
use crate::folder_windows::{self, FolderWindow};
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
    /// scheme serves it at, and the prefix of its windows' labels.
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

    /// Where every window of the app opens, whatever folder it was bound to.
    /// Its navigation stays below this path.
    pub fn path(self) -> String {
        format!("/{}/", self.page())
    }

    pub fn from_page(page: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|app| app.page() == page)
    }

    fn window_title(self, name: &str) -> String {
        if name == self.name() {
            self.name().to_string()
        } else {
            format!("{}: {name}", self.name())
        }
    }
}

/// Which folder an app's window opens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AppFolder {
    /// The app's fixed default under the folder root, made when missing.
    Default,
    /// A folder the Folders window listed, by its directory name.
    Listed(String),
    /// A directory the person chose in the native picker.
    Chosen(PathBuf),
}

/// Open bundled app `app` on its fixed default folder, or with `folder`, on
/// the folder the Folders window listed under that directory name. A window
/// already open on the folder is revealed.
#[tauri::command]
#[specta::specta]
pub async fn open_bundled_app(
    handle: DesktopAppHandle,
    app: BundledApp,
    folder: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = folder.map_or(AppFolder::Default, AppFolder::Listed);
        open_on(&handle, app, target, build_app_window(app)).map(|_| ())
    })
    .await
    .map_err(|error| format!("the {} window could not be opened: {error}", app.name()))?
}

/// Ask the person for a folder with the native picker and open bundled app
/// `app` on it, or reveal the window already open on it. Answers whether a
/// folder was chosen. The page passes no path: the picker answers Rust.
#[tauri::command]
#[specta::specta]
pub async fn choose_folder_for_app(
    handle: DesktopAppHandle,
    app: BundledApp,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder_dir = handle.state::<DesktopPaths>().folder_dir.clone();
        let picked = handle
            .dialog()
            .file()
            .set_title(format!("Open a folder in {}", app.name()))
            .set_directory(&folder_dir)
            .blocking_pick_folder()
            .map(|picked| picked.into_path())
            .transpose()
            .map_err(|error| format!("The chosen folder could not be read: {error}"))?;
        open_chosen(&handle, app, picked, build_app_window(app))
    })
    .await
    .map_err(|error| format!("the {} window could not be opened: {error}", app.name()))?
}

/// Builds the WebView of an app's window, at the app's page.
fn build_app_window(
    app: BundledApp,
) -> impl FnOnce(&DesktopAppHandle, &str, &str) -> anyhow::Result<WebviewWindow<tauri::Wry>>
       + Send
       + 'static {
    let path = app.path();
    move |handle, label, title| folder_windows::build(handle, label, title, &path)
}

/// Open `app` on what the picker answered, or nothing when the person
/// cancelled: whether a folder was chosen.
pub(crate) fn open_chosen<R: Runtime>(
    handle: &AppHandle<R>,
    app: BundledApp,
    picked: Option<PathBuf>,
    build: impl FnOnce(&AppHandle<R>, &str, &str) -> anyhow::Result<WebviewWindow<R>> + Send + 'static,
) -> Result<bool, String> {
    let Some(path) = picked else {
        return Ok(false);
    };
    open_on(handle, app, AppFolder::Chosen(path), build).map(|_| true)
}

/// Resolve `target` for `app`, then reveal its window or bind and build it.
pub(crate) fn open_on<R: Runtime>(
    handle: &AppHandle<R>,
    app: BundledApp,
    target: AppFolder,
    build: impl FnOnce(&AppHandle<R>, &str, &str) -> anyhow::Result<WebviewWindow<R>> + Send + 'static,
) -> Result<(), String> {
    let window = app_window(&handle.state::<DesktopPaths>(), app, target)?;
    folder_windows::show(handle, window, build).map_err(|error| format!("{error:#}"))
}

/// The window `app` opens `target` in, with its directory resolved: made
/// when it is the fixed default, found as it is otherwise, and refused when
/// it overlaps Epicenter's own files.
fn app_window(
    paths: &DesktopPaths,
    app: BundledApp,
    target: AppFolder,
) -> Result<FolderWindow, String> {
    let folder_dir = &paths.folder_dir;
    let (path, create) = match target {
        AppFolder::Default => (folder_dir.join(default_name(folder_dir, app.name())), true),
        AppFolder::Listed(name) => (listed_folder(folder_dir, &name)?, false),
        AppFolder::Chosen(path) => (path, false),
    };
    let opened = if create {
        Directory::create(&path)
    } else {
        Directory::existing(&path)
    };
    let directory = opened
        .map_err(|error| format!("The folder could not be opened in {}: {error}", app.name()))?;
    if overlaps_epicenter_files(paths, &directory) {
        return Err(format!(
            "This folder holds Epicenter's own files, so it cannot be opened in {}.",
            app.name()
        ));
    }
    let title = app.window_title(&folder_windows::directory_name(&directory));
    Ok(FolderWindow::new(app.page(), title, directory))
}

/// The name the default folder `default` has on disk. A case-insensitive
/// disk that already holds `Todos` as `todos` lists it as `todos`, and the
/// window is named by the canonical root, so the default is one directory
/// with one window, not two. An exact `default` always wins, so a
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

#[cfg(test)]
mod tests {
    //! The routing of each kind of folder to an app's window, through the
    //! folder plugin's real commands on the mock runtime, as each page calls
    //! them when it opens its folder. A mock window stands in for the
    //! WebView, and a test passes the path the picker would answer.

    use serde_json::{json, Value};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
    use tauri::utils::acl::ExecutionContext;
    use tauri::webview::InvokeRequest;
    use tauri::{App, WebviewWindowBuilder};
    use tauri_plugin_epicenter_folder::FolderExt;

    use super::*;
    use crate::data_folders::list_in;
    use crate::folders_config::DEFAULT_EPICENTER_FOLDER;

    use super::BundledApp::{Capture, Honeycrisp, Todos, Whispering};

    struct Fixture {
        app: App<MockRuntime>,
        folder_dir: PathBuf,
        data_dir: PathBuf,
        _temporary: tempfile::TempDir,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.app.folders().shutdown();
        }
    }

    /// A mock window in place of the app's WebView.
    fn mock_window(
        app: &AppHandle<MockRuntime>,
        label: &str,
        _title: &str,
    ) -> anyhow::Result<WebviewWindow<MockRuntime>> {
        Ok(WebviewWindowBuilder::new(app, label, Default::default()).build()?)
    }

    impl Fixture {
        /// Open `app` on `target` as the commands do. The boolean records
        /// whether its window already existed before this call.
        fn open(&self, app: BundledApp, target: AppFolder) -> Result<(String, bool), String> {
            let paths = self.app.state::<DesktopPaths>();
            let label = app_window(&paths, app, target.clone())?.label;
            let was_open = self.app.get_webview_window(&label).is_some();
            open_on(self.app.handle(), app, target, mock_window).map(|()| (label, was_open))
        }

        fn listed(&self, app: BundledApp, name: &str) -> Result<String, String> {
            self.open(app, AppFolder::Listed(name.to_string()))
                .map(|(label, _)| label)
        }

        fn default(&self, app: BundledApp) -> Result<String, String> {
            self.open(app, AppFolder::Default).map(|(label, _)| label)
        }

        fn window(&self, label: &str) -> WebviewWindow<MockRuntime> {
            self.app.get_webview_window(label).expect("an open window")
        }

        /// A data folder with one todo in it.
        fn folder_with_todo(&self, parent: &Path, name: &str, id: &str) -> PathBuf {
            let root = parent.join(name);
            fs::create_dir_all(root.join("todos")).unwrap();
            fs::write(
                root.join("todos").join(format!("{id}.md")),
                format!("---\ntitle: {id}\n---\n"),
            )
            .unwrap();
            root
        }

        fn listed_with_todo(&self, name: &str, id: &str) -> PathBuf {
            self.folder_with_todo(&self.folder_dir.clone(), name, id)
        }

        /// A directory outside the folder root, as a person might choose.
        fn elsewhere(&self, name: &str) -> PathBuf {
            let path = self.folder_dir.with_file_name(name);
            fs::create_dir_all(&path).unwrap();
            path
        }
    }

    fn fixture() -> Fixture {
        let temporary = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temporary.path()).unwrap();
        let folder_dir = root.join("Epicenter");
        fs::create_dir_all(&folder_dir).unwrap();
        let data_dir = root.join("Application Support").join("so.epicenter");
        fs::create_dir_all(&data_dir).unwrap();

        let mut context = mock_context(noop_assets());
        for command in tauri_plugin_epicenter_folder::COMMANDS {
            context.runtime_authority_mut().__allow_command(
                format!("plugin:epicenter-folder|{command}"),
                ExecutionContext::Local,
            );
        }
        let app = mock_builder()
            .plugin(tauri_plugin_epicenter_folder::init())
            .manage(DesktopPaths {
                data_dir: data_dir.clone(),
                folder_dir: folder_dir.clone(),
            })
            .build(context)
            .expect("mock app");
        Fixture {
            app,
            folder_dir,
            data_dir,
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

    /// What `app`'s page does in `openFolder({ tables })`, then a listing of
    /// its todos: the files the window reaches.
    fn todo_files(window: &WebviewWindow<MockRuntime>) -> Value {
        invoke(window, "open_folder", json!({})).unwrap();
        invoke(
            window,
            "read_folder_children",
            json!({ "directory": "todos" }),
        )
        .unwrap()["files"]
            .clone()
    }

    fn bound_root(fixture: &Fixture, label: &str) -> PathBuf {
        fixture
            .app
            .folders()
            .bound(label)
            .unwrap()
            .root()
            .to_path_buf()
    }

    #[test]
    fn the_table_has_stable_pages_names_paths_and_capabilities() {
        let actual = BundledApp::ALL.map(|app| {
            (
                app.page(),
                app.name(),
                app.path(),
                format!("{}:", app.page()),
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
        assert_eq!(Todos.window_title("Todos"), "Todos");
        assert_eq!(
            Whispering.window_title("Groceries"),
            "Whispering: Groceries"
        );
    }

    /// Two existing folders, each opened in its own window of one page: each
    /// window reaches its own root and not the other's. Every bundled app
    /// routes the same way, and opening a folder again reveals its window.
    #[test]
    fn two_listed_folders_open_in_one_page_each_bound_alone() {
        for app in BundledApp::ALL {
            let fixture = fixture();
            let a = fixture.listed_with_todo("A", "milk");
            let b = fixture.listed_with_todo("B", "eggs");

            let label_a = fixture.listed(app, "A").unwrap();
            let label_b = fixture.listed(app, "B").unwrap();
            assert_ne!(label_a, label_b);
            for label in [&label_a, &label_b] {
                assert!(label.starts_with(&format!("{}:", app.page())), "{label}");
            }
            assert_eq!(bound_root(&fixture, &label_a), a);
            assert_eq!(bound_root(&fixture, &label_b), b);
            assert_eq!(todo_files(&fixture.window(&label_a)), json!(["milk.md"]));
            assert_eq!(todo_files(&fixture.window(&label_b)), json!(["eggs.md"]));

            assert_eq!(
                fixture.open(app, AppFolder::Listed("A".into())).unwrap(),
                (label_a.clone(), true)
            );
            assert_eq!(bound_root(&fixture, &label_a), a);
        }
    }

    /// A folder an earlier build's installed app opened, named by its id, is
    /// listed as a data folder and opens in every bundled app, its files as
    /// they are: nothing is cloned, built, or approved on the way.
    #[test]
    fn a_folder_named_by_an_installed_apps_id_opens_in_every_bundled_app() {
        let fixture = fixture();
        let old = fixture.listed_with_todo("so.epicenter.todos", "milk");
        assert_eq!(
            list_in(&fixture.folder_dir, None).unwrap()[0].name,
            "so.epicenter.todos"
        );
        for app in BundledApp::ALL {
            let label = fixture.listed(app, "so.epicenter.todos").unwrap();
            assert_eq!(bound_root(&fixture, &label), old);
            assert_eq!(todo_files(&fixture.window(&label)), json!(["milk.md"]));
        }
    }

    /// Two apps on one folder are two windows on its one root; neither reaches
    /// a folder it was not opened on.
    #[test]
    fn two_apps_on_one_folder_are_two_windows_on_one_root() {
        let fixture = fixture();
        let a = fixture.listed_with_todo("A", "milk");
        fixture.listed_with_todo("B", "eggs");

        let todos = fixture.listed(Todos, "A").unwrap();
        let capture = fixture.listed(Capture, "B").unwrap();
        let whispering = fixture.listed(Whispering, "A").unwrap();
        assert_ne!(todos, whispering);
        assert_eq!(bound_root(&fixture, &todos), a);
        assert_eq!(bound_root(&fixture, &whispering), a);
        assert_eq!(todo_files(&fixture.window(&capture)), json!(["eggs.md"]));
        assert_eq!(todo_files(&fixture.window(&whispering)), json!(["milk.md"]));
    }

    fn refusal(app: BundledApp) -> String {
        format!(
            "This folder holds Epicenter's own files, so it cannot be opened in {}.",
            app.name()
        )
    }

    /// No bundled app opens a folder that overlaps Epicenter's own files:
    /// `so.epicenter` listed, in another casing, or chosen, anything in it,
    /// the app data, or a directory holding either, including the folder root.
    /// Nothing is bound or opened. The root's other direct children and a
    /// folder elsewhere still open.
    #[test]
    fn no_bundled_app_opens_a_folder_that_overlaps_epicenters_own_files() {
        let fixture = fixture();
        let own = fixture.folder_dir.join(DEFAULT_EPICENTER_FOLDER);
        fs::create_dir_all(own.join("connections")).unwrap();
        let chosen = [
            own.clone(),
            own.join("connections"),
            fixture.folder_dir.clone(),
            fixture.folder_dir.parent().unwrap().to_path_buf(),
            fixture.data_dir.clone(),
            fixture.data_dir.parent().unwrap().to_path_buf(),
        ];
        for app in BundledApp::ALL {
            assert_eq!(
                fixture.listed(app, DEFAULT_EPICENTER_FOLDER).unwrap_err(),
                refusal(app)
            );
            if fixture.folder_dir.join("SO.EPICENTER").exists() {
                assert_eq!(
                    fixture.listed(app, "SO.EPICENTER").unwrap_err(),
                    refusal(app)
                );
            }
            for path in &chosen {
                assert_eq!(
                    open_chosen(fixture.app.handle(), app, Some(path.clone()), mock_window)
                        .unwrap_err(),
                    refusal(app),
                    "{path:?}"
                );
            }
        }
        assert!(fixture.app.webview_windows().is_empty());

        let listed = fixture.listed_with_todo("A", "milk");
        let elsewhere = fixture.folder_with_todo(&fixture.elsewhere("place"), "Notes", "eggs");
        for app in BundledApp::ALL {
            let label = fixture.listed(app, "A").unwrap();
            assert_eq!(bound_root(&fixture, &label), listed);
            let (chosen, was_open) = fixture
                .open(app, AppFolder::Chosen(listed.clone()))
                .unwrap();
            assert_eq!((chosen, was_open), (label, true));
            let (label, _) = fixture
                .open(app, AppFolder::Chosen(elsewhere.clone()))
                .unwrap();
            assert_eq!(bound_root(&fixture, &label), elsewhere);
        }
    }

    /// A linked parent is no route around the refusal: the folder root, the
    /// app data, Settings' folder, and the directories holding them are
    /// refused through it, while a direct child opens on its real root.
    #[cfg(unix)]
    #[test]
    fn a_linked_parent_reaches_no_folder_that_overlaps_epicenters_own_files() {
        let fixture = fixture();
        let own = fixture.folder_dir.join(DEFAULT_EPICENTER_FOLDER);
        fs::create_dir_all(own.join("connections")).unwrap();
        let root = fixture.folder_dir.parent().unwrap();
        let alias = fixture.elsewhere("place").join("alias");
        std::os::unix::fs::symlink(root, &alias).unwrap();
        let linked_root = fixture.elsewhere("other").join("linked-root");
        std::os::unix::fs::symlink(&fixture.folder_dir, &linked_root).unwrap();
        let through = |path: &Path| alias.join(path.strip_prefix(root).unwrap());

        for app in BundledApp::ALL {
            for path in [
                through(&fixture.folder_dir),
                through(&own),
                through(&own.join("connections")),
                through(&fixture.data_dir),
                through(fixture.data_dir.parent().unwrap()),
                linked_root.join(DEFAULT_EPICENTER_FOLDER),
            ] {
                assert_eq!(
                    fixture
                        .open(app, AppFolder::Chosen(path.clone()))
                        .unwrap_err(),
                    refusal(app),
                    "{path:?}"
                );
            }
        }
        assert!(fixture.app.webview_windows().is_empty());

        let child = fixture.listed_with_todo("A", "milk");
        let (label, _) = fixture
            .open(Todos, AppFolder::Chosen(linked_root.join("A")))
            .unwrap();
        assert_eq!(bound_root(&fixture, &label), child);
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_epicenter_parent_keeps_settings_reserved() {
        let fixture = fixture();
        let real = fixture.folder_dir.with_file_name("actual-folders");
        fs::rename(&fixture.folder_dir, &real).unwrap();
        std::os::unix::fs::symlink(&real, &fixture.folder_dir).unwrap();
        let own = real.join(DEFAULT_EPICENTER_FOLDER);
        fs::create_dir(&own).unwrap();

        for app in BundledApp::ALL {
            assert!(fixture.listed(app, DEFAULT_EPICENTER_FOLDER).is_err());
            for path in [
                own.clone(),
                fixture.folder_dir.join(DEFAULT_EPICENTER_FOLDER),
            ] {
                assert!(fixture.open(app, AppFolder::Chosen(path)).is_err());
            }
        }
        assert!(fixture.app.webview_windows().is_empty());
        let todos = fixture.default(Todos).unwrap();
        assert_eq!(bound_root(&fixture, &todos), real.join("Todos"));
    }

    /// A listed folder that is gone is refused: nothing is created in its
    /// place, and the default is not opened instead.
    #[test]
    fn a_missing_listed_folder_is_refused_without_creating_it_or_the_default() {
        for app in BundledApp::ALL {
            let fixture = fixture();
            fixture.listed_with_todo("A", "milk");
            fs::remove_dir_all(fixture.folder_dir.join("A")).unwrap();

            let refused = fixture.listed(app, "A").unwrap_err();
            assert_eq!(refused, "The folder \"A\" is not there anymore.");
            assert!(!fixture.folder_dir.join("A").exists());
            assert!(!fixture.folder_dir.join(app.name()).exists());

            // A name that is not one listed directory, and a path, open nothing.
            for unlisted in ["B", "data:A", "/tmp", "../A", "", "A/B"] {
                assert!(fixture.listed(app, unlisted).is_err(), "{unlisted}");
            }
            assert!(!fixture.folder_dir.join(app.name()).exists());
            assert!(fixture.app.webview_windows().is_empty());
        }
    }

    /// Opening an app makes its fixed default when it is missing, and binds
    /// the window to that directory, empty. Each app has its own. Opening it
    /// again, or opening the listed default, reveals the same window.
    #[test]
    fn each_missing_default_folder_is_created_and_bound() {
        let fixture = fixture();
        for app in BundledApp::ALL {
            let default = fixture.folder_dir.join(app.name());
            assert!(!default.exists());

            let (label, was_open) = fixture.open(app, AppFolder::Default).unwrap();
            assert_eq!(was_open, false);
            assert!(default.is_dir());
            assert_eq!(bound_root(&fixture, &label), default);
            assert_eq!(fs::read_dir(&default).unwrap().count(), 0);

            assert_eq!(
                fixture.open(app, AppFolder::Default).unwrap(),
                (label.clone(), true)
            );
            assert_eq!(fixture.listed(app, app.name()).unwrap(), label);
            assert_eq!(
                fixture
                    .open(app, AppFolder::Chosen(default.clone()))
                    .unwrap(),
                (label.clone(), true)
            );
        }
        let names: Vec<String> = list_in(&fixture.folder_dir, None)
            .unwrap()
            .into_iter()
            .map(|folder| folder.name)
            .collect();
        assert_eq!(names, ["Capture", "Honeycrisp", "Todos", "Whispering"]);
    }

    #[test]
    fn a_removed_default_is_recreated_when_opened_again() {
        for app in BundledApp::ALL {
            let fixture = fixture();
            let label = fixture.default(app).unwrap();
            let default = fixture.folder_dir.join(app.name());
            fs::remove_dir(&default).unwrap();
            assert_eq!(
                invoke(&fixture.window(&label), "open_folder", json!({})).unwrap_err(),
                json!({ "name": "Missing" })
            );

            assert_eq!(fixture.default(app).unwrap(), label);
            assert!(default.is_dir());
            assert_eq!(fs::read_dir(&default).unwrap().count(), 0);
            invoke(&fixture.window(&label), "open_folder", json!({})).unwrap();
        }
    }

    /// The default is not a link the shell would follow out of the root.
    #[cfg(unix)]
    #[test]
    fn a_linked_default_folder_is_refused() {
        let fixture = fixture();
        let elsewhere = fixture.elsewhere("elsewhere");
        std::os::unix::fs::symlink(&elsewhere, fixture.folder_dir.join(Whispering.name())).unwrap();
        assert!(fixture.default(Whispering).is_err());
        assert!(fixture.app.webview_windows().is_empty());
    }

    /// The picker's answer is routed to one window per app and canonical
    /// directory: the same directory again reveals it, and two directories
    /// with one name in different places are two windows. A cancelled pick
    /// opens nothing.
    #[test]
    fn a_chosen_folder_opens_its_own_window_and_again_reveals_it() {
        let fixture = fixture();
        let home = fixture.elsewhere("home");
        let work = fixture.elsewhere("work");
        let home_notes = fixture.folder_with_todo(&home, "Notes", "milk");
        let work_notes = fixture.folder_with_todo(&work, "Notes", "eggs");

        assert_eq!(
            open_chosen(fixture.app.handle(), Todos, None, mock_window),
            Ok(false)
        );
        assert!(fixture.app.webview_windows().is_empty());

        assert_eq!(
            open_chosen(
                fixture.app.handle(),
                Todos,
                Some(home_notes.clone()),
                mock_window
            ),
            Ok(true)
        );
        let (home_label, was_open) = fixture
            .open(Todos, AppFolder::Chosen(home_notes.clone()))
            .unwrap();
        assert_eq!(was_open, true);
        // Reached through another spelling of the same directory: one window.
        let roundabout = home_notes.join("todos").join("..");
        assert_eq!(
            fixture.open(Todos, AppFolder::Chosen(roundabout)).unwrap(),
            (home_label.clone(), true)
        );
        let (work_label, was_open) = fixture
            .open(Todos, AppFolder::Chosen(work_notes.clone()))
            .unwrap();
        assert_eq!(was_open, false);
        assert_ne!(home_label, work_label);
        assert_eq!(todo_files(&fixture.window(&home_label)), json!(["milk.md"]));
        assert_eq!(todo_files(&fixture.window(&work_label)), json!(["eggs.md"]));
        // Another app on the same chosen directory is its own window.
        let (capture, _) = fixture
            .open(Capture, AppFolder::Chosen(home_notes.clone()))
            .unwrap();
        assert_ne!(capture, home_label);
        assert_eq!(bound_root(&fixture, &capture), home_notes);
    }

    /// A chosen directory is opened only as it is: one that is gone, a file,
    /// or a link is refused and nothing is created. A linked parent is fine.
    #[test]
    fn a_chosen_folder_must_be_an_existing_real_directory() {
        let fixture = fixture();
        let place = fixture.elsewhere("place");
        let gone = place.join("gone");
        let file = place.join("notes.md");
        fs::write(&file, "").unwrap();
        for refused in [&gone, &file] {
            assert!(
                open_chosen(
                    fixture.app.handle(),
                    Honeycrisp,
                    Some(refused.clone()),
                    mock_window
                )
                .is_err(),
                "{refused:?}"
            );
        }
        assert!(!gone.exists());
        assert!(fixture.app.webview_windows().is_empty());
        #[cfg(unix)]
        {
            let real = fixture.elsewhere("real");
            fs::create_dir(real.join("notes")).unwrap();
            let link = place.join("link");
            std::os::unix::fs::symlink(&real.join("notes"), &link).unwrap();
            assert!(fixture.open(Honeycrisp, AppFolder::Chosen(link)).is_err());

            let alias = place.join("alias");
            std::os::unix::fs::symlink(&real, &alias).unwrap();
            let (label, _) = fixture
                .open(Honeycrisp, AppFolder::Chosen(alias.join("notes")))
                .unwrap();
            assert_eq!(bound_root(&fixture, &label), real.join("notes"));
        }
    }

    /// A window whose WebView could not be built leaves no binding: the next
    /// open of the same folder builds it.
    #[test]
    fn a_window_that_fails_to_build_leaves_its_label_free() {
        let fixture = fixture();
        fixture.listed_with_todo("A", "milk");
        let failed = open_on(
            fixture.app.handle(),
            Todos,
            AppFolder::Listed("A".into()),
            |_, _, _| anyhow::bail!("no WebView"),
        );
        assert!(failed.unwrap_err().contains("no WebView"));
        let label = fixture.listed(Todos, "A").unwrap();
        assert_eq!(todo_files(&fixture.window(&label)), json!(["milk.md"]));
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
            let label = fixture.default(Todos).unwrap();
            assert_eq!(fixture.listed(Todos, "todos").unwrap(), label);
        } else {
            // An exact `Todos` wins where both exist.
            fs::create_dir(fixture.folder_dir.join("Todos")).unwrap();
            assert_eq!(default(), "Todos");
        }
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
