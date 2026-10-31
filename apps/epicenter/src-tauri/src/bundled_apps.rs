//! The apps Epicenter bundles, each opened on one existing folder per window.
//!
//! `BundledApp` is the closed table: Todos, Capture, Honeycrisp, Whispering,
//! and Messages. Each row names the app's page, built from `apps/<page>` into
//! `dist/<page>/` and served by the scheme at `/<page>/`; its fixed library
//! default (`library::LibraryDefault`), the same one standalone Todos opens;
//! and the prefix of its windows' labels, which selects their capability.
//! Opening one clones, builds, and fetches nothing, and no account, approval,
//! or Git step is on the way.
//!
//! The shell decides the window's folder in trusted Rust and binds it to the
//! window before the WebView exists (`folder_windows`). The page calls
//! `openFolder({ tables })` and names no path: every folder command it sends
//! reaches the directory bound to its window.
//!
//! - Open an app: its fixed default, `<folder_dir>/<id>`, such as
//!   `<folder_dir>/so.epicenter.todos`, created when missing and reused as it
//!   is otherwise. Nothing is saved, so a removed default is made again.
//! - Open a listed folder in an app: a current row in the combined root and
//!   grouped folder listing, found again by its native ID. It must exist.
//! - Choose a folder for an app: the native folder picker, in Rust. The
//!   chosen directory must exist and be a real directory; its parent may be
//!   a link.
//!
//! A listed or chosen folder that is missing, a file, or a link is refused,
//! never created and never replaced by the default. A folder that overlaps
//! Epicenter's own files is refused however it is reached: the records
//! directory, `<folder_dir>/so.epicenter`, or anything in it, its save staging
//! directory, the app data, or a directory holding any of these
//! (`overlaps_epicenter_files`). Ordinary directories outside those protected
//! roots open. One app on one directory is one window: opening it again
//! reveals that window. Whispering's AI connections are rows of the records
//! folder, which its page reads and saves through two commands by operation
//! (`cli::whispering_connection_read` and `_set`), never as a second folder.
//!
//! A window is destroyed when it closes, as Tauri closes any window: no
//! handler hides it. The recorder finalizes a Whispering recording when its
//! window is destroyed.

use std::path::PathBuf;

use epicenter_folder_core::library::{self, LibraryDefault};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_epicenter_folder::Directory;

use crate::data_folders::overlaps_epicenter_files;
use crate::folder_opening::{remember_opened, OpenedFolder};
use crate::folder_windows;
use crate::DesktopAppHandle;
use tauri_plugin_epicenter_folder::defaults::DesktopPaths;

/// An app Epicenter bundles. The page API names it by its page.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum BundledApp {
    Todos,
    Capture,
    Honeycrisp,
    Whispering,
    Messages,
}

impl BundledApp {
    pub const ALL: [Self; 5] = [
        Self::Todos,
        Self::Capture,
        Self::Honeycrisp,
        Self::Whispering,
        Self::Messages,
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
            Self::Messages => "messages",
        }
    }

    /// The app's fixed default under the library root, shared with any
    /// standalone shell of the same app.
    pub const fn library_default(self) -> LibraryDefault {
        match self {
            Self::Todos => library::TODOS,
            Self::Capture => library::CAPTURE,
            Self::Honeycrisp => library::HONEYCRISP,
            Self::Whispering => library::WHISPERING,
            Self::Messages => library::MESSAGES,
        }
    }

    /// The app's display name in window titles and messages. It never
    /// names storage.
    pub const fn name(self) -> &'static str {
        self.library_default().title
    }

    /// The capability file, by identifier, whose `windows` select this app's
    /// labels: the folder plugin alone, or Whispering's own grant. Tauri
    /// matches labels to the files; the tests hold the files to this.
    #[cfg(test)]
    pub const fn capability(self) -> &'static str {
        match self {
            Self::Todos | Self::Capture | Self::Honeycrisp => "bundled-app",
            Self::Whispering => "whispering",
            Self::Messages => "messages",
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

    /// The window's title for a directory named `name`: the app's own
    /// default reads as the app, and another app's default by its title.
    fn window_title(self, name: &str) -> String {
        if name == self.library_default().id {
            return self.name().to_string();
        }
        let name = library::ALL
            .into_iter()
            .find(|default| default.id == name)
            .map_or(name, |default| default.title);
        format!("{}: {name}", self.name())
    }
}

/// Which folder an app's window opens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AppFolder {
    /// The fixed library default, created when missing.
    Default,
    /// A folder in the grouped listing, identified by its native row ID.
    Listed(String),
    /// A directory the person chose in the native picker.
    Chosen(PathBuf),
}

/// Open bundled app `app` on its fixed default, or with `folder`, on
/// the folder identified by a current row in the grouped listing. A window
/// already open on the folder is revealed.
#[tauri::command]
#[specta::specta]
pub async fn open_bundled_app(
    handle: DesktopAppHandle,
    app: BundledApp,
    folder: Option<String>,
) -> Result<OpenedFolder, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = folder.map_or(AppFolder::Default, AppFolder::Listed);
        open_on(&handle, app, target).map(|(_, opened)| opened)
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
) -> Result<Option<OpenedFolder>, String> {
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
        open_chosen(&handle, app, picked)
    })
    .await
    .map_err(|error| format!("the {} window could not be opened: {error}", app.name()))?
}

/// Open `app` on what the picker answered, or nothing when the person
/// cancelled: whether a folder was chosen.
pub(crate) fn open_chosen<R: Runtime>(
    handle: &AppHandle<R>,
    app: BundledApp,
    picked: Option<PathBuf>,
) -> Result<Option<OpenedFolder>, String> {
    let Some(path) = picked else {
        return Ok(None);
    };
    open_on(handle, app, AppFolder::Chosen(path)).map(|(_, opened)| Some(opened))
}

/// Resolve `target` for `app`, then reveal its window or bind and build it.
pub(crate) fn open_on<R: Runtime>(
    handle: &AppHandle<R>,
    app: BundledApp,
    target: AppFolder,
) -> Result<(WebviewWindow<R>, OpenedFolder), String> {
    let directory = app_directory(
        &handle.state::<DesktopPaths>(),
        app,
        target,
        &handle.state::<crate::folder_opening::FolderOpenings>(),
    )?;
    let title = app.window_title(&folder_windows::directory_name(&directory));
    let window = folder_windows::open(handle, app.page(), directory.clone(), title, &app.path())
        .map_err(|error| format!("{error:#}"))?;
    let opened = remember_opened(
        &handle.state::<crate::folder_opening::FolderOpenings>(),
        &handle.state::<DesktopPaths>(),
        &directory,
    );
    Ok((window, opened))
}

/// The directory `app` opens `target` in: its fixed default, admitted and
/// made by `open_default`, or an explicit existing target, refused when it
/// overlaps Epicenter's own files.
fn app_directory(
    paths: &DesktopPaths,
    app: BundledApp,
    target: AppFolder,
    openings: &crate::folder_opening::FolderOpenings,
) -> Result<Directory, String> {
    let opened = match target {
        AppFolder::Default => return paths.open_default(app.library_default()),
        AppFolder::Listed(id) => crate::folder_listing::listed_directory(paths, openings, &id),
        AppFolder::Chosen(path) => Directory::existing(&path).map_err(|error| error.to_string()),
    };
    let directory = opened
        .map_err(|error| format!("The folder could not be opened in {}: {error}", app.name()))?;
    if overlaps_epicenter_files(paths, &directory) {
        return Err(format!(
            "This folder holds Epicenter's own files, so it cannot be opened in {}.",
            app.name()
        ));
    }
    Ok(directory)
}

#[cfg(test)]
mod tests {
    //! The routing of each kind of folder to an app's window, through the
    //! folder plugin's real commands on the mock runtime, as each page calls
    //! them when it opens its folder. A mock window stands in for the
    //! WebView, and a test passes the path the picker would answer.

    use std::fs;
    use std::path::Path;

    use serde_json::{json, Value};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
    use tauri::utils::acl::ExecutionContext;
    use tauri::webview::InvokeRequest;
    use tauri::App;
    use tauri_plugin_epicenter_folder::FolderExt;

    use super::*;
    use crate::data_folders::list_in;

    use super::BundledApp::{Capture, Honeycrisp, Todos, Whispering};

    const RECORDS: &str = library::RECORDS.id;

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

    impl Fixture {
        /// Open `app` on `target` as the commands do. The boolean records
        /// whether its window already existed before this call.
        fn open(&self, app: BundledApp, target: AppFolder) -> Result<(String, bool), String> {
            let target = match target {
                AppFolder::Listed(name) if !name.starts_with("folder:") => {
                    let path = self.folder_dir.join(name);
                    let path = dunce::canonicalize(&path).unwrap_or(path);
                    AppFolder::Listed(crate::folder_listing::folder_id(&path))
                }
                target => target,
            };
            let before = self.app.webview_windows().len();
            let (window, _) = open_on(self.app.handle(), app, target)?;
            Ok((
                window.label().to_owned(),
                self.app.webview_windows().len() == before,
            ))
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
            .manage(crate::folder_opening::FolderOpenings::default())
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
        let args = if command == "open_folder" {
            let channel = tauri::ipc::Channel::<tauri_plugin_epicenter_folder::FolderChanged>::new(
                |_: tauri::ipc::InvokeResponseBody| Ok(()),
            );
            json!({ "onChange": channel })
        } else {
            args
        };
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
    fn the_table_has_stable_pages_titles_defaults_paths_and_capabilities() {
        let actual = BundledApp::ALL.map(|app| {
            (
                app.page(),
                app.name(),
                app.library_default().id.to_string(),
                app.path(),
                format!("{}:", app.page()),
                app.capability(),
            )
        });
        let row = |page: &'static str, name: &'static str, capability: &'static str| {
            (
                page,
                name,
                format!("so.epicenter.{page}"),
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
                row("messages", "Messages", "messages"),
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
        assert_eq!(Todos.window_title("so.epicenter.todos"), "Todos");
        assert_eq!(Todos.window_title("Todos"), "Todos: Todos");
        assert_eq!(
            Whispering.window_title("so.epicenter.capture"),
            "Whispering: Capture"
        );
        assert_eq!(
            Whispering.window_title("Groceries"),
            "Whispering: Groceries"
        );
    }

    /// Every app's default is a distinct row of the shared table, so
    /// standalone Todos and hosted Todos open the same directory.
    #[test]
    fn every_bundled_app_has_its_own_shared_library_default() {
        let mut ids = std::collections::BTreeSet::from([library::RECORDS.id]);
        for app in BundledApp::ALL {
            let default = app.library_default();
            assert!(library::ALL.contains(&default), "{}", default.id);
            assert!(ids.insert(default.id), "duplicate default: {}", default.id);
        }
        assert_eq!(ids.len(), library::ALL.len());
        assert_eq!(Todos.library_default(), library::TODOS);
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

    /// One app's default is an ordinary listed folder that every bundled app
    /// may open, its files as they are: nothing is cloned, built, or approved
    /// on the way, and no app owns it.
    #[test]
    fn one_apps_default_opens_in_every_bundled_app() {
        let fixture = fixture();
        let todos = fixture.listed_with_todo(library::TODOS.id, "milk");
        assert_eq!(list_in(&fixture.folder_dir).unwrap(), [todos.clone()]);
        for app in BundledApp::ALL {
            let label = fixture.listed(app, library::TODOS.id).unwrap();
            assert_eq!(bound_root(&fixture, &label), todos);
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
        let own = fixture.folder_dir.join(RECORDS);
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
            assert_eq!(fixture.listed(app, RECORDS).unwrap_err(), refusal(app));
            if fixture.folder_dir.join("SO.EPICENTER").exists() {
                assert_eq!(
                    fixture.listed(app, "SO.EPICENTER").unwrap_err(),
                    refusal(app)
                );
            }
            for path in &chosen {
                assert_eq!(
                    open_chosen(fixture.app.handle(), app, Some(path.clone())).unwrap_err(),
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
        let own = fixture.folder_dir.join(RECORDS);
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
                linked_root.join(RECORDS),
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
        let own = real.join(RECORDS);
        fs::create_dir(&own).unwrap();

        for app in BundledApp::ALL {
            assert!(fixture.listed(app, RECORDS).is_err());
            for path in [own.clone(), fixture.folder_dir.join(RECORDS)] {
                assert!(fixture.open(app, AppFolder::Chosen(path)).is_err());
            }
        }
        assert!(fixture.app.webview_windows().is_empty());
        let todos = fixture.default(Todos).unwrap();
        assert_eq!(bound_root(&fixture, &todos), real.join(library::TODOS.id));
    }

    /// A listed folder that is gone is refused: nothing is created in its
    /// place, and the default is not opened instead.
    #[test]
    fn a_missing_listed_folder_is_refused_without_creating_it_or_the_default() {
        for app in BundledApp::ALL {
            let fixture = fixture();
            fixture.listed_with_todo("A", "milk");
            fs::remove_dir_all(fixture.folder_dir.join("A")).unwrap();

            let default = fixture.folder_dir.join(app.library_default().id);
            let refused = fixture.listed(app, "A").unwrap_err();
            assert!(refused.contains("no longer in the list"), "{refused}");
            assert!(!fixture.folder_dir.join("A").exists());
            assert!(!default.exists());

            // A name that is not one listed directory, and a path, open nothing.
            for unlisted in ["B", "data:A", "/tmp", "../A", "", "A/B"] {
                assert!(fixture.listed(app, unlisted).is_err(), "{unlisted}");
            }
            assert!(!default.exists());
            assert!(fixture.app.webview_windows().is_empty());
        }
    }

    /// Opening an app makes its fixed default when it is missing, and binds
    /// the window to that directory, empty. Each app has its own. Opening it
    /// again, or opening the listed default, reveals the same window. No
    /// configuration is written.
    #[test]
    fn each_missing_default_folder_is_created_and_bound() {
        let fixture = fixture();
        for app in BundledApp::ALL {
            let id = app.library_default().id;
            let default = fixture.folder_dir.join(id);
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
            assert_eq!(fixture.listed(app, id).unwrap(), label);
            assert_eq!(
                fixture
                    .open(app, AppFolder::Chosen(default.clone()))
                    .unwrap(),
                (label.clone(), true)
            );
        }
        let mut children = list_in(&fixture.folder_dir).unwrap();
        children.sort();
        assert_eq!(
            children,
            [
                "so.epicenter.capture",
                "so.epicenter.honeycrisp",
                "so.epicenter.messages",
                "so.epicenter.todos",
                "so.epicenter.whispering"
            ]
            .map(|name| fixture.folder_dir.join(name))
        );
        assert_eq!(
            epicenter_folder_core::navigation::read(&fixture.data_dir)
                .unwrap()
                .recent
                .len(),
            5
        );
    }

    /// An existing default opens with the files already in it.
    #[test]
    fn an_existing_default_is_reused_with_its_files() {
        let fixture = fixture();
        let existing = fixture.listed_with_todo(library::TODOS.id, "milk");
        fs::write(existing.join("unrelated.txt"), "keep").unwrap();
        let label = fixture.default(Todos).unwrap();
        assert_eq!(bound_root(&fixture, &label), existing);
        assert_eq!(todo_files(&fixture.window(&label)), json!(["milk.md"]));
        assert_eq!(
            fs::read_to_string(existing.join("unrelated.txt")).unwrap(),
            "keep"
        );
    }

    /// A default removed while its window is open is refused to that page and
    /// made again, empty, by the next ordinary open, which reveals the same
    /// window on the same path.
    #[test]
    fn a_removed_default_is_made_again_on_the_next_open() {
        for app in BundledApp::ALL {
            let fixture = fixture();
            let label = fixture.default(app).unwrap();
            let default = fixture.folder_dir.join(app.library_default().id);
            fs::remove_dir(&default).unwrap();
            assert_eq!(
                invoke(&fixture.window(&label), "open_folder", json!({})).unwrap_err(),
                json!({ "name": "Missing" })
            );

            assert_eq!(fixture.default(app).unwrap(), label);
            assert!(default.is_dir());
            invoke(&fixture.window(&label), "open_folder", json!({})).unwrap();
        }
    }

    /// The default is not a link the shell would follow out of the root.
    #[cfg(unix)]
    #[test]
    fn a_linked_default_folder_is_refused() {
        let fixture = fixture();
        let elsewhere = fixture.elsewhere("elsewhere");
        std::os::unix::fs::symlink(
            &elsewhere,
            fixture.folder_dir.join(Whispering.library_default().id),
        )
        .unwrap();
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

        assert_eq!(open_chosen(fixture.app.handle(), Todos, None), Ok(None));
        assert!(fixture.app.webview_windows().is_empty());

        assert_eq!(
            open_chosen(fixture.app.handle(), Todos, Some(home_notes.clone())),
            Ok(Some(crate::folder_opening::OpenedFolder {
                remember_problem: None
            }))
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
                open_chosen(fixture.app.handle(), Honeycrisp, Some(refused.clone())).is_err(),
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

    /// The default is one directory with one window whatever its spelling on
    /// a case-insensitive disk, where the listing names it as it is stored.
    #[test]
    fn default_and_listed_windows_follow_the_disks_case_sensitivity() {
        let fixture = fixture();
        let stored = "SO.EPICENTER.TODOS";
        fs::create_dir(fixture.folder_dir.join(stored)).unwrap();
        let insensitive = fixture.folder_dir.join(library::TODOS.id).exists();
        let label = fixture.default(Todos).unwrap();
        let listed = fixture.listed(Todos, stored).unwrap();
        if insensitive {
            assert_eq!(listed, label);
            assert_eq!(
                bound_root(&fixture, &label),
                fixture.folder_dir.join(stored)
            );
        } else {
            assert_ne!(listed, label);
            assert_eq!(
                bound_root(&fixture, &label),
                fixture.folder_dir.join(library::TODOS.id)
            );
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
