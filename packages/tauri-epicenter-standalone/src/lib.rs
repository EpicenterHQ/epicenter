//! Standalone startup: one app, two named roots, one window.
//!
//! An installed app keeps two roots, which the page reaches by name through
//! the folder plugin (`Root`, ADR-0725). Its **AppData root** is the
//! operating system's application data directory for the app, one per
//! installation, never synced and never chosen; its settings notes sit at
//! its top (`settings.md`, `shortcuts.md`). Its **data root** is the
//! person's files, `<library root>/<name>`: the name comes from the app's
//! bundle identifier, the reversed host of its production site, and the
//! library root is `~/Epicenter`, or `~/Epicenter Dev` for a development
//! build. The environment is stated in the Tauri configuration, which only
//! the development configuration (`tauri.dev.conf.json`) does
//! (`data_folder::Environment`); a development build's identifier is the
//! production one with `.dev` appended. Only the data root is ever synced
//! (by Epicenter).
//!
//! Startup names both roots, opens the data root, making the folder when
//! nothing is at its path and following a link there (ADR-0726), and only
//! then opens the window; nothing is granted or stored. If the data root
//! cannot open, the window still opens so its recovery screen can show the
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
use tauri_plugin_epicenter_folder::{Root, RootsExt};

use crate::data_folder::{Environment, EnvironmentError, FolderNameError};

pub mod data_folder;

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
            Self::Window(error) => write!(formatter, "The window could not open: {error}"),
        }
    }
}

impl std::error::Error for StartupError {}

/// Builder with the folder plugin, the dialog plugin (for a startup failure),
/// and setup that names the app's roots, opens its data folder, and opens its
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

/// Start the app under the person's home folder: name its roots, open its
/// data folder, then open its window.
pub fn start<R: Runtime>(
    handle: &AppHandle<R>,
    app: StandaloneApp,
) -> Result<WebviewWindow<R>, StartupError> {
    let path = handle.path();
    let home = path.home_dir().map_err(StartupError::Paths)?;
    let app_data = path.app_data_dir().map_err(StartupError::Paths)?;
    start_in(handle, app, &home, app_data)
}

/// `start` for `home` and `app_data`.
fn start_in<R: Runtime>(
    handle: &AppHandle<R>,
    app: StandaloneApp,
    home: &Path,
    app_data: PathBuf,
) -> Result<WebviewWindow<R>, StartupError> {
    name_roots(handle, home, app_data)?;
    // The page opens Data again to attach its change channel. If this first
    // attempt fails, that open returns the typed error to Recovery and Retry.
    let _ = handle.roots().open(Root::Data);
    open_window(handle, app)
}

/// Name the roots: AppData, and the data folder the bundle identifier
/// derives under `home` in the environment the configuration states.
fn name_roots<R: Runtime>(
    handle: &AppHandle<R>,
    home: &Path,
    app_data: PathBuf,
) -> Result<(), StartupError> {
    let config = handle.config();
    let environment = Environment::from_config(config.plugins.0.get(data_folder::CONFIG_KEY))
        .map_err(StartupError::Environment)?;
    let identity =
        data_folder::identity(&config.identifier, environment).map_err(StartupError::Identity)?;
    let library = data_folder::root(home, environment);
    let data =
        library.join(data_folder::relative_path(&identity.host).map_err(StartupError::Identity)?);
    let roots = handle.roots();
    roots.name(Root::AppData, app_data, |_| None);
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
            start_in(self.app.handle(), NOTES, home, self.config.clone())
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
        let app = mock_builder()
            .plugin(tauri_plugin_epicenter_folder::init())
            .build(context)
            .expect("mock app");
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

    /// `open_root`, then `root_path`, as `openDataFolder` and `openAppData`
    /// ask for them: the path to show, or why the root did not open.
    fn open(window: &WebviewWindow<MockRuntime>, root: &str) -> Result<Value, Value> {
        assert_eq!(
            call(
                window,
                "open_root",
                json!({ "root": root, "onChange": "__CHANNEL__:1" }),
            )?,
            Value::Null
        );
        call(window, "root_path", json!({ "root": root }))
    }

    /// The files a page lists in `root`, or the plugin's refusal.
    fn list(window: &WebviewWindow<MockRuntime>, root: &str) -> Result<Vec<String>, Value> {
        call(window, "list_folder", json!({ "root": root })).map(|listing| {
            listing
                .as_array()
                .unwrap()
                .iter()
                .map(|file| file["path"].as_str().unwrap().to_owned())
                .collect()
        })
    }

    /// Startup makes the data folder before the window exists; the page then
    /// opens both roots by name and is shown the path the shell derived.
    /// AppData is made when the page first opens it.
    #[test]
    fn startup_makes_the_data_folder_before_the_window() {
        let fixture = fixture();
        assert!(!fixture.data.exists());
        let window = fixture.start().unwrap();
        assert_eq!(window.label(), "notes:main");
        assert!(fixture.data.is_dir());
        assert!(!fixture.config.exists());
        assert_eq!(open(&window, "Data").unwrap(), json!(fixture.data));
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
        assert!(fixture.home.join("Epicenter Dev/notes").is_dir());
        assert!(!fixture.home.join("Epicenter").exists());
        assert_eq!(
            open(&window, "Data").unwrap(),
            json!(fixture.home.join("Epicenter Dev/notes"))
        );
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
