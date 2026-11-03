//! Standalone startup: one app, two roots, one primary window.
//!
//! An installed app keeps two roots. Its **AppData root** is fixed: the
//! operating system's application data directory for the app, one per
//! installation, never synced and never chosen. Its settings notes sit at its
//! top (`settings.md`, `shortcuts.md`), as the same notes sit at the top of
//! the data root. Its **data root** is the person's files, derived from the
//! app's declared production site under `~/Epicenter` or `~/Epicenter Dev`.
//! For this transition, the page may still use a folder remembered in its
//! AppData settings. Only the data root is ever synced (by Epicenter).
//!
//! Rust never reads or writes a settings note. Startup grants the derived
//! data folder through Tauri's file-system scope, keeps its resolved path for
//! the folder plugin to answer, makes the AppData root, and opens the window
//! bound to it. The page opens both roots through the folder plugin
//! (`openAppData` and `openDataFolder` in `@epicenter/folder/tauri`), which
//! opens a data folder only when Tauri's runtime file-system scope allows it:
//! startup allows the derived folder, the dialog plugin's `open` allows a
//! folder the person picks, and `tauri-plugin-persisted-scope` keeps those
//! across launches (in the AppData root's `.persisted-scope`). No capability
//! names a folder.
//! The folder plugin refuses the places no app keeps its files in
//! (`scope::Refusals`).
//!
//! Quit is the default menu's, and quits; a window closes at once. This crate
//! installs no close, destroy, or exit handler that waits for a page. Every
//! plugin still hears the window's `Destroyed` and the app's `Exit` (AppKit's
//! Quit reaches `Exit` without `ExitRequested`), which is where the recorder
//! finishes a recording in progress.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_epicenter_folder::{scope::Refusals, DataFolder, Directory, FolderExt};
use tauri_plugin_fs::FsExt;

pub mod data_folder;

#[derive(Clone, Copy, Debug)]
pub struct StandaloneApp {
    /// The window-label prefix its capability selects (`<page>:*`).
    pub page: &'static str,
    /// The app's declared production origin, which names its data folder.
    pub site: &'static str,
    /// The app's name, in its windows and messages.
    pub title: &'static str,
    /// The primary window's logical width and height.
    pub size: (f64, f64),
}

/// Builder with the file-system scope (`tauri-plugin-fs`, no commands
/// granted), its persistence, the folder plugin, the dialog plugin, and setup
/// that opens the app's window. Add app-specific plugins and commands, then
/// call `.run(tauri::generate_context!())`.
pub fn builder(app: StandaloneApp) -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        // The fs scope must exist before persisted-scope restores into it.
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_epicenter_folder::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(app)
        .setup(move |application| {
            let handle = application.handle().clone();
            let started = allow_data_folder(&handle, app.site).and_then(|()| {
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
        })
}

/// The data folder this build derives from its site and bundle identifier.
pub fn data_folder<R: Runtime>(handle: &AppHandle<R>, site: &str) -> Result<PathBuf, String> {
    let home = handle
        .path()
        .home_dir()
        .map_err(|error| error.to_string())?;
    let root = data_folder::root(
        &home,
        &handle.config().identifier,
        std::env::var_os("EPICENTER_FOLDER_DIR").as_deref(),
    );
    let relative = data_folder::relative_path(site).map_err(|error| error.to_string())?;
    Ok(root.join(relative))
}

/// Grant the derived folder and keep the same resolved path for the page.
fn allow_data_folder<R: Runtime>(handle: &AppHandle<R>, site: &str) -> Result<(), String> {
    let folder = data_folder(handle, site)?;
    grant_data_folder(handle, &folder)
}

fn grant_data_folder<R: Runtime>(handle: &AppHandle<R>, folder: &Path) -> Result<(), String> {
    let resolved = if folder.exists() {
        dunce::canonicalize(folder).map_err(|error| error.to_string())?
    } else {
        folder.to_path_buf()
    };
    if folder
        .parent()
        .is_some_and(|parent| parent.starts_with(&resolved))
    {
        return Err(format!(
            "{} contains the app's folder root and cannot be its data folder",
            resolved.display()
        ));
    }
    if let Some(reason) = Refusals::resolve(handle)
        .map_err(|error| format!("{error:?}"))?
        .refusal(&resolved)
    {
        return Err(reason);
    }
    handle
        .fs_scope()
        .allow_directory(&resolved, true)
        .map_err(|error| error.to_string())?;
    handle.manage(DataFolder(resolved));
    Ok(())
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
        site: "https://notes.epicenter.so",
        title: "Notes",
        size: (960.0, 720.0),
    };

    struct Fixture {
        app: App<MockRuntime>,
        /// The AppData root.
        config: PathBuf,
        /// The derived data folder, `~/Epicenter/notes`.
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
            default: base.join("home/Epicenter/notes"),
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

    /// Startup grants the derived folder and nothing beside it.
    #[test]
    fn startup_allows_this_builds_derived_folder() {
        let fixture = fixture();
        let handle = fixture.app.handle();
        let default = &fixture.default;
        assert!(!handle.fs_scope().is_allowed(&default));
        grant_data_folder(handle, default).unwrap();
        assert!(handle.fs_scope().is_allowed(&default));
        assert!(handle.fs_scope().is_allowed(default.join("notes/a.md")));
        assert!(!handle
            .fs_scope()
            .is_allowed(default.with_file_name("Elsewhere")));
        assert_eq!(handle.state::<DataFolder>().0, *default);
        let window = fixture.start();
        assert_eq!(
            call(&window, "data_folder", json!({})).unwrap(),
            json!(default)
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_folder_is_granted_by_its_target() {
        use std::os::unix::fs::symlink;

        let fixture = fixture();
        let target = fixture.base.join("archive/notes");
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(fixture.default.parent().unwrap()).unwrap();
        symlink(&target, &fixture.default).unwrap();
        let handle = fixture.app.handle();
        grant_data_folder(handle, &fixture.default).unwrap();
        assert_eq!(handle.state::<DataFolder>().0, target);
        assert!(handle.fs_scope().is_allowed(&target));
        assert!(handle.fs_scope().is_allowed(target.join("a.md")));
    }

    #[cfg(unix)]
    #[test]
    fn a_link_to_the_library_root_is_not_granted_recursively() {
        use std::os::unix::fs::symlink;

        let fixture = fixture();
        let library = fixture.default.parent().unwrap();
        fs::create_dir_all(library).unwrap();
        symlink(library, &fixture.default).unwrap();
        let handle = fixture.app.handle();
        assert!(grant_data_folder(handle, &fixture.default).is_err());
        assert!(!handle.fs_scope().is_allowed(library.join("other-app")));
    }
}
