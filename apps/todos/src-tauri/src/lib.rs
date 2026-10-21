//! Standalone Todos opens one directory in one window.
//!
//! The native wrapper defaults to `~/Epicenter/Todos` (or the development
//! root) and binds it before loading the static page.
//! The page calls `openFolder({ tables })` and never selects or discovers a
//! path. Epicenter can load the same page
//! over another folder selected by its own launcher. Standalone Todos has
//! no folder picker, recent-folder list, or extra-folder windows.

use std::error::Error;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, WebviewUrl};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_epicenter_folder::{Directory, FolderExt, Folders};
use tauri_plugin_opener::OpenerExt;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_epicenter_folder::init())
        // Native startup errors and the page's unfinished-save confirmation.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![open_in_epicenter])
        .setup(|app| {
            if let Err(error) = open_default(app.handle()) {
                report_open_error(app.handle(), error.to_string());
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Todos could not start");
}

/// Create and bind the fixed default before constructing the app's window.
fn open_default(app: &AppHandle) -> Result<(), Box<dyn Error>> {
    let root = default_folder(
        &app.config().identifier,
        &app.path().home_dir()?,
        std::env::var_os("EPICENTER_FOLDER_DIR").as_deref(),
    )?;
    let directory = Directory::create(&root)?;
    // Keep WebView runtime files outside the authored Folder.
    let webview_data = app.path().app_cache_dir()?.join("webview");
    app.open_folder_window("todos", directory, WebviewUrl::default(), move |builder| {
        Ok(builder
            .title("Todos")
            .inner_size(960.0, 720.0)
            .min_inner_size(480.0, 400.0)
            .data_directory(webview_data))
    })?;
    Ok(())
}

fn default_folder(
    identifier: &str,
    home: &Path,
    override_value: Option<&OsStr>,
) -> Result<PathBuf, String> {
    let base = match override_value {
        Some(value) if !value.is_empty() => {
            let path = Path::new(value);
            if !path.is_absolute() {
                return Err(format!(
                    "EPICENTER_FOLDER_DIR must be an absolute path, not {value:?}."
                ));
            }
            path.to_path_buf()
        }
        _ => {
            let name = match identifier {
                "so.epicenter.todos" => "Epicenter",
                "so.epicenter.todos.dev" => "Epicenter Dev",
                _ => {
                    return Err(format!(
                        "No authored root for {identifier}; set EPICENTER_FOLDER_DIR explicitly"
                    ))
                }
            };
            home.join(name)
        }
    };
    Ok(base.join("Todos"))
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

    #[test]
    fn roots_match_host_storage_environments_and_require_absolute_overrides() {
        let home = Path::new("/home/person");
        assert_eq!(
            default_folder("so.epicenter.todos", home, None).unwrap(),
            home.join("Epicenter/Todos")
        );
        assert_eq!(
            default_folder("so.epicenter.todos.dev", home, None).unwrap(),
            home.join("Epicenter Dev/Todos")
        );
        assert_eq!(
            default_folder("so.epicenter.todos", home, Some(OsStr::new("/other"))).unwrap(),
            Path::new("/other/Todos")
        );
        assert!(default_folder("so.epicenter.todos", home, Some(OsStr::new("relative"))).is_err());
        assert_eq!(
            default_folder("unrecognized", home, Some(OsStr::new("/other"))).unwrap(),
            Path::new("/other/Todos")
        );
    }

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
            encode_path("/Users/me/Epicenter Dev/Todos"),
            "/Users/me/Epicenter%20Dev/Todos"
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
