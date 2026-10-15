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
//! - Reads reach the granted root and everything beneath it, `.git`
//!   included, and nothing else: never another window's root, never through
//!   a link on the way. A final link is described, not followed.
//! - A grant adds nothing to the app's access control, so an app that
//!   already scopes another permission grants and reads as any other does.
//! - Changes land only after a grant, only under the root, and never in
//!   Git's private state; `git` runs in the root and only as an allowed
//!   operation.
//! - A staged write takes its bytes as a raw body and its arguments as
//!   percent-encoded headers; a JSON array of bytes, Tauri's postMessage
//!   fallback, is accepted too. A file read returns its bytes raw.
//! - A page's `git` runs end with it: a cancel stops a run whether it
//!   arrives before or after the run starts, a page load or a destroyed
//!   window cancels every run of the page before it, and two windows' runs
//!   never meet, whatever IDs their pages chose.
//! - After shutdown, a late change is refused and the folder is unlocked.
//! - A window without the plugin's permission cannot call it.

use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::http::{HeaderMap, HeaderValue};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody, RuntimeAuthority};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
use tauri::utils::acl::manifest::Manifest;
use tauri::utils::acl::resolved::Resolved;
use tauri::utils::acl::capability::Capability;
use tauri::utils::acl::ExecutionContext;
use tauri::utils::platform::Target;
use tauri::webview::InvokeRequest;
use tauri::{App, WebviewWindow, WebviewWindowBuilder};

use crate::{init, Author, FolderConfig, FolderExt, ScopeConfig, COMMANDS};

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
    // `write_folder_file` takes a raw body and `read_folder_file` returns
    // one, which specta cannot type; the page invokes them by name.
    const RAW: [&str; 2] = ["write_folder_file", "read_folder_file"];
    for command in RAW {
        assert!(!fresh.contains(command), "{command}");
    }
    for command in COMMANDS.iter().filter(|command| !RAW.contains(command)) {
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

/// The mock context, allowing every command of this plugin.
fn context() -> tauri::Context<MockRuntime> {
    let mut context = mock_context(noop_assets());
    allow_plugin(&mut context);
    context
}

fn allow_plugin(context: &mut tauri::Context<MockRuntime>) {
    for command in COMMANDS {
        context.runtime_authority_mut().__allow_command(
            format!("plugin:epicenter-folder|{command}"),
            ExecutionContext::Local,
        );
    }
}

/// An app whose windows may call every plugin command, with the scope
/// `notes` registered for the window `main`.
fn fixture(label: &str) -> Fixture {
    fixture_in(label, context())
}

fn fixture_in(label: &str, context: tauri::Context<MockRuntime>) -> Fixture {
    let directory = temp(label);
    let root = directory.0.join("notes");
    let app = mock_builder()
        .plugin(init())
        .build(context)
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
    request(window, command, InvokeBody::Json(args), Default::default())
}

fn request(
    window: &WebviewWindow<MockRuntime>,
    command: &str,
    body: InvokeBody,
    headers: HeaderMap,
) -> Result<Value, Value> {
    response(window, command, body, headers)
        .map(|body| body.deserialize::<Value>().expect("a JSON response"))
}

fn response(
    window: &WebviewWindow<MockRuntime>,
    command: &str,
    body: InvokeBody,
    headers: HeaderMap,
) -> Result<InvokeResponseBody, Value> {
    tauri::test::get_ipc_response(
        window,
        InvokeRequest {
            cmd: format!("plugin:epicenter-folder|{command}"),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body,
            headers,
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
}

/// `read_folder_file` as `directory-tauri.ts` asks for it: the bytes, which
/// arrive raw, or the refusal.
fn read_file(
    window: &WebviewWindow<MockRuntime>,
    scope: &str,
    path: &str,
) -> Result<Vec<u8>, Value> {
    match response(
        window,
        "read_folder_file",
        InvokeBody::Json(json!({ "scope": scope, "path": path })),
        Default::default(),
    )? {
        InvokeResponseBody::Raw(bytes) => Ok(bytes),
        InvokeResponseBody::Json(json) => panic!("the bytes came back as JSON: {json}"),
    }
}

fn read_dir(
    window: &WebviewWindow<MockRuntime>,
    scope: &str,
    path: &str,
) -> Result<Value, Value> {
    invoke(
        window,
        "read_folder_directory",
        json!({ "scope": scope, "path": path }),
    )
}

fn lstat(window: &WebviewWindow<MockRuntime>, scope: &str, path: &str) -> Result<Value, Value> {
    invoke(
        window,
        "stat_folder_path",
        json!({ "scope": scope, "path": path }),
    )
}

/// `write_folder_file` as `directory-tauri.ts` sends it: the bytes as the
/// raw body, the rest in percent-encoded headers.
fn write_file(
    window: &WebviewWindow<MockRuntime>,
    path: &str,
    bytes: &[u8],
    create_new: bool,
) -> Result<Value, Value> {
    request(
        window,
        "write_folder_file",
        InvokeBody::Raw(bytes.to_vec()),
        write_headers(path, create_new),
    )
}

fn write_headers(path: &str, create_new: bool) -> HeaderMap {
    let encoded = |value: &str| {
        HeaderValue::from_str(
            &percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC)
                .to_string(),
        )
        .unwrap()
    };
    let mut headers = HeaderMap::new();
    headers.insert("scope", encoded("notes"));
    headers.insert("path", encoded(path));
    headers.insert("create-new", encoded(&create_new.to_string()));
    headers
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

/// Write a file as the engine overwrites one: its bytes to a new staged
/// file, which is then renamed over the path, whatever is there.
fn write(
    fixture: &Fixture,
    window: &WebviewWindow<MockRuntime>,
    relative: &str,
    content: &str,
) -> Result<Value, Value> {
    publish(fixture, window, relative, content, json!("any"))
}

/// Write a file as `write` does, landing only if the path holds what
/// `expected` says.
fn publish(
    fixture: &Fixture,
    window: &WebviewWindow<MockRuntime>,
    relative: &str,
    content: &str,
    expected: Value,
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
    write_file(window, &staged, content.as_bytes(), true)?;
    invoke(
        window,
        "rename_folder_path",
        json!({
            "scope": "notes",
            "from": staged,
            "to": inside(fixture, relative),
            "expected": expected,
        }),
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
            "expected": "absent",
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
            json!({
                "scope": "notes",
                "path": inside(&fixture, path),
                "recursive": false,
                "expected": "any",
            }),
        )
        .unwrap();
    }
    assert!(!fixture.root.join("notes").exists());

    // Git's private state and anything outside the root are refused.
    assert!(write(&fixture, &main, ".git/config", "[core]\n").is_err());
    let outside = fixture.root.parent().unwrap().join("outside.md");
    assert!(write_file(&main, outside.to_str().unwrap(), b"x", false).is_err());
    assert!(!outside.exists());
}

/// The lowercase hexadecimal SHA-256 the page computes.
fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn a_save_lands_only_on_what_the_page_expected_and_says_what_it_found() {
    let fixture = fixture("expected");
    let main = window(&fixture.app, "main");
    grant(&main).unwrap();
    git(&main, &["init", "--quiet", "--initial-branch=main"], "1").unwrap();
    publish(&fixture, &main, "a.md", "first\n", json!("absent")).unwrap();

    assert_eq!(
        publish(&fixture, &main, "a.md", "again\n", json!("absent")).unwrap_err(),
        json!({ "name": "Exists" })
    );
    assert_eq!(
        publish(&fixture, &main, "b.md", "b\n", json!("present")).unwrap_err(),
        json!({ "name": "NotFound" })
    );
    let stale = json!({ "sha256": sha256(b"stale\n") });
    assert_eq!(
        publish(&fixture, &main, "a.md", "mine\n", stale.clone()).unwrap_err(),
        json!({ "name": "Conflict", "actualSha256": sha256(b"first\n") })
    );
    assert_eq!(
        invoke(
            &main,
            "remove_folder_path",
            json!({
                "scope": "notes",
                "path": inside(&fixture, "a.md"),
                "recursive": false,
                "expected": stale,
            }),
        )
        .unwrap_err(),
        json!({ "name": "Conflict", "actualSha256": sha256(b"first\n") })
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("a.md")).unwrap(),
        "first\n"
    );
    publish(
        &fixture,
        &main,
        "a.md",
        "second\n",
        json!({ "sha256": sha256(b"first\n") }),
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("a.md")).unwrap(),
        "second\n"
    );
    // Any other refusal names itself.
    let refused = publish(&fixture, &main, ".git/config", "[core]\n", json!("any")).unwrap_err();
    assert_eq!(refused["name"], "Failed", "{refused}");
}

#[test]
fn a_staged_write_takes_its_bytes_raw_and_its_path_percent_encoded() {
    let fixture = fixture("raw-write");
    let main = window(&fixture.app, "main");
    grant(&main).unwrap();
    git(&main, &["init", "--quiet", "--initial-branch=main"], "1").unwrap();
    let scratch = inside(&fixture, ".git/epicenter/scratch");
    invoke(
        &main,
        "make_folder_directory",
        json!({ "scope": "notes", "path": scratch }),
    )
    .unwrap();

    // Every byte value arrives as it is, and the path decodes whole: the
    // headers encode every `/` and `.` in it.
    let bytes: Vec<u8> = (0..=255).collect();
    let staged = format!("{scratch}/raw");
    write_file(&main, &staged, &bytes, true).unwrap();
    invoke(
        &main,
        "rename_folder_path",
        json!({
            "scope": "notes",
            "from": staged,
            "to": inside(&fixture, "all.bin"),
            "expected": "absent",
        }),
    )
    .unwrap();
    assert_eq!(std::fs::read(fixture.root.join("all.bin")).unwrap(), bytes);

    // The bytes as a JSON array, Tauri's postMessage fallback, also land.
    let fallback = format!("{scratch}/fallback");
    request(
        &main,
        "write_folder_file",
        InvokeBody::Json(json!([0, 120, 255])),
        write_headers(&fallback, true),
    )
    .unwrap();
    assert_eq!(std::fs::read(&fallback).unwrap(), vec![0, 120, 255]);

    // Any other JSON body, or a header missing, is refused.
    let refused = format!("{scratch}/refused");
    let json = request(
        &main,
        "write_folder_file",
        InvokeBody::Json(json!({ "bytes": [1] })),
        write_headers(&refused, true),
    )
    .unwrap_err();
    assert!(text(&json).contains("raw body"), "{json}");
    let mut headers = write_headers(&refused, true);
    headers.remove("create-new");
    let missing = request(
        &main,
        "write_folder_file",
        InvokeBody::Raw(b"x".to_vec()),
        headers,
    )
    .unwrap_err();
    assert!(text(&missing).contains("create-new"), "{missing}");
    assert!(!std::path::Path::new(&refused).exists());
}

#[test]
fn reads_reach_the_granted_root_and_nothing_else() {
    let fixture = fixture("reads");
    let main = window(&fixture.app, "main");
    let root = fixture.root.to_str().unwrap().to_string();
    // Nothing is read before a grant.
    assert!(text(&read_dir(&main, "notes", &root).unwrap_err()).contains("not been granted"));
    grant(&main).unwrap();
    git(&main, &["init", "--quiet", "--initial-branch=main"], "1").unwrap();
    invoke(
        &main,
        "make_folder_directory",
        json!({ "scope": "notes", "path": inside(&fixture, "todos") }),
    )
    .unwrap();
    write(&fixture, &main, "todos/a.md", "first\n").unwrap();

    let mut names: Vec<(String, String)> = read_dir(&main, "notes", &root)
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| (text(&entry["name"]), text(&entry["kind"])))
        .collect();
    names.sort();
    assert_eq!(
        names,
        [
            (".git".to_string(), "directory".to_string()),
            ("todos".to_string(), "directory".to_string()),
        ]
    );
    // Every byte value arrives as it is, raw.
    let bytes: Vec<u8> = (0..=255).collect();
    std::fs::write(fixture.root.join("todos/all.bin"), &bytes).unwrap();
    assert_eq!(read_file(&main, "notes", &inside(&fixture, "todos/all.bin")).unwrap(), bytes);
    // Git's own files are read too.
    assert_eq!(
        read_file(&main, "notes", &inside(&fixture, ".git/HEAD")).unwrap(),
        b"ref: refs/heads/main\n"
    );
    let info = lstat(&main, "notes", &inside(&fixture, "todos/a.md")).unwrap();
    assert_eq!(info["kind"], "file");
    assert_eq!(info["size"], 6.0);
    assert_eq!(lstat(&main, "notes", &inside(&fixture, "todos/b.md")).unwrap(), Value::Null);
    assert!(read_file(&main, "notes", &inside(&fixture, "todos/b.md")).is_err());

    // Outside the root is refused, a sibling whose name extends it included.
    let outside = fixture.root.parent().unwrap().join("outside.md");
    std::fs::write(&outside, b"theirs").unwrap();
    let sibling = format!("{root}2/a.md");
    for path in [outside.to_str().unwrap(), &sibling, &format!("{root}/todos/../../outside.md")] {
        assert!(read_file(&main, "notes", path).is_err(), "{path}");
        assert!(lstat(&main, "notes", path).is_err(), "{path}");
        assert!(read_dir(&main, "notes", path).is_err(), "{path}");
    }
}

#[cfg(unix)]
#[test]
fn a_read_through_a_link_is_refused_and_a_final_link_is_described() {
    let fixture = fixture("read-links");
    let main = window(&fixture.app, "main");
    grant(&main).unwrap();
    let elsewhere = fixture.root.parent().unwrap().join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    std::fs::write(elsewhere.join("secret.md"), b"theirs").unwrap();
    std::os::unix::fs::symlink(&elsewhere, fixture.root.join("todos")).unwrap();
    std::os::unix::fs::symlink(elsewhere.join("secret.md"), fixture.root.join("a.md")).unwrap();

    let through = inside(&fixture, "todos/secret.md");
    assert!(text(&read_file(&main, "notes", &through).unwrap_err()).contains("link"));
    assert!(text(&lstat(&main, "notes", &through).unwrap_err()).contains("link"));
    assert!(read_dir(&main, "notes", &inside(&fixture, "todos")).is_err());
    assert!(read_file(&main, "notes", &inside(&fixture, "a.md")).is_err());
    for link in ["todos", "a.md"] {
        assert_eq!(lstat(&main, "notes", &inside(&fixture, link)).unwrap()["kind"], "link");
    }
    let listed = read_dir(&main, "notes", fixture.root.to_str().unwrap()).unwrap();
    assert!(listed
        .as_array()
        .unwrap()
        .iter()
        .all(|entry| entry["kind"] == "link"), "{listed}");
}

#[test]
fn two_windows_each_read_only_their_own_folder() {
    let fixture = fixture("two-readers");
    let other_root = fixture.root.parent().unwrap().join("other-notes");
    fixture
        .app
        .folders()
        .register(ScopeConfig {
            scope: "other-notes".to_string(),
            folder: FolderConfig::new(
                &other_root,
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
    std::fs::write(fixture.root.join("mine.md"), b"main's").unwrap();
    std::fs::write(other_root.join("mine.md"), b"other's").unwrap();

    assert_eq!(read_file(&main, "notes", &inside(&fixture, "mine.md")).unwrap(), b"main's");
    let others = other_root.join("mine.md");
    let others = others.to_str().unwrap();
    assert_eq!(read_file(&other, "other-notes", others).unwrap(), b"other's");
    // Neither reaches the other's root, by its own scope or by the other's.
    assert!(read_file(&main, "notes", others).is_err());
    assert!(text(&read_file(&main, "other-notes", others).unwrap_err())
        .contains("WindowNotPermitted"));
    assert!(read_file(&other, "other-notes", &inside(&fixture, "mine.md")).is_err());
    assert!(text(&lstat(&other, "notes", &inside(&fixture, "mine.md")).unwrap_err())
        .contains("WindowNotPermitted"));
}

/// Before Tauri 2.12 a capability added at run time numbered its scopes from
/// zero, so a grant that added one collided with a scope the app already
/// had, and every read failed to deserialize its scope. A grant now adds
/// nothing to the app's access control: here the app scopes a permission of
/// another plugin, and the grant and its reads work as they do in any app.
#[test]
fn a_grant_in_an_app_that_already_scopes_a_permission_still_reads() {
    let mut context = mock_context(noop_assets());
    let permission = serde_json::from_value(json!({
        "identifier": "allow-fetch",
        "commands": { "allow": ["fetch"] },
    }))
    .unwrap();
    let http = Manifest {
        default_permission: None,
        permissions: [("allow-fetch".to_string(), permission)].into(),
        permission_sets: Default::default(),
        global_scope_schema: None,
    };
    let acl = [("http".to_string(), http)].into();
    let capability: Capability = serde_json::from_value(json!({
        "identifier": "main",
        "windows": ["main"],
        "permissions": [
            { "identifier": "http:allow-fetch", "allow": [{ "url": "https://example.com/*" }] },
        ],
    }))
    .unwrap();
    let resolved = Resolved::resolve(
        &acl,
        [("main".to_string(), capability)].into(),
        Target::current(),
    )
    .unwrap();
    assert!(!resolved.command_scope.is_empty(), "the app scopes a permission");
    *context.runtime_authority_mut() = RuntimeAuthority::new(acl, resolved);
    allow_plugin(&mut context);
    let fixture = fixture_in("scoped-app", context);
    let main = window(&fixture.app, "main");
    grant(&main).unwrap();
    std::fs::write(fixture.root.join("a.md"), b"read").unwrap();
    assert_eq!(read_file(&main, "notes", &inside(&fixture, "a.md")).unwrap(), b"read");
    assert_eq!(lstat(&main, "notes", &inside(&fixture, "a.md")).unwrap()["kind"], "file");
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
