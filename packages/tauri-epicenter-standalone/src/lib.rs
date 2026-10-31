//! Standalone startup: one app, two roots, one primary window (decisions 88
//! and 89).
//!
//! An installed app keeps two roots. Its **AppData root** is fixed: the
//! operating system's application data directory for the app, one per
//! installation, never synced and never chosen. Its settings notes sit at its
//! top (`settings.md`, `shortcuts.md`), as the same notes sit at the top of
//! the data root. Its **data root** is the person's files: `~/Epicenter/<App>`
//! by default (`~/Epicenter Dev/<App>` for a `.dev` build, or under
//! `EPICENTER_FOLDER_DIR`), or the folder the person chose with "Choose data
//! folder…", which the page remembers as `folder` in the AppData root's
//! `settings.md`. Only the data root is ever synced (by Epicenter).
//!
//! Rust never reads or writes a settings note. Startup makes the AppData root
//! and opens the window bound to it alone; before any of the page's code
//! runs, `window.__EPICENTER_APP_FOLDERS__` (`appFolders()` in
//! `@epicenter/folder/tauri`) names it and the default data folder. The page
//! reads `folder` from `settings.md` through its contract client and calls
//! `commands::open_data_folder` with it, or with `null` for the default:
//! Rust admits the folder (`Places::data_root`: the default is created when
//! missing; a chosen folder is opened as it is, never created and never
//! moved), makes it the window's watched root with the AppData root granted
//! beside it, and answers its path, or a typed refusal the page shows on its
//! recovery screen (Retry, Choose folder…, Use the default folder). It never
//! falls back to another folder. "Choose data folder…" is
//! `commands::choose_data_folder` (the native picker) followed by the same
//! command; the page writes `folder` through its client.
//!
//! On macOS, the menu's Quit and Cmd-Q request the primary window's ordinary
//! close, so the page's leave guard answers. This crate installs no close,
//! destroy, or exit handler that waits. Auxiliary windows an app makes are
//! destroyed with the primary, never another primary.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_epicenter_folder::library::{resolved, RECORDS};
use tauri_plugin_epicenter_folder::{Directory, FolderExt};

#[derive(Clone, Copy, Debug)]
pub struct StandaloneApp {
    /// The window-label prefix its capability selects (`<page>:*`).
    pub page: &'static str,
    /// The app's name: its windows and messages, and its default folder's
    /// name in the Epicenter folder (`~/Epicenter/<title>`).
    pub title: &'static str,
    /// The primary window's logical width and height.
    pub size: (f64, f64),
}

/// Where this app keeps its AppData root, its default data folder, and the
/// folders it never accepts as a data folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Places {
    /// The AppData root: the app's application data directory, whose top
    /// holds its settings notes.
    pub config: PathBuf,
    /// The default data root: `<Epicenter folder>/<title>`.
    pub default: PathBuf,
    /// The person's home directory, never a folder itself.
    pub home: PathBuf,
    /// Epicenter's own records (`<Epicenter folder>/so.epicenter`) and its
    /// application data and configuration directories: never a folder, never
    /// inside or around one.
    pub epicenter_own: Vec<PathBuf>,
}

impl Places {
    /// The places for `app` on this machine. The Epicenter folder is
    /// `~/Epicenter`, `~/Epicenter Dev` for a `.dev` build, or
    /// `EPICENTER_FOLDER_DIR` when set (ADR-0672's library root).
    pub fn resolve<R: Runtime>(handle: &AppHandle<R>, app: StandaloneApp) -> Result<Self, String> {
        let path = handle.path();
        let failed = |error: tauri::Error| error.to_string();
        let home = path.home_dir().map_err(failed)?;
        let library = match std::env::var_os("EPICENTER_FOLDER_DIR") {
            Some(root) if !root.is_empty() => PathBuf::from(root),
            _ if handle.config().identifier.ends_with(".dev") => home.join("Epicenter Dev"),
            _ => home.join("Epicenter"),
        };
        let mut epicenter_own = vec![library.join(RECORDS.id)];
        for base in [path.data_dir(), path.config_dir(), path.local_data_dir()] {
            let base = base.map_err(failed)?;
            epicenter_own.push(base.join("so.epicenter"));
            epicenter_own.push(base.join("so.epicenter.dev"));
        }
        Ok(Self {
            config: path.app_data_dir().map_err(failed)?,
            default: library.join(app.title),
            home,
            epicenter_own,
        })
    }

    /// Why `folder` cannot be the app's folder, in one line, or `None`.
    pub fn refusal(&self, folder: &Path) -> Option<String> {
        let shown = folder.display();
        if !folder.is_absolute() {
            return Some(format!("{shown} is not a full path to a folder."));
        }
        let candidate = resolved(folder);
        if candidate.parent().is_none() {
            return Some(format!(
                "{shown} is the top of a disk; choose a folder inside it."
            ));
        }
        if candidate == resolved(&self.home) {
            return Some(format!(
                "{shown} is your home folder; choose a folder inside it."
            ));
        }
        if candidate
            .components()
            .any(|part| part.as_os_str() == ".git")
        {
            return Some(format!(
                "{shown} is inside a Git repository's own .git folder."
            ));
        }
        for own in &self.epicenter_own {
            let own = resolved(own);
            if candidate.starts_with(&own) || own.starts_with(&candidate) {
                return Some(format!(
                    "{shown} holds Epicenter's own records or settings."
                ));
            }
        }
        let config = resolved(&self.config);
        if config.starts_with(&candidate) {
            return Some(format!("{shown} holds this app's own settings."));
        }
        None
    }

    /// The data root for `folder`, or the default for `None`. The default is
    /// created when missing; a chosen folder is opened as it is, never
    /// created again (an unplugged drive stays unplugged) and never moved.
    pub fn data_root(&self, folder: Option<&Path>) -> Result<Directory, DataFolderRefusal> {
        let (folder, create) = match folder {
            Some(folder) => (folder, false),
            None => (self.default.as_path(), true),
        };
        if let Some(message) = self.refusal(folder) {
            return Err(DataFolderRefusal::Refused { message });
        }
        if create {
            return Directory::create(folder).map_err(|error| DataFolderRefusal::Unavailable {
                message: format!("{} could not be made: {error}", folder.display()),
            });
        }
        Directory::existing(folder).map_err(|_| DataFolderRefusal::Missing {
            message: format!("{} is missing.", folder.display()),
        })
    }
}

/// Why a data folder was not opened, as the page's recovery screen says it.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum DataFolderRefusal {
    /// Never a data folder (`Places::refusal`), in one line.
    Refused { message: String },
    /// The chosen folder is not there (deleted, or on a drive not plugged in).
    Missing { message: String },
    /// It could not be made or given to the window.
    Unavailable { message: String },
}

/// Builder with the folder plugin, the dialog plugin, setup that opens the
/// app's window, and (macOS) guarded Quit. Add app-specific plugins and
/// commands, then call `.run(tauri::generate_context!())`.
pub fn builder(app: StandaloneApp) -> tauri::Builder<tauri::Wry> {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_epicenter_folder::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(app)
        // Tauri appends window-event handlers, so an app's own cannot replace this rule.
        .on_window_event(move |window, event| {
            if !matches!(event, WindowEvent::Destroyed) {
                return;
            }
            let handle = window.app_handle();
            for label in auxiliary_windows(
                app.page,
                window.label(),
                handle.webview_windows().keys().map(String::as_str),
            ) {
                if let Some(auxiliary) = handle.get_webview_window(&label) {
                    let _ = auxiliary.destroy();
                }
            }
        })
        .setup(move |application| {
            let handle = application.handle().clone();
            let started = Places::resolve(&handle, app).and_then(|places| {
                handle.manage(places.clone());
                start(&handle, app, &places).map(|_| ())
            });
            if let Err(error) = started {
                quit_with(&handle, app, error);
            }
            Ok(())
        });
    // AppKit's predefined Quit terminates without asking the page. Request
    // the ordinary guarded window close instead.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(quit_menu).on_menu_event(move |handle, event| {
        if event.id().as_ref() == "quit" {
            request_quit(handle, app);
        }
    });
    builder
}

/// Open the window bound to the AppData root alone; the page asks for its
/// data root (`commands::open_data_folder`).
fn start<R: Runtime>(
    handle: &AppHandle<R>,
    app: StandaloneApp,
    places: &Places,
) -> Result<WebviewWindow<R>, String> {
    let config = Directory::create(&places.config).map_err(|error| {
        format!(
            "{} could not keep its settings in {}: {error}",
            app.title,
            places.config.display()
        )
    })?;
    let script = folders_script(places, &config);
    // Keep WebView runtime files outside both roots.
    let webview_data = handle
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("webview");
    let (width, height) = app.size;
    handle
        .open_folder_window_granting(
            app.page,
            config,
            Vec::new(),
            WebviewUrl::default(),
            move |builder| {
                Ok(builder
                    .title(app.title)
                    .inner_size(width, height)
                    .min_inner_size(400.0, 400.0)
                    .data_directory(webview_data)
                    .initialization_script(&script))
            },
        )
        .map_err(|error| error.to_string())
}

/// What the page reads as `appFolders()` before any of its code runs.
fn folders_script(places: &Places, config: &Directory) -> String {
    let folders = serde_json::json!({
        "config": config.root(),
        "default": places.default,
    });
    format!("window.__EPICENTER_APP_FOLDERS__ = Object.freeze({folders});")
}

/// Make `folder` (or the default, for `None`) the window's watched data root,
/// the AppData root granted beside it, and answer the root's path.
pub(crate) fn open_data<R: Runtime>(
    handle: &AppHandle<R>,
    places: &Places,
    label: &str,
    folder: Option<&Path>,
) -> Result<PathBuf, DataFolderRefusal> {
    let data = places.data_root(folder)?;
    let unavailable = |message: String| DataFolderRefusal::Unavailable { message };
    let config = Directory::existing(&places.config)
        .map_err(|error| unavailable(format!("{}: {error}", places.config.display())))?;
    let root = data.root().to_path_buf();
    handle
        .folders()
        .rebind(label, data, vec![config])
        .map_err(|error| unavailable(error.to_string()))?;
    Ok(root)
}

/// Name the failure and offer only Quit: no other folder is opened instead.
fn quit_with<R: Runtime>(handle: &AppHandle<R>, app: StandaloneApp, message: String) {
    let exit = handle.clone();
    handle
        .dialog()
        .message(message)
        .title(format!("{} could not start", app.title))
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCustom("Quit".into()))
        .show(move |_| exit.exit(1));
}

/// Commands an app registers itself, since `invoke_handler` takes one list:
/// `tauri::generate_handler![epicenter_standalone::commands::open_data_folder,
/// epicenter_standalone::commands::choose_data_folder]`, granted by
/// `allow-open-data-folder` and `allow-choose-data-folder`, which the app's
/// `build.rs` declares (`COMMANDS`).
pub mod commands {
    use std::path::{Path, PathBuf};

    use tauri::{AppHandle, Manager, Runtime};
    use tauri_plugin_dialog::DialogExt;
    use tauri_plugin_epicenter_folder::FolderExt;

    use super::{open_data, DataFolderRefusal, Places, StandaloneApp};

    /// Open the data root: `folder` as the page read it from `settings.md`,
    /// or the default folder for `null` (created when missing). Answers the
    /// root's path, which the page opens its data device at, or why not. The
    /// page waits for its saves before moving an open window.
    #[tauri::command]
    pub async fn open_data_folder<R: Runtime>(
        app: AppHandle<R>,
        window: tauri::WebviewWindow<R>,
        folder: Option<String>,
    ) -> Result<String, DataFolderRefusal> {
        tauri::async_runtime::spawn_blocking(move || {
            let places = app.state::<Places>().inner().clone();
            open_data(
                &app,
                &places,
                window.label(),
                folder.as_deref().map(Path::new),
            )
            .map(|root| root.to_string_lossy().into_owned())
        })
        .await
        .map_err(|error| DataFolderRefusal::Unavailable {
            message: error.to_string(),
        })?
    }

    /// "Choose data folder…": the native picker, starting at the window's
    /// data root. Answers the folder picked, or `null` when the person
    /// cancels; it opens nothing (`open_data_folder` does).
    #[tauri::command]
    pub async fn choose_data_folder<R: Runtime>(
        app: AppHandle<R>,
        window: tauri::WebviewWindow<R>,
    ) -> Result<Option<String>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            let standalone = *app.state::<StandaloneApp>();
            let places = app.state::<Places>();
            let start: PathBuf = app
                .folders()
                .bound(window.label())
                .map(|directory| directory.root().to_path_buf())
                .unwrap_or_else(|_| places.home.clone());
            let picked = app
                .dialog()
                .file()
                .set_title(format!("Choose {}'s data folder", standalone.title))
                .set_directory(start)
                .set_can_create_directories(true)
                .blocking_pick_folder();
            Ok(picked
                .and_then(|path| path.into_path().ok())
                .map(|path| path.to_string_lossy().into_owned()))
        })
        .await
        .map_err(|error| error.to_string())?
    }
}

/// Every command `commands` gives a window, as its `build.rs` declares them.
pub const COMMANDS: &[&str] = &["open_data_folder", "choose_data_folder"];

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn request_quit<R: Runtime>(handle: &AppHandle<R>, app: StandaloneApp) {
    let windows = handle.webview_windows();
    let Some(label) = primary_label(app.page, windows.keys().map(String::as_str)) else {
        handle.exit(0);
        return;
    };
    if let Err(error) = windows[label].close() {
        handle
            .dialog()
            .message(format!("The window could not close. Try again.\n\n{error}"))
            .title(format!("{} stayed open", app.title))
            .kind(MessageDialogKind::Error)
            .show(|_| {});
    }
}

/// The primary is identified by the page prefix, regardless of map iteration order.
fn primary_label<'a>(page: &str, labels: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    let prefix = format!("{page}:");
    labels.into_iter().find(|label| label.starts_with(&prefix))
}

/// The windows to destroy with `destroyed`: when it is a primary, every
/// window that is not one. A primary that replaced it (a moved folder) stays.
fn auxiliary_windows<'a>(
    page: &str,
    destroyed: &str,
    labels: impl IntoIterator<Item = &'a str>,
) -> Vec<String> {
    if primary_label(page, [destroyed]).is_none() {
        return Vec::new();
    }
    labels
        .into_iter()
        .filter(|label| primary_label(page, [*label]).is_none())
        .map(str::to_owned)
        .collect()
}

#[cfg(target_os = "macos")]
fn quit_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, MenuItem};

    let menu = Menu::default(app)?;
    let application = menu
        .items()?
        .first()
        .and_then(|item| item.as_submenu())
        .cloned()
        .ok_or_else(|| std::io::Error::other("default application menu is missing"))?;
    let quit = application
        .items()?
        .last()
        .and_then(|item| item.as_predefined_menuitem())
        .cloned()
        .ok_or_else(|| std::io::Error::other("default Quit item is missing"))?;
    application.remove(&quit)?;
    application.append(&MenuItem::with_id(
        app,
        "quit",
        quit.text()?,
        true,
        Some("Cmd+Q"),
    )?)?;
    Ok(menu)
}

#[cfg(test)]
mod tests {
    //! The folder plugin's real commands on the mock runtime, as a page calls
    //! them over the roots startup and `open_data_folder` give its window, with
    //! a mock window standing in for the WebView. The native picker and the
    //! page are not driven here; what they lead to is.

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
        places: Places,
        base: PathBuf,
        _temp: tempfile::TempDir,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.app.folders().shutdown();
        }
    }

    impl Fixture {
        fn start(&self) -> WebviewWindow<MockRuntime> {
            start(self.app.handle(), NOTES, &self.places).unwrap()
        }

        fn open(
            &self,
            window: &WebviewWindow<MockRuntime>,
            folder: Option<&Path>,
        ) -> Result<PathBuf, DataFolderRefusal> {
            open_data(self.app.handle(), &self.places, window.label(), folder)
        }

        fn root(&self, window: &WebviewWindow<MockRuntime>) -> PathBuf {
            self.app
                .folders()
                .bound(window.label())
                .unwrap()
                .root()
                .to_path_buf()
        }
    }

    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(temp.path()).unwrap();
        let support = base.join("home/Library/Application Support");
        let places = Places {
            config: support.join("so.epicenter.notes"),
            default: base.join("home/Epicenter/Notes"),
            home: base.join("home"),
            epicenter_own: vec![
                base.join("home/Epicenter/so.epicenter"),
                support.join("so.epicenter"),
                support.join("so.epicenter.dev"),
            ],
        };
        fs::create_dir_all(&places.home).unwrap();
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
        Fixture {
            app,
            places,
            base,
            _temp: temp,
        }
    }

    /// The files a page lists at `root`, or the plugin's refusal.
    fn list(window: &WebviewWindow<MockRuntime>, root: &Path) -> Result<Vec<String>, Value> {
        tauri::test::get_ipc_response(
            window,
            InvokeRequest {
                cmd: "plugin:epicenter-folder|list_folder".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: InvokeBody::Json(json!({ "root": root })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize::<Value>().expect("a JSON response"))
        .map(|listing| {
            listing["files"]
                .as_array()
                .unwrap()
                .iter()
                .map(|file| file["path"].as_str().unwrap().to_owned())
                .collect()
        })
    }

    /// The window starts on its AppData root alone: no data folder is made
    /// or reached until the page asks, and no settings note is written.
    #[test]
    fn a_window_starts_on_its_app_data_root_alone() {
        let fixture = fixture();
        let window = fixture.start();
        assert!(window.label().starts_with("notes:"));
        assert_eq!(fixture.root(&window), fixture.places.config);
        assert_eq!(
            list(&window, &fixture.places.config).unwrap(),
            Vec::<String>::new()
        );
        assert!(!fixture.places.default.exists());
        assert!(list(&window, &fixture.places.home).is_err());
    }

    /// `null` opens the default folder, made when missing, as the window's
    /// watched root with the AppData root granted beside it; a second open
    /// finds what it holds.
    #[test]
    fn the_default_data_folder_is_made_and_opened() {
        let fixture = fixture();
        let window = fixture.start();
        assert_eq!(fixture.open(&window, None).unwrap(), fixture.places.default);
        assert!(fixture.places.default.is_dir());
        assert_eq!(fixture.root(&window), fixture.places.default);
        assert_eq!(
            list(&window, &fixture.places.config).unwrap(),
            Vec::<String>::new()
        );
        fs::write(fixture.places.default.join("a.md"), "---\n---\n").unwrap();
        fixture.open(&window, None).unwrap();
        assert_eq!(list(&window, &fixture.places.default).unwrap(), ["a.md"]);
        assert!(list(&window, &fixture.base).is_err());
    }

    /// A chosen folder opens with its files where they are; the previous data
    /// root is no longer reached, the AppData root still is.
    #[test]
    fn a_chosen_folder_opens_with_its_files_and_replaces_the_last() {
        let fixture = fixture();
        let window = fixture.start();
        fixture.open(&window, None).unwrap();
        let chosen = fixture.base.join("home/Documents/Notes");
        fs::create_dir_all(chosen.join("notes")).unwrap();
        fs::write(chosen.join("notes/b.md"), "---\n---\n").unwrap();
        assert_eq!(fixture.open(&window, Some(&chosen)).unwrap(), chosen);
        assert_eq!(fixture.root(&window), chosen);
        assert_eq!(list(&window, &chosen).unwrap(), ["notes/b.md"]);
        assert!(list(&window, &fixture.places.default).is_err());
        assert!(list(&window, &fixture.places.config).is_ok());
    }

    /// A chosen folder that is gone is not made again and nothing falls back
    /// to the default: the window keeps its roots and the page hears why.
    /// Once the folder is back, the same request (Retry) opens it.
    #[test]
    fn a_missing_or_refused_folder_is_not_opened_and_retry_finds_it_back() {
        let fixture = fixture();
        let window = fixture.start();
        let unplugged = fixture.base.join("unplugged/Notes");
        assert_eq!(
            fixture.open(&window, Some(&unplugged)).unwrap_err(),
            DataFolderRefusal::Missing {
                message: format!("{} is missing.", unplugged.display())
            }
        );
        assert!(!unplugged.exists());
        assert!(!fixture.places.default.exists());
        assert_eq!(fixture.root(&window), fixture.places.config);
        let refused = fixture
            .open(&window, Some(&fixture.places.home))
            .unwrap_err();
        assert!(
            matches!(refused, DataFolderRefusal::Refused { ref message } if message.contains("is your home folder"))
        );
        assert_eq!(serde_json::to_value(&refused).unwrap()["kind"], "refused");
        fs::create_dir_all(&unplugged).unwrap();
        assert_eq!(fixture.open(&window, Some(&unplugged)).unwrap(), unplugged);
    }

    #[test]
    fn unsafe_folders_are_refused_each_in_one_line() {
        let fixture = fixture();
        let places = &fixture.places;
        let home = &places.home;
        let repository = home.join("Code/app");
        fs::create_dir_all(repository.join(".git/objects")).unwrap();
        for (refused, why) in [
            (PathBuf::from("/"), "is the top of a disk"),
            (home.clone(), "is your home folder"),
            (
                home.join("Epicenter/so.epicenter"),
                "Epicenter's own records",
            ),
            (
                home.join("Epicenter/so.epicenter/connections"),
                "Epicenter's own records",
            ),
            (home.join("Epicenter"), "Epicenter's own records"),
            (
                home.join("Library/Application Support/so.epicenter.dev"),
                "Epicenter's own records",
            ),
            (
                home.join("Library/Application Support"),
                "Epicenter's own records",
            ),
            (places.config.clone(), "this app's own settings"),
            (repository.join(".git"), "own .git folder"),
            (repository.join(".git/objects"), "own .git folder"),
            (PathBuf::from("relative/Notes"), "not a full path"),
        ] {
            let refusal = places
                .refusal(&refused)
                .unwrap_or_else(|| panic!("{} should be refused", refused.display()));
            assert!(refusal.contains(why), "{refusal}");
            assert!(!refusal.contains('\n'), "{refusal}");
            assert!(matches!(
                places.data_root(Some(&refused)),
                Err(DataFolderRefusal::Refused { .. })
            ));
        }
        // The offered places, and an ordinary folder, a repository's working
        // tree included, are accepted.
        for accepted in [
            places.default.clone(),
            home.join("Documents/Notes"),
            repository.clone(),
        ] {
            assert_eq!(places.refusal(&accepted), None, "{}", accepted.display());
        }
    }

    #[test]
    fn the_page_is_told_its_roots_before_it_runs() {
        let fixture = fixture();
        let config = Directory::create(&fixture.places.config).unwrap();
        let script = folders_script(&fixture.places, &config);
        let json = script
            .strip_prefix("window.__EPICENTER_APP_FOLDERS__ = Object.freeze(")
            .and_then(|rest| rest.strip_suffix(");"))
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(json).unwrap(),
            json!({
                "config": fixture.places.config,
                "default": fixture.places.default,
            })
        );
    }

    #[test]
    fn quit_with_an_open_window_does_not_exit() {
        let fixture = fixture();
        let window = fixture.start();
        // MockRuntime's exit panics, so reaching the assertion proves Quit
        // took the open-window branch.
        request_quit(fixture.app.handle(), NOTES);
        assert!(fixture.app.folders().bound(window.label()).is_ok());
    }

    #[test]
    fn quit_selects_the_primary_after_an_auxiliary_and_exits_without_one() {
        assert_eq!(
            primary_label("notes", ["settings", "notes:folder"]),
            Some("notes:folder")
        );
        assert_eq!(primary_label("notes", ["settings", "todos:folder"]), None);
    }

    #[test]
    fn only_primary_destruction_destroys_auxiliaries_and_never_another_primary() {
        assert_eq!(
            auxiliary_windows("notes", "notes:a", ["settings", "notes:a", "notes:b"]),
            ["settings"]
        );
        assert!(auxiliary_windows("notes", "settings", ["notes:a"]).is_empty());
    }
}
