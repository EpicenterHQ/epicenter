//! Todos as its own desktop window over its own local Folder.
//!
//! The shell resolves the application data directory, registers that whole
//! directory as the one folder the Todos window may edit, and hands it to the
//! window before the window exists. The page then calls
//! `openFolder({ tables })`, which asks the folder plugin which folder this
//! window was handed and is granted it; the page never names a path. The
//! plugin creates the directory at the first grant when it is missing.

use std::path::PathBuf;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_epicenter_folder::{FolderConfig, FolderExt, Folders, ScopeConfig, WindowFolder};

/// The label of the one Todos window, which `capabilities/todos.json` names.
const WINDOW: &str = "todos";

/// The app and the scope of its folder, as `window_folder` answers the page.
/// A label for the shell's registry, not a path or a lookup key: the page
/// passes it back to `grant_directory` and reads nothing from it.
const TODOS: &str = "so.epicenter.todos";

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_epicenter_folder::init())
        .setup(|app| {
            let root = app.path().app_data_dir()?;
            assign_folder(app.folders(), root)?;
            WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::default())
                .title("Todos")
                .inner_size(960.0, 720.0)
                .min_inner_size(480.0, 400.0)
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

    #[test]
    fn the_capability_selects_only_the_todos_window_and_the_folder_commands() {
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/todos.json")).unwrap();
        assert_eq!(capability["windows"], json!([WINDOW]));
        assert_eq!(
            capability["permissions"],
            json!([
                "epicenter-folder:default",
                "core:event:allow-listen",
                "core:event:allow-unlisten"
            ])
        );
    }
}
