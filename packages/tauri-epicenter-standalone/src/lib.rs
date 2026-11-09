//! Standalone startup: one app, two named roots, one window.
//!
//! An installed app keeps two roots, which the page reaches by name through
//! the folder plugin (`Root`, ADR-0725). Its **AppData root** is the
//! operating system's application data directory for the app, one per
//! installation, never synced and never chosen; its settings notes sit at
//! its top (`settings.md`, `shortcuts.md`), beside `epicenter-account`'s
//! `credentials.json` and `account.json` in an app that signs in. Its
//! **data root** is the
//! person's files, `<library root>/<name>`: the name comes from the app's
//! bundle identifier, the reversed host of its production site, and the
//! library root is `~/Epicenter`, or `~/Epicenter Dev` for a development
//! build. The environment is stated in the Tauri configuration, which only
//! the development configuration (`tauri.dev.conf.json`) does
//! (`data_folder::Environment`); a development build's identifier is the
//! production one with `.dev` appended. Only the data root is ever synced,
//! and only by Epicenter (ADR-0822).
//!
//! An app finds its folder by its identity (`data_identity`): the shell
//! remembers the data root's inode and birth time in its AppData root each
//! time the page opens it, and at start names the directory in the library
//! root that they prove before its derived path, so a folder the person
//! renamed is still the app's. Open with names any directory directly in the
//! library root (`--folder <name or path>`).
//!
//! Startup names both roots, then opens the window. The page opens the data
//! root off the window thread, making the folder when nothing is at its path
//! and following a link there (ADR-0726). If the data root cannot open,
//! its recovery screen shows the
//! typed error and Retry. The one refusal is
//! a data root whose location is the person's home folder, a folder holding
//! it, or the library root itself (`refusal`). A startup that fails says why
//! (`StartupError`) and offers only Quit when it cannot name roots or build
//! the window. Rust never reads or writes a
//! settings note.
//!
//! Quit is the default menu's, and quits; a window closes at once. This crate
//! installs no close, destroy, or exit handler that waits for a page. Every
//! plugin still hears the window's `Destroyed` and the app's `Exit` (AppKit's
//! Quit reaches `Exit` without `ExitRequested`), which is where the recorder
//! finishes a recording in progress.

use std::fmt;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_epicenter_folder::admission::resolved;
use tauri_plugin_epicenter_folder::{identity_at, FolderIdentity, Root, RootsExt};

use crate::data_folder::{Environment, EnvironmentError, FolderNameError};

pub mod data_folder;
pub mod data_identity;

/// The app's data folder is named by its bundle identifier, the reversed host
/// of its production site (`data_folder::identity`), so nothing here names it.
#[derive(Clone, Copy, Debug)]
pub struct StandaloneApp {
    /// The window-label prefix its capability selects (`<page>:*`).
    pub page: &'static str,
    /// The app's name, in its windows and messages.
    pub title: &'static str,
    /// The primary window's logical width and height.
    pub size: (f64, f64),
}

/// Why the app did not start: what its one dialog says before Quit.
#[derive(Debug)]
pub enum StartupError {
    /// The operating system named no home folder, application data folder,
    /// or cache folder for the app.
    Paths(tauri::Error),
    /// The configuration's `plugins.epicenter-standalone` names no
    /// environment.
    Environment(EnvironmentError),
    /// The bundle identifier names no data folder in this environment.
    Identity(FolderNameError),
    /// The folder the app was opened with (`--folder`) cannot be its folder:
    /// why, in one line.
    Folder(String),
    /// The window could not be built.
    Window(tauri::Error),
}

impl fmt::Display for StartupError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Paths(error) => write!(
                formatter,
                "The system did not say where this app keeps its files: {error}"
            ),
            Self::Environment(error) => write!(formatter, "The app is misconfigured: {error}."),
            Self::Identity(error) => write!(formatter, "The app is misconfigured: {error}."),
            Self::Folder(reason) => formatter.write_str(reason),
            Self::Window(error) => write!(formatter, "The window could not open: {error}"),
        }
    }
}

impl std::error::Error for StartupError {}

/// Builder with the folder plugin, the dialog plugin (for a startup failure),
/// and setup that names the app's roots and opens its
/// window. Add app-specific plugins and commands, then call
/// `.run(tauri::generate_context!())`.
pub fn builder(app: StandaloneApp) -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .plugin(tauri_plugin_epicenter_folder::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(app)
        .setup(move |application| {
            let handle = application.handle().clone();
            if let Err(error) = start(&handle, app) {
                quit_with(&handle, app, &error);
            }
            Ok(())
        })
}

/// Start the app under the person's home folder, opened with the folder the
/// launch arguments name (`--folder <name or path>`) if any: name its roots,
/// then open its window.
pub fn start<R: Runtime>(
    handle: &AppHandle<R>,
    app: StandaloneApp,
) -> Result<WebviewWindow<R>, StartupError> {
    let path = handle.path();
    let home = path.home_dir().map_err(StartupError::Paths)?;
    let app_data = path.app_data_dir().map_err(StartupError::Paths)?;
    let arguments: Vec<String> = std::env::args().collect();
    let startup = Startup {
        home: &home,
        app_data,
        folder: data_identity::folder_argument(&arguments),
        identity: &|path| identity_at(path).ok().flatten(),
    };
    start_in(handle, app, startup)
}

/// Where a start looks: the person's home folder, the app's AppData root,
/// the folder it was opened with, and how a directory's identity is read
/// (`identity_at`, which a test replaces to stand in for a file system
/// without birth times).
struct Startup<'a> {
    home: &'a Path,
    app_data: PathBuf,
    folder: Option<String>,
    identity: &'a dyn Fn(&Path) -> Option<FolderIdentity>,
}

/// `start` for `startup`.
fn start_in<R: Runtime>(
    handle: &AppHandle<R>,
    app: StandaloneApp,
    startup: Startup<'_>,
) -> Result<WebviewWindow<R>, StartupError> {
    name_roots(handle, startup)?;
    open_window(handle, app)
}

/// Name the roots: AppData, and the data folder: the one the app was opened
/// with, else the directory in the library root its remembered identity
/// proves, else the one the bundle identifier derives under `home` in the
/// environment the configuration states. Each time the page opens Data,
/// its identity is remembered.
fn name_roots<R: Runtime>(handle: &AppHandle<R>, startup: Startup<'_>) -> Result<(), StartupError> {
    let Startup {
        home,
        app_data,
        folder,
        identity: read_identity,
    } = startup;
    let config = handle.config();
    let environment = Environment::from_config(config.plugins.0.get(data_folder::CONFIG_KEY))
        .map_err(StartupError::Environment)?;
    let identity =
        data_folder::identity(&config.identifier, environment).map_err(StartupError::Identity)?;
    let library = data_folder::root(home, environment);
    let derived =
        library.join(data_folder::relative_path(&identity.host).map_err(StartupError::Identity)?);
    let data = match folder {
        Some(folder) => data_identity::opened_with(&library, &folder).map_err(StartupError::Folder)?,
        None => {
            let remembered = data_identity::remembered(&app_data);
            data_identity::find(&library, &derived, remembered.as_ref(), read_identity)
                .unwrap_or(derived)
        }
    };
    let roots = handle.roots();
    roots.name(Root::AppData, app_data.clone(), |_| None);
    roots.name_library(library.clone());
    roots.on_open(move |root, directory| {
        if *root != Root::Data {
            return;
        }
        let remembered = identity_at(directory.root())
            .and_then(|identity| match identity {
                Some(identity) => data_identity::remember(&app_data, &identity),
                None => Ok(()),
            });
        if let Err(error) = remembered {
            log::warn!("The data folder's identity was not remembered: {error}");
        }
    });
    let home = home.to_path_buf();
    roots.name(Root::Data, data, move |location| {
        refusal(&home, &library, location)
    });
    Ok(())
}

/// The one location a data root is refused (ADR-0725): the person's home
/// folder, a folder holding it, or the library root itself. `location` is
/// where the root's path resolves, so a link to one of them is refused too.
pub fn refusal(home: &Path, library: &Path, location: &Path) -> Option<String> {
    let shown = location.display();
    if resolved(home).starts_with(location) {
        return Some(format!(
            "{shown} is your home folder or holds it, so it cannot be an app's folder."
        ));
    }
    if location == resolved(library) {
        return Some(format!(
            "{shown} holds every app's folder, so it cannot be one app's folder."
        ));
    }
    None
}

/// The app's one window, `<page>:main`, with its WebView files outside both
/// roots.
fn open_window<R: Runtime>(
    handle: &AppHandle<R>,
    app: StandaloneApp,
) -> Result<WebviewWindow<R>, StartupError> {
    let webview_data = handle
        .path()
        .app_cache_dir()
        .map_err(StartupError::Paths)?
        .join("webview");
    let (width, height) = app.size;
    WebviewWindowBuilder::new(handle, format!("{}:main", app.page), WebviewUrl::default())
        .title(app.title)
        .inner_size(width, height)
        .min_inner_size(400.0, 400.0)
        .data_directory(webview_data)
        .build()
        .map_err(StartupError::Window)
}

/// Name the failure and offer only Quit: no other folder is opened instead.
fn quit_with<R: Runtime>(handle: &AppHandle<R>, app: StandaloneApp, error: &StartupError) {
    let exit = handle.clone();
    handle
        .dialog()
        .message(error.to_string())
        .title(format!("{} could not start", app.title))
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCustom("Quit".into()))
        .show(move |_| exit.exit(1));
}

#[cfg(test)]
mod tests {
    //! Startup and the folder plugin's real commands on the mock runtime, as
    //! a page calls them over the window startup opens, with a mock window
    //! standing in for the WebView. The roots are named under a temporary
    //! home, as startup names them under the person's.

    use std::fs;

    use serde_json::{json, Value};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
    use tauri::utils::acl::ExecutionContext;
    use tauri::webview::InvokeRequest;
    use tauri::App;

    use super::*;

    const NOTES: StandaloneApp = StandaloneApp {
        page: "notes",
        title: "Notes",
        size: (960.0, 720.0),
    };

    struct Fixture {
        app: App<MockRuntime>,
        /// The AppData root.
        config: PathBuf,
        /// The person's home folder.
        home: PathBuf,
        /// The derived data folder, `~/Epicenter/notes`.
        data: PathBuf,
        base: PathBuf,
        _temp: tempfile::TempDir,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.app.roots().shutdown();
        }
    }

    impl Fixture {
        /// Start under the fixture's home.
        fn start(&self) -> Result<WebviewWindow<MockRuntime>, StartupError> {
            self.start_at(&self.home)
        }

        /// Start with `home` spelled as given.
        fn start_at(&self, home: &Path) -> Result<WebviewWindow<MockRuntime>, StartupError> {
            self.start_with(home, None, &|path| identity_at(path).ok().flatten())
        }

        /// Start opened with `folder`, reading identities with `identity`.
        fn start_with(
            &self,
            home: &Path,
            folder: Option<&str>,
            identity: &dyn Fn(&Path) -> Option<FolderIdentity>,
        ) -> Result<WebviewWindow<MockRuntime>, StartupError> {
            let startup = Startup {
                home,
                app_data: self.config.clone(),
                folder: folder.map(str::to_string),
                identity,
            };
            start_in(self.app.handle(), NOTES, startup)
        }

        /// Quit, and launch the app again over the same home.
        fn restart(&mut self) {
            self.app.roots().shutdown();
            self.app = mock_app("so.epicenter.notes", None);
        }

        /// Whether startup opened no window.
        fn no_window(&self) -> bool {
            self.app.webview_windows().is_empty()
        }
    }

    /// An app whose configuration has `identifier`, and `setting` as its
    /// `plugins.epicenter-standalone` when given.
    fn fixture_for(identifier: &str, setting: Option<Value>) -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(temp.path()).unwrap();
        let app = mock_app(identifier, setting);
        let home = base.join("home");
        fs::create_dir_all(&home).unwrap();
        Fixture {
            app,
            config: home.join("Library/Application Support/so.epicenter.notes"),
            data: home.join("Epicenter/notes"),
            home,
            base,
            _temp: temp,
        }
    }

    /// The mock app for `identifier`, with `setting` as its
    /// `plugins.epicenter-standalone` when given.
    fn mock_app(identifier: &str, setting: Option<Value>) -> App<MockRuntime> {
        let mut context = mock_context(noop_assets());
        context.config_mut().identifier = identifier.into();
        if let Some(setting) = setting {
            context
                .config_mut()
                .plugins
                .0
                .insert(data_folder::CONFIG_KEY.into(), setting);
        }
        for command in tauri_plugin_epicenter_folder::COMMANDS {
            context.runtime_authority_mut().__allow_command(
                format!("plugin:epicenter-folder|{command}"),
                ExecutionContext::Local,
            );
        }
        mock_builder()
            .plugin(tauri_plugin_epicenter_folder::init())
            .build(context)
            .expect("mock app")
    }

    fn fixture() -> Fixture {
        fixture_for("so.epicenter.notes", None)
    }

    fn call(
        window: &WebviewWindow<MockRuntime>,
        command: &str,
        body: Value,
    ) -> Result<Value, Value> {
        tauri::test::get_ipc_response(
            window,
            InvokeRequest {
                cmd: format!("plugin:epicenter-folder|{command}"),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize::<Value>().expect("a JSON response"))
    }

    /// `open_root` as a page asks for its `Data` and `AppData` roots.
    fn open(window: &WebviewWindow<MockRuntime>, root: &str) -> Result<Value, Value> {
        call(window, "open_root", json!({ "root": root }))
    }

    /// The files a page lists in `root`, or the plugin's refusal.
    fn list(window: &WebviewWindow<MockRuntime>, root: &str) -> Result<Vec<String>, Value> {
        call(window, "list_folder", json!({ "root": root, "under": [""] })).map(|listing| {
            listing
                .as_array()
                .unwrap()
                .iter()
                .map(|file| file["path"].as_str().unwrap().to_owned())
                .collect()
        })
    }

    /// Startup names roots without touching disk; the page opens them after the window.
    /// AppData is made when the page first opens it.
    #[test]
    fn the_page_makes_the_data_folder_after_the_window_opens() {
        let fixture = fixture();
        assert!(!fixture.data.exists());
        let window = fixture.start().unwrap();
        assert_eq!(window.label(), "notes:main");
        assert!(!fixture.data.exists());
        assert!(!fixture.config.exists());
        assert_eq!(open(&window, "Data").unwrap(), json!(fixture.data));
        assert!(fixture.data.is_dir());
        assert_eq!(open(&window, "AppData").unwrap(), json!(fixture.config));
        fs::write(fixture.data.join("a.md"), "---\n---\n").unwrap();
        fs::write(fixture.config.join("settings.md"), "---\n---\n").unwrap();
        assert_eq!(list(&window, "Data").unwrap(), ["a.md"]);
        assert_eq!(list(&window, "AppData").unwrap(), ["settings.md"]);
    }

    /// A development configuration states its environment, and its
    /// identifier, the production one with `.dev`, names a folder under
    /// `~/Epicenter Dev`.
    #[test]
    fn a_development_configuration_makes_its_folder_under_epicenter_dev() {
        let fixture = fixture_for(
            "so.epicenter.notes.dev",
            Some(json!({ "environment": "development" })),
        );
        let window = fixture.start().unwrap();
        assert!(!fixture.home.join("Epicenter Dev/notes").exists());
        assert!(!fixture.home.join("Epicenter").exists());
        assert_eq!(
            open(&window, "Data").unwrap(),
            json!(fixture.home.join("Epicenter Dev/notes"))
        );
        assert!(fixture.home.join("Epicenter Dev/notes").is_dir());
    }

    /// A configuration whose environment and identifier disagree, or whose
    /// environment is not one, starts nothing and makes nothing.
    #[test]
    fn a_misconfigured_environment_starts_nothing() {
        let fixture = fixture_for(
            "so.epicenter.notes",
            Some(json!({ "environment": "development" })),
        );
        assert!(matches!(
            fixture.start(),
            Err(StartupError::Identity(FolderNameError::NotADevelopmentIdentifier(identifier)))
                if identifier == "so.epicenter.notes"
        ));
        let fixture = fixture_for(
            "so.epicenter.notes.dev",
            Some(json!({ "environment": "staging" })),
        );
        assert!(matches!(
            fixture.start(),
            Err(StartupError::Environment(
                EnvironmentError::UnknownEnvironment(_)
            ))
        ));
        assert!(fixture.no_window());
        assert_eq!(fs::read_dir(&fixture.home).unwrap().count(), 0);
    }

    /// A dangling link makes nothing. The window opens so its page receives
    /// Disconnected and can retry when the drive returns.
    #[cfg(unix)]
    #[test]
    fn a_dangling_link_reaches_recovery_and_makes_nothing() {
        use std::os::unix::fs::symlink;

        let fixture = fixture();
        let target = fixture.base.join("Volumes/Archive/notes");
        fs::create_dir_all(fixture.data.parent().unwrap()).unwrap();
        symlink(&target, &fixture.data).unwrap();
        let window = fixture.start().unwrap();
        let failed = open(&window, "Data").unwrap_err();
        assert!(
            matches!(
                &failed,
                Value::Object(fields)
                    if fields["name"] == "Disconnected"
                        && fields["folder"] == fixture.data.display().to_string()
                        && fields["target"] == target.display().to_string()
            ),
            "{failed:?}"
        );
        // Storage on the root answers the same, and makes nothing.
        assert_eq!(list(&window, "Data").unwrap_err(), failed);
        assert!(!fixture.base.join("Volumes").exists());
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("a.md"), "---\n---\n").unwrap();
        assert_eq!(open(&window, "Data").unwrap(), json!(fixture.data));
        assert_eq!(list(&window, "Data").unwrap(), ["a.md"]);
    }

    /// The same holds when the link is the library root above the folder.
    #[cfg(unix)]
    #[test]
    fn a_dangling_library_root_reaches_recovery_and_makes_nothing() {
        use std::os::unix::fs::symlink;

        let fixture = fixture();
        let drive = fixture.base.join("Volumes/Archive/Epicenter");
        symlink(&drive, fixture.data.parent().unwrap()).unwrap();
        let window = fixture.start().unwrap();
        assert_eq!(
            open(&window, "Data").unwrap_err()["target"],
            drive.join("notes").display().to_string()
        );
        assert!(!drive.exists());
    }

    /// A data root kept elsewhere is a link at its path, and the page is
    /// still shown the path, not where it leads.
    #[cfg(unix)]
    #[test]
    fn a_linked_data_folder_opens_where_it_leads() {
        use std::os::unix::fs::symlink;

        let fixture = fixture();
        let target = fixture.base.join("archive/notes");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("a.md"), "---\n---\n").unwrap();
        fs::create_dir_all(fixture.data.parent().unwrap()).unwrap();
        symlink(&target, &fixture.data).unwrap();
        let window = fixture.start().unwrap();
        assert_eq!(open(&window, "Data").unwrap(), json!(fixture.data));
        assert_eq!(list(&window, "Data").unwrap(), ["a.md"]);
    }

    /// A data root that resolves to the library root, the home folder, or a
    /// folder holding it is refused to the page, however either is spelled.
    #[cfg(unix)]
    #[test]
    fn a_link_to_the_library_root_or_home_or_above_is_refused_to_the_page() {
        use std::os::unix::fs::symlink;

        for leads_to in ["library", "home", "above"] {
            let fixture = fixture();
            let library = fixture.data.parent().unwrap().to_path_buf();
            fs::create_dir_all(&library).unwrap();
            let target = match leads_to {
                "library" => library.clone(),
                "home" => fixture.home.clone(),
                _ => fixture.base.clone(),
            };
            symlink(&target, &fixture.data).unwrap();
            // A home reached through a link (`/tmp` is `/private/tmp` on
            // macOS) does not hide the link.
            let alias = fixture.base.join("alias");
            symlink(&fixture.home, &alias).unwrap();
            let window = fixture.start_at(&alias).unwrap();
            let failed = open(&window, "Data").unwrap_err();
            let expected = alias.join("Epicenter/notes").display().to_string();
            assert!(
                matches!(
                    &failed,
                    Value::Object(fields) if fields["name"] == "Refused" && fields["folder"] == expected
                ),
                "{leads_to}: {failed:?}"
            );
        }
    }

    /// The page's open of Data is what makes the folder, and the shell then
    /// remembers its identity, which no page reaches.
    #[test]
    fn opening_data_remembers_its_identity() {
        let fixture = fixture();
        let window = fixture.start().unwrap();
        open(&window, "Data").unwrap();
        let identity = identity_at(&fixture.data).unwrap().unwrap();
        assert_eq!(data_identity::remembered(&fixture.config), Some(identity));
        open(&window, "AppData").unwrap();
        assert!(list(&window, "AppData").unwrap().is_empty());
    }

    /// A folder the person renamed is still the app's: the next start opens
    /// it by its new name, even when an empty folder was made at the old one
    /// meanwhile.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_renamed_folder_is_opened_by_its_new_name() {
        let mut fixture = fixture();
        let window = fixture.start().unwrap();
        open(&window, "Data").unwrap();
        fs::write(fixture.data.join("a.md"), "---\n---\n").unwrap();
        let renamed = fixture.home.join("Epicenter/My notes");
        fs::rename(&fixture.data, &renamed).unwrap();
        fs::create_dir(&fixture.data).unwrap();

        fixture.restart();
        let window = fixture.start().unwrap();
        assert_eq!(open(&window, "Data").unwrap(), json!(renamed));
        assert_eq!(list(&window, "Data").unwrap(), ["a.md"]);

        // Gone altogether, the app makes its folder at its usual path again.
        fs::remove_dir_all(&renamed).unwrap();
        fixture.restart();
        let window = fixture.start().unwrap();
        assert_eq!(open(&window, "Data").unwrap(), json!(fixture.data));
    }

    /// Where the file system records no birth time, an inode alone proves
    /// nothing: the derived folder opens, whatever directory has the inode.
    #[test]
    fn without_birth_times_the_derived_folder_opens() {
        let mut fixture = fixture();
        let unborn = |path: &Path| {
            identity_at(path).ok().flatten().map(|identity| FolderIdentity {
                birthtime: None,
                ..identity
            })
        };
        let window = fixture.start_with(&fixture.home, None, &unborn).unwrap();
        open(&window, "Data").unwrap();
        let renamed = fixture.home.join("Epicenter/My notes");
        fs::rename(&fixture.data, &renamed).unwrap();
        // What a file system without birth times remembers.
        let remembered = identity_at(&renamed).unwrap().unwrap();
        data_identity::remember(
            &fixture.config,
            &FolderIdentity {
                birthtime: None,
                ..remembered
            },
        )
        .unwrap();

        fixture.restart();
        let window = fixture.start_with(&fixture.home, None, &unborn).unwrap();
        assert_eq!(open(&window, "Data").unwrap(), json!(fixture.data));
    }

    /// Open with names any folder directly inside the Epicenter folder, by
    /// name or path, and the app remembers it; anything else does not start.
    #[test]
    fn open_with_names_a_folder_in_the_epicenter_folder() {
        let mut fixture = fixture();
        let recipes = fixture.home.join("Epicenter/Recipes");
        fs::create_dir_all(&recipes).unwrap();
        let window = fixture
            .start_with(&fixture.home, Some("Recipes"), &|path| {
                identity_at(path).ok().flatten()
            })
            .unwrap();
        assert_eq!(open(&window, "Data").unwrap(), json!(recipes));
        assert_eq!(
            data_identity::remembered(&fixture.config),
            identity_at(&recipes).unwrap()
        );

        fixture.restart();
        let path = recipes.display().to_string();
        let window = fixture
            .start_with(&fixture.home, Some(&path), &|path| {
                identity_at(path).ok().flatten()
            })
            .unwrap();
        assert_eq!(open(&window, "Data").unwrap(), json!(recipes));

        for refused in ["Missing", ".hidden", "../home"] {
            fixture.restart();
            assert!(
                matches!(
                    fixture.start_with(&fixture.home, Some(refused), &|_| None),
                    Err(StartupError::Folder(_))
                ),
                "{refused}"
            );
            assert!(fixture.no_window());
        }
    }

    #[test]
    fn the_refusal_names_home_its_ancestors_and_the_library_root_alone() {
        let home = Path::new("/Users/person");
        let library = home.join("Epicenter");
        for refused in [
            PathBuf::from("/"),
            PathBuf::from("/Users"),
            home.to_path_buf(),
            library.clone(),
        ] {
            let reason = refusal(home, &library, &refused).unwrap();
            assert!(!reason.contains('\n'), "{reason}");
        }
        for accepted in [
            library.join("notes"),
            library.join("bradenwong.com/zhongwen"),
            home.join("Documents/notes"),
            home.join(".notes"),
            PathBuf::from("/Volumes/Archive/notes"),
        ] {
            assert_eq!(
                refusal(home, &library, &accepted),
                None,
                "{}",
                accepted.display()
            );
        }
    }
}
