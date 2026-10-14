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
//! - A page's `git` runs end with it: a cancel stops a run whether it
//!   arrives before or after the run starts, a page load or a destroyed
//!   window cancels every run of the page before it, and two windows' runs
//!   never meet, whatever IDs their pages chose.
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

/// Write a file as the engine does: its bytes to a new staged file, which
/// is then renamed over the path.
fn write(
    fixture: &Fixture,
    window: &WebviewWindow<MockRuntime>,
    relative: &str,
    content: &str,
) -> Result<Value, Value> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let scratch = inside(fixture, ".git/epicenter/scratch");
    let staged = format!(
        "{scratch}/staged-{}",
        NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    );
    invoke(
        window,
        "make_folder_directory",
        json!({ "scope": "notes", "path": scratch }),
    )?;
    invoke(
        window,
        "write_folder_file",
        json!({
            "scope": "notes",
            "path": staged,
            "bytes": content.as_bytes(),
            "createNew": true,
        }),
    )?;
    invoke(
        window,
        "rename_folder_path",
        json!({ "scope": "notes", "from": staged, "to": inside(fixture, relative) }),
    )
}

fn git(
    window: &WebviewWindow<MockRuntime>,
    args: &[&str],
    request: &str,
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
    git(&main, &["init", "--quiet", "--initial-branch=main"], "1").unwrap();

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
    let initialized = git(&main, &["init", "--quiet", "--initial-branch=main"], "1").unwrap();
    assert_eq!(initialized["code"], 0, "{initialized}");
    assert!(fixture.root.join(".git").is_dir());
    let head = git(&main, &["symbolic-ref", "--quiet", "HEAD"], "2").unwrap();
    assert_eq!(head["stdout"], json!(b"refs/heads/main\n".to_vec()));

    let refused = git(&main, &["config", "core.hooksPath", "/tmp"], "3").unwrap_err();
    assert_eq!(refused["name"], "Unavailable", "{refused}");
    // Cancelling a run that already finished does nothing.
    invoke(&main, "cancel_git", json!({ "request": "2" })).unwrap();
}

/// A loopback Git remote that accepts each connection and never answers, so
/// a fetch from it runs until it is cancelled. Each connection is reported.
fn silent_remote() -> (String, std::sync::mpsc::Receiver<()>) {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("a loopback listener");
    let port = listener.local_addr().unwrap().port();
    let (connected, connections) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut held = Vec::new();
        for stream in listener.incoming() {
            held.push(stream);
            if connected.send(()).is_err() {
                return;
            }
        }
    });
    (format!("http://127.0.0.1:{port}/r.git"), connections)
}

/// Start a fetch from `remote` in `window`'s folder `scope` on another
/// thread, once the remote has seen it connect. Its reply arrives on the
/// returned channel when the fetch ends.
fn start_fetch(
    window: &WebviewWindow<MockRuntime>,
    scope: &str,
    remote: &str,
    connections: &std::sync::mpsc::Receiver<()>,
    request: &str,
) -> std::sync::mpsc::Receiver<Result<Value, Value>> {
    let run = |args: &[&str], request: &str| {
        invoke(
            window,
            "run_git",
            json!({
                "scope": scope,
                "args": args,
                "input": null,
                "indexFile": null,
                "authorization": null,
                "request": request,
            }),
        )
    };
    run(&["init", "--quiet", "--initial-branch=main"], "init").unwrap();
    run(&["config", "remote.origin.url", remote], "remote").unwrap();
    let (replied, reply) = std::sync::mpsc::channel();
    let fetching = window.clone();
    let args = json!({
        "scope": scope,
        "args": ["fetch", "--no-tags", "--quiet", remote, "+refs/heads/main:refs/remotes/origin/main"],
        "input": null,
        "indexFile": null,
        "authorization": null,
        "request": request,
    });
    std::thread::spawn(move || {
        let _ = replied.send(invoke(&fetching, "run_git", args));
    });
    connections
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("the fetch reaches the remote");
    reply
}

const STILL_RUNNING: std::time::Duration = std::time::Duration::from_millis(300);
const ENDS: std::time::Duration = std::time::Duration::from_secs(10);

/// A killed `git` reports no exit code.
fn assert_killed(reply: Result<Value, Value>) {
    let output = reply.expect("a cancelled run still replies");
    assert_eq!(output["code"], Value::Null, "{output}");
}

#[test]
fn a_page_load_or_a_closed_window_cancels_the_runs_of_the_page_before_it() {
    let fixture = fixture("reload");
    let main = window(&fixture.app, "main");
    grant(&main).unwrap();
    let (remote, connections) = silent_remote();
    let reply = start_fetch(&main, "notes", &remote, &connections, "fetch-1");
    assert!(reply.recv_timeout(STILL_RUNNING).is_err(), "the fetch is running");
    // What the plugin does when a page starts loading in the window.
    crate::page_started(main.as_ref());
    assert_killed(reply.recv_timeout(ENDS).unwrap());

    // The same for a window that is destroyed.
    let reply = start_fetch(&main, "notes", &remote, &connections, "fetch-2");
    assert!(reply.recv_timeout(STILL_RUNNING).is_err(), "the fetch is running");
    crate::window_destroyed(fixture.app.handle(), "main");
    assert_killed(reply.recv_timeout(ENDS).unwrap());
}

#[test]
fn a_cancel_that_arrives_before_its_run_stops_it_as_it_starts() {
    let fixture = fixture("early-cancel");
    let main = window(&fixture.app, "main");
    grant(&main).unwrap();
    git(&main, &["init", "--quiet", "--initial-branch=main"], "init").unwrap();
    invoke(&main, "cancel_git", json!({ "request": "early" })).unwrap();
    let refused = git(&main, &["symbolic-ref", "--quiet", "HEAD"], "early").unwrap_err();
    assert!(text(&refused).contains("cancelled before it started"), "{refused}");
    // The cancel is spent: the same ID runs again.
    let head = git(&main, &["symbolic-ref", "--quiet", "HEAD"], "early").unwrap();
    assert_eq!(head["code"], 0, "{head}");
    // A reload forgets a cancel its page left waiting.
    invoke(&main, "cancel_git", json!({ "request": "left" })).unwrap();
    crate::page_started(main.as_ref());
    let head = git(&main, &["symbolic-ref", "--quiet", "HEAD"], "left").unwrap();
    assert_eq!(head["code"], 0, "{head}");
}

#[test]
fn two_windows_runs_with_the_same_id_stay_apart() {
    let fixture = fixture("two-windows");
    fixture
        .app
        .folders()
        .register(ScopeConfig {
            scope: "other-notes".to_string(),
            folder: FolderConfig::new(
                fixture.root.parent().unwrap().join("other-notes"),
                Author {
                    name: "Test Author".to_string(),
                    email: "test@example.com".to_string(),
                },
            ),
            window: "other".to_string(),
        })
        .unwrap();
    let main = window(&fixture.app, "main");
    let other = window(&fixture.app, "other");
    grant(&main).unwrap();
    invoke(&other, "grant_directory", json!({ "scope": "other-notes" })).unwrap();
    let (remote, connections) = silent_remote();
    let reply = start_fetch(&main, "notes", &remote, &connections, "same");

    // The other window runs and cancels its own `same`, and main's goes on.
    let run_other = || {
        invoke(
            &other,
            "run_git",
            json!({
                "scope": "other-notes",
                "args": ["init", "--quiet", "--initial-branch=main"],
                "input": null,
                "indexFile": null,
                "authorization": null,
                "request": "same",
            }),
        )
    };
    assert_eq!(run_other().unwrap()["code"], 0);
    invoke(&other, "cancel_git", json!({ "request": "same" })).unwrap();
    crate::page_started(other.as_ref());
    assert!(reply.recv_timeout(STILL_RUNNING).is_err(), "main's run is untouched");

    invoke(&main, "cancel_git", json!({ "request": "same" })).unwrap();
    assert_killed(reply.recv_timeout(ENDS).unwrap());
}

#[test]
fn after_shutdown_a_late_change_is_refused_and_the_folder_is_unlocked() {
    let fixture = fixture("shutdown");
    let main = window(&fixture.app, "main");
    grant(&main).unwrap();
    git(&main, &["init", "--quiet", "--initial-branch=main"], "1").unwrap();
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
