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
//! - The folder scope is granted to the notes window only, for the page's own
//!   engine. The shell writes nothing inside the root; granting an existing
//!   folder and reading it change no file and nothing in its repository, born
//!   or unborn; a root another process holds is busy and gains no file.
//! - The grant lets the window read its directory through the folder plugin,
//!   dot names included, and nothing outside it. Writes go through the folder plugin under the shared
//!   path rule, and a save commits nothing.
//! - A held close reaches the page as an event; refusals reach it as text.
//! - The terminal keeps its working directory in the shell.
//!
//! An approved close ends in `AppHandle::exit`, which the mock runtime does
//! not implement, so an accepted approval is covered by `close.rs` and by the
//! page client's tests instead.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::http::{HeaderMap, HeaderValue};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{mock_builder, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{App, Listener, WebviewWindow, WebviewWindowBuilder};

use tauri_plugin_epicenter_folder::FolderExt;

use crate::commands::{hold, CLOSE_REQUESTED, WINDOW};
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
    request(window, command, InvokeBody::Json(args), Default::default())
}

fn request(
    window: &WebviewWindow<MockRuntime>,
    command: &str,
    body: InvokeBody,
    headers: HeaderMap,
) -> Result<Value, Value> {
    tauri::test::get_ipc_response(
        window,
        InvokeRequest {
            cmd: command.to_string(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body,
            headers,
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
    let granted = invoke(
        &other,
        "plugin:epicenter-folder|grant_directory",
        json!({ "scope": root::SCOPE }),
    );
    assert!(text(&granted.unwrap_err()).contains("not allowed"));
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
    assert!(
        capability.get("local").is_none(),
        "the bundled page is local, the default"
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
    assert!(config.get("plugins").is_none(), "no fs plugin is configured");
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
fn the_folder_has_honeycrisp_as_the_fallback_author() {
    let directory = temp("config");
    let config = folder_config(directory.path());
    assert_eq!(config.branch, "main");
    assert_eq!(config.author.name, "Honeycrisp");
    assert_eq!(config.author.email, "honeycrisp@localhost");
}

fn grant(window: &WebviewWindow<MockRuntime>) -> Result<Value, Value> {
    invoke(
        window,
        "plugin:epicenter-folder|grant_directory",
        json!({ "scope": root::SCOPE }),
    )
}

/// A path inside the root, as the page's engine names it to the plugin.
fn inside(fixture: &Fixture, relative: &str) -> String {
    fixture.root.join(relative).to_str().unwrap().to_string()
}

/// `write_folder_file` as the page's engine sends it: the bytes as the raw
/// body, the rest in percent-encoded headers. These values are plain ASCII
/// with no `%`, so each encodes as itself.
fn write_file(
    window: &WebviewWindow<MockRuntime>,
    path: &str,
    bytes: &[u8],
    create_new: bool,
) -> Result<Value, Value> {
    let create_new = create_new.to_string();
    let mut headers = HeaderMap::new();
    for (name, value) in [("scope", root::SCOPE), ("path", path), ("create-new", &create_new)] {
        headers.insert(name, HeaderValue::from_str(value).unwrap());
    }
    request(
        window,
        "plugin:epicenter-folder|write_folder_file",
        InvokeBody::Raw(bytes.to_vec()),
        headers,
    )
}

/// One file written the way the page's engine writes it: its bytes to a new
/// staged file under `.git/epicenter/scratch`, which is then renamed over the
/// path.
fn write(
    fixture: &Fixture,
    window: &WebviewWindow<MockRuntime>,
    relative: &str,
    text: &str,
) -> Result<Value, Value> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let scratch = inside(fixture, ".git/epicenter/scratch");
    let staged = format!(
        "{scratch}/staged-{}",
        NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    );
    invoke(
        window,
        "plugin:epicenter-folder|make_folder_directory",
        json!({ "scope": root::SCOPE, "path": scratch }),
    )?;
    write_file(window, &staged, text.as_bytes(), true)?;
    invoke(
        window,
        "plugin:epicenter-folder|rename_folder_path",
        json!({
            "scope": root::SCOPE,
            "from": staged,
            "to": inside(fixture, relative),
            "expected": "any",
        }),
    )
}

const NOTE: &str = "---\r\ntitle:   \"Spaced\"  # keep\r\nextra: [1, 2]\r\n---\r\n\r\n* a\r\n";
const SETTINGS: &str = "{\"kept\":true}";

/// A folder someone already has: a note and its settings.
fn existing(root: &Path) {
    std::fs::create_dir(root.join("notes")).unwrap();
    std::fs::write(root.join("notes/old.md"), NOTE).unwrap();
    std::fs::write(root.join("kv.json"), SETTINGS).unwrap();
}

/// What the page reads on every open, through the folder plugin's commands.
fn look(fixture: &Fixture, window: &WebviewWindow<MockRuntime>) {
    for path in ["", "notes"] {
        invoke(
            window,
            "plugin:epicenter-folder|read_folder_directory",
            json!({ "scope": root::SCOPE, "path": inside(fixture, path).trim_end_matches('/') }),
        )
        .unwrap();
    }
    for path in ["kv.json", "notes/old.md"] {
        invoke(
            window,
            "plugin:epicenter-folder|stat_folder_path",
            json!({ "scope": root::SCOPE, "path": inside(fixture, path) }),
        )
        .unwrap();
    }
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
fn the_notes_window_is_granted_its_root_with_the_fallback_author() {
    let fixture = fixture("grant", |_| {});
    let main = window(&fixture.app, WINDOW);
    let granted = grant(&main).expect("the notes window is granted its folder");
    assert_eq!(
        granted,
        json!({
            "root": fixture.root.to_str().unwrap(),
            "branch": "main",
            "authorName": "Honeycrisp",
            "authorEmail": "honeycrisp@localhost",
        })
    );
    // Granting writes nothing inside the root.
    assert_eq!(std::fs::read_dir(&fixture.root).unwrap().count(), 0);
}

/// The folder plugin reads the granted directory and nothing else, dot names
/// included, and only after the grant.
#[test]
fn the_grant_lets_the_window_read_its_folder_dot_names_included_and_nothing_else() {
    let fixture = fixture("read", |root| {
        existing(root);
        git(root, &["init", "--quiet", "--initial-branch=main"]);
        std::fs::write(root.join("notes/.hidden.md"), "hidden\n").unwrap();
    });
    let outside = fixture.root.parent().unwrap().join("outside.txt");
    std::fs::write(&outside, "outside\n").unwrap();
    let main = window(&fixture.app, WINDOW);
    let lstat = |path: &str| {
        invoke(
            &main,
            "plugin:epicenter-folder|stat_folder_path",
            json!({ "scope": root::SCOPE, "path": path }),
        )
    };
    let head = inside(&fixture, ".git/HEAD");
    assert!(lstat(&head).is_err(), "nothing is readable before the grant");

    grant(&main).unwrap();
    for path in [".git/HEAD", "notes/.hidden.md", "kv.json", "notes/old.md"] {
        let found = lstat(&inside(&fixture, path)).unwrap_or_else(|error| panic!("{path}: {error}"));
        assert!(found.is_object(), "{path}: {found}");
    }
    assert!(lstat(outside.to_str().unwrap()).is_err());
    assert!(lstat(fixture.root.parent().unwrap().to_str().unwrap()).is_err());
}

#[test]
fn an_existing_folder_with_history_is_opened_without_changing_its_files_or_its_repository() {
    let fixture = fixture("existing", |root| {
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
    grant(&main).expect("the notes window is granted its folder");
    look(&fixture, &main);
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
    grant(&main).unwrap();
    look(&fixture, &main);
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
    let refused = grant(&main).unwrap_err();
    assert_eq!(refused["name"], json!("Busy"));
    assert_eq!(std::fs::read_dir(&fixture.root).unwrap().count(), 0);
    drop(other);
    grant(&main).expect("the folder opens once the other holder is gone");
}

#[test]
fn a_scope_the_shell_did_not_register_is_unknown() {
    let fixture = fixture("unknown-scope", |_| {});
    let main = window(&fixture.app, WINDOW);
    let refused = invoke(
        &main,
        "plugin:epicenter-folder|grant_directory",
        json!({ "scope": "so.epicenter.other" }),
    )
    .unwrap_err();
    assert_eq!(refused["name"], json!("UnknownScope"));
}

/// The calls the page's setup makes for a folder that has nothing yet, after
/// its engine made the repository: a directory per table, then `kv.json`
/// only where it is absent. A save commits nothing.
#[test]
fn a_new_folder_is_set_up_through_the_plugin_and_a_save_commits_nothing() {
    let fixture = fixture("fresh", |root| {
        git(root, &["init", "--quiet", "--initial-branch=main"]);
    });
    let main = window(&fixture.app, WINDOW);
    grant(&main).unwrap();
    for table in ["notes", "folders"] {
        invoke(
            &main,
            "plugin:epicenter-folder|make_folder_directory",
            json!({ "scope": root::SCOPE, "path": inside(&fixture, table) }),
        )
        .unwrap();
        assert!(fixture.root.join(table).is_dir());
    }
    write(&fixture, &main, "kv.json", "{}\n").expect("the default settings are written");
    assert!(!git_output(&fixture.root, &["rev-parse", "--verify", "--quiet", "HEAD"]).0);

    // A data file is never written in place, new or not: it changes nothing.
    for create_new in [true, false] {
        let refused = write_file(
            &main,
            &inside(&fixture, "kv.json"),
            b"{\"overwritten\":true}\n",
            create_new,
        )
        .unwrap_err();
        assert!(!text(&refused).contains("raw body"), "{refused}");
    }
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("kv.json")).unwrap(),
        "{}\n"
    );
    let scratch = fixture.root.join(".git/epicenter/scratch");
    assert_eq!(std::fs::read_dir(scratch).unwrap().count(), 0);
}

/// The README's promise about names: leading dots work; a name some disk
/// reads as another file, and `HEAD`, are refused and write nothing.
#[test]
fn a_note_may_have_a_leading_dot_but_not_a_name_some_disk_reads_as_another() {
    let fixture = fixture("names", |root| {
        git(root, &["init", "--quiet", "--initial-branch=main"]);
        std::fs::create_dir(root.join("notes")).unwrap();
    });
    let main = window(&fixture.app, WINDOW);
    grant(&main).unwrap();
    for allowed in ["notes/.md", "notes/.hidden.md", "notes/a .md", ".gitignore"] {
        write(&fixture, &main, allowed, "kept\n")
            .unwrap_or_else(|error| panic!("{allowed}: {error}"));
        assert_eq!(
            std::fs::read_to_string(fixture.root.join(allowed)).unwrap(),
            "kept\n"
        );
    }
    for refused in [
        "notes/a.",
        "notes/a ",
        "notes/a:b.md",
        "notes/a?.md",
        "notes/con.md",
        "notes/NUL",
        "notes/GIT~1.md",
        "HEAD",
        "notes/head",
        ".git/config",
        ".GIT/hooks/pre-commit",
    ] {
        let error = write(&fixture, &main, refused, "refused\n").unwrap_err();
        assert!(text(&error).contains("is not one this page may change"), "{refused}: {error}");
    }
    let mut names: Vec<String> = std::fs::read_dir(fixture.root.join("notes"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names, [".hidden.md", ".md", "a .md"]);
    assert!(!fixture.root.join("HEAD").exists());
}

/// The failure the acceptance route produces by hand in a disposable folder,
/// with nothing injected: a save that cannot be written.
#[cfg(unix)]
#[test]
fn a_save_that_cannot_be_written_fails_and_leaves_the_file() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = fixture("failures", |root| {
        git(root, &["init", "--quiet", "--initial-branch=main"]);
        std::fs::create_dir(root.join("notes")).unwrap();
    });
    let main = window(&fixture.app, WINDOW);
    grant(&main).unwrap();
    write(&fixture, &main, "notes/a.md", "first\n").expect("an ordinary save lands");

    // `chmod a-w notes`: the save fails and nothing is written.
    let notes = fixture.root.join("notes");
    std::fs::set_permissions(&notes, std::fs::Permissions::from_mode(0o555)).unwrap();
    let refused = write(&fixture, &main, "notes/a.md", "second\n");
    std::fs::set_permissions(&notes, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(refused.is_err(), "{refused:?}");
    assert_eq!(
        std::fs::read_to_string(notes.join("a.md")).unwrap(),
        "first\n"
    );
}

/// Quit: once the shell shuts the folder down, a write the page sends late is
/// refused and the folder is unlocked.
#[test]
fn after_shutdown_a_late_write_is_refused_and_the_folder_is_unlocked() {
    let fixture = fixture("shutdown", |root| {
        git(root, &["init", "--quiet", "--initial-branch=main"]);
    });
    let main = window(&fixture.app, WINDOW);
    grant(&main).unwrap();
    write(&fixture, &main, "kv.json", "{}\n").unwrap();
    fixture.app.handle().folders().shutdown();
    let refused = write(&fixture, &main, "kv.json", "late\n").unwrap_err();
    assert!(text(&refused).contains("ShuttingDown"), "{refused}");
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("kv.json")).unwrap(),
        "{}\n"
    );
    drop(
        epicenter_folder_core::lock::RootLock::acquire(&fixture.root)
            .unwrap_or_else(|_| panic!("the folder is unlocked after shutdown")),
    );
}

// ============================================================================
// Close consent
// ============================================================================

#[test]
fn a_held_close_reaches_the_page_and_stale_answers_are_refused_as_text() {
    let fixture = fixture("close", |_| {});
    let main = window(&fixture.app, WINDOW);
    let (sender, asked) = mpsc::channel::<Value>();
    main.listen(CLOSE_REQUESTED, move |event| {
        let _ = sender.send(serde_json::from_str(event.payload()).unwrap());
    });
    let next = || {
        asked
            .recv_timeout(Duration::from_secs(10))
            .expect("the close request event")
    };

    assert_eq!(invoke(&main, "close_register", json!({})), Ok(json!(1)));
    assert_eq!(
        invoke(&main, "close_opened", json!({ "generation": 1 })),
        Ok(Value::Null)
    );
    assert!(hold(fixture.app.handle()));
    assert_eq!(next(), json!({ "generation": 1, "request": 1 }));
    // Asked again while unanswered: the same request.
    assert!(hold(fixture.app.handle()));
    assert_eq!(next(), json!({ "generation": 1, "request": 1 }));

    assert_eq!(
        invoke(
            &main,
            "close_decline",
            json!({ "generation": 1, "request": 1 })
        ),
        Ok(Value::Null)
    );
    assert_eq!(
        invoke(
            &main,
            "close_approve",
            json!({ "generation": 1, "request": 1 })
        ),
        Err(json!(
            "this close request is no longer waiting for an answer"
        ))
    );
    assert!(hold(fixture.app.handle()));
    assert_eq!(next(), json!({ "generation": 1, "request": 2 }));

    // A reload registers a new page; the page before it can no longer answer.
    assert_eq!(invoke(&main, "close_register", json!({})), Ok(json!(2)));
    assert_eq!(
        invoke(
            &main,
            "close_approve",
            json!({ "generation": 1, "request": 2 })
        ),
        Err(json!("this page was replaced by a newer one"))
    );
    // The new page has not opened its folder: the close goes ahead, for good.
    assert!(!hold(fixture.app.handle()));
    assert_eq!(
        invoke(&main, "close_opened", json!({ "generation": 2 })),
        Err(json!("the app is already closing"))
    );
}

#[test]
fn a_close_before_any_page_registered_goes_ahead() {
    let fixture = fixture("close-early", |_| {});
    assert!(!hold(fixture.app.handle()));
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
