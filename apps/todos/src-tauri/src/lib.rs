//! Standalone Todos opens one directory in one window.
//!
//! The native wrapper defaults to `~/Epicenter/Todos` (or the development
//! root) and binds it before loading the static page. Existing authored work
//! in the former whole-AppData Folder requires an explicit launch choice.
//! The page calls `openFolder({ tables })` and never selects or discovers a
//! path. Epicenter can load the same page
//! over another folder selected by its own launcher. Standalone Todos has
//! no folder picker, recent-folder list, or extra-folder windows.

use std::error::Error;
use std::path::Path;

use tauri::{AppHandle, Manager, WebviewUrl};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};
use tauri_plugin_epicenter_folder::{Directory, FolderExt, Folders};
use tauri_plugin_opener::OpenerExt;

mod launch;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_epicenter_folder::init())
        // Only reports a startup failure; no page receives dialog commands.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![open_in_epicenter])
        .setup(|app| {
            let handle = app.handle().clone();
            let launch = (|| -> Result<launch::Launch, Box<dyn Error>> {
                let legacy = app.path().app_data_dir()?;
                let home = app.path().home_dir()?;
                let target = launch::root(
                    &app.config().identifier,
                    &home,
                    std::env::var_os("EPICENTER_FOLDER_DIR").as_deref(),
                )?;
                Ok(launch::decide(&legacy, &target)?)
            })();
            match launch {
                Ok(launch::Launch::Default(target)) => open_or_report(&handle, &target, true),
                Ok(launch::Launch::Choose { legacy, target, target_status }) => {
                    match target_status {
                        launch::TargetStatus::Unavailable(error) => {
                            let message = format!(
                                "Todos found work in its previous location, but the Epicenter folder cannot be opened: {error}\n\nExisting: {}\nEpicenter: {}",
                                legacy.display(), target.display()
                            );
                            let choice_handle = handle.clone();
                            app.dialog()
                                .message(message)
                                .title("Open existing Todos work")
                                .buttons(MessageDialogButtons::OkCancelCustom(
                                    "Open Existing".into(),
                                    "Quit".into(),
                                ))
                                .show_with_result(move |choice| match choice {
                                    MessageDialogResult::Ok => {
                                        open_or_report(&choice_handle, &legacy, false)
                                    }
                                    MessageDialogResult::Custom(label) if label == "Open Existing" => {
                                        open_or_report(&choice_handle, &legacy, false)
                                    }
                                    _ => choice_handle.exit(0),
                                });
                        }
                        status => {
                            let create_target = status == launch::TargetStatus::Empty;
                            let message = match status {
                                launch::TargetStatus::HasWork => format!(
                                    "Todos work exists in both locations. Choose which folder to open. Nothing will be copied or merged.\n\nExisting: {}\nEpicenter: {}",
                                    legacy.display(), target.display()
                                ),
                                launch::TargetStatus::Empty => format!(
                                    "Todos found work in its previous location. Open that work, or create the new Epicenter folder. Nothing will be copied or moved.\n\nExisting: {}\nEpicenter: {}",
                                    legacy.display(), target.display()
                                ),
                                launch::TargetStatus::Uninspected(error) => format!(
                                    "Todos found work in its previous location. The Epicenter folder exists, but some contents could not be inspected: {error}\n\nYou can try opening the existing Epicenter folder. Nothing will be created, copied, or merged.\n\nExisting: {}\nEpicenter: {}",
                                    legacy.display(), target.display()
                                ),
                                launch::TargetStatus::Unavailable(_) => unreachable!(),
                            };
                            let choice_handle = handle.clone();
                            app.dialog()
                                .message(message)
                                .title("Choose Todos folder")
                                .buttons(MessageDialogButtons::YesNoCancelCustom(
                                    "Open Existing".into(),
                                    "Open Epicenter".into(),
                                    "Quit".into(),
                                ))
                                .show_with_result(move |choice| match choice {
                                    MessageDialogResult::Yes => open_or_report(&choice_handle, &legacy, false),
                                    MessageDialogResult::No => {
                                        open_or_report(&choice_handle, &target, create_target)
                                    }
                                    MessageDialogResult::Custom(label) if label == "Open Existing" => {
                                        open_or_report(&choice_handle, &legacy, false)
                                    }
                                    MessageDialogResult::Custom(label) if label == "Open Epicenter" => {
                                        open_or_report(&choice_handle, &target, create_target)
                                    }
                                    _ => choice_handle.exit(0),
                                });
                        }
                    }
                }
                Err(error) => report_open_error(&handle, error.to_string()),
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Todos could not start");
}

fn open_or_report(app: &AppHandle, root: &Path, create: bool) {
    let opened = (|| -> Result<(), Box<dyn Error>> {
        let directory = if create {
            Directory::create(root)?
        } else {
            Directory::existing(root)?
        };
        // Keep WebView runtime files outside whichever Folder is opened.
        let webview_data = app.path().app_cache_dir()?.join("webview");
        app.open_folder_window("todos", directory, WebviewUrl::default(), move |builder| {
            Ok(builder
                .title("Todos")
                .inner_size(960.0, 720.0)
                .min_inner_size(480.0, 400.0)
                .data_directory(webview_data))
        })?;
        Ok(())
    })();
    if let Err(error) = opened {
        report_open_error(app, error.to_string());
    }
}

fn report_open_error(app: &AppHandle, message: String) {
    let handle = app.clone();
    app.dialog()
        .message(message)
        .title("Todos could not open its folder")
        .kind(MessageDialogKind::Error)
        .show(move |_| handle.exit(1));
}

/// Ask the operating system to open Epicenter on the directory the calling
/// window is bound to. Answers once the system took the request; whether
/// Epicenter opens the folder is the person's choice there.
#[tauri::command]
fn open_in_epicenter(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    let link = epicenter_link(app.folders(), window.label())?;
    app.opener()
        .open_url(link, None::<String>)
        .map_err(|error| format!("The system did not open Epicenter: {error}"))
}

/// `epicenter://open?path=<directory>` for the root `label` is bound to, as
/// the folder plugin resolved it.
fn epicenter_link(folders: &Folders, label: &str) -> Result<String, String> {
    let directory = folders.bound(label).map_err(|error| error.to_string())?;
    let root = directory.root();
    let root = root
        .to_str()
        .ok_or_else(|| "This folder's path cannot be sent to Epicenter.".to_string())?;
    Ok(format!("epicenter://open?path={}", encode_path(root)))
}

/// `path` with every byte but unreserved characters and `/` percent-encoded,
/// so `+`, `&`, `%`, and spaces have one reading.
fn encode_path(path: &str) -> String {
    let mut encoded = String::with_capacity(path.len());
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    //! The folder plugin's real commands on the mock runtime, as each page
    //! calls them when it opens its fixed folder, with a mock window standing
    //! in for the WebView.

    use std::fs;
    use std::path::{Path, PathBuf};

    use serde_json::{json, Value};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
    use tauri::utils::acl::ExecutionContext;
    use tauri::webview::InvokeRequest;
    use tauri::{App, WebviewWindow, WebviewWindowBuilder};

    use super::*;

    /// A mock app with the folder plugin, and Todos's default folder at
    /// `root`, which does not exist yet.
    struct Fixture {
        app: App<MockRuntime>,
        root: PathBuf,
        _temp: tempfile::TempDir,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.app.folders().shutdown();
        }
    }

    impl Fixture {
        fn launch(&self) -> String {
            let directory = Directory::create(&self.root).unwrap();
            self.app
                .open_folder_window("todos", directory, Default::default(), |builder| {
                    Ok(builder)
                })
                .unwrap()
                .label()
                .to_owned()
        }

        fn window(&self, label: &str) -> WebviewWindow<MockRuntime> {
            self.app.get_webview_window(label).expect("an open window")
        }
    }

    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path())
            .unwrap()
            .join("Epicenter/Todos");

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
            root,
            _temp: temp,
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

    fn entries(directory: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

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

    #[test]
    fn a_path_is_encoded_with_one_reading() {
        assert_eq!(
            encode_path("/Users/me/Library/Application Support/so.epicenter.todos"),
            "/Users/me/Library/Application%20Support/so.epicenter.todos"
        );
        assert_eq!(
            encode_path("/tmp/a+b&c=d%e;f#g?h/notés"),
            "/tmp/a%2Bb%26c%3Dd%25e%3Bf%23g%3Fh/not%C3%A9s"
        );
    }

    #[test]
    fn handoff_names_the_default_bound_root_without_a_page_grant() {
        let fixture = fixture();
        fixture.launch();
        assert_eq!(
            epicenter_link(fixture.app.folders(), &fixture.launch()).unwrap(),
            format!(
                "epicenter://open?path={}",
                encode_path(fixture.root.to_str().unwrap())
            )
        );
        assert!(epicenter_link(fixture.app.folders(), "unbound").is_err());
    }

    #[test]
    fn launch_makes_the_epicenter_default_and_binds_it_to_the_first_window() {
        let fixture = fixture();
        assert!(!fixture.root.exists());
        let todos = fixture.window(&fixture.launch());
        // Launch made the named authored folder with no marker file.
        assert!(fixture.root.is_dir());
        assert!(entries(&fixture.root).is_empty());
        invoke(&todos, "open_folder", json!({})).unwrap();
        assert_eq!(
            fixture.app.folders().bound(todos.label()).unwrap().root(),
            fixture.root
        );

        fs::create_dir(fixture.root.join("todos")).unwrap();
        fs::write(
            fixture.root.join("todos/milk.md"),
            "---\ntitle: Milk\n---\n",
        )
        .unwrap();
        // A reloaded page opens the same directory and finds its files.
        assert_eq!(todo_files(&todos), json!(["milk.md"]));
    }

    /// The default removed while its window is open is refused when the page
    /// opens it again, and is made again only when native startup prepares the default.
    #[test]
    fn a_removed_default_is_refused_until_native_startup_prepares_it() {
        let fixture = fixture();
        let todos = fixture.window(&fixture.launch());
        fs::remove_dir(&fixture.root).unwrap();
        assert_eq!(
            invoke(&todos, "open_folder", json!({})).unwrap_err(),
            json!({ "name": "Missing" })
        );
        assert!(!fixture.root.exists());
        Directory::create(&fixture.root).unwrap();
        assert!(fixture.root.is_dir());
        invoke(&todos, "open_folder", json!({})).unwrap();
    }

    #[test]
    fn a_window_with_no_folder_is_refused() {
        let fixture = fixture();
        fixture.launch();
        let other = WebviewWindowBuilder::new(&fixture.app, "other", Default::default())
            .build()
            .unwrap();
        assert_eq!(
            invoke(&other, "open_folder", json!({})).unwrap_err(),
            json!({ "name": "NotBound" })
        );
    }

    #[test]
    fn the_capability_selects_the_one_standalone_window() {
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/todos.json")).unwrap();
        assert_eq!(capability["windows"], json!(["todos:*"]));
        assert_eq!(capability["local"], true);
        assert_eq!(
            capability["permissions"],
            json!([
                "epicenter-folder:default",
                "core:event:allow-listen",
                "core:event:allow-unlisten",
                "dialog:allow-message",
                "core:window:allow-set-focus",
                "core:window:allow-destroy",
                "core:app:allow-identifier",
                "allow-open-in-epicenter"
            ])
        );
    }
}
