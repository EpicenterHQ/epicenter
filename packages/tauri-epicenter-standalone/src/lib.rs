//! Standalone startup: one app, one folder it owns, one primary window
//! (decision 81).
//!
//! On first run the app asks where to keep its files: the Epicenter folder
//! `~/Epicenter/<Title>` (recommended, visible), its data folder (hidden), or
//! a folder the person picks. It creates the folder, or reuses one already
//! there with its files, and keeps the path as `folder` in `settings.md`, the
//! app's machine-local configuration note in the operating system's
//! configuration directory for the app (`appConfig` in `@epicenter/folder`,
//! decision 82), never in the folder. Later launches open that folder; a
//! folder that has gone missing is asked about again. The page can ask to
//! choose another folder (`commands::choose_folder`).
//!
//! The folder is bound to the window before its WebView exists, so the page
//! opens it with `openDevice(contract)` from `@epicenter/folder/tauri` and
//! never names a path. Nothing here syncs: Epicenter does, once the page asks
//! it to (`syncWithEpicenter({ path, contract })`, with the path from
//! `commands::folder_path`).
//!
//! On macOS, the menu's Quit and Cmd-Q request the primary window's ordinary
//! close, so the page's leave guard answers. This crate installs no close,
//! destroy, or exit handler that waits. Auxiliary windows an app makes are
//! destroyed with the primary.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};
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

/// Where this app may keep its folder, and where it remembers its choice.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Places {
    /// The recommended folder: `<Epicenter folder>/<title>`.
    pub epicenter: PathBuf,
    /// The hidden one, in the app's data directory.
    pub app_data: PathBuf,
    /// `settings.md`, the app's configuration note (`appConfig`), in its
    /// configuration directory.
    pub settings: PathBuf,
}

impl Places {
    /// The places for `app` on this machine. The Epicenter folder is
    /// `~/Epicenter`, `~/Epicenter Dev` for a `.dev` build, or
    /// `EPICENTER_FOLDER_DIR` when set (ADR-0672's library root).
    pub fn resolve<R: Runtime>(handle: &AppHandle<R>, app: StandaloneApp) -> Result<Self, String> {
        let path = handle.path();
        let failed = |error: tauri::Error| error.to_string();
        let library = match std::env::var_os("EPICENTER_FOLDER_DIR") {
            Some(root) if !root.is_empty() => PathBuf::from(root),
            _ => {
                let dev = handle.config().identifier.ends_with(".dev");
                path.home_dir().map_err(failed)?.join(if dev {
                    "Epicenter Dev"
                } else {
                    "Epicenter"
                })
            }
        };
        Ok(Self {
            epicenter: library.join(app.title),
            app_data: path.app_data_dir().map_err(failed)?.join(app.title),
            settings: path.app_config_dir().map_err(failed)?.join("settings.md"),
        })
    }

    /// The folder chosen before: `folder` in `settings.md`, if any.
    pub fn chosen(&self) -> Option<PathBuf> {
        let text = fs::read_to_string(&self.settings).ok()?;
        settings_folder(&text).map(PathBuf::from)
    }

    /// Create `folder`, or reuse it with its files, then remember it as
    /// `folder` in `settings.md`, keeping every other setting. A file or a
    /// link at the path is refused and nothing is remembered.
    pub fn adopt(&self, folder: &Path) -> Result<Directory, String> {
        let directory = Directory::create(folder)
            .map_err(|error| format!("{} could not be used: {error}", folder.display()))?;
        let root = directory
            .root()
            .to_str()
            .ok_or_else(|| format!("{} cannot be written down.", folder.display()))?;
        if let Some(parent) = self.settings.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let before = fs::read_to_string(&self.settings).unwrap_or_default();
        fs::write(&self.settings, with_settings_folder(&before, root))
            .map_err(|error| format!("Where the folder is could not be remembered: {error}"))?;
        Ok(directory)
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

/// The settings note `text` with `folder` set to `root`, written as
/// `appConfig`'s writer writes it; every other line, the body included, is
/// kept. A note that does not start with front matter is replaced.
fn with_settings_folder(text: &str, root: &str) -> String {
    let line = format!("folder: {}", serde_json::Value::from(root));
    let Some(front) = text.strip_prefix("---\n") else {
        return format!("---\n{line}\n---\n");
    };
    let Some(end) = front.find("\n---") else {
        return format!("---\n{line}\n---\n");
    };
    let (front, rest) = front.split_at(end);
    let mut lines: Vec<String> = front
        .lines()
        .filter(|existing| !existing.starts_with("folder:"))
        .map(str::to_owned)
        .collect();
    lines.insert(0, line);
    format!("---\n{}{rest}", lines.join("\n"))
}

/// Builder with the folder plugin, the dialog plugin, setup that opens the
/// app's folder (asking first when there is none), and (macOS) guarded Quit.
/// Add app-specific plugins and commands, then call
/// `.run(tauri::generate_context!())`.
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
            match Places::resolve(&handle, app) {
                Ok(places) => {
                    handle.manage(places.clone());
                    start(handle, app, places);
                }
                Err(error) => quit_with(&handle, app, error),
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

/// Open the chosen folder, or ask for one when none was chosen or the one
/// chosen is gone.
fn start<R: Runtime>(handle: AppHandle<R>, app: StandaloneApp, places: Places) {
    let note = match places.chosen() {
        Some(folder) if folder.is_dir() => match places.adopt(&folder) {
            Ok(directory) => return open_or_quit(&handle, app, directory),
            Err(error) => Some(error),
        },
        Some(folder) => Some(format!("Its folder, {}, is missing.", folder.display())),
        None => None,
    };
    ask(handle, app, places, note);
}

/// The first-run question, as a native dialog: Epicenter folder, app data
/// folder, or a folder the person picks. Cancelling the picker asks again.
fn ask<R: Runtime>(handle: AppHandle<R>, app: StandaloneApp, places: Places, note: Option<String>) {
    let mut message = format!(
        "The Epicenter folder keeps them at {} (recommended: you can see them in your files).\n\nThe app data folder keeps them hidden, at {}.\n\nYou can choose another folder later.",
        places.epicenter.display(),
        places.app_data.display()
    );
    if let Some(note) = note {
        message = format!("{note}\n\n{message}");
    }
    let dialog = handle.clone();
    handle
        .dialog()
        .message(message)
        .title(format!("Where should {} keep its files?", app.title))
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            EPICENTER_FOLDER.into(),
            APP_DATA_FOLDER.into(),
            CHOOSE_FOLDER.into(),
        ))
        .show_with_result(move |answer| match place(&answer, &places) {
            Some(folder) => settle(dialog, app, places, folder),
            None => {
                let picker = dialog.clone();
                dialog
                    .dialog()
                    .file()
                    .set_title(format!("Choose where {} keeps its files", app.title))
                    .set_can_create_directories(true)
                    .pick_folder(move |picked| {
                        match picked.and_then(|path| path.into_path().ok()) {
                            Some(folder) => settle(picker, app, places, folder),
                            None => ask(picker, app, places, None),
                        }
                    });
            }
        });
}

const EPICENTER_FOLDER: &str = "Epicenter folder";
const APP_DATA_FOLDER: &str = "App data folder";
const CHOOSE_FOLDER: &str = "Choose folder…";

/// The folder an answer names, or `None` for "Choose folder…" (and for a
/// dialog closed without an answer, which then opens the picker).
fn place(answer: &MessageDialogResult, places: &Places) -> Option<PathBuf> {
    match answer {
        MessageDialogResult::Yes => Some(places.epicenter.clone()),
        MessageDialogResult::No => Some(places.app_data.clone()),
        MessageDialogResult::Custom(label) if label == EPICENTER_FOLDER => {
            Some(places.epicenter.clone())
        }
        MessageDialogResult::Custom(label) if label == APP_DATA_FOLDER => {
            Some(places.app_data.clone())
        }
        _ => None,
    }
}

/// Adopt the answer and open it, or say why not and ask again.
fn settle<R: Runtime>(handle: AppHandle<R>, app: StandaloneApp, places: Places, folder: PathBuf) {
    match places.adopt(&folder) {
        Ok(directory) => open_or_quit(&handle, app, directory),
        Err(error) => ask(handle, app, places, Some(error)),
    }
}

fn open_or_quit<R: Runtime>(handle: &AppHandle<R>, app: StandaloneApp, directory: Directory) {
    if let Err(error) = open_window(handle, app, directory) {
        quit_with(handle, app, error);
    }
}

/// The primary window, bound to `directory` before its WebView exists.
fn open_window<R: Runtime>(
    handle: &AppHandle<R>,
    app: StandaloneApp,
    directory: Directory,
) -> Result<WebviewWindow<R>, String> {
    // Keep WebView runtime files outside the folder.
    let webview_data = handle
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("webview");
    let (width, height) = app.size;
    handle
        .open_folder_window(app.page, directory, WebviewUrl::default(), move |builder| {
            Ok(builder
                .title(app.title)
                .inner_size(width, height)
                .min_inner_size(400.0, 400.0)
                .data_directory(webview_data))
        })
        .map_err(|error| error.to_string())
}

/// Name the failure and offer only Quit: no other folder is opened instead.
fn quit_with<R: Runtime>(handle: &AppHandle<R>, app: StandaloneApp, message: String) {
    let exit = handle.clone();
    handle
        .dialog()
        .message(message)
        .title(format!("{} could not open its folder", app.title))
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCustom("Quit".into()))
        .show(move |_| exit.exit(1));
}

/// Commands an app registers itself, since `invoke_handler` takes one list:
/// `tauri::generate_handler![epicenter_standalone::commands::choose_folder,
/// epicenter_standalone::commands::folder_path]`, granted by
/// `allow-choose-folder` and `allow-folder-path`, which the app's `build.rs`
/// declares.
pub mod commands {
    use tauri::{AppHandle, Manager, Runtime};
    use tauri_plugin_dialog::DialogExt;
    use tauri_plugin_epicenter_folder::FolderExt;

    use super::{open_window, Places, StandaloneApp};

    /// The folder the calling window keeps its files in, as an absolute path:
    /// what the page passes to `syncWithEpicenter({ path, contract })`.
    #[tauri::command]
    pub fn folder_path<R: Runtime>(
        app: AppHandle<R>,
        window: tauri::WebviewWindow<R>,
    ) -> Result<String, String> {
        let directory = app
            .folders()
            .bound(window.label())
            .map_err(|error| error.to_string())?;
        directory
            .root()
            .to_str()
            .map(str::to_owned)
            .ok_or_else(|| "This folder's path cannot be read as text.".into())
    }

    /// "Choose folder…" from the page: pick a folder, adopt it, and move the
    /// app there: a new window bound to it replaces the calling one. Answers
    /// `false` when the person cancels. The page waits for its saves first.
    #[tauri::command]
    pub async fn choose_folder<R: Runtime>(
        app: AppHandle<R>,
        window: tauri::WebviewWindow<R>,
    ) -> Result<bool, String> {
        let standalone = *app.state::<StandaloneApp>();
        let places = app.state::<Places>().inner().clone();
        let current = app
            .folders()
            .bound(window.label())
            .map_err(|error| error.to_string())?;
        let picked = app
            .dialog()
            .file()
            .set_title(format!("Choose where {} keeps its files", standalone.title))
            .set_directory(current.root())
            .set_can_create_directories(true)
            .blocking_pick_folder();
        let Some(folder) = picked.and_then(|path| path.into_path().ok()) else {
            return Ok(false);
        };
        move_to(&app, standalone, &places, &window, &folder)?;
        Ok(true)
    }

    /// Adopt `folder` and swap `window` for one bound to it. The same folder
    /// keeps the window as it is.
    pub(crate) fn move_to<R: Runtime>(
        app: &AppHandle<R>,
        standalone: StandaloneApp,
        places: &Places,
        window: &tauri::WebviewWindow<R>,
        folder: &std::path::Path,
    ) -> Result<(), String> {
        let directory = places.adopt(folder)?;
        let next = open_window(app, standalone, directory)?;
        if next.label() != window.label() {
            window.destroy().map_err(|error| error.to_string())?;
        }
        Ok(())
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
    //! them when it opens its folder, with a mock window standing in for the
    //! WebView. The native dialogs are not driven here; what they lead to is.

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
        /// What a launch with a folder already chosen does.
        fn launch(&self) -> WebviewWindow<MockRuntime> {
            let folder = self.places.chosen().expect("a chosen folder");
            open_window(
                self.app.handle(),
                NOTES,
                self.places.adopt(&folder).unwrap(),
            )
            .unwrap()
        }
    }

    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(temp.path()).unwrap();
        let places = Places {
            epicenter: base.join("home/Epicenter/Notes"),
            app_data: base.join("support/so.epicenter.notes/Notes"),
            settings: base.join("support/so.epicenter.notes/settings.md"),
        };
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

    fn invoke(window: &WebviewWindow<MockRuntime>, command: &str) -> Result<Value, Value> {
        let args = if command == "open_folder" {
            let channel = tauri::ipc::Channel::<tauri_plugin_epicenter_folder::FolderChanged>::new(
                |_: tauri::ipc::InvokeResponseBody| Ok(()),
            );
            json!({ "onChange": channel })
        } else {
            json!({ "directory": "notes" })
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

    fn entries(directory: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn the_first_run_answers_name_the_epicenter_folder_the_data_folder_or_the_picker() {
        let places = fixture().places.clone();
        for (answer, folder) in [
            (MessageDialogResult::Yes, Some(&places.epicenter)),
            (
                MessageDialogResult::Custom(EPICENTER_FOLDER.into()),
                Some(&places.epicenter),
            ),
            (MessageDialogResult::No, Some(&places.app_data)),
            (
                MessageDialogResult::Custom(APP_DATA_FOLDER.into()),
                Some(&places.app_data),
            ),
            (MessageDialogResult::Cancel, None),
            (MessageDialogResult::Custom(CHOOSE_FOLDER.into()), None),
        ] {
            assert_eq!(place(&answer, &places).as_ref(), folder, "{answer:?}");
        }
    }

    /// Nothing is remembered before an answer. Adopting makes the folder,
    /// with no marker file in it, and remembers it outside it; the next
    /// launch opens it without asking, and the page finds its files.
    #[test]
    fn an_adopted_folder_is_made_remembered_outside_it_and_reopened() {
        let fixture = fixture();
        assert_eq!(fixture.places.chosen(), None);
        fixture.places.adopt(&fixture.places.epicenter).unwrap();
        assert!(entries(&fixture.places.epicenter).is_empty());
        assert_eq!(
            fixture.places.chosen(),
            Some(fixture.places.epicenter.clone())
        );
        assert!(!fixture
            .places
            .settings
            .starts_with(&fixture.places.epicenter));
        // `appConfig`'s note, exactly as its TypeScript writer writes it.
        assert_eq!(
            fs::read_to_string(&fixture.places.settings).unwrap(),
            format!(
                "---\nfolder: {}\n---\n",
                serde_json::Value::from(fixture.places.epicenter.to_str().unwrap())
            )
        );

        let window = fixture.launch();
        assert!(window.label().starts_with("notes:"));
        fs::create_dir(fixture.places.epicenter.join("notes")).unwrap();
        fs::write(fixture.places.epicenter.join("notes/a.md"), "---\n---\n").unwrap();
        invoke(&window, "open_folder").unwrap();
        assert_eq!(
            invoke(&window, "read_folder_children").unwrap()["files"],
            json!(["a.md"])
        );
    }

    #[test]
    fn an_existing_folder_is_reused_with_its_files_and_a_file_is_refused() {
        let fixture = fixture();
        let existing = fixture.base.join("Documents/My notes");
        fs::create_dir_all(existing.join("notes")).unwrap();
        fs::write(existing.join("notes/kept.md"), "keep").unwrap();
        fixture.places.adopt(&existing).unwrap();
        assert_eq!(entries(&existing.join("notes")), ["kept.md"]);
        assert_eq!(fixture.places.chosen(), Some(existing.clone()));

        let file = fixture.base.join("a-file");
        fs::write(&file, "keep").unwrap();
        assert!(fixture.places.adopt(&file).is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "keep");
        // The earlier choice stands.
        assert_eq!(fixture.places.chosen(), Some(existing));
    }

    /// A folder removed while the app is open is refused to the page, which
    /// keeps its binding; the next launch finds it missing and asks again.
    #[test]
    fn a_removed_folder_is_refused_to_the_page() {
        let fixture = fixture();
        fixture.places.adopt(&fixture.places.app_data).unwrap();
        let window = fixture.launch();
        fs::remove_dir(&fixture.places.app_data).unwrap();
        assert_eq!(
            invoke(&window, "open_folder").unwrap_err(),
            json!({ "name": "Missing" })
        );
        let chosen = fixture.places.chosen().unwrap();
        assert!(!chosen.is_dir(), "start() asks again for a missing folder");
    }

    /// Choosing another folder binds a new window to it and destroys the old
    /// one; the choice is remembered. Choosing the same folder keeps the window.
    #[test]
    fn choosing_another_folder_moves_the_window_there() {
        let fixture = fixture();
        fixture.places.adopt(&fixture.places.epicenter).unwrap();
        let window = fixture.launch();
        let elsewhere = fixture.base.join("Elsewhere");
        commands::move_to(
            fixture.app.handle(),
            NOTES,
            &fixture.places,
            &window,
            &elsewhere,
        )
        .unwrap();
        assert_eq!(fixture.places.chosen(), Some(elsewhere.clone()));
        let windows = fixture.app.webview_windows();
        let moved = windows
            .values()
            .find(|next| next.label() != window.label())
            .expect("a window bound to the new folder");
        assert_eq!(
            fixture.app.folders().bound(moved.label()).unwrap().root(),
            elsewhere
        );
        commands::move_to(
            fixture.app.handle(),
            NOTES,
            &fixture.places,
            moved,
            &elsewhere,
        )
        .unwrap();
        assert!(fixture.app.get_webview_window(moved.label()).is_some());
    }

    /// Choosing another folder rewrites `folder` and keeps every other
    /// machine setting and the note's body; a plain or quoted value reads.
    #[test]
    fn the_settings_note_keeps_its_other_settings() {
        let before = "---\ntheme: dark\nfolder: \"/old\"\nshortcut: \"Alt+Space\"\n---\n\nNotes.\n";
        let after = with_settings_folder(before, "/new \"place\"");
        assert_eq!(
            after,
            "---\nfolder: \"/new \\\"place\\\"\"\ntheme: dark\nshortcut: \"Alt+Space\"\n---\n\nNotes.\n"
        );
        assert_eq!(settings_folder(&after).as_deref(), Some("/new \"place\""));
        assert_eq!(
            settings_folder("---\nfolder: /plain/path\n---\n").as_deref(),
            Some("/plain/path")
        );
        assert_eq!(settings_folder("---\ntheme: dark\n---\n"), None);
        assert_eq!(settings_folder("no front matter"), None);
        assert_eq!(
            with_settings_folder("not a note", "/x"),
            "---\nfolder: \"/x\"\n---\n"
        );
    }

    #[test]
    fn quit_with_an_open_window_does_not_exit() {
        let fixture = fixture();
        fixture.places.adopt(&fixture.places.epicenter).unwrap();
        let window = fixture.launch();
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
