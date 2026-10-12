//! The plugin through Tauri's real invoke path, on the mock runtime.
//!
//! Each test builds an app with the plugin installed, creates windows, and
//! sends `plugin:epicenter-folder|...` requests exactly as a page's `invoke` would. The
//! folder is a real directory with a real repository.
//!
//! Key behaviors:
//! - The generated TypeScript bindings match the registered commands.
//! - A window attaches only to scopes registered for its label.
//! - A session belongs to the window that attached it; another window that
//!   names it is denied, and a page never supplies a root.
//! - Two windows share one owner: saves, conflicts, events, and history.
//! - Detaching one window leaves the other and the commit already admitted.
//! - Saves are not ordered by the page: one held before the folder lands
//!   after a later one and stays, and a second delivery lands again. One the
//!   plugin took before its session ended still lands. A second scope cannot
//!   open the same root.
//! - A page built for another protocol is refused at attach.
//! - A push request withdrawn before the owner starts its transport never
//!   reaches the remote; one already started finishes, and ending a session
//!   withdraws only what had not started.
//! - `merge_incoming`'s unrelated-history consent and conflict versions are
//!   optional arguments: absent or `null` is `false`, and sent they reach the
//!   owner, with each side's bytes on the wire.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
use tauri::utils::acl::ExecutionContext;
use tauri::webview::InvokeRequest;
use tauri::{App, Listener, Manager, WebviewWindow, WebviewWindowBuilder};

use crate::{init, Author, FolderConfig, FolderExt, Remote, ScopeConfig, COMMANDS, PROTOCOL};

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

/// An app whose windows may call every plugin command, with the scope
/// `notes` registered for `windows`.
fn fixture(label: &str, windows: &[&str]) -> Fixture {
    fixture_in(temp(label), windows, None)
}

fn fixture_in(directory: TempDirectory, windows: &[&str], remote: Option<Remote>) -> Fixture {
    let root = directory.0.join("notes");
    std::fs::create_dir(&root).unwrap();
    let mut context = mock_context(noop_assets());
    for command in COMMANDS {
        context.runtime_authority_mut().__allow_command(
            format!("plugin:epicenter-folder|{command}"),
            ExecutionContext::Local,
        );
    }
    let app = mock_builder()
        .plugin(init())
        .build(context)
        .expect("mock app");
    app.folders()
        .register(ScopeConfig {
            scope: "notes".to_string(),
            folder: FolderConfig {
                remote,
                watch_events: false,
                watch_interval: None,
                ..FolderConfig::new(
                    &root,
                    Author {
                        name: "Test Author".to_string(),
                        email: "test@example.com".to_string(),
                    },
                )
            },
            windows: windows.iter().map(|window| window.to_string()).collect(),
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

fn attach(window: &WebviewWindow<MockRuntime>) -> u64 {
    let attached = invoke(
        window,
        "attach",
        json!({ "scope": "notes", "protocol": PROTOCOL }),
    )
    .expect("attach");
    attached["session"].as_u64().expect("a session resource ID")
}

fn create(path: &str, content: &str) -> Value {
    json!({ "kind": "create", "path": path, "bytes": content.as_bytes() })
}

fn overwrite(path: &str, content: &str) -> Value {
    json!({ "kind": "overwrite", "path": path, "bytes": content.as_bytes() })
}

/// A replacement conditional on the hash a read returned.
fn replace(path: &str, content: &str, expected_sha256: &Value) -> Value {
    json!({
        "kind": "replace",
        "path": path,
        "bytes": content.as_bytes(),
        "expectedSha256": expected_sha256,
    })
}

fn apply(
    window: &WebviewWindow<MockRuntime>,
    session: u64,
    changes: Value,
) -> Result<Value, Value> {
    invoke(
        window,
        "apply",
        json!({ "session": session, "changes": changes }),
    )
}

/// Return once no commit the owner admitted is still running. `paths` takes
/// the Git lock, which an admitted commit holds from before its save returned
/// until it has recorded its outcome.
fn idle(window: &WebviewWindow<MockRuntime>, session: u64) {
    invoke(window, "paths", json!({ "session": session })).expect("paths");
}

fn git(root: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn eventually(what: &str, condition: impl Fn() -> bool) {
    for _ in 0..2000 {
        if condition() {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("timed out waiting for {what}");
}

#[test]
fn a_window_attaches_reads_publishes_and_commits_through_invoke() {
    let fixture = fixture("round-trip", &["main"]);
    let main = window(&fixture.app, "main");
    let attached = invoke(
        &main,
        "attach",
        json!({ "scope": "notes", "protocol": PROTOCOL }),
    )
    .unwrap();
    let session = attached["session"].as_u64().unwrap();
    assert_eq!(attached["snapshot"]["branch"], "main");
    assert!(attached["snapshot"].get("commitOnEdit").is_none());
    assert_eq!(
        attached["snapshot"]["files"],
        json!({ "state": "unknown", "error": null })
    );
    assert_eq!(attached["snapshot"]["closed"], false);
    assert_eq!(
        attached["snapshot"]["activity"]["commit"],
        json!({ "active": false }),
        "activity reports what is running and nothing else"
    );

    apply(
        &main,
        session,
        json!([
            create("todos/a.md", "first"),
            create("todos/a.png", "image"),
        ]),
    )
    .unwrap();
    let read = invoke(
        &main,
        "read",
        json!({ "session": session, "path": "todos/a.md" }),
    )
    .unwrap();
    assert_eq!(read["bytes"], json!("first".as_bytes()));
    // A read is its bytes and their hash, computed by the owner.
    assert_eq!(
        read["sha256"],
        "a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e"
    );
    assert_eq!(read.as_object().unwrap().len(), 2);
    let sha256 = read["sha256"].clone();
    assert_eq!(
        invoke(
            &main,
            "children",
            json!({ "session": session, "directory": "todos" })
        )
        .unwrap(),
        json!({ "files": ["a.md", "a.png"], "directories": [] })
    );
    assert_eq!(
        invoke(&main, "list", json!({ "session": session })).unwrap(),
        json!({
            "files": [{ "path": "todos/a.md", "size": 5 }, { "path": "todos/a.png", "size": 5 }],
            "directories": ["todos"],
        })
    );
    let many = invoke(
        &main,
        "read_many",
        json!({ "session": session, "paths": ["todos/a.png", "missing.md"] }),
    )
    .unwrap();
    assert_eq!(many[0]["status"], "ok");
    assert_eq!(many[0]["value"]["bytes"], json!("image".as_bytes()));
    assert_eq!(
        many[1],
        json!({ "status": "err", "error": { "name": "NotFound", "path": "missing.md" } })
    );

    // A typed refusal crosses as the rejection, with nothing written.
    let occupied = apply(&main, session, json!([create("todos/a.md", "again")])).unwrap_err();
    assert_eq!(
        occupied,
        json!({ "name": "Refused", "error": { "name": "Exists", "path": "todos/a.md" } })
    );
    let escaped = apply(&main, session, json!([overwrite("../outside.md", "x")])).unwrap_err();
    assert_eq!(escaped["error"]["name"], "InvalidPath");
    assert!(!fixture.root.parent().unwrap().join("outside.md").exists());

    // A replacement naming a hash the file does not have is a conflict, and
    // one for a missing file reports no actual hash.
    let stale = "0".repeat(64);
    for (path, actual) in [("todos/a.md", sha256.clone()), ("missing.md", Value::Null)] {
        let conflict = apply(
            &main,
            session,
            json!([replace(path, "never lands", &json!(stale))]),
        )
        .unwrap_err();
        assert_eq!(
            conflict["error"],
            json!({
                "name": "Conflict",
                "path": path,
                "expectedSha256": stale,
                "actualSha256": actual,
            })
        );
    }

    // A replacement naming the exact hash that was read replaces the file.
    apply(
        &main,
        session,
        json!([replace("todos/a.md", "second", &sha256)]),
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("todos/a.md")).unwrap(),
        "second"
    );

    // A move and a removal name the hash as `expectedSha256`, or omit it.
    // The earlier `write` shape with an `expected` object is not a change.
    assert!(apply(
        &main,
        session,
        json!([{
            "kind": "write",
            "path": "old.md",
            "bytes": [],
            "expected": { "kind": "any" },
        }]),
    )
    .is_err());
    assert!(!fixture.root.join("old.md").exists());
    apply(&main, session, json!([create("scratch.md", "first")])).unwrap();
    let guarded = apply(
        &main,
        session,
        json!([{ "kind": "move", "from": "scratch.md", "to": "moved.md", "expectedSha256": stale }]),
    )
    .unwrap_err();
    assert_eq!(guarded["error"]["name"], "Conflict");
    assert_eq!(guarded["error"]["actualSha256"], sha256);
    apply(
        &main,
        session,
        json!([
            { "kind": "move", "from": "scratch.md", "to": "moved.md", "expectedSha256": sha256 },
            create("other.md", "other"),
        ]),
    )
    .unwrap();
    let occupied = apply(
        &main,
        session,
        json!([{ "kind": "move", "from": "other.md", "to": "moved.md" }]),
    )
    .unwrap_err();
    assert_eq!(
        occupied["error"],
        json!({ "name": "Exists", "path": "moved.md" })
    );
    apply(
        &main,
        session,
        json!([
            { "kind": "remove", "path": "moved.md", "expectedSha256": sha256 },
            { "kind": "remove", "path": "other.md" },
        ]),
    )
    .unwrap();
    assert!(!fixture.root.join("moved.md").exists() && !fixture.root.join("other.md").exists());

    // Every save asked for a commit; once they ran, nothing is uncommitted.
    eventually("the saves to be committed", || {
        invoke(&main, "status", json!({ "session": session })).unwrap()["changes"] == json!([])
    });
    // A file another program writes waits for a commit someone asks for.
    std::fs::write(fixture.root.join("outside.md"), "outside").unwrap();
    std::fs::write(fixture.root.join("todos/a.png"), "edited").unwrap();
    let status = invoke(&main, "status", json!({ "session": session })).unwrap();
    assert_eq!(
        status["changes"],
        json!([{ "path": "outside.md", "kind": "add" }, { "path": "todos/a.png", "kind": "modify" }])
    );
    // The commit command replies with the settled outcome itself.
    let committed = invoke(&main, "commit", json!({ "session": session })).unwrap();
    assert_eq!(committed["status"], "committed");
    assert_eq!(committed["message"], "Update 2 files");
    assert_eq!(committed["changedPaths"], 2);
    assert!(committed.get("outcome").is_none() && committed.get("followingPush").is_none());
    assert_eq!(
        git(&fixture.root, &["log", "-1", "--format=%s"]),
        "Update 2 files"
    );
    let log = invoke(&main, "log", json!({ "session": session, "depth": 5 })).unwrap();
    assert_eq!(log[0]["oid"], committed["oid"]);
    assert_eq!(log[0]["author"]["name"], "Test Author");
    assert_eq!(
        push(&main, session, open_request(&main, session)).unwrap(),
        json!({ "status": "noRemote" })
    );
    let fetching = open_request(&main, session);
    let fetch = || {
        invoke(
            &main,
            "fetch",
            json!({ "session": session, "request": fetching }),
        )
        .unwrap_err()
    };
    assert_eq!(fetch(), json!({ "name": "NoRemote" }));
    // A request serves one command. Once that command has its answer the
    // request is gone, and naming it again starts nothing.
    let gone = fetch();
    assert_eq!(gone["name"], "Denied");
    assert!(
        gone["reason"].as_str().unwrap().contains("no such request"),
        "{gone}"
    );
    assert_eq!(
        invoke(&main, "pull_fast_forward", json!({ "session": session })).unwrap_err(),
        json!({ "name": "Git", "error": { "name": "NoRemote" } })
    );
    // A merge needs a remote first.
    assert_eq!(
        invoke(&main, "merge_incoming", json!({ "session": session })).unwrap_err(),
        json!({ "name": "Pull", "error": { "name": "Git", "error": { "name": "NoRemote" } } })
    );

    // Paths and diff report a change another program made, unstaged.
    std::fs::write(fixture.root.join("outside.md"), "changed").unwrap();
    assert_eq!(
        invoke(&main, "paths", json!({ "session": session })).unwrap(),
        json!([{ "path": "outside.md", "index": " ", "worktree": "M" }])
    );
    let diff = invoke(&main, "diff", json!({ "session": session, "paths": [] })).unwrap();
    assert!(diff.as_str().unwrap().contains("+changed"), "{diff}");

    for response in [&status, &committed] {
        assert!(response.to_string().len() < 1024, "{response}");
    }
}

#[test]
fn a_window_reaches_only_its_own_scopes_and_its_own_sessions() {
    let fixture = fixture("sessions", &["a", "b"]);
    let a = window(&fixture.app, "a");
    let b = window(&fixture.app, "b");
    let intruder = window(&fixture.app, "intruder");

    assert_eq!(
        invoke(
            &intruder,
            "attach",
            json!({ "scope": "notes", "protocol": PROTOCOL })
        )
        .unwrap_err(),
        json!({ "name": "WindowNotPermitted", "scope": "notes", "window": "intruder" })
    );
    assert_eq!(
        invoke(
            &a,
            "attach",
            json!({ "scope": "elsewhere", "protocol": PROTOCOL })
        )
        .unwrap_err(),
        json!({ "name": "UnknownScope", "scope": "elsewhere" })
    );
    assert!(
        !fixture.root.join(".git").exists(),
        "a refused attach opens nothing"
    );
    // A page cannot name a root: the command has no such argument to honor.
    let ignored = invoke(
        &a,
        "attach",
        json!({ "scope": "notes", "protocol": PROTOCOL, "root": "/tmp/elsewhere" }),
    )
    .unwrap();
    assert_eq!(
        ignored["root"],
        fixture.root.display().to_string(),
        "attach reports the owner's root"
    );
    assert_eq!(
        invoke(
            &b,
            "attach",
            json!({ "scope": "notes", "protocol": PROTOCOL + 1 })
        )
        .unwrap_err(),
        json!({ "name": "Incompatible", "host": PROTOCOL, "page": PROTOCOL + 1 })
    );
    // A page built for the previous protocol is refused before other calls.
    assert_eq!(
        invoke(
            &b,
            "attach",
            json!({ "scope": "notes", "protocol": PROTOCOL - 1 })
        )
        .unwrap_err(),
        json!({ "name": "Incompatible", "host": PROTOCOL, "page": PROTOCOL - 1 })
    );
    let no_session = invoke(&b, "list", json!({ "session": 1 })).unwrap_err();
    assert_eq!(
        no_session["name"], "Denied",
        "the refused page has no session"
    );
    let a_session = ignored["session"].as_u64().unwrap();
    assert!(
        fixture.root.join(".git/HEAD").is_file(),
        "the registered root was opened"
    );
    apply(&a, a_session, json!([create("a.md", "from a")])).unwrap();

    // Another window naming A's session is denied on every kind of call.
    let denied = json!({
        "name": "Denied",
        "reason": "this window has no such folder session; attach first",
    });
    for window in [&b, &intruder] {
        assert_eq!(
            invoke(
                window,
                "read",
                json!({ "session": a_session, "path": "a.md" })
            )
            .unwrap_err(),
            denied
        );
        assert_eq!(
            apply(window, a_session, json!([overwrite("a.md", "stolen")])).unwrap_err(),
            json!({ "name": "Refused", "error": denied })
        );
        for command in ["commit", "status"] {
            assert_eq!(
                invoke(window, command, json!({ "session": a_session })).unwrap_err(),
                denied
            );
        }
        assert_eq!(
            invoke(
                window,
                "mkdir",
                json!({ "session": a_session, "path": "made" })
            )
            .unwrap_err(),
            denied
        );
        assert_eq!(
            invoke(window, "pull_fast_forward", json!({ "session": a_session })).unwrap_err(),
            json!({ "name": "Git", "error": denied })
        );
    }
    assert!(!fixture.root.join("made").exists());
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("a.md")).unwrap(),
        "from a"
    );
}

#[test]
fn two_windows_share_one_owner_and_detaching_one_leaves_the_other() {
    let fixture = fixture("shared", &["a", "b"]);
    let a = window(&fixture.app, "a");
    let b = window(&fixture.app, "b");
    let heard: Arc<Mutex<Vec<Value>>> = Arc::default();
    let listener = Arc::clone(&heard);
    fixture.app.listen_any(
        "plugin:epicenter-folder:folder-files-changed",
        move |event| {
            listener
                .lock()
                .unwrap()
                .push(serde_json::from_str(event.payload()).unwrap());
        },
    );
    let a_session = attach(&a);
    let b_session = attach(&b);

    apply(&a, a_session, json!([create("a.md", "base")])).unwrap();
    let base = invoke(&b, "read", json!({ "session": b_session, "path": "a.md" })).unwrap()
        ["sha256"]
        .clone();

    // Both windows replace the bytes they both read: exactly one lands.
    let results: Vec<Result<Value, Value>> = std::thread::scope(|scope| {
        let saves = [(&a, a_session, "from a"), (&b, b_session, "from b")].map(
            |(window, session, content)| {
                let expected = base.clone();
                scope.spawn(move || {
                    apply(
                        window,
                        session,
                        json!([replace("a.md", content, &expected)]),
                    )
                })
            },
        );
        saves.into_iter().map(|save| save.join().unwrap()).collect()
    });
    assert_eq!(
        results.iter().filter(|result| result.is_ok()).count(),
        1,
        "{results:?}"
    );
    let lost = results
        .iter()
        .find_map(|result| result.as_ref().err())
        .unwrap();
    assert_eq!(lost["error"]["name"], "Conflict");
    assert_eq!(lost["error"]["expectedSha256"], base);
    assert!(lost["error"]["actualSha256"].is_string());

    // Each attached window heard the saves, whichever window made them.
    eventually("both windows to hear both saves", || {
        heard.lock().unwrap().len() >= 4
    });
    assert!(heard
        .lock()
        .unwrap()
        .iter()
        .all(|event| event["scope"] == "notes" && event["paths"] == json!(["a.md"])));

    // Window A saves and goes away at once. The owner admitted the save's
    // commit before the save returned, and finishes it without the window.
    // The earlier saves' commits are let finish first: a save made while one
    // of them held the Git lock would have its own attempt skipped.
    idle(&a, a_session);
    apply(
        &a,
        a_session,
        json!([create("last.md", "saved as the page closed")]),
    )
    .unwrap();
    invoke(&a, "detach", json!({ "session": a_session })).unwrap();
    assert_eq!(
        invoke(&a, "read", json!({ "session": a_session, "path": "a.md" })).unwrap_err()["name"],
        "Denied"
    );
    eventually("the detached window's save to be committed", || {
        fixture.root.join(".git/refs/heads/main").exists()
            && git(&fixture.root, &["ls-tree", "-r", "--name-only", "HEAD"]) == "a.md\nlast.md"
    });

    // Window B is untouched: same session, same owner, same history.
    idle(&b, b_session);
    apply(&b, b_session, json!([create("b.md", "after a left")])).unwrap();
    idle(&b, b_session);
    assert_eq!(
        git(&fixture.root, &["ls-tree", "-r", "--name-only", "HEAD"]),
        "a.md\nb.md\nlast.md"
    );
    let status = invoke(&b, "status", json!({ "session": b_session })).unwrap();
    assert_eq!(status["changes"], json!([]));

    // The commands a page built for the terminal lease would send are gone.
    // One is refused before the plugin sees it, and holds nothing.
    for command in ["acquire_lease", "release_lease"] {
        let refused = invoke(&b, command, json!({ "session": b_session, "lease": 1 })).unwrap_err();
        assert!(refused.is_string(), "{command}: {refused}");
    }
    // A new session of window A saves at once: nothing of B's holds it out.
    let a_again = attach(&a);
    apply(&a, a_again, json!([create("again.md", "x")])).unwrap();

    // Shutdown drains what was admitted and refuses what comes after. That
    // save was admitted for its commit when it landed, with the folder free.
    fixture.app.folders().shutdown();
    assert_eq!(
        apply(&b, b_session, json!([create("late.md", "x")])).unwrap_err(),
        json!({ "name": "Refused", "error": { "name": "Closed" } })
    );
    assert_eq!(
        invoke(
            &a,
            "attach",
            json!({ "scope": "notes", "protocol": PROTOCOL })
        )
        .unwrap_err(),
        json!({ "name": "ShuttingDown" })
    );
    assert_eq!(
        git(&fixture.root, &["status", "--porcelain"]),
        "",
        "the admitted commit finished before shutdown returned"
    );
}

/// A bare remote whose `pre-receive` hook holds every push that carries
/// commits: the real `git push` the owner started stays in flight until the
/// test releases it. Each held push records what it carries.
#[cfg(unix)]
struct HeldRemote {
    bare: PathBuf,
    gate: PathBuf,
}

#[cfg(unix)]
impl HeldRemote {
    fn new(directory: &Path) -> (Self, Remote) {
        use std::os::unix::fs::PermissionsExt;
        let bare = directory.join("remote.git");
        let gate = directory.join("gate");
        std::fs::create_dir_all(&bare).unwrap();
        std::fs::create_dir(&gate).unwrap();
        git(
            &bare,
            &["init", "--quiet", "--bare", "--initial-branch=main"],
        );
        // The update is written under another name first, so a file named
        // `arrived-N` is always complete.
        let script = [
            "#!/bin/sh",
            &format!("cd '{}' || exit 1", gate.display()),
            "n=$(($(ls | grep -c '^arriv') + 1))",
            "cat > \"arriving-$n\"",
            "mv \"arriving-$n\" \"arrived-$n\"",
            "while [ ! -e \"release-$n\" ]; do sleep 0.02; done",
            "",
        ]
        .join("\n");
        let hook = bare.join("hooks/pre-receive");
        std::fs::write(&hook, script).unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        let remote = Remote {
            url: bare.display().to_string(),
            branch: "main".to_string(),
        };
        (Self { bare, gate }, remote)
    }

    /// Wait for the `n`th push to reach the remote, and say which commit it
    /// carries. It stays held there.
    fn arrived(&self, n: usize) -> String {
        let arrived = self.gate.join(format!("arrived-{n}"));
        eventually("a push to reach the remote", || arrived.is_file());
        let update = std::fs::read_to_string(arrived).unwrap();
        update.split_whitespace().nth(1).unwrap().to_string()
    }

    /// How many pushes have reached the remote so far.
    fn arrivals(&self) -> usize {
        std::fs::read_dir(&self.gate)
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("arriv"))
            .count()
    }

    fn release(&self, n: usize) {
        std::fs::write(self.gate.join(format!("release-{n}")), "").unwrap();
    }

    fn head(&self) -> String {
        git(&self.bare, &["rev-parse", "main"])
    }
}

/// A folder that does not commit on edit, with a remote whose pushes are held.
#[cfg(unix)]
fn held_fixture(label: &str, windows: &[&str]) -> (Fixture, HeldRemote) {
    let directory = temp(label);
    let (held, remote) = HeldRemote::new(&directory.0);
    (fixture_in(directory, windows, Some(remote)), held)
}

fn open_request(window: &WebviewWindow<MockRuntime>, session: u64) -> u64 {
    invoke(window, "open_request", json!({ "session": session }))
        .expect("open a request")
        .as_u64()
        .expect("a request number")
}

fn push(window: &WebviewWindow<MockRuntime>, session: u64, request: u64) -> Result<Value, Value> {
    invoke(
        window,
        "push",
        json!({ "session": session, "request": request }),
    )
}

#[cfg(unix)]
fn withdraw(window: &WebviewWindow<MockRuntime>, session: u64, request: u64) {
    invoke(
        window,
        "withdraw_request",
        json!({ "session": session, "request": request }),
    )
    .expect("withdrawing never fails");
}

/// Save one file and commit it; the commit's ID.
#[cfg(unix)]
fn commit_file(window: &WebviewWindow<MockRuntime>, session: u64, path: &str) -> String {
    apply(window, session, json!([create(path, path)])).unwrap();
    // The save's automatic commit, or this one if it gets there first.
    let committed = invoke(window, "commit", json!({ "session": session })).unwrap();
    assert!(
        committed["status"] == "committed" || committed["status"] == "unchanged",
        "{committed}"
    );
    let head = invoke(window, "log", json!({ "session": session, "depth": 1 })).unwrap();
    assert_eq!(
        head[0]["message"].as_str().unwrap().trim_end(),
        format!("Add {path}")
    );
    head[0]["oid"].as_str().unwrap().to_string()
}

/// What the owner replies for a push it never started: this request pinned
/// no commit and sent nothing. A push that named a request the session no
/// longer has is refused on arrival instead; that started nothing either.
/// Which of the two a test sees depends on whether the push command had
/// reached the owner when its request was withdrawn.
#[cfg(unix)]
fn assert_never_started(reply: Result<Value, Value>) {
    match reply {
        Ok(outcome) => assert_eq!(outcome, json!({ "status": "cancelled", "oid": null })),
        Err(refused) => assert_eq!(refused["name"], "Denied", "{refused}"),
    }
}

#[cfg(unix)]
#[test]
fn a_push_withdrawn_before_its_transport_starts_never_reaches_the_remote() {
    let (fixture, remote) = held_fixture("withdraw", &["a", "b"]);
    let a = window(&fixture.app, "a");
    let b = window(&fixture.app, "b");
    let a_session = attach(&a);
    let b_session = attach(&b);
    let first = commit_file(&a, a_session, "one.md");
    let (a, b) = (&a, &b);

    std::thread::scope(|scope| {
        // A's push is a real `git push`, held inside the remote.
        let a_request = open_request(&a, a_session);
        let a_pushing = scope.spawn(move || push(a, a_session, a_request));
        assert_eq!(remote.arrived(1), first);
        // Its request is in use: a second command cannot take it.
        let duplicate = push(&a, a_session, a_request).unwrap_err();
        assert_eq!(duplicate["name"], "Denied");
        assert!(
            duplicate["reason"]
                .as_str()
                .unwrap()
                .contains("already in use"),
            "{duplicate}"
        );
        // A second commit, so a push started for B would carry it.
        let second = commit_file(&a, a_session, "two.md");

        // Withdrawn before the push command arrives: refused, nothing queued.
        let early = open_request(&a, a_session);
        withdraw(&a, a_session, early);
        let refused = push(&a, a_session, early).unwrap_err();
        assert_eq!(refused["name"], "Denied");
        assert!(
            refused["reason"]
                .as_str()
                .unwrap()
                .contains("nothing was started"),
            "{refused}"
        );

        // B asks behind A and withdraws while A is still in flight.
        let b_request = open_request(&a, a_session);
        let b_pushing = scope.spawn(move || push(a, a_session, b_request));
        withdraw(&a, a_session, b_request);
        assert_never_started(b_pushing.join().unwrap());
        // Withdrawing again, or using the request now, does nothing.
        withdraw(&a, a_session, b_request);
        assert_eq!(
            push(&a, a_session, b_request).unwrap_err()["name"],
            "Denied"
        );

        // A was admitted before any of this, and finishes.
        remote.release(1);
        assert_eq!(
            a_pushing.join().unwrap().unwrap(),
            json!({ "status": "pushed", "oid": first })
        );
        assert_eq!(remote.head(), first);

        // The next push to reach the remote is P's, carrying the third
        // commit. Had B's push started when A finished, it would have reached
        // the remote first, carrying the second.
        let third = commit_file(&a, a_session, "three.md");
        let p_request = open_request(&a, a_session);
        let p_pushing = scope.spawn(move || push(a, a_session, p_request));
        assert_eq!(remote.arrived(2), third);
        assert_ne!(second, third);

        // C asks behind P from window A. Window B cannot withdraw or use it:
        // it has neither A's session nor a request of that number.
        let c_request = open_request(&a, a_session);
        let c_pushing = scope.spawn(move || push(a, a_session, c_request));
        withdraw(&b, a_session, c_request);
        withdraw(&b, b_session, c_request);
        for session in [a_session, b_session] {
            assert_eq!(push(&b, session, c_request).unwrap_err()["name"], "Denied");
        }
        let fourth = commit_file(&b, b_session, "four.md");
        remote.release(2);
        assert_eq!(
            p_pushing.join().unwrap().unwrap(),
            json!({ "status": "pushed", "oid": third })
        );
        // C was not withdrawn: its push runs, once, after P.
        assert_eq!(remote.arrived(3), fourth);
        remote.release(3);
        assert_eq!(
            c_pushing.join().unwrap().unwrap(),
            json!({ "status": "pushed", "oid": fourth })
        );
        assert_eq!(remote.head(), fourth);
        assert_eq!(remote.arrivals(), 3, "A, P, and C; never B");
    });
}

#[cfg(unix)]
#[test]
fn ending_a_session_withdraws_its_unstarted_push_and_keeps_the_one_in_flight() {
    for ending in ["reload", "destroyed"] {
        let (fixture, remote) = held_fixture(ending, &["a", "b"]);
        let a = window(&fixture.app, "a");
        let b = window(&fixture.app, "b");
        let a_session = attach(&a);
        let b_session = attach(&b);
        let first = commit_file(&a, a_session, "one.md");
        let (a, b) = (&a, &b);

        std::thread::scope(|scope| {
            // Window A has one push in flight at the remote and one behind it.
            let a_request = open_request(&a, a_session);
            let a_pushing = scope.spawn(move || push(a, a_session, a_request));
            assert_eq!(remote.arrived(1), first, "{ending}");
            commit_file(&b, b_session, "two.md");
            let b_request = open_request(&a, a_session);
            let b_pushing = scope.spawn(move || push(a, a_session, b_request));

            // The page goes away, or its window does.
            if ending == "reload" {
                crate::commands::end_page(a.as_ref());
            } else {
                a.as_ref().close().unwrap();
                crate::window_destroyed(fixture.app.handle(), "a");
            }

            // The push that had not started never will, and the ended
            // session can neither use the request nor open another.
            assert_never_started(b_pushing.join().unwrap());
            assert_eq!(
                push(&a, a_session, b_request).unwrap_err()["name"],
                "Denied",
                "{ending}"
            );
            assert_eq!(
                invoke(&a, "open_request", json!({ "session": a_session })).unwrap_err()["name"],
                "Denied",
                "{ending}"
            );

            // The push the owner had already started is the owner's: it
            // finishes without the session that asked.
            remote.release(1);
            assert_eq!(
                a_pushing.join().unwrap().unwrap(),
                json!({ "status": "pushed", "oid": first }),
                "{ending}"
            );
            assert_eq!(remote.head(), first, "{ending}");

            // The next push to reach the remote is window B's own, carrying
            // a commit made after the session ended.
            let third = commit_file(&b, b_session, "three.md");
            let p_request = open_request(&b, b_session);
            let p_pushing = scope.spawn(move || push(b, b_session, p_request));
            assert_eq!(remote.arrived(2), third, "{ending}");
            remote.release(2);
            assert_eq!(
                p_pushing.join().unwrap().unwrap(),
                json!({ "status": "pushed", "oid": third }),
                "{ending}"
            );
            assert_eq!(remote.arrivals(), 2, "{ending}");
        });
    }
}

#[cfg(unix)]
#[test]
fn a_push_in_flight_at_the_remote_holds_no_window_save_or_commit_back() {
    // This folder commits on edit, and its remote holds every push.
    let directory = temp("network-held");
    let (remote, configured) = HeldRemote::new(&directory.0);
    let fixture = fixture_in(directory, &["a", "b"], Some(configured));
    let a = window(&fixture.app, "a");
    let b = window(&fixture.app, "b");
    let a_session = attach(&a);
    let b_session = attach(&b);
    let head = || git(&fixture.root, &["rev-parse", "HEAD"]);
    let subjects = || git(&fixture.root, &["log", "--format=%s"]);
    let (a, b) = (&a, &b);

    // Window A saves. The owner commits it on its own and pushes nothing:
    // only a push request sends history to the remote.
    apply(a, a_session, json!([create("one.md", "one")])).unwrap();
    idle(a, a_session);
    assert_eq!(subjects(), "Add one.md");
    let first = head();
    assert_eq!(remote.arrivals(), 0, "an automatic commit stays local");

    std::thread::scope(|scope| {
        // A asks for a push. It is a real `git push`, held inside the remote.
        let held = open_request(a, a_session);
        let held_pushing = scope.spawn(move || push(a, a_session, held));
        assert_eq!(remote.arrived(1), first);

        // A's terminal runs `git push`: a request it opened, waiting behind
        // the push in flight. Nothing of it holds the folder.
        let request = open_request(a, a_session);
        let pushing = scope.spawn(move || push(a, a_session, request));

        // Window B saves, and both windows' terminals make directories and
        // save, while one push is in flight and another waits. Every call
        // returns, and each complete save is committed by its own attempt.
        apply(b, b_session, json!([create("two.md", "two")])).unwrap();
        idle(b, b_session);
        assert_eq!(subjects(), "Add two.md\nAdd one.md");
        invoke(a, "mkdir", json!({ "session": a_session, "path": "made" })).unwrap();
        apply(a, a_session, json!([create("made/three.md", "three")])).unwrap();
        idle(a, a_session);
        assert_eq!(subjects(), "Add made/three.md\nAdd two.md\nAdd one.md");
        let third = head();
        let status = invoke(b, "status", json!({ "session": b_session })).unwrap();
        assert_eq!(status["changes"], json!([]));
        assert_eq!(remote.arrivals(), 1, "the first push is still in flight");

        // The held push finishes with the commit it carried. A's waiting
        // push then starts, and carries everything committed meanwhile.
        remote.release(1);
        assert_eq!(
            held_pushing.join().unwrap().unwrap(),
            json!({ "status": "pushed", "oid": first })
        );
        assert_eq!(remote.arrived(2), third);
        assert_eq!(remote.head(), first);
        remote.release(2);
        assert_eq!(
            pushing.join().unwrap().unwrap(),
            json!({ "status": "pushed", "oid": third })
        );
        assert_eq!(remote.head(), third);
        assert_eq!(
            remote.arrivals(),
            2,
            "the two requested pushes, and no other"
        );
    });
}

#[test]
fn a_page_reload_ends_that_pages_sessions_and_nothing_else() {
    let fixture = fixture("reload", &["a", "b"]);
    let a = window(&fixture.app, "a");
    let b = window(&fixture.app, "b");
    let a_session = attach(&a);
    let b_session = attach(&b);
    // Another plugin's resource in the same webview must survive the reload.
    struct Unrelated;
    impl tauri::Resource for Unrelated {}
    let unrelated = a.as_ref().resources_table().add(Unrelated);

    // The old page saved before it is replaced.
    apply(
        &a,
        a_session,
        json!([create("before.md", "saved before the reload")]),
    )
    .unwrap();
    // Let that save's commit finish, so window B's save below is not skipped
    // for finding the Git lock held.
    idle(&b, b_session);
    crate::commands::end_page(a.as_ref());

    // Its session is gone.
    assert_eq!(
        invoke(
            &a,
            "read",
            json!({ "session": a_session, "path": "before.md" })
        )
        .unwrap_err()["name"],
        "Denied"
    );
    assert!(
        a.as_ref().resources_table().has(unrelated),
        "other resources are untouched"
    );
    apply(
        &b,
        b_session,
        json!([create("b.md", "window b never waited")]),
    )
    .unwrap();

    // The new page attaches again and finds what the old one saved.
    let again = attach(&a);
    assert_ne!(again, a_session);
    let read = invoke(&a, "read", json!({ "session": again, "path": "before.md" })).unwrap();
    assert_eq!(read["bytes"], json!("saved before the reload".as_bytes()));
    eventually("the old page's save to be committed", || {
        fixture.root.join(".git/refs/heads/main").exists()
            && git(&fixture.root, &["ls-tree", "-r", "--name-only", "HEAD"]) == "b.md\nbefore.md"
    });
}

type AttachHook = Arc<dyn Fn() + Send + Sync>;

/// Runs inside `attach` for one window label, after the folder was opened
/// and before the session is registered: where a slow open would leave it.
static ATTACH_HOOKS: Mutex<Vec<(String, AttachHook)>> = Mutex::new(Vec::new());

pub(crate) fn attach_opened(label: &str) {
    run_hook(&ATTACH_HOOKS, label);
}

/// Runs inside `apply` for one window label, after its session admitted the
/// batch and before the owner sees it: where a worker pool that is slow to
/// start the call would leave it.
static APPLY_HOOKS: Mutex<Vec<(String, AttachHook)>> = Mutex::new(Vec::new());

pub(crate) fn apply_admitted(label: &str) {
    run_hook(&APPLY_HOOKS, label);
}

fn run_hook(hooks: &Mutex<Vec<(String, AttachHook)>>, label: &str) {
    let hook = hooks
        .lock()
        .unwrap()
        .iter()
        .find(|(held, _)| held == label)
        .map(|(_, hook)| Arc::clone(hook));
    if let Some(hook) = hook {
        hook();
    }
}

/// Hold the first attach from `label` after its folder opened. Returns what
/// tells the test the attach is held, and what lets it go.
fn hold_first_attach(label: &str) -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
    hold_next(&ATTACH_HOOKS, label)
}

/// Hold the next call from `label` that reaches one of `hooks`, replacing
/// any earlier hold for it. Later calls pass.
fn hold_next(
    hooks: &Mutex<Vec<(String, AttachHook)>>,
    label: &str,
) -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
    let (reached, at_hook) = std::sync::mpsc::channel::<()>();
    let (release, gate) = std::sync::mpsc::channel::<()>();
    let gate = Mutex::new(gate);
    let once = std::sync::atomic::AtomicBool::new(true);
    let mut hooks = hooks.lock().unwrap();
    hooks.retain(|(held, _)| held != label);
    hooks.push((
        label.to_string(),
        Arc::new(move || {
            if once.swap(false, std::sync::atomic::Ordering::SeqCst) {
                reached.send(()).unwrap();
                gate.lock().unwrap().recv().unwrap();
            }
        }),
    ));
    (at_hook, release)
}

#[test]
fn a_save_held_before_the_folder_lands_after_its_sessions_later_save_and_stays() {
    let fixture = fixture("last-landed", &["last-landed"]);
    let page = window(&fixture.app, "last-landed");
    let session = attach(&page);
    let read = |path: &str| std::fs::read_to_string(fixture.root.join(path)).ok();

    // The earlier save is in the plugin and waits before the folder. The
    // later one lands first; the earlier one then lands over it and stays.
    let (at_hook, release) = hold_next(&APPLY_HOOKS, "last-landed");
    std::thread::scope(|scope| {
        let earlier =
            scope.spawn(|| apply(&page, session, json!([overwrite("note.md", "earlier")])));
        at_hook.recv().unwrap();
        apply(&page, session, json!([overwrite("note.md", "later")])).unwrap();
        release.send(()).unwrap();
        earlier.join().unwrap().expect("the held save lands");
    });
    assert_eq!(read("note.md").as_deref(), Some("earlier"));

    // A save the plugin took before its session ended still lands.
    let (at_hook, release) = hold_next(&APPLY_HOOKS, "last-landed");
    std::thread::scope(|scope| {
        let admitted = scope.spawn(|| apply(&page, session, json!([overwrite("kept.md", "kept")])));
        at_hook.recv().unwrap();
        invoke(&page, "detach", json!({ "session": session })).unwrap();
        release.send(()).unwrap();
        admitted.join().unwrap().expect("the admitted save lands");
    });
    assert_eq!(read("kept.md").as_deref(), Some("kept"));
}

#[test]
fn a_second_delivery_of_a_save_lands_again_through_any_session() {
    let fixture = fixture("late-delivery", &["late-delivery", "elsewhere"]);
    let page = window(&fixture.app, "late-delivery");
    let (one, two) = (attach(&page), attach(&page));
    let read = |path: &str| std::fs::read_to_string(fixture.root.join(path)).ok();

    // A save lands and its reply is lost; a later save lands; then Tauri's
    // IPC fallback delivers the first again. Nothing numbers saves, so it
    // lands, through whichever session carried it, and is final.
    apply(&page, one, json!([overwrite("lost.md", "three")])).unwrap();
    apply(&page, two, json!([overwrite("lost.md", "four")])).unwrap();
    apply(&page, one, json!([overwrite("lost.md", "three")])).unwrap();
    assert_eq!(read("lost.md").as_deref(), Some("three"));

    // Another window's save is the same: the last to land wins.
    let elsewhere = window(&fixture.app, "elsewhere");
    let there = attach(&elsewhere);
    apply(
        &elsewhere,
        there,
        json!([overwrite("lost.md", "elsewhere")]),
    )
    .unwrap();
    assert_eq!(read("lost.md").as_deref(), Some("elsewhere"));
}

#[test]
fn a_second_scope_on_the_same_root_cannot_open() {
    let fixture = fixture("alias-scope", &["main"]);
    // The same directory, spelled through its parent.
    let spelled = fixture.root.join("..").join("notes");
    fixture
        .app
        .folders()
        .register(ScopeConfig {
            scope: "alias".to_string(),
            folder: FolderConfig {
                watch_events: false,
                watch_interval: None,
                ..FolderConfig::new(
                    &spelled,
                    Author {
                        name: "Test Author".to_string(),
                        email: "test@example.com".to_string(),
                    },
                )
            },
            windows: vec!["main".to_string()],
        })
        .unwrap();
    let main = window(&fixture.app, "main");
    attach(&main);
    let refused = invoke(
        &main,
        "attach",
        json!({ "scope": "alias", "protocol": PROTOCOL }),
    )
    .unwrap_err();
    assert_eq!(refused["name"], "Busy", "{refused}");
}

#[test]
fn a_destroyed_window_ends_its_sessions_after_the_manager_forgot_its_webview() {
    let fixture = fixture("destroyed", &["a", "b"]);
    let a = window(&fixture.app, "a");
    let b = window(&fixture.app, "b");
    let a_session = attach(&a);
    let b_session = attach(&b);
    apply(
        &a,
        a_session,
        json!([create("before.md", "saved before the window closed")]),
    )
    .unwrap();
    // Let that save's commit finish, so window B's save below is not skipped
    // for finding the Git lock held.
    idle(&b, b_session);

    // What Tauri does before any plugin hears `Destroyed`: the manager drops
    // the webview. From here the plugin cannot look the webview up by label,
    // which is how the old cleanup found the sessions and why it found none.
    a.as_ref().close().unwrap();
    assert!(
        fixture.app.get_webview_window("a").is_none(),
        "the manager no longer has the webview"
    );
    // The plugin's `Destroyed` handler, in that order.
    crate::window_destroyed(fixture.app.handle(), "a");

    // The session ended, and window B carries on.
    apply(
        &b,
        b_session,
        json!([create("b.md", "window b carried on")]),
    )
    .unwrap();
    // A request that still reaches the old webview finds no live session.
    let ended = invoke(
        &a,
        "read",
        json!({ "session": a_session, "path": "before.md" }),
    )
    .unwrap_err();
    assert_eq!(ended["name"], "Denied");
    assert_eq!(
        apply(&a, a_session, json!([overwrite("late.md", "x")])).unwrap_err()["error"]["name"],
        "Denied"
    );
    assert!(!fixture.root.join("late.md").exists());
    // Window B keeps its session, and the save made before the window closed
    // is in the folder and in history.
    let read = invoke(
        &b,
        "read",
        json!({ "session": b_session, "path": "before.md" }),
    )
    .unwrap();
    assert_eq!(
        read["bytes"],
        json!("saved before the window closed".as_bytes())
    );
    eventually("both saves to be committed", || {
        fixture.root.join(".git/refs/heads/main").exists()
            && git(&fixture.root, &["ls-tree", "-r", "--name-only", "HEAD"]) == "b.md\nbefore.md"
    });
    // Destroying it again, or a window that never attached, changes nothing.
    crate::window_destroyed(fixture.app.handle(), "a");
    crate::window_destroyed(fixture.app.handle(), "never-existed");
    assert!(invoke(&b, "list", json!({ "session": b_session })).is_ok());
}

#[test]
fn a_stale_webview_handle_neither_joins_nor_ends_another_webviews_sessions() {
    // Two real webviews, each with the identity the webview-ready hook gave
    // it. The mock manager keeps a destroyed window's entry, so the second
    // cannot be built under the first one's label here; the same-label case
    // is exercised on the identity objects in the test after this one.
    let fixture = fixture("stale-handle", &["old", "successor"]);
    let old = window(&fixture.app, "old");
    let old_session = attach(&old);
    old.as_ref().close().unwrap();
    crate::window_destroyed(fixture.app.handle(), "old");
    let successor = window(&fixture.app, "successor");
    let session = attach(&successor);
    apply(
        &successor,
        session,
        json!([create("new.md", "from the new window")]),
    )
    .unwrap();

    // A request the old page sent before it died is only now delivered. It
    // arrives on the old webview handle, whose own instance has ended.
    assert_eq!(
        invoke(
            &old,
            "attach",
            json!({ "scope": "notes", "protocol": PROTOCOL })
        )
        .unwrap_err(),
        json!({ "name": "Unavailable", "message": "the page that was attaching is gone" })
    );
    assert_eq!(
        invoke(
            &old,
            "read",
            json!({ "session": old_session, "path": "new.md" })
        )
        .unwrap_err()["name"],
        "Denied"
    );
    // A late page-load callback for the old webview ends nothing elsewhere,
    // and neither does a repeated `Destroyed` for its window.
    crate::commands::end_page(old.as_ref());
    crate::window_destroyed(fixture.app.handle(), "old");
    let read = invoke(
        &successor,
        "read",
        json!({ "session": session, "path": "new.md" }),
    )
    .unwrap();
    assert_eq!(read["bytes"], json!("from the new window".as_bytes()));
    let registered = |window: &WebviewWindow<MockRuntime>| {
        window
            .as_ref()
            .resources_table()
            .names()
            .filter(|(_, name)| name == "epicenter-folder-session")
            .count()
    };
    assert_eq!(registered(&successor), 1);
}

#[test]
fn a_window_recreated_under_the_same_label_is_a_separate_instance() {
    use crate::lifecycle::{Lifecycles, Live, SessionState};
    use epicenter_folder_core::registry::Registry;

    // Real sessions on a real folder; the identity objects are the ones the
    // plugin keeps per webview. No webview is involved, because the mock
    // runtime cannot hold two under one label.
    let directory = temp("same-label");
    let root = directory.0.join("notes");
    std::fs::create_dir(&root).unwrap();
    let registry = Registry::new();
    registry
        .register(ScopeConfig {
            scope: "notes".to_string(),
            folder: FolderConfig {
                watch_events: false,
                watch_interval: None,
                ..FolderConfig::new(
                    &root,
                    Author {
                        name: "Test Author".to_string(),
                        email: "test@example.com".to_string(),
                    },
                )
            },
            windows: vec!["late".to_string()],
        })
        .unwrap();
    let session_for = |instance: &Arc<crate::lifecycle::Instance>| {
        let session = registry.attach("notes", "late").unwrap();
        let subscription = session.authorize("late").unwrap().subscribe(|_| {});
        SessionState::new(
            instance,
            Live {
                session,
                requests: Default::default(),
                _subscription: subscription,
            },
        )
    };
    let live = |session: &Arc<SessionState>| session.owner("late").is_ok();

    let lifecycles = Lifecycles::default();
    // The first window labelled `late`, with a session and an attach in flight.
    let old = lifecycles.created("late");
    let old_page = old.page().unwrap();
    let old_session = session_for(&old);
    assert_eq!(old.register(old_page, &old_session, || ()), Some(()));
    let in_flight = session_for(&old);

    // It is destroyed, and a window is created again under the same label.
    lifecycles.window_destroyed("late");
    assert!(!live(&old_session));
    let new = lifecycles.created("late");
    let new_page = new.page().unwrap();
    let new_session = session_for(&new);
    assert_eq!(new.register(new_page, &new_session, || ()), Some(()));

    // The old instance is over for good: the attach that was in flight, and
    // one that only starts now on the old handle, both register nothing.
    assert_eq!(old.page(), None);
    assert_eq!(old.register(old_page, &in_flight, || ()), None);
    assert_eq!(old.register(new_page, &in_flight, || ()), None);
    // A late reload callback for the old instance ends nothing of the new one.
    old.page_started();
    assert!(live(&new_session));
    assert_eq!(
        new.page(),
        Some(new_page),
        "the new instance's page did not move"
    );

    // The new instance's own reload ends its own sessions and fences its own
    // pending attach.
    let pending = session_for(&new);
    new.page_started();
    assert!(!live(&new_session));
    assert_eq!(new.register(new_page, &pending, || ()), None);
    let reloaded = session_for(&new);
    assert_eq!(
        new.register(new.page().unwrap(), &reloaded, || ()),
        Some(())
    );

    // `Destroyed` for the label now ends the new instance, and only then.
    lifecycles.window_destroyed("late");
    assert!(!live(&reloaded));
    assert_eq!(new.page(), None);
    registry.shutdown();
}

#[test]
fn an_attach_that_finishes_after_its_window_was_destroyed_registers_nothing() {
    let fixture = fixture("late-attach", &["late", "b"]);
    let late = window(&fixture.app, "late");
    let b = window(&fixture.app, "b");
    let b_session = attach(&b);

    // The first attach from `late` is held after the folder opened.
    let (at_hook, release) = hold_first_attach("late");

    std::thread::scope(|scope| {
        let in_flight = scope.spawn(|| {
            invoke(
                &late,
                "attach",
                json!({ "scope": "notes", "protocol": PROTOCOL }),
            )
        });
        at_hook.recv().unwrap();

        // Its window is destroyed, manager first, as in the app's event loop.
        late.as_ref().close().unwrap();
        crate::window_destroyed(fixture.app.handle(), "late");

        // The old attach finishes now. Its webview's instance has ended.
        release.send(()).unwrap();
        let refused = in_flight.join().unwrap().unwrap_err();
        assert_eq!(
            refused,
            json!({ "name": "Unavailable", "message": "the page that was attaching is gone" })
        );
        // It registered nothing in the webview it still held.
        let sessions = late
            .as_ref()
            .resources_table()
            .names()
            .filter(|(_, name)| name == "epicenter-folder-session")
            .count();
        assert_eq!(sessions, 0);
        // The folder it opened stays open for the window that is still there.
        assert!(invoke(&b, "list", json!({ "session": b_session })).is_ok());
    });

    // An attach that only starts now on the old handle is refused as well.
    assert_eq!(
        invoke(
            &late,
            "attach",
            json!({ "scope": "notes", "protocol": PROTOCOL })
        )
        .unwrap_err(),
        json!({ "name": "Unavailable", "message": "the page that was attaching is gone" })
    );
}

#[test]
fn a_reload_fences_an_attach_in_flight_for_the_old_page() {
    let fixture = fixture("reload-attach", &["reloading"]);
    let page = window(&fixture.app, "reloading");
    let (at_hook, release) = hold_first_attach("reloading");

    std::thread::scope(|scope| {
        let in_flight = scope.spawn(|| {
            invoke(
                &page,
                "attach",
                json!({ "scope": "notes", "protocol": PROTOCOL }),
            )
        });
        at_hook.recv().unwrap();
        // The page-load hook's body, for a reload of the same webview.
        crate::commands::end_page(page.as_ref());
        let new_session = attach(&page);
        release.send(()).unwrap();
        assert_eq!(
            in_flight.join().unwrap().unwrap_err()["name"],
            "Unavailable"
        );
        assert!(invoke(&page, "list", json!({ "session": new_session })).is_ok());
    });
}

/// Runs inside `end_page` for one webview label, after the page advanced and
/// before the old page's table entries are removed.
static PAGE_HOOKS: Mutex<Vec<(String, AttachHook)>> = Mutex::new(Vec::new());

pub(crate) fn page_advanced(label: &str) {
    let hook = PAGE_HOOKS
        .lock()
        .unwrap()
        .iter()
        .find(|(held, _)| held == label)
        .map(|(_, hook)| Arc::clone(hook));
    if let Some(hook) = hook {
        hook();
    }
}

#[test]
fn a_session_the_new_page_attaches_during_reload_cleanup_survives_it() {
    let fixture = fixture("reload-cleanup", &["reloading-cleanup"]);
    let page = window(&fixture.app, "reloading-cleanup");
    let old_session = attach(&page);

    // The reload has advanced the page and ended the old page's sessions, and
    // has not yet removed their table entries. The new page attaches here.
    let new_session: Arc<Mutex<Option<u64>>> = Arc::default();
    let attached = Arc::clone(&new_session);
    let attaching = page.clone();
    let once = std::sync::atomic::AtomicBool::new(true);
    PAGE_HOOKS.lock().unwrap().push((
        "reloading-cleanup".to_string(),
        Arc::new(move || {
            if once.swap(false, std::sync::atomic::Ordering::SeqCst) {
                *attached.lock().unwrap() = Some(attach(&attaching));
            }
        }),
    ));
    crate::commands::end_page(page.as_ref());

    let new_session = new_session.lock().unwrap().expect("the new page attached");
    assert_ne!(new_session, old_session);
    // The new page's session is live and still in the table.
    apply(
        &page,
        new_session,
        json!([create("new.md", "from the new page")]),
    )
    .expect("the cleanup of the old page did not close the new page's session");
    // The old page's session ended and its entry is gone.
    assert_eq!(
        invoke(&page, "list", json!({ "session": old_session })).unwrap_err(),
        json!({
            "name": "Denied",
            "reason": "this window has no such folder session; attach first",
        })
    );
    let registered = page
        .as_ref()
        .resources_table()
        .names()
        .filter(|(_, name)| name == "epicenter-folder-session")
        .count();
    assert_eq!(registered, 1, "only the new page's session remains");
}

/// A line-oriented bridge to the real invoke handler, for the TypeScript
/// adapter's conformance tests in `packages/app/src/files/tauri-native.test.ts`.
///
/// Each stdin line is `{ id, window, cmd, args }`; each reply is one stdout
/// line `FOLDER_BRIDGE { id, ok | err }`. Events a window receives are printed
/// as `FOLDER_BRIDGE { event, window, payload }`. Requests run concurrently,
/// as a page's would. Closing stdin shuts the folders down.
/// `FOLDER_BRIDGE_REMOTE` names the URL the folder pushes to and fetches from.
#[test]
#[ignore = "run through packages/app/src/files/tauri-native.test.ts"]
fn invoke_bridge() {
    use std::io::{BufRead, Write};

    fn emit(value: Value) {
        let mut stdout = std::io::stdout().lock();
        writeln!(stdout, "FOLDER_BRIDGE {value}").unwrap();
        stdout.flush().unwrap();
    }

    let root = PathBuf::from(std::env::var("FOLDER_BRIDGE_ROOT").expect("the folder to open"));
    std::env::set_var("GIT_CONFIG_GLOBAL", "/dev/null");
    std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
    let mut context = mock_context(noop_assets());
    for command in COMMANDS {
        context.runtime_authority_mut().__allow_command(
            format!("plugin:epicenter-folder|{command}"),
            ExecutionContext::Local,
        );
    }
    let app = mock_builder()
        .plugin(init())
        .build(context)
        .expect("mock app");
    app.folders()
        .register(ScopeConfig {
            scope: "notes".to_string(),
            folder: FolderConfig {
                remote: std::env::var("FOLDER_BRIDGE_REMOTE")
                    .ok()
                    .map(|url| Remote {
                        url,
                        branch: "main".to_string(),
                    }),
                watch_events: false,
                watch_interval: None,
                ..FolderConfig::new(
                    &root,
                    Author {
                        name: "Test Author".to_string(),
                        email: "test@example.com".to_string(),
                    },
                )
            },
            windows: vec!["a".to_string(), "b".to_string()],
        })
        .unwrap();
    let windows: std::collections::BTreeMap<&str, WebviewWindow<MockRuntime>> =
        ["a", "b", "intruder"]
            .into_iter()
            .map(|label| {
                let created = window(&app, label);
                for event in [
                    "plugin:epicenter-folder:folder-snapshot-changed",
                    "plugin:epicenter-folder:folder-files-changed",
                ] {
                    created.listen(event, move |received| {
                        emit(json!({
                            "event": event,
                            "window": label,
                            "payload": serde_json::from_str::<Value>(received.payload()).unwrap(),
                        }));
                    });
                }
                (label, created)
            })
            .collect();
    emit(json!({ "ready": true }));

    std::thread::scope(|scope| {
        for line in std::io::stdin().lock().lines() {
            let request: Value = serde_json::from_str(&line.unwrap()).expect("a JSON request");
            let window = &windows[request["window"].as_str().expect("a window label")];
            scope.spawn(move || {
                let result = tauri::test::get_ipc_response(
                    window,
                    InvokeRequest {
                        cmd: request["cmd"].as_str().expect("a command").to_string(),
                        callback: CallbackFn(0),
                        error: CallbackFn(1),
                        url: "tauri://localhost".parse().unwrap(),
                        body: InvokeBody::Json(request["args"].clone()),
                        headers: Default::default(),
                        invoke_key: INVOKE_KEY.to_string(),
                    },
                );
                emit(match result {
                    Ok(body) => {
                        json!({ "id": request["id"], "ok": body.deserialize::<Value>().unwrap() })
                    }
                    Err(error) => json!({ "id": request["id"], "err": error }),
                });
            });
        }
    });
    app.folders().shutdown();
    emit(json!({ "finished": true }));
}

#[test]
fn a_window_without_the_permission_cannot_call_the_plugin() {
    let directory = temp("acl");
    let app = mock_builder()
        .plugin(init())
        .build(mock_context(noop_assets()))
        .unwrap();
    let main = window(&app, "main");
    for (command, args) in [
        ("attach", json!({ "scope": "notes", "protocol": PROTOCOL })),
        ("recover_incoming", json!({ "session": 1 })),
    ] {
        let refused = invoke(&main, command, args).unwrap_err();
        assert!(
            refused
                .as_str()
                .is_some_and(|message| message.contains("not allowed")),
            "{command}: {refused}"
        );
    }
    drop(directory);
}

#[test]
fn recovering_an_incoming_update_is_a_command_of_a_session_on_that_scope() {
    let fixture = fixture("recover-scope", &["owner", "other"]);
    let owner = window(&fixture.app, "owner");
    let other = window(&fixture.app, "other");
    let intruder = window(&fixture.app, "intruder");
    let session = attach(&owner);
    let other_session = attach(&other);
    let recover = |window: &WebviewWindow<MockRuntime>, session: u64| {
        invoke(window, "recover_incoming", json!({ "session": session }))
    };

    // Nothing is pending.
    assert_eq!(
        recover(&owner, session).unwrap(),
        json!({ "status": "none" })
    );

    // A window naming a session it did not attach is denied, whether or not
    // the scope lists it, and nothing is read or written for it.
    let denied = json!({
        "name": "Git",
        "error": {
            "name": "Denied",
            "reason": "this window has no such folder session; attach first",
        },
    });
    assert_eq!(recover(&other, session).unwrap_err(), denied);
    assert_eq!(recover(&intruder, session).unwrap_err(), denied);
    assert_eq!(
        invoke(
            &intruder,
            "attach",
            json!({ "scope": "notes", "protocol": PROTOCOL })
        )
        .unwrap_err()["name"],
        "WindowNotPermitted"
    );

    // A record the folder cannot read is reported to every session of the
    // scope, refused by name, and never removed.
    let record = fixture.root.join(".git/epicenter/incoming.json");
    std::fs::create_dir_all(record.parent().unwrap()).unwrap();
    std::fs::write(&record, "not a record").unwrap();
    invoke(&owner, "status", json!({ "session": session })).unwrap();
    for (window, session) in [(&owner, session), (&other, other_session)] {
        let refused = recover(window, session).unwrap_err();
        assert_eq!(refused["name"], "RecoveryRefused", "{refused}");
        assert_eq!(refused["pending"]["state"], "unreadable", "{refused}");
        assert_eq!(refused["paths"], json!([]));
    }
    assert!(record.exists());
    let blocked = invoke(&other, "commit", json!({ "session": other_session })).unwrap();
    assert_eq!(blocked["status"], "blocked", "{blocked}");
    let attached = invoke(
        &other,
        "attach",
        json!({ "scope": "notes", "protocol": PROTOCOL }),
    )
    .unwrap();
    assert_eq!(
        attached["snapshot"]["pendingIncoming"]["state"],
        "unreadable"
    );
}

/// The merge options are optional arguments: a request without them is the
/// version 8 request it always was, and each one reaches the owner when sent.
#[test]
fn merge_options_are_optional_arguments_that_reach_the_owner() {
    let directory = temp("merge-options");
    let bare = directory.0.join("remote.git");
    std::fs::create_dir(&bare).unwrap();
    git(
        &bare,
        &["init", "--quiet", "--bare", "--initial-branch=main"],
    );
    // The remote's history shares no commit with the folder's.
    let upstream = directory.0.join("upstream");
    std::fs::create_dir(&upstream).unwrap();
    git(&upstream, &["init", "--quiet", "--initial-branch=main"]);
    std::fs::write(upstream.join("same.bin"), [0u8, 254, 9]).unwrap();
    std::fs::write(upstream.join("theirs.md"), "theirs\n").unwrap();
    git(&upstream, &["add", "--all"]);
    git(
        &upstream,
        &[
            "-c",
            "user.name=Upstream",
            "-c",
            "user.email=upstream@example.com",
            "commit",
            "--quiet",
            "-m",
            "their root",
        ],
    );
    git(
        &upstream,
        &["push", "--quiet", &bare.display().to_string(), "main"],
    );
    let remote = Remote {
        url: bare.display().to_string(),
        branch: "main".to_string(),
    };
    let fixture = fixture_in(directory, &["main"], Some(remote));
    let main = window(&fixture.app, "main");
    let session = attach(&main);
    apply(
        &main,
        session,
        json!([
            { "kind": "create", "path": "same.bin", "bytes": [0, 255, 1] },
            create("ours.md", "ours\n"),
        ]),
    )
    .unwrap();
    // The save's automatic commit, or this one if it gets there first.
    invoke(&main, "commit", json!({ "session": session })).unwrap();
    let ours = json!(git(&fixture.root, &["rev-parse", "HEAD"]));
    let request = open_request(&main, session);
    let theirs = invoke(
        &main,
        "fetch",
        json!({ "session": session, "request": request }),
    )
    .unwrap()["oid"]
        .clone();
    let merge = |args: Value| invoke(&main, "merge_incoming", args).unwrap_err();
    let conflicts = json!([{ "reason": "binary", "path": "same.bin" }]);

    // Neither option: unrelated histories are refused.
    assert_eq!(
        merge(json!({ "session": session })),
        json!({ "name": "UnsupportedHistory", "head": ours, "fetched": theirs, "bases": 0 })
    );
    // Consent and versions: the two-sided addition conflicts, with the exact
    // committed bytes of each side.
    assert_eq!(
        merge(json!({
            "session": session,
            "allowUnrelatedHistories": true,
            "versions": true,
        })),
        json!({
            "name": "Conflicted",
            "conflicts": conflicts,
            "versions": [{ "path": "same.bin", "ours": [0, 255, 1], "theirs": [0, 254, 9] }],
        })
    );
    // `null` is `false`: consent alone refuses the conflict without bytes.
    assert_eq!(
        merge(json!({
            "session": session,
            "allowUnrelatedHistories": true,
            "versions": null,
        })),
        json!({ "name": "Conflicted", "conflicts": conflicts, "versions": null })
    );
    // Nothing was written, and the snapshot carries no bytes.
    assert_eq!(
        git(&fixture.root, &["rev-parse", "main"]),
        ours.as_str().unwrap()
    );
    assert!(!fixture.root.join("theirs.md").exists());
    assert_eq!(
        std::fs::read(fixture.root.join("same.bin")).unwrap(),
        [0u8, 255, 1]
    );
    let reattached = invoke(
        &main,
        "attach",
        json!({ "scope": "notes", "protocol": PROTOCOL }),
    )
    .unwrap();
    assert_eq!(
        reattached["snapshot"]["lastMerge"]["result"],
        json!({
            "status": "err",
            "error": { "name": "Conflicted", "conflicts": conflicts, "versions": null },
        })
    );
}
