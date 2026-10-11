//! The shell through Tauri's real invoke path, on the mock runtime.
//!
//! Each test builds the app from the real generated context, so the
//! capability file and the generated command permissions are the ones that
//! ship. Requests are sent exactly as a page's `invoke` sends them. The notes
//! directory is a real directory with the real `git`.
//!
//! Key behaviors:
//! - Every listed command is registered and granted to the notes window, and
//!   refused for any other window.
//! - The folder scope serves the notes window only. The shell writes nothing
//!   inside the root; opening an existing folder changes no file and nothing
//!   in its repository, born or unborn; a root another process holds is busy
//!   and gains no file.
//! - A new folder is set up through the owner, and its settings are the first
//!   commit by the owner's own policy.
//! - A close sends the page one flush event, and exits when the page
//!   acknowledges or the bound runs out, whichever comes first.
//! - The terminal keeps its working directory in the shell.
//!
//! The mock runtime does not implement `AppHandle::exit`, so the close tests
//! replace the exit with a message to the test.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{mock_builder, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{App, Listener, WebviewWindow, WebviewWindowBuilder};

use crate::commands::WINDOW;
use crate::flush::{hold_then, FLUSH_ON_CLOSE};
use crate::testing::{git, temp, TempDirectory};
use crate::{context, folder_config, install, is_app_page, root, shell, COMMANDS};

struct Fixture {
    app: App<MockRuntime>,
    root: PathBuf,
    _directory: TempDirectory,
}

/// The shell over a notes directory that `seed` filled first.
fn fixture(label: &str, seed: impl FnOnce(&Path)) -> Fixture {
    let directory = temp(label);
    let root = directory.path().join("notes-root");
    std::fs::create_dir(&root).unwrap();
    seed(&root);
    let app = shell(mock_builder())
        .build(context())
        .expect("the mock app builds from the real context");
    install(app.handle(), root.clone()).unwrap();
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
            cmd: command.to_string(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|body| body.deserialize::<Value>().unwrap())
}

fn text(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

// ============================================================================
// Registration and permission
// ============================================================================

#[test]
fn every_listed_command_is_registered_and_granted_to_the_notes_window() {
    let fixture = fixture("commands", |_| {});
    let main = window(&fixture.app, WINDOW);
    for command in COMMANDS {
        // No arguments: a registered, permitted command answers or complains
        // about its arguments. It is never missing and never denied.
        let reply = match invoke(&main, command, json!({})) {
            Ok(_) => continue,
            Err(error) => text(&error),
        };
        assert!(!reply.contains("not found"), "{command}: {reply}");
        assert!(!reply.contains("not allowed"), "{command}: {reply}");
    }
}

#[test]
fn another_window_is_denied_every_command_and_the_folder() {
    let fixture = fixture("other-window", |_| {});
    let other = window(&fixture.app, "other");
    for command in COMMANDS {
        let reply = text(&invoke(&other, command, json!({})).unwrap_err());
        assert!(reply.contains("not allowed"), "{command}: {reply}");
    }
    let attach = invoke(
        &other,
        "plugin:epicenter-folder|attach",
        json!({ "scope": root::SCOPE, "protocol": tauri_plugin_epicenter_folder::PROTOCOL }),
    );
    assert!(text(&attach.unwrap_err()).contains("not allowed"));
}

#[test]
fn the_capability_grants_exactly_the_listed_commands_to_the_notes_window() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let capability: Value = serde_json::from_str(
        &std::fs::read_to_string(manifest.join("capabilities/main.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(capability["windows"], json!([WINDOW]));
    assert!(
        capability.get("remote").is_none(),
        "no remote page reaches the shell"
    );
    let mut expected: Vec<String> = COMMANDS
        .iter()
        .map(|command| format!("allow-{}", command.replace('_', "-")))
        .collect();
    expected.extend(
        [
            "core:event:allow-listen",
            "core:event:allow-unlisten",
            "epicenter-folder:default",
        ]
        .map(str::to_string),
    );
    expected.sort();
    let mut granted: Vec<String> = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|permission| permission.as_str().unwrap().to_string())
        .collect();
    granted.sort();
    assert_eq!(granted, expected);

    let config: Value =
        serde_json::from_str(&std::fs::read_to_string(manifest.join("tauri.conf.json")).unwrap())
            .unwrap();
    assert_eq!(config["app"]["security"]["capabilities"], json!(["main"]));
    assert_eq!(config["build"]["frontendDist"], json!("../build-desktop"));
    assert_eq!(config["identifier"], json!(root::SCOPE));
    assert!(
        config["bundle"].get("externalBin").is_none(),
        "no second process is packaged"
    );
    assert!(config["bundle"].get("resources").is_none());
    let policy = config["app"]["security"]["csp"].as_str().unwrap();
    assert!(
        policy.contains("connect-src 'self' ipc: http://ipc.localhost;"),
        "{policy}"
    );
    assert!(policy.contains("script-src 'self';"), "{policy}");
}

#[test]
fn the_window_shows_the_bundled_page_and_nothing_else() {
    for page in [
        "tauri://localhost/",
        "tauri://localhost/index.html",
        "tauri://localhost/some/route?query=1#part",
        "http://tauri.localhost/",
        "http://tauri.localhost/index.html",
    ] {
        assert!(is_app_page(&page.parse().unwrap()), "{page}");
    }
    for page in [
        "https://example.com/",
        "http://127.0.0.1:4999/",
        "tauri://evil.example/",
        "file:///etc/passwd",
        "http://tauri.localhost.evil.example/",
        // The bundled host on another port is another origin.
        "tauri://localhost:1234/",
        "http://tauri.localhost:8080/",
        "http://localhost/",
        // Credentials never belong to the bundled page.
        "tauri://user@localhost/",
        "tauri://user:secret@localhost/",
        "http://user@tauri.localhost/",
        "http://user:secret@tauri.localhost/",
        "http://:secret@tauri.localhost/",
        // The shell does not serve the page over HTTPS.
        "https://tauri.localhost/",
    ] {
        assert!(!is_app_page(&page.parse().unwrap()), "{page}");
    }
}

// ============================================================================
// The folder
// ============================================================================

#[test]
fn history_is_local_and_the_repository_configuration_adds_no_remote() {
    let directory = temp("config");
    git(
        directory.path(),
        &["init", "--quiet", "--initial-branch=main"],
    );
    git(
        directory.path(),
        &["remote", "add", "origin", "https://example.com/notes.git"],
    );
    let config = folder_config(directory.path());
    assert!(config.remote.is_none());
    assert!(config.use_repository_author);
    assert!(!config.use_repository_origin);
    assert!(config.commit_on_edit);
    assert_eq!(config.branch, "main");
}

/// The owner agrees: a folder whose repository names an `origin` is opened
/// with no remote, so nothing is pushed or fetched.
#[test]
fn repository_author_is_used_for_local_history_without_adopting_origin() {
    let fixture = fixture("origin", |root| {
        git(root, &["init", "--quiet", "--initial-branch=main"]);
        git(
            root,
            &["remote", "add", "origin", "https://example.com/notes.git"],
        );
        git(root, &["config", "user.name", "Local Person"]);
        git(root, &["config", "user.email", "local@example.com"]);
    });
    let main = window(&fixture.app, WINDOW);
    let attached = attach(&main).unwrap();
    assert_eq!(attached["snapshot"]["remote"], Value::Null);
    invoke(
        &main,
        "plugin:epicenter-folder|apply",
        json!({
            "session": attached["session"],
            "changes": [{ "kind": "create", "path": "kv.json", "bytes": b"{}\n" }],
        }),
    )
    .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while !git_output(&fixture.root, &["rev-parse", "--verify", "--quiet", "HEAD"]).0 {
        assert!(
            std::time::Instant::now() < deadline,
            "no automatic local commit"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(
        git(&fixture.root, &["log", "-1", "--format=%an <%ae>"]),
        "Local Person <local@example.com>"
    );
    assert_eq!(git(&fixture.root, &["for-each-ref", "refs/remotes"]), "");
    assert_eq!(
        git(&fixture.root, &["config", "remote.origin.url"]),
        "https://example.com/notes.git"
    );
}

const NOTE: &str = "---\r\ntitle:   \"Spaced\"  # keep\r\nextra: [1, 2]\r\n---\r\n\r\n* a\r\n";
const SETTINGS: &str = "{\"kept\":true}";

/// A folder someone already has: a note and its settings.
fn existing(root: &Path) {
    std::fs::create_dir(root.join("notes")).unwrap();
    std::fs::write(root.join("notes/old.md"), NOTE).unwrap();
    std::fs::write(root.join("kv.json"), SETTINGS).unwrap();
}

fn attach(window: &WebviewWindow<MockRuntime>) -> Result<Value, Value> {
    invoke(
        window,
        "plugin:epicenter-folder|attach",
        json!({ "scope": root::SCOPE, "protocol": tauri_plugin_epicenter_folder::PROTOCOL }),
    )
}

/// What the page does on every open: list, then read the settings and a note.
fn look(window: &WebviewWindow<MockRuntime>, session: &Value) {
    invoke(
        window,
        "plugin:epicenter-folder|list",
        json!({ "session": session }),
    )
    .unwrap();
    for path in ["kv.json", "notes/old.md"] {
        invoke(
            window,
            "plugin:epicenter-folder|read",
            json!({ "session": session, "path": path }),
        )
        .unwrap();
    }
    invoke(
        window,
        "plugin:epicenter-folder|status",
        json!({ "session": session }),
    )
    .unwrap();
}

/// `git` output whether or not it succeeded, for a repository that may have
/// no commit.
fn git_output(root: &Path, args: &[&str]) -> (bool, String) {
    let output = std::process::Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .expect("git runs");
    (
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).trim().to_string(),
    )
}

/// The saved work and the repository's history: file bytes and modification
/// times, the head, every ref, and the object count.
fn saved_state(root: &Path) -> Vec<String> {
    let mut state: Vec<String> = ["notes/old.md", "kv.json"]
        .iter()
        .map(|path| {
            let file = root.join(path);
            format!(
                "{path} {:?} {:?}",
                std::fs::read(&file).unwrap(),
                file.metadata().unwrap().modified().unwrap()
            )
        })
        .collect();
    for args in [
        &["rev-parse", "--verify", "--quiet", "HEAD"][..],
        &["for-each-ref"],
        &["count-objects", "-v"],
    ] {
        state.push(format!("{args:?} {:?}", git_output(root, args)));
    }
    state
}

#[test]
fn installing_the_shell_writes_nothing_inside_the_root() {
    let fixture = fixture("install", |_| {});
    assert_eq!(std::fs::read_dir(&fixture.root).unwrap().count(), 0);
}

#[test]
fn an_existing_folder_with_history_is_opened_without_changing_its_files_or_its_repository() {
    let fixture = fixture("attach", |root| {
        existing(root);
        git(root, &["init", "--quiet", "--initial-branch=main"]);
        git(root, &["add", "--all"]);
        git(
            root,
            &["commit", "--quiet", "--message", "Their own first commit"],
        );
    });
    let before = saved_state(&fixture.root);
    let main = window(&fixture.app, WINDOW);
    let attached = attach(&main).expect("the notes window attaches");
    assert_eq!(attached["root"], json!(fixture.root.to_str().unwrap()));
    assert_eq!(attached["snapshot"]["commitOnEdit"], json!(true));
    look(&main, &attached["session"]);
    // Long enough for a commit to have been made, had one been requested.
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(saved_state(&fixture.root), before);
    assert_eq!(
        git(&fixture.root, &["log", "--format=%s"]),
        "Their own first commit"
    );
}

#[test]
fn an_existing_folder_with_an_unborn_repository_stays_unborn_when_opened() {
    let fixture = fixture("unborn", |root| {
        existing(root);
        git(root, &["init", "--quiet", "--initial-branch=main"]);
    });
    let before = saved_state(&fixture.root);
    let main = window(&fixture.app, WINDOW);
    let attached = attach(&main).unwrap();
    look(&main, &attached["session"]);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(saved_state(&fixture.root), before);
    assert!(!git_output(&fixture.root, &["rev-parse", "--verify", "--quiet", "HEAD"]).0);
    assert_eq!(git_output(&fixture.root, &["for-each-ref"]).1, "");
    assert!(git_output(&fixture.root, &["count-objects", "-v"])
        .1
        .contains("count: 0"));
}

#[test]
fn a_root_another_holder_locks_is_busy_and_gains_no_file() {
    let fixture = fixture("busy", |_| {});
    // A competing holder takes the same cross-process lock.
    let other = epicenter_folder_core::lock::RootLock::acquire(&fixture.root)
        .unwrap_or_else(|_| panic!("the test takes the root lock"));
    let main = window(&fixture.app, WINDOW);
    let refused = attach(&main).unwrap_err();
    assert_eq!(refused["name"], json!("Busy"));
    // No layout, no settings, no repository: nothing was written without the lock.
    assert_eq!(std::fs::read_dir(&fixture.root).unwrap().count(), 0);
    drop(other);
    attach(&main).expect("the folder opens once the other holder is gone");
}

/// The calls the page's setup makes for a folder that has nothing yet, in its
/// order, through the owner.
#[test]
fn a_new_folder_is_set_up_through_the_owner_and_its_settings_are_the_first_commit() {
    let fixture = fixture("fresh", |_| {});
    let main = window(&fixture.app, WINDOW);
    let attached = attach(&main).unwrap();
    let session = &attached["session"];
    let missing = invoke(
        &main,
        "plugin:epicenter-folder|read",
        json!({ "session": session, "path": "kv.json" }),
    )
    .unwrap_err();
    assert_eq!(missing["name"], json!("NotFound"));
    for table in ["notes", "folders"] {
        invoke(
            &main,
            "plugin:epicenter-folder|mkdir",
            json!({ "session": session, "path": table }),
        )
        .unwrap();
        assert!(fixture.root.join(table).is_dir());
    }
    let create = |text: &str| {
        invoke(
            &main,
            "plugin:epicenter-folder|apply",
            json!({
                "session": session,
                "changes": [{
                    "kind": "create",
                    "path": "kv.json",
                    "bytes": text.as_bytes(),
                }],
            }),
        )
    };
    create("{}\n").expect("the default settings are published");
    // The owner commits the save by its own policy; nothing asked it to.
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while git_output(&fixture.root, &["rev-list", "--count", "HEAD"]).1 != "1" {
        assert!(std::time::Instant::now() < deadline, "no first commit");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(git(&fixture.root, &["log", "--format=%s"]), "Add kv.json");

    // A second creation loses to the file that is there and changes nothing.
    let refused = create("{\"overwritten\":true}\n").unwrap_err();
    assert_eq!(refused["name"], json!("Refused"));
    assert_eq!(refused["error"]["name"], json!("Exists"));
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("kv.json")).unwrap(),
        "{}\n"
    );
}

#[test]
fn a_scope_the_shell_did_not_register_is_unknown() {
    let fixture = fixture("unknown-scope", |_| {});
    let main = window(&fixture.app, WINDOW);
    let refused = invoke(
        &main,
        "plugin:epicenter-folder|attach",
        json!({ "scope": "so.epicenter.other", "protocol": tauri_plugin_epicenter_folder::PROTOCOL }),
    )
    .unwrap_err();
    assert_eq!(refused["name"], json!("UnknownScope"));
}

/// The two failures the acceptance route produces by hand in a disposable
/// folder, with nothing injected: a save that cannot be written, and a commit
/// that cannot be recorded.
#[cfg(unix)]
#[test]
fn a_save_that_cannot_be_written_fails_alone_and_a_commit_that_cannot_be_recorded_leaves_the_save()
{
    use std::os::unix::fs::PermissionsExt;

    let fixture = fixture("failures", |_| {});
    let main = window(&fixture.app, WINDOW);
    let attached = invoke(
        &main,
        "plugin:epicenter-folder|attach",
        json!({ "scope": root::SCOPE, "protocol": tauri_plugin_epicenter_folder::PROTOCOL }),
    )
    .unwrap();
    let session = &attached["session"];
    let write = |path: &str, text: &str| {
        invoke(
            &main,
            "plugin:epicenter-folder|apply",
            json!({
                "session": session,
                "changes": [{
                    "kind": "overwrite",
                    "path": path,
                    "bytes": text.as_bytes(),
                }],
            }),
        )
    };
    let commit = || {
        invoke(
            &main,
            "plugin:epicenter-folder|commit",
            json!({ "session": session }),
        )
        .unwrap()["status"]
            .clone()
    };
    write("notes/a.md", "first\n").expect("an ordinary save lands");
    // The save's own commit may already have recorded it.
    let first = commit();
    assert!(
        first == json!("committed") || first == json!("unchanged"),
        "{first}"
    );

    // `chmod a-w notes`: the save fails and nothing is written.
    let notes = fixture.root.join("notes");
    std::fs::set_permissions(&notes, std::fs::Permissions::from_mode(0o555)).unwrap();
    let refused = write("notes/a.md", "second\n");
    std::fs::set_permissions(&notes, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(refused.is_err(), "{refused:?}");
    assert_eq!(
        std::fs::read_to_string(notes.join("a.md")).unwrap(),
        "first\n"
    );

    // `touch .git/refs/heads/main.lock`: the save lands, the commit fails.
    let lock = fixture.root.join(".git/refs/heads/main.lock");
    std::fs::write(&lock, "").unwrap();
    write("notes/a.md", "third\n").expect("the save does not wait for history");
    assert_eq!(commit(), json!("failed"));
    assert_eq!(
        std::fs::read_to_string(notes.join("a.md")).unwrap(),
        "third\n"
    );
    std::fs::remove_file(&lock).unwrap();
    assert_eq!(commit(), json!("committed"));
}

// ============================================================================
// Closing
// ============================================================================

/// Hold a close as the shell does, with the exit reported to the test. Answers
/// whether it was held, and receives the moment the app would exit.
fn close(fixture: &Fixture, bound: Duration) -> (bool, mpsc::Receiver<Instant>) {
    let (exited, exit) = mpsc::channel();
    let held = hold_then(fixture.app.handle(), bound, move |_| {
        let _ = exited.send(Instant::now());
    });
    (held, exit)
}

#[test]
fn a_close_the_page_acknowledges_exits_at_once() {
    let fixture = fixture("close-ack", |_| {});
    let main = window(&fixture.app, WINDOW);
    let (sender, flushes) = mpsc::channel::<()>();
    main.listen(FLUSH_ON_CLOSE, move |_| {
        let _ = sender.send(());
    });

    let started = Instant::now();
    let (held, exit) = close(&fixture, Duration::from_secs(10));
    assert!(held);
    flushes
        .recv_timeout(Duration::from_secs(5))
        .expect("the page is sent the flush event");
    // A second close while the page flushes is held and sends nothing more.
    let (held_again, exit_again) = close(&fixture, Duration::from_secs(10));
    assert!(held_again);

    assert_eq!(invoke(&main, "flush_done", json!({})), Ok(Value::Null));
    let exited = exit
        .recv_timeout(Duration::from_secs(5))
        .expect("the app exits once the page acknowledges");
    assert!(exited - started < Duration::from_secs(5));
    assert!(flushes.try_recv().is_err(), "one flush event per close");
    assert!(exit_again.try_recv().is_err(), "one exit per close");

    // Once the wait is over, the exit request the exit raises goes ahead.
    let (held_after, _) = close(&fixture, Duration::from_secs(10));
    assert!(!held_after);
}

#[test]
fn a_close_the_page_never_acknowledges_exits_at_the_bound() {
    let fixture = fixture("close-silent", |_| {});
    let bound = Duration::from_millis(200);
    let started = Instant::now();
    let (held, exit) = close(&fixture, bound);
    assert!(held);
    let exited = exit
        .recv_timeout(Duration::from_secs(5))
        .expect("the app exits without the page");
    assert!(exited - started >= bound);
}

#[test]
fn another_window_cannot_end_the_wait() {
    let fixture = fixture("close-other", |_| {});
    let other = window(&fixture.app, "other");
    let (held, exit) = close(&fixture, Duration::from_millis(300));
    assert!(held);
    assert!(invoke(&other, "flush_done", json!({})).is_err());
    assert!(exit.recv_timeout(Duration::from_millis(150)).is_err());
    exit.recv_timeout(Duration::from_secs(5))
        .expect("the bound still ends the wait");
}

// ============================================================================
// Terminal and history
// ============================================================================

#[cfg(unix)]
#[test]
fn shell_info_returns_while_a_terminal_command_is_still_running() {
    let fixture = fixture("terminal-reload", |_| {});
    let main = window(&fixture.app, WINDOW);
    let runner = {
        let main = main.clone();
        std::thread::spawn(move || {
            invoke(
                &main,
                "terminal_run",
                json!({
                    "command": "touch started; while [ ! -f finish ]; do sleep 0.01; done"
                }),
            )
        })
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !fixture.root.join("started").exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "terminal never started"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let (sent, received) = mpsc::channel();
    let reader = {
        let main = main.clone();
        std::thread::spawn(move || sent.send(invoke(&main, "shell_info", json!({}))))
    };
    let info = received.recv_timeout(Duration::from_secs(2));
    // Always finish the command before asserting, including on regression.
    std::fs::write(fixture.root.join("finish"), "").unwrap();
    runner.join().unwrap().unwrap();
    reader.join().unwrap().unwrap();
    let info = info
        .expect("shell_info blocked behind the command")
        .unwrap();
    assert_eq!(info["cwd"], json!(fixture.root.to_str().unwrap()));
}

#[test]
fn the_terminal_runs_in_the_root_and_the_shell_keeps_its_working_directory() {
    let fixture = fixture("terminal", |root| {
        std::fs::create_dir(root.join("notes")).unwrap();
    });
    let main = window(&fixture.app, WINDOW);
    let root = fixture.root.to_str().unwrap();
    assert_eq!(
        invoke(&main, "shell_info", json!({})),
        Ok(json!({ "root": root, "cwd": root }))
    );
    let moved = invoke(
        &main,
        "terminal_run",
        json!({ "command": "cd notes && pwd -P; (exit 3)" }),
    )
    .unwrap();
    assert_eq!(
        moved,
        json!({
            "stdout": format!("{root}/notes\n"),
            "stderr": "",
            "exitCode": 3,
            "cwd": format!("{root}/notes"),
        })
    );
    // A reloaded page asks where the terminal is; it never tells.
    assert_eq!(
        invoke(&main, "shell_info", json!({})).unwrap()["cwd"],
        json!(format!("{root}/notes"))
    );
    let next = invoke(&main, "terminal_run", json!({ "command": "pwd -P" })).unwrap();
    assert_eq!(next["stdout"], json!(format!("{root}/notes\n")));
    // A working directory offered by the page is not an argument.
    let ignored = invoke(
        &main,
        "terminal_run",
        json!({ "command": "pwd -P", "cwd": "/" }),
    )
    .unwrap();
    assert_eq!(ignored["stdout"], json!(format!("{root}/notes\n")));
}

#[test]
fn a_file_lists_its_commits_and_reads_an_old_version_through_the_commands() {
    let fixture = fixture("history", |root| {
        git(root, &["init", "--quiet", "--initial-branch=main"]);
        std::fs::create_dir(root.join("notes")).unwrap();
        std::fs::write(root.join("notes/a.md"), "first\n").unwrap();
        git(root, &["add", "--all"]);
        git(root, &["commit", "--quiet", "--message", "Add notes/a.md"]);
        std::fs::write(root.join("notes/a.md"), "second\n").unwrap();
        git(
            root,
            &[
                "commit",
                "--quiet",
                "--all",
                "--message",
                "Update notes/a.md",
            ],
        );
    });
    let main = window(&fixture.app, WINDOW);
    let log = invoke(
        &main,
        "file_log",
        json!({ "path": "notes/a.md", "depth": 10 }),
    )
    .unwrap();
    let revisions = log.as_array().unwrap();
    assert_eq!(revisions.len(), 2);
    assert_eq!(revisions[0]["subject"], json!("Update notes/a.md"));
    assert!(revisions[0]["timestamp"].is_u64());
    assert_eq!(
        invoke(
            &main,
            "file_show",
            json!({ "oid": revisions[1]["oid"], "path": "notes/a.md" })
        ),
        Ok(json!("first\n"))
    );
    assert_eq!(
        invoke(
            &main,
            "file_show",
            json!({ "oid": "HEAD", "path": "notes/a.md" })
        ),
        Err(json!("Not a commit id."))
    );
    assert_eq!(
        invoke(&main, "file_log", json!({ "path": "../x", "depth": 10 })),
        Err(json!("the path contains a relative segment"))
    );
}
