//! Standalone startup: one app, two roots, one primary window (decisions 88
//! to 97).
//!
//! An installed app keeps two roots. Its **AppData root** is fixed: the
//! operating system's application data directory for the app, one per
//! installation, never synced and never chosen. Its settings notes sit at its
//! top (`settings.md`, `shortcuts.md`), as the same notes sit at the top of
//! the data root. Its **data root** is the person's files:
//! `~/Epicenter/<productName>` by default (`~/Epicenter/<App> Dev` for the
//! development configuration, which overrides `productName`), or the folder
//! the person picked with "Choose data folder…", which the page remembers as
//! `folder` in the AppData root's `settings.md`. Only the data root is ever
//! synced (by Epicenter).
//!
//! Rust never reads or writes a settings note, names no path to the page, and
//! grants no folder itself: Tauri does. Startup makes the AppData root and
//! opens the window bound to it. The page finds both roots with Tauri's path
//! API and opens them through the folder plugin (`openAppData` and
//! `openDataFolder` in `@epicenter/folder/tauri`), which opens a data folder
//! only when Tauri's runtime file-system scope allows it: startup allows the
//! default (`default_folder`), the dialog plugin's `open` allows a folder the
//! person picks, and `tauri-plugin-persisted-scope` keeps those across
//! launches (in the AppData root's `.persisted-scope`). No capability names
//! a folder.
//! The folder plugin refuses the places no app keeps its files in
//! (`scope::Refusals`).
//!
//! On macOS, the menu's Quit and Cmd-Q request the primary window's ordinary
//! close, so the page's leave guard answers. This crate installs no close,
//! destroy, or exit handler that waits. Auxiliary windows an app makes are
//! destroyed with the primary, never another primary.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_epicenter_folder::{Directory, FolderExt};
use tauri_plugin_fs::FsExt;

#[derive(Clone, Copy, Debug)]
pub struct StandaloneApp {
    /// The window-label prefix its capability selects (`<page>:*`).
    pub page: &'static str,
    /// The app's name, in its windows and messages. Its default folder is
    /// named for the configured `productName` (`default_folder`).
    pub title: &'static str,
    /// The primary window's logical width and height.
    pub size: (f64, f64),
}

/// Builder with the file-system scope (`tauri-plugin-fs`, no commands
/// granted), its persistence, the folder plugin, the dialog plugin, setup
/// that opens the app's window, and (macOS) guarded Quit. Add app-specific
/// plugins and commands, then call `.run(tauri::generate_context!())`.
pub fn builder(app: StandaloneApp) -> tauri::Builder<tauri::Wry> {
    let builder = tauri::Builder::default()
        // The fs scope must exist before persisted-scope restores into it.
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
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
            let started = allow_default_folder(&handle).and_then(|()| {
                handle
                    .path()
                    .app_data_dir()
                    .map_err(|error| error.to_string())
                    .and_then(|config| start(&handle, app, &config).map(|_| ()))
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

/// `~/Epicenter/<productName>`: the data folder a page opens when its
/// `settings.md` names none. `productName` is the merged configuration's
/// (`package_info().name`, what the page's `getName()` answers), so the
/// development configuration's `<App> Dev` gets its own folder.
pub fn default_folder<R: Runtime>(handle: &AppHandle<R>) -> Result<PathBuf, String> {
    let home = handle
        .path()
        .home_dir()
        .map_err(|error| error.to_string())?;
    Ok(home.join("Epicenter").join(&handle.package_info().name))
}

/// Allow this build's own default folder, and everything in it, in Tauri's
/// runtime file-system scope, the one grant the folder plugin consults.
fn allow_default_folder<R: Runtime>(handle: &AppHandle<R>) -> Result<(), String> {
    handle
        .fs_scope()
        .allow_directory(default_folder(handle)?, true)
        .map_err(|error| error.to_string())
}

/// Make the AppData root `config` and open the window bound to it; the page
/// opens its data root by path.
fn start<R: Runtime>(
    handle: &AppHandle<R>,
    app: StandaloneApp,
    config: &Path,
) -> Result<WebviewWindow<R>, String> {
    let config = Directory::create(config).map_err(|error| {
        format!(
            "{} could not keep its settings in {}: {error}",
            app.title,
            config.display()
        )
    })?;
    // Keep WebView runtime files outside both roots.
    let webview_data = handle
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("webview");
    let (width, height) = app.size;
    handle
        .open_folder_window(app.page, config, WebviewUrl::default(), move |builder| {
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
        .title(format!("{} could not start", app.title))
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCustom("Quit".into()))
        .show(move |_| exit.exit(1));
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
    //! them over the window startup opens, with a mock window standing in for
    //! the WebView. Tauri's runtime file-system scope stands in for the
    //! grants: startup's `allow_default_folder` and the dialog plugin's
    //! `open` both extend it with `allow_directory(folder, true)`. The
    //! native picker and the page are not driven here; what they lead to is.

    use std::fs;

    use serde_json::{json, Value};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
    use tauri::utils::acl::ExecutionContext;
    use tauri::webview::InvokeRequest;
    use tauri::App;
    use tauri_plugin_fs::FsExt;

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
        /// The default data folder, `~/Epicenter/Notes`.
        default: PathBuf,
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
            start(self.app.handle(), NOTES, &self.config).unwrap()
        }
    }

    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(temp.path()).unwrap();
        let mut context = mock_context(noop_assets());
        for command in tauri_plugin_epicenter_folder::COMMANDS {
            context.runtime_authority_mut().__allow_command(
                format!("plugin:epicenter-folder|{command}"),
                ExecutionContext::Local,
            );
        }
        let app = mock_builder()
            .plugin(tauri_plugin_fs::init())
            .plugin(tauri_plugin_epicenter_folder::init())
            .build(context)
            .expect("mock app");
        Fixture {
            app,
            config: base.join("home/Library/Application Support/so.epicenter.notes"),
            default: base.join("home/Epicenter/Notes"),
            base,
            _temp: temp,
        }
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

    /// `open_folder` as `openDevice` asks for it: the root's path, or why not.
    fn open(
        window: &WebviewWindow<MockRuntime>,
        root: &Path,
        create: bool,
    ) -> Result<Value, Value> {
        call(
            window,
            "open_folder",
            json!({ "root": root, "create": create, "onChange": "__CHANNEL__:1" }),
        )
    }

    /// The files a page lists at `root`, or the plugin's refusal.
    fn list(window: &WebviewWindow<MockRuntime>, root: &Path) -> Result<Vec<String>, Value> {
        call(window, "list_folder", json!({ "root": root })).map(|listing| {
            listing
                .as_array()
                .unwrap()
                .iter()
                .map(|file| file["path"].as_str().unwrap().to_owned())
                .collect()
        })
    }

    /// The window starts on its AppData root alone: no data folder is made
    /// or reached until the page opens one, and no settings note is written.
    #[test]
    fn a_window_starts_on_its_app_data_root_alone() {
        let fixture = fixture();
        let window = fixture.start();
        assert!(window.label().starts_with("notes:"));
        assert_eq!(
            open(&window, &fixture.config, false).unwrap(),
            json!(fixture.config)
        );
        assert_eq!(
            list(&window, &fixture.config).unwrap(),
            Vec::<String>::new()
        );
        assert!(!fixture.default.exists());
        assert!(list(&window, &fixture.base.join("home")).is_err());
    }

    /// The default folder, allowed as startup allows it, is made when missing
    /// and opened beside the AppData root; a second open finds what it holds.
    #[test]
    fn the_default_data_folder_is_made_and_opened() {
        let fixture = fixture();
        let window = fixture.start();
        let default = &fixture.default;
        fixture
            .app
            .fs_scope()
            .allow_directory(default, true)
            .unwrap();
        assert_eq!(open(&window, default, true).unwrap(), json!(default));
        assert!(default.is_dir());
        fs::write(default.join("a.md"), "---\n---\n").unwrap();
        open(&window, default, true).unwrap();
        assert_eq!(list(&window, default).unwrap(), ["a.md"]);
        open(&window, &fixture.config, false).unwrap();
        assert!(list(&window, &fixture.config).is_ok());
    }

    /// A folder written into `settings.md` without the picker is not
    /// granted, and nothing falls back to the default. Once the picker
    /// grants it, it opens with its files where they are; the folder opened
    /// before stays granted, so switching back is free.
    #[test]
    fn a_folder_not_picked_is_not_granted_until_the_picker_grants_it() {
        let fixture = fixture();
        let window = fixture.start();
        let default = &fixture.default;
        fixture
            .app
            .fs_scope()
            .allow_directory(default, true)
            .unwrap();
        open(&window, default, true).unwrap();
        let chosen = fixture.base.join("home/Documents/Notes");
        fs::create_dir_all(chosen.join("notes")).unwrap();
        fs::write(chosen.join("notes/b.md"), "---\n---\n").unwrap();
        assert_eq!(
            open(&window, &chosen, false).unwrap_err(),
            json!({ "name": "NotGranted", "root": chosen })
        );
        assert!(list(&window, &chosen).is_err());
        fixture
            .app
            .fs_scope()
            .allow_directory(&chosen, true)
            .unwrap();
        assert_eq!(open(&window, &chosen, false).unwrap(), json!(chosen));
        assert_eq!(list(&window, &chosen).unwrap(), ["notes/b.md"]);
        assert_eq!(open(&window, default, false).unwrap(), json!(default));
    }

    /// A picked folder that is gone is not made again: the page hears
    /// `Missing`, and once the folder is back, the same open (Retry) finds it.
    /// A folder no app keeps its files in is refused even when picked.
    #[test]
    fn a_missing_or_refused_folder_is_not_opened_and_retry_finds_it_back() {
        let fixture = fixture();
        let window = fixture.start();
        let unplugged = fixture.base.join("unplugged/Notes");
        fixture
            .app
            .fs_scope()
            .allow_directory(&unplugged, true)
            .unwrap();
        assert_eq!(
            open(&window, &unplugged, false).unwrap_err(),
            json!({ "name": "Missing" })
        );
        assert!(!unplugged.exists());
        assert!(!fixture.default.exists());
        fs::create_dir_all(&unplugged).unwrap();
        assert_eq!(open(&window, &unplugged, false).unwrap(), json!(unplugged));
    }

    /// Startup allows `~/Epicenter/<productName>`, the merged configuration's
    /// name the page's `getName()` answers, and only it: a folder beside it
    /// stays not granted. Nothing on disk is touched.
    #[test]
    fn startup_allows_this_builds_own_default_folder() {
        let fixture = fixture();
        let handle = fixture.app.handle();
        let default = default_folder(handle).unwrap();
        assert_eq!(
            default,
            handle
                .path()
                .home_dir()
                .unwrap()
                .join("Epicenter")
                .join(&handle.package_info().name)
        );
        assert!(!handle.fs_scope().is_allowed(&default));
        allow_default_folder(handle).unwrap();
        assert!(handle.fs_scope().is_allowed(&default));
        assert!(handle.fs_scope().is_allowed(default.join("notes/a.md")));
        assert!(!handle
            .fs_scope()
            .is_allowed(default.with_file_name("Elsewhere")));
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
