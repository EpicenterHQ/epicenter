//! The plugin through Tauri's real invoke path, on the mock runtime.
//!
//! Each test builds an app with the plugin installed, creates windows, and
//! sends `plugin:epicenter-folder|...` requests exactly as a page's `invoke`
//! would. The folder is a real directory with the real `git`.
//!
//! Key behaviors:
//! - The generated TypeScript bindings match the registered commands.
//! - A scope is granted only to the window registered for it, and a page
//!   never supplies a root.
//! - Changes land only after a grant, only under the root, and never in
//!   Git's private state; `git` runs in the root and only as an allowed
//!   operation.
//! - After shutdown, a late change is refused and the folder is unlocked.
//! - A window without the plugin's permission cannot call it.

use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody, RuntimeAuthority};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
use tauri::utils::acl::manifest::Manifest;
use tauri::utils::acl::resolved::Resolved;
use tauri::utils::acl::ExecutionContext;
use tauri::webview::InvokeRequest;
use tauri::{App, WebviewWindow, WebviewWindowBuilder};

use crate::{init, Author, FolderConfig, FolderExt, ScopeConfig, COMMANDS, DIRECTORY_COMMANDS};

const BINDINGS: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../folder/src/native/bindings.gen.ts"
);

/// Set `FOLDER_WRITE_BINDINGS=1` to rewrite the committed bindings.
#[test]
fn the_committed_typescript_bindings_match_the_registered_commands() {
    let generated = std::env::temp_dir().join(format!("folder-bindings-{}.ts", std::process::id()));
    crate::specta_builder::<tauri::Wry>()
        .export(specta_typescript::Typescript::default(), &generated)
        .expect("export the bindings");
    let fresh = std::fs::read_to_string(&generated).unwrap();
    // Specta leaves trailing whitespace in multiline unions. Generation and
    // freshness compare the same normalized text, ending in one newline.
    let fresh = fresh
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n");
    let fresh = format!("{}\n", fresh.trim_end());
    let _ = std::fs::remove_file(&generated);
    if std::env::var_os("FOLDER_WRITE_BINDINGS").is_some() {
        std::fs::write(BINDINGS, &fresh).unwrap();
    }
    let committed = std::fs::read_to_string(BINDINGS).unwrap_or_default();
    assert!(
        committed == fresh,
        "packages/folder/src/native/bindings.gen.ts is stale; run `FOLDER_WRITE_BINDINGS=1 cargo test --offline bindings` in packages/tauri-plugin-epicenter-folder"
    );
    for command in COMMANDS {
        assert!(
            fresh.contains(&format!("'plugin:epicenter-folder|{command}'"))
                || fresh.contains(&format!("\"plugin:epicenter-folder|{command}\"")),
            "{command} is listed for permissions but not registered"
        );
    }
}

struct Fixture {
    app: App<MockRuntime>,
    root: PathBuf,
    _directory: TempDirectory,
}

struct TempDirectory(PathBuf);

impl Drop for TempDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn temp(label: &str) -> TempDirectory {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    std::env::set_var("GIT_CONFIG_GLOBAL", "/dev/null");
    std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
    let path = std::env::temp_dir().join(format!(
        "folder-plugin-{label}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    TempDirectory(std::fs::canonicalize(path).unwrap())
}

/// The mock context, knowing the fs plugin's reading permissions, which a
/// grant's capability names, and allowing every command of this plugin.
fn context() -> tauri::Context<MockRuntime> {
    let mut context = mock_context(noop_assets());
    let permissions = DIRECTORY_COMMANDS
        .iter()
        .map(|identifier| {
            let identifier = identifier.strip_prefix("fs:").unwrap();
            let command = identifier.strip_prefix("allow-").unwrap().replace('-', "_");
            let permission = serde_json::from_value(json!({
                "identifier": identifier,
                "commands": { "allow": [command] },
            }))
            .unwrap();
            (identifier.to_string(), permission)
        })
        .collect();
    let fs = Manifest {
        default_permission: None,
        permissions,
        permission_sets: Default::default(),
        global_scope_schema: None,
    };
    *context.runtime_authority_mut() =
        RuntimeAuthority::new([("fs".to_string(), fs)].into(), Resolved::default());
    for command in COMMANDS {
        context.runtime_authority_mut().__allow_command(
            format!("plugin:epicenter-folder|{command}"),
            ExecutionContext::Local,
        );
    }
    context
}

/// An app whose windows may call every plugin command, with the scope
/// `notes` registered for the window `main`.
fn fixture(label: &str) -> Fixture {
    let directory = temp(label);
    let root = directory.0.join("notes");
    let app = mock_builder()
        .plugin(init())
        .build(context())
        .expect("mock app");
    app.folders()
        .register(ScopeConfig {
            scope: "notes".to_string(),
            folder: FolderConfig::new(
                &root,
                Author {
                    name: "Test Author".to_string(),
                    email: "test@example.com".to_string(),
                },
            ),
            window: "main".to_string(),
        })
        .unwrap();
    Fixture {
        app,
        root,
        _directory: directory,
    }
}

fn window(app: &App<MockRuntime>, label: &str) -> WebviewWindow<MockRuntime> {
    WebviewWindowBuilder::new(app, label, Default::default())
        .build()
        .expect("mock window")
}

/// One request through the IPC handler: the resolved value, or the rejection.
fn invoke(window: &WebviewWindow<MockRuntime>, command: &str, args: Value) -> Result<Value, Value> {
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

fn text(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

fn grant(window: &WebviewWindow<MockRuntime>) -> Result<Value, Value> {
    invoke(window, "grant_directory", json!({ "scope": "notes" }))
}

/// A path inside the root, as the page's engine names it to the plugin.
fn inside(fixture: &Fixture, relative: &str) -> String {
    fixture.root.join(relative).to_str().unwrap().to_string()
}

fn write(
    fixture: &Fixture,
    window: &WebviewWindow<MockRuntime>,
    relative: &str,
    content: &str,
) -> Result<Value, Value> {
    invoke(
        window,
        "write_folder_file",
        json!({
            "scope": "notes",
            "path": inside(fixture, relative),
            "bytes": content.as_bytes(),
            "createNew": false,
        }),
    )
}

fn git(
    window: &WebviewWindow<MockRuntime>,
    args: &[&str],
    request: u32,
) -> Result<Value, Value> {
    invoke(
        window,
        "run_git",
        json!({
            "scope": "notes",
            "args": args,
            "input": null,
            "indexFile": null,
            "authorization": null,
            "request": request,
        }),
    )
}

#[test]
fn a_scope_is_granted_to_its_window_and_no_other() {
    let fixture = fixture("grant");
    let main = window(&fixture.app, "main");
    let other = window(&fixture.app, "other");
    assert_eq!(
        grant(&other).unwrap_err(),
        json!({ "name": "WindowNotPermitted", "scope": "notes", "window": "other" })
    );
    assert_eq!(
        invoke(&main, "grant_directory", json!({ "scope": "elsewhere" })).unwrap_err(),
        json!({ "name": "UnknownScope", "scope": "elsewhere" })
    );
    // Nothing reaches the folder before a grant, from any window.
    assert!(text(&write(&fixture, &main, "a.md", "a").unwrap_err()).contains("not been granted"));
    assert!(!fixture.root.exists());

    let granted = grant(&main).unwrap();
    assert_eq!(
        granted,
        json!({
            "root": fixture.root.to_str().unwrap(),
            "branch": "main",
            "authorName": "Test Author",
            "authorEmail": "test@example.com",
        })
    );
    // A reloaded page asks again and gets the same folder.
    assert_eq!(grant(&main).unwrap(), granted);
    assert!(text(&write(&fixture, &other, "a.md", "a").unwrap_err())
        .contains("WindowNotPermitted"));
}

#[test]
fn changes_land_under_the_root_and_never_in_git_state() {
    let fixture = fixture("changes");
    let main = window(&fixture.app, "main");
    grant(&main).unwrap();
    // The engine initializes the repository first; its staged writes need
    // `.git`, which no change command makes.
    git(&main, &["init", "--quiet", "--initial-branch=main"], 1).unwrap();

    invoke(
        &main,
        "make_folder_directory",
        json!({ "scope": "notes", "path": inside(&fixture, "notes") }),
    )
    .unwrap();
    write(&fixture, &main, "notes/a.md", "first\n").unwrap();
    invoke(
        &main,
        "rename_folder_path",
        json!({
            "scope": "notes",
            "from": inside(&fixture, "notes/a.md"),
            "to": inside(&fixture, "notes/b.md"),
        }),
    )
    .unwrap();
    assert!(!fixture.root.join("notes/a.md").exists());
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("notes/b.md")).unwrap(),
        "first\n"
    );
    for path in ["notes/b.md", "notes"] {
        invoke(
            &main,
            "remove_folder_path",
            json!({ "scope": "notes", "path": inside(&fixture, path), "recursive": false }),
        )
        .unwrap();
    }
    assert!(!fixture.root.join("notes").exists());

    // Git's private state and anything outside the root are refused.
    assert!(write(&fixture, &main, ".git/config", "[core]\n").is_err());
    let outside = fixture.root.parent().unwrap().join("outside.md");
    assert!(invoke(
        &main,
        "write_folder_file",
        json!({
            "scope": "notes",
            "path": outside.to_str().unwrap(),
            "bytes": b"x",
            "createNew": false,
        }),
    )
    .is_err());
    assert!(!outside.exists());
}

#[test]
fn git_runs_in_the_root_only_as_an_allowed_operation() {
    let fixture = fixture("git");
    let main = window(&fixture.app, "main");
    grant(&main).unwrap();
    let initialized = git(&main, &["init", "--quiet", "--initial-branch=main"], 1).unwrap();
    assert_eq!(initialized["code"], 0, "{initialized}");
    assert!(fixture.root.join(".git").is_dir());
    let head = git(&main, &["symbolic-ref", "--quiet", "HEAD"], 2).unwrap();
    assert_eq!(head["stdout"], json!(b"refs/heads/main\n".to_vec()));

    let refused = git(&main, &["config", "core.hooksPath", "/tmp"], 3).unwrap_err();
    assert_eq!(refused["name"], "Unavailable", "{refused}");
    // Cancelling a run that already finished does nothing.
    invoke(&main, "cancel_git", json!({ "request": 2 })).unwrap();
}

#[test]
fn after_shutdown_a_late_change_is_refused_and_the_folder_is_unlocked() {
    let fixture = fixture("shutdown");
    let main = window(&fixture.app, "main");
    grant(&main).unwrap();
    git(&main, &["init", "--quiet", "--initial-branch=main"], 1).unwrap();
    write(&fixture, &main, "kv.json", "{}\n").unwrap();
    fixture.app.folders().shutdown();
    assert!(text(&write(&fixture, &main, "kv.json", "late\n").unwrap_err())
        .contains("ShuttingDown"));
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("kv.json")).unwrap(),
        "{}\n"
    );
    assert_eq!(grant(&main).unwrap_err(), json!({ "name": "ShuttingDown" }));
    drop(
        epicenter_folder_core::lock::RootLock::acquire(&fixture.root)
            .unwrap_or_else(|_| panic!("the folder is unlocked after shutdown")),
    );
}

#[test]
fn a_window_without_the_permission_cannot_call_the_plugin() {
    let app = mock_builder()
        .plugin(init())
        .build(mock_context(noop_assets()))
        .unwrap();
    let main = window(&app, "main");
    for command in COMMANDS {
        let refused = invoke(&main, command, json!({})).unwrap_err();
        assert!(text(&refused).contains("not allowed"), "{command}: {refused}");
    }
}
