//! Standalone startup: one app, one folder it owns, one primary window
//! (decisions 81 and 82).
//!
//! The app keeps two roots. Its configuration directory (the operating
//! system's, for the app) holds `settings.md`, the machine-local `appConfig`
//! note the page reads and writes; its `folder` is where the app keeps the
//! person's files. Startup makes the configuration directory, reads `folder`
//! from `settings.md` (it never writes the note), and opens the window bound
//! to that folder with the configuration directory granted beside it, or to
//! the configuration directory alone when there is no folder yet, or the one
//! named is missing or refused. The page opens each root by its path,
//! `openDevice(appConfig, { path: config })` and
//! `openDevice(contract, { path: folder })` from `@epicenter/folder/tauri`;
//! the folder plugin refuses any other path.
//!
//! The page learns the roots before any of its code runs:
//! `window.__EPICENTER_APP_FOLDERS__` (`appFolders()` in
//! `@epicenter/folder/tauri`) names the configuration directory, the folder
//! or `null`, why a remembered folder was not opened, and the two places
//! offered on first run. With no folder the page asks where to keep the
//! files and calls `commands::choose_folder`, which resolves the answer,
//! refuses an unsafe folder with one line saying why (`Places::refusal`),
//! creates the folder or reuses it with its files, and replaces the window
//! with one bound to it; that page records it as `folder` in `settings.md`.
//! "Choose folder…" later is the same command.
//!
//! On macOS, the menu's Quit and Cmd-Q request the primary window's ordinary
//! close, so the page's leave guard answers. This crate installs no close,
//! destroy, or exit handler that waits. Auxiliary windows an app makes are
//! destroyed with the primary, never another primary.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_epicenter_folder::library::{resolved, RECORDS};
use tauri_plugin_epicenter_folder::{Directory, FolderExt};

#[derive(Clone, Copy, Debug)]
pub struct StandaloneApp {
    /// The window-label prefix its capability selects (`<page>:*`).
    pub page: &'static str,
    /// The app's name: its windows and messages, and its folder's name in
    /// the Epicenter folder (`~/Epicenter/<title>`).
    pub title: &'static str,
    /// The primary window's logical width and height.
    pub size: (f64, f64),
}

/// Where this app keeps its configuration, the places it offers for its
/// folder, and the folders it never accepts as one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Places {
    /// The app's configuration directory, which holds `settings.md`.
    pub config: PathBuf,
    /// The recommended folder: `<Epicenter folder>/<title>`.
    pub epicenter: PathBuf,
    /// The hidden one, in the app's data directory.
    pub app_data: PathBuf,
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
            config: path.app_config_dir().map_err(failed)?,
            epicenter: library.join(app.title),
            app_data: path.app_data_dir().map_err(failed)?.join(app.title),
            home,
            epicenter_own,
        })
    }

    /// The folder remembered in `settings.md`, if any.
    pub fn remembered(&self) -> Option<PathBuf> {
        let text = fs::read_to_string(self.config.join("settings.md")).ok()?;
        settings_folder(&text).map(PathBuf::from)
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

    /// `folder`, created when missing or reused with its files, unless it is
    /// refused. A file or a link at the path is refused too.
    pub fn admit(&self, folder: &Path) -> Result<Directory, String> {
        if let Some(refusal) = self.refusal(folder) {
            return Err(refusal);
        }
        Directory::create(folder)
            .map_err(|error| format!("{} could not be used: {error}", folder.display()))
    }

    /// The remembered `folder` as it is now, never created again: why not
    /// when it is missing or refused.
    fn reopen(&self, folder: &Path) -> Result<Directory, String> {
        if let Some(refusal) = self.refusal(folder) {
            return Err(refusal);
        }
        Directory::existing(folder)
            .map_err(|_| format!("Its folder, {}, is missing.", folder.display()))
    }
}

/// `folder` in the front matter of the settings note `text`: a JSON-quoted
/// string, as `appConfig`'s writer puts it, or a plain one.
fn settings_folder(text: &str) -> Option<String> {
    let front = text.strip_prefix("---\n")?;
    let front = &front[..front.find("\n---")?];
    let value = front
        .lines()
        .find_map(|line| line.strip_prefix("folder:"))?
        .trim();
    if value.starts_with('"') {
        serde_json::from_str(value).ok()
    } else {
        (!value.is_empty()).then(|| value.to_owned())
    }
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

/// Open the window on the remembered folder, or on the configuration
/// directory alone when there is none or it cannot be opened.
fn start<R: Runtime>(
    handle: &AppHandle<R>,
    app: StandaloneApp,
    places: &Places,
) -> Result<WebviewWindow<R>, String> {
    let (folder, problem) = match places.remembered() {
        None => (None, None),
        Some(remembered) => match places.reopen(&remembered) {
            Ok(folder) => (Some(folder), None),
            Err(problem) => (None, Some(problem)),
        },
    };
    open_window(handle, app, places, folder, problem)
}

/// The primary window: bound to `folder` with the configuration directory
/// granted beside it, or to the configuration directory alone, and told its
/// roots before its page runs.
fn open_window<R: Runtime>(
    handle: &AppHandle<R>,
    app: StandaloneApp,
    places: &Places,
    folder: Option<Directory>,
    problem: Option<String>,
) -> Result<WebviewWindow<R>, String> {
    let config = Directory::create(&places.config).map_err(|error| {
        format!(
            "{} could not keep its settings in {}: {error}",
            app.title,
            places.config.display()
        )
    })?;
    let script = folders_script(places, &config, folder.as_ref(), problem.as_deref());
    let (primary, grants) = match folder {
        Some(folder) => (folder, vec![config]),
        None => (config, Vec::new()),
    };
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
            primary,
            grants,
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
fn folders_script(
    places: &Places,
    config: &Directory,
    folder: Option<&Directory>,
    problem: Option<&str>,
) -> String {
    let folders = serde_json::json!({
        "config": config.root(),
        "folder": folder.map(Directory::root),
        "problem": problem,
        "places": { "epicenter": places.epicenter, "appData": places.app_data },
    });
    format!("window.__EPICENTER_APP_FOLDERS__ = Object.freeze({folders});")
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
/// `tauri::generate_handler![epicenter_standalone::commands::choose_folder]`,
/// granted by `allow-choose-folder`, which the app's `build.rs` declares.
pub mod commands {
    use std::path::{Path, PathBuf};

    use tauri::{AppHandle, Manager, Runtime};
    use tauri_plugin_dialog::DialogExt;
    use tauri_plugin_epicenter_folder::FolderExt;

    use super::{open_window, Places, StandaloneApp};

    /// Where the app keeps its files, as the person answered: the Epicenter
    /// folder (`"epicenter"`), the app data folder (`"app-data"`), or a
    /// folder picked natively (`"pick"`). The answer is admitted (or refused
    /// with one line saying why), created or reused, and a window bound to
    /// it replaces the calling one; that page records it in `settings.md`.
    /// `false` when the person cancels the picker. The page waits for its
    /// saves first.
    #[tauri::command]
    pub async fn choose_folder<R: Runtime>(
        app: AppHandle<R>,
        window: tauri::WebviewWindow<R>,
        place: String,
    ) -> Result<bool, String> {
        tauri::async_runtime::spawn_blocking(move || {
            let standalone = *app.state::<StandaloneApp>();
            let places = app.state::<Places>().inner().clone();
            let folder = match place.as_str() {
                "epicenter" => places.epicenter.clone(),
                "app-data" => places.app_data.clone(),
                "pick" => {
                    let start = app
                        .folders()
                        .bound(window.label())
                        .map(|directory| directory.root().to_path_buf())
                        .unwrap_or_else(|_| places.home.clone());
                    let picked = app
                        .dialog()
                        .file()
                        .set_title(format!("Choose where {} keeps its files", standalone.title))
                        .set_directory(start)
                        .set_can_create_directories(true)
                        .blocking_pick_folder();
                    match picked.and_then(|path| path.into_path().ok()) {
                        Some(folder) => folder,
                        None => return Ok(false),
                    }
                }
                other => return Err(format!("{other} is not a place to keep files.")),
            };
            move_to(&app, standalone, &places, &window, &folder).map(|_| true)
        })
        .await
        .map_err(|error| error.to_string())?
    }

    /// Admit `folder` and replace `window` with one bound to it, the
    /// configuration directory granted beside it. The same folder keeps the
    /// window as it is.
    pub(crate) fn move_to<R: Runtime>(
        app: &AppHandle<R>,
        standalone: StandaloneApp,
        places: &Places,
        window: &tauri::WebviewWindow<R>,
        folder: &Path,
    ) -> Result<PathBuf, String> {
        let directory = places.admit(folder)?;
        let root = directory.root().to_path_buf();
        let next = open_window(app, standalone, places, Some(directory), None)?;
        if next.label() != window.label() {
            window.destroy().map_err(|error| error.to_string())?;
        }
        Ok(root)
    }
}

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
    //! them over the roots startup and "Choose folder…" give its window, with
    //! a mock window standing in for the WebView. The native picker and the
    //! page are not driven here; what they lead to is.

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

        fn remember(&self, folder: &str) {
            fs::create_dir_all(&self.places.config).unwrap();
            fs::write(
                self.places.config.join("settings.md"),
                format!("---\nfolder: {}\ntheme: dark\n---\n", Value::from(folder)),
            )
            .unwrap();
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
            epicenter: base.join("home/Epicenter/Notes"),
            app_data: support.join("so.epicenter.notes/Notes"),
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

    #[test]
    fn a_first_run_window_reaches_only_its_configuration() {
        let fixture = fixture();
        let window = fixture.start();
        assert!(window.label().starts_with("notes:"));
        assert_eq!(fixture.root(&window), fixture.places.config);
        assert_eq!(
            list(&window, &fixture.places.config).unwrap(),
            Vec::<String>::new()
        );
        // No folder is made before the person answers.
        assert!(!fixture.places.epicenter.exists());
        assert!(list(&window, &fixture.places.home).is_err());
    }

    /// The remembered folder opens with the configuration granted beside it;
    /// the page reaches both by path and nothing else.
    #[test]
    fn a_remembered_folder_opens_with_its_configuration_beside_it() {
        let fixture = fixture();
        let folder = fixture.base.join("home/Documents/Notes");
        fs::create_dir_all(folder.join("notes")).unwrap();
        fs::write(folder.join("notes/a.md"), "---\n---\n").unwrap();
        fixture.remember(folder.to_str().unwrap());
        let window = fixture.start();
        assert_eq!(fixture.root(&window), folder);
        assert_eq!(list(&window, &folder).unwrap(), ["notes/a.md"]);
        assert_eq!(
            list(&window, &fixture.places.config).unwrap(),
            ["settings.md"]
        );
        assert!(list(&window, &fixture.base).is_err());
        // Startup read the note and wrote nothing.
        assert!(
            fs::read_to_string(fixture.places.config.join("settings.md"))
                .unwrap()
                .contains("theme: dark")
        );
    }

    /// A remembered folder that is gone is not made again, and one that is
    /// refused is not opened: the page is told why and asks again.
    #[test]
    fn a_missing_or_refused_remembered_folder_is_not_opened() {
        let fixture = fixture();
        let gone = fixture.base.join("unplugged/Notes");
        fixture.remember(gone.to_str().unwrap());
        assert_eq!(
            fixture.places.reopen(&gone).unwrap_err(),
            format!("Its folder, {}, is missing.", gone.display())
        );
        let window = fixture.start();
        assert_eq!(fixture.root(&window), fixture.places.config);
        assert!(!gone.exists());

        let refusing = self::fixture();
        refusing.remember(refusing.places.home.to_str().unwrap());
        assert!(refusing
            .places
            .reopen(&refusing.places.home)
            .unwrap_err()
            .contains("is your home folder"));
        assert_eq!(refusing.root(&refusing.start()), refusing.places.config);
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
            assert!(places.admit(&refused).is_err());
        }
        // The offered places, and an ordinary folder, a repository's working
        // tree included, are accepted.
        for accepted in [
            places.epicenter.clone(),
            places.app_data.clone(),
            home.join("Documents/Notes"),
            repository.clone(),
        ] {
            assert_eq!(places.refusal(&accepted), None, "{}", accepted.display());
        }
    }

    /// The person's answer becomes a new window bound to it, the
    /// configuration granted beside it, and the first-run window closes. A
    /// refused answer changes nothing.
    #[test]
    fn choosing_a_folder_moves_the_app_there() {
        let fixture = fixture();
        let first = fixture.start();
        let refused = commands::move_to(
            fixture.app.handle(),
            NOTES,
            &fixture.places,
            &first,
            &fixture.places.home,
        );
        assert!(refused.unwrap_err().contains("is your home folder"));
        assert_eq!(fixture.app.webview_windows().len(), 1);

        let chosen = commands::move_to(
            fixture.app.handle(),
            NOTES,
            &fixture.places,
            &first,
            &fixture.places.epicenter,
        )
        .unwrap();
        assert_eq!(chosen, fixture.places.epicenter);
        assert!(fixture.places.epicenter.is_dir());
        let windows = fixture.app.webview_windows();
        let moved = windows
            .values()
            .find(|window| window.label() != first.label())
            .expect("a window bound to the chosen folder");
        assert_eq!(fixture.root(moved), fixture.places.epicenter);
        assert_eq!(
            list(moved, &fixture.places.config).unwrap(),
            Vec::<String>::new()
        );
        // The same folder again keeps the window.
        commands::move_to(
            fixture.app.handle(),
            NOTES,
            &fixture.places,
            moved,
            &fixture.places.epicenter,
        )
        .unwrap();
        assert!(fixture.app.get_webview_window(moved.label()).is_some());
    }

    #[test]
    fn the_page_is_told_its_roots_before_it_runs() {
        let fixture = fixture();
        let config = Directory::create(&fixture.places.config).unwrap();
        let script = folders_script(
            &fixture.places,
            &config,
            None,
            Some("Its folder is missing."),
        );
        let json = script
            .strip_prefix("window.__EPICENTER_APP_FOLDERS__ = Object.freeze(")
            .and_then(|rest| rest.strip_suffix(");"))
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(json).unwrap(),
            json!({
                "config": fixture.places.config,
                "folder": null,
                "problem": "Its folder is missing.",
                "places": {
                    "epicenter": fixture.places.epicenter,
                    "appData": fixture.places.app_data,
                },
            })
        );
    }

    #[test]
    fn the_settings_note_is_read_as_its_writer_writes_it() {
        assert_eq!(
            settings_folder("---\nfolder: \"/a \\\"b\\\"\"\ntheme: dark\n---\n").as_deref(),
            Some("/a \"b\"")
        );
        assert_eq!(
            settings_folder("---\nfolder: /plain/path\n---\n").as_deref(),
            Some("/plain/path")
        );
        assert_eq!(settings_folder("---\ntheme: dark\n---\n"), None);
        assert_eq!(settings_folder("no front matter"), None);
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
