//! Todos as its own desktop window over its own local Folder.
//!
//! The shell resolves the application data directory, registers that whole
//! directory as the one folder the Todos window may edit, and hands it to the
//! window before the window exists. The page then calls
//! `openFolder({ tables })`, which asks the folder plugin which folder this
//! window was handed and is granted it; the page never names a path. The
//! plugin creates the directory at the first grant when it is missing.
//!
//! **Open in Epicenter** (`open_in_epicenter`) asks the operating system to
//! open `epicenter://open?path=<directory>` for the directory the window was
//! granted (ADR-0646). The shell reads that directory from its own grant, not
//! from the page or the app's id. A successful answer means the system took
//! the request, not that Epicenter opened the folder: Epicenter asks the
//! person first.

use std::path::PathBuf;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_epicenter_folder::{FolderConfig, FolderExt, Folders, ScopeConfig, WindowFolder};
use tauri_plugin_opener::OpenerExt;

/// The label of the one Todos window, which `capabilities/todos.json` names.
const WINDOW: &str = "todos";

/// The app and the scope of its folder, as `window_folder` answers the page.
/// A label for the shell's registry, not a path or a lookup key: the page
/// passes it back to `grant_directory` and reads nothing from it.
const TODOS: &str = "so.epicenter.todos";

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_epicenter_folder::init())
        // Rust alone opens the link; no capability grants the page the
        // opener's commands.
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![open_in_epicenter])
        .setup(|app| {
            let root = app.path().app_data_dir()?;
            // A Linux WebView otherwise defaults to local app data, which is
            // also this Folder root. Keep browser runtime files in cache.
            let webview_data = app.path().app_cache_dir()?.join("webview");
            assign_folder(app.folders(), root)?;
            WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::default())
                .title("Todos")
                .inner_size(960.0, 720.0)
                .min_inner_size(480.0, 400.0)
                .data_directory(webview_data)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Todos could not start");
}

/// Register `root` as the Todos window's folder, whole, and hand it to that
/// window. No other window is let in.
fn assign_folder(folders: &Folders, root: PathBuf) -> Result<(), String> {
    folders.register(ScopeConfig {
        scope: TODOS.into(),
        folder: FolderConfig::new(root),
        windows: vec![WINDOW.into()],
    })?;
    folders.hand(
        WINDOW,
        WindowFolder {
            app: TODOS.into(),
            folder: TODOS.into(),
        },
    );
    Ok(())
}

/// Ask the operating system to open Epicenter on the directory the calling
/// window was granted. Answers once the system took the request; whether
/// Epicenter opens the folder is the person's choice there.
#[tauri::command]
fn open_in_epicenter(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    let link = epicenter_link(app.folders(), window.label())?;
    app.opener()
        .open_url(link, None::<String>)
        .map_err(|error| format!("The system did not open Epicenter: {error}"))
}

/// `epicenter://open?path=<directory>` for the root `window` was granted, as
/// the folder plugin resolved it.
fn epicenter_link(folders: &Folders, window: &str) -> Result<String, String> {
    let handed = folders
        .handed(window)
        .ok_or_else(|| "This window has no folder.".to_string())?;
    let root = folders
        .granted_root(&handed.folder, window)
        .map_err(|_| "This window's folder is not open yet.".to_string())?;
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
    //! The folder plugin's real commands on the mock runtime, as the page
    //! calls them when it opens its folder.

    use std::fs;
    use std::path::{Path, PathBuf};

    use serde_json::{json, Value};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
    use tauri::utils::acl::ExecutionContext;
    use tauri::webview::InvokeRequest;
    use tauri::{App, WebviewWindow, WebviewWindowBuilder};

    use super::*;

    /// A mock app with the folder plugin and Todos's folder assigned at
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

    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path())
            .unwrap()
            .join("so.epicenter.todos");

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
        assign_folder(app.folders(), root.clone()).unwrap();
        Fixture {
            app,
            root,
            _temp: temp,
        }
    }

    fn window(app: &App<MockRuntime>, label: &str) -> WebviewWindow<MockRuntime> {
        WebviewWindowBuilder::new(app, label, Default::default())
            .build()
            .expect("mock window")
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

    #[test]
    fn the_todos_window_opens_the_whole_assigned_directory_and_makes_it_when_missing() {
        let fixture = fixture();
        let todos = window(&fixture.app, WINDOW);
        assert!(!fixture.root.exists());

        let handed = invoke(&todos, "window_folder", json!({})).unwrap();
        assert_eq!(handed, json!({ "app": TODOS, "folder": TODOS }));
        let scope = handed["folder"].as_str().unwrap();

        let granted = invoke(&todos, "grant_directory", json!({ "scope": scope })).unwrap();
        assert_eq!(granted, json!({ "root": fixture.root.to_str().unwrap() }));
        // The grant made the directory itself, and nothing in it: no child
        // folder and no marker file.
        assert!(fixture.root.is_dir());
        assert!(entries(&fixture.root).is_empty());
        assert_eq!(
            fixture.app.folders().granted_root(TODOS, WINDOW).unwrap(),
            fixture.root
        );
    }

    #[test]
    fn a_reopened_page_is_granted_the_same_directory_and_finds_its_files() {
        let fixture = fixture();
        let todos = window(&fixture.app, WINDOW);
        invoke(&todos, "grant_directory", json!({ "scope": TODOS })).unwrap();
        fs::create_dir(fixture.root.join("todos")).unwrap();
        fs::write(
            fixture.root.join("todos/milk.md"),
            "---\ntitle: Milk\n---\n",
        )
        .unwrap();

        let granted = invoke(&todos, "grant_directory", json!({ "scope": TODOS })).unwrap();
        assert_eq!(granted, json!({ "root": fixture.root.to_str().unwrap() }));
        let children = invoke(
            &todos,
            "read_folder_children",
            json!({ "scope": TODOS, "directory": "todos" }),
        )
        .unwrap();
        assert_eq!(children, json!({ "files": ["milk.md"], "directories": [] }));
    }

    #[test]
    fn a_removed_fixed_default_is_recreated_within_the_same_run() {
        let fixture = fixture();
        let todos = window(&fixture.app, WINDOW);
        invoke(&todos, "grant_directory", json!({ "scope": TODOS })).unwrap();
        fs::remove_dir(&fixture.root).unwrap();

        let granted = invoke(&todos, "grant_directory", json!({ "scope": TODOS })).unwrap();
        assert_eq!(granted, json!({ "root": fixture.root.to_str().unwrap() }));
        assert!(fixture.root.is_dir());
        assert!(entries(&fixture.root).is_empty());
    }

    #[test]
    fn no_other_window_is_handed_or_granted_the_folder() {
        let fixture = fixture();
        let other = window(&fixture.app, "other");

        assert_eq!(
            invoke(&other, "window_folder", json!({})).unwrap(),
            Value::Null
        );
        let refused = invoke(&other, "grant_directory", json!({ "scope": TODOS })).unwrap_err();
        assert_eq!(refused["name"], "WindowNotPermitted");
        assert!(!fixture.root.exists());
    }

    /// The link names the directory the plugin granted the window, read from
    /// the grant itself, so a moved or redirected root is sent as it now is.
    #[test]
    fn open_in_epicenter_names_the_granted_directory() {
        let fixture = fixture();
        let todos = window(&fixture.app, WINDOW);
        assert_eq!(
            epicenter_link(fixture.app.folders(), WINDOW).unwrap_err(),
            "This window's folder is not open yet."
        );

        invoke(&todos, "grant_directory", json!({ "scope": TODOS })).unwrap();
        let link = epicenter_link(fixture.app.folders(), WINDOW).unwrap();
        assert_eq!(
            link,
            format!(
                "epicenter://open?path={}",
                encode_path(fixture.root.to_str().unwrap())
            )
        );
        assert_eq!(
            epicenter_link(fixture.app.folders(), "other").unwrap_err(),
            "This window has no folder."
        );
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

    /// The window holds the folder plugin, its own app identifier (which the
    /// page reads to offer Open in Epicenter only in standalone Todos), and
    /// its one command. No opener permission: the shell opens the link.
    #[test]
    fn the_capability_selects_only_the_todos_window_and_the_folder_commands() {
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/todos.json")).unwrap();
        assert_eq!(capability["windows"], json!([WINDOW]));
        assert_eq!(capability["local"], true);
        assert_eq!(
            capability["permissions"],
            json!([
                "epicenter-folder:default",
                "core:event:allow-listen",
                "core:event:allow-unlisten",
                "core:window:allow-destroy",
                "core:app:allow-identifier",
                "allow-open-in-epicenter"
            ])
        );
    }
}
