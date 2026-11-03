//! The plugin through Tauri's real invoke path, on the mock runtime.
//!
//! Each test builds an app with the plugin installed, names its roots as a
//! shell does at startup, creates a window, and sends
//! `plugin:epicenter-folder|...` requests exactly as a page's `invoke`
//! would. The folder is a real directory; a test makes its repository with
//! the real `git`, which the plugin itself never runs (ADR-0559).
//!
//! Key behaviors:
//! - The generated TypeScript bindings match the registered commands.
//! - A page reaches a root by name, once it opened it, and holds no
//!   absolute path but the one `open_root` gives it to show. A root the
//!   shell did not name, or a name that is not a root, reaches nothing.
//! - Opening makes a missing folder, follows a link at the root, and makes
//!   nothing behind a link whose target is gone; every storage command on
//!   such a root answers `Disconnected` with the link's folder and target.
//! - Two roots are separate: a file in one is never read through the other.
//! - Storage reaches the data paths of the root and nothing else: never
//!   `.git`, never outside it, never through a link. A save stages in the
//!   root's `.epicenter/saves` and makes no `.git`; a `.git` file or link
//!   opens and saves and is left as it is. Opening sweeps staged files a
//!   stopped save left.
//! - A put takes its bytes as a raw body and its arguments as
//!   percent-encoded headers; a JSON array of bytes, Tauri's postMessage
//!   fallback, is accepted too. A file read returns its bytes raw. A
//!   refusal is a `StorageError`.
//! - After shutdown, a late change and a late open are refused.
//! - A window without the plugin's permission cannot call it.

use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::http::{HeaderMap, HeaderValue};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
use tauri::utils::acl::ExecutionContext;
use tauri::webview::InvokeRequest;
use tauri::{App, Listener, WebviewWindow, WebviewWindowBuilder};

use crate::{init, FolderEvent, Root, RootsExt, COMMANDS};

/// Subscribe before opening the root, as a page does.
fn heard(app: &App<MockRuntime>, root: Root, send: std::sync::mpsc::Sender<FolderEvent>) {
    app.listen_any("folder-changed", move |event| {
        if let Ok(change) = serde_json::from_str::<FolderEvent>(event.payload()) {
            if change.root == root {
                let _ = send.send(change);
            }
        }
    });
}

fn open_root(window: &WebviewWindow<MockRuntime>, root: Root) -> Result<String, Value> {
    let webview: tauri::Webview<MockRuntime> = window.as_ref().clone();
    tauri::async_runtime::block_on(crate::commands::open_root(webview, root))
        .map_err(|error| serde_json::to_value(error).unwrap())
}

fn open(window: &WebviewWindow<MockRuntime>) -> Result<String, Value> {
    open_root(window, Root::Data)
}

/// Wait for a change that may name `path`.
fn wait_for(receive: &std::sync::mpsc::Receiver<FolderEvent>, path: &str) {
    let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let notice = receive
            .recv_timeout(until.saturating_duration_since(std::time::Instant::now()))
            .expect("native observation");
        if notice.paths.as_ref().is_none_or(|paths| {
            paths
                .iter()
                .any(|hint| path == hint || path.starts_with(&format!("{hint}/")))
        }) {
            return;
        }
    }
}

/// A page's changes come through the channel it opened the root with, and
/// a reloaded page's new channel replaces its old one.
/// Real notify delivery through each root's watch: a change in one root is
/// not heard from the other. No file content or absolute path crosses the
/// event.
#[test]
fn external_writes_and_atomic_replacements_reach_only_their_roots_listeners() {
    use std::sync::mpsc;

    let fixture = fixture("native-watch");
    let main = fixture.window("main");
    let (send, receive) = mpsc::channel();
    let (settings_send, settings_receive) = mpsc::channel();
    heard(&fixture.app, Root::Data, send);
    heard(&fixture.app, Root::AppData, settings_send);
    open_root(&main, Root::Data).unwrap();
    open_root(&main, Root::AppData).unwrap();

    std::fs::create_dir(fixture.root.join("notes")).unwrap();
    std::fs::write(fixture.root.join("notes/a.md"), b"external").unwrap();
    wait_for(&receive, "notes/a.md");
    assert!(settings_receive.try_recv().is_err());

    let staged = fixture.root.with_file_name("replacement");
    std::fs::write(&staged, b"replaced").unwrap();
    std::fs::rename(staged, fixture.root.join("notes/a.md")).unwrap();
    wait_for(&receive, "notes/a.md");
    assert_eq!(read_file(&main, "notes/a.md").unwrap(), b"replaced");

    std::fs::rename(fixture.root.join("notes"), fixture.root.join("archive")).unwrap();
    wait_for(&receive, "notes/a.md");
    assert_eq!(read_file(&main, "archive/a.md").unwrap(), b"replaced");
    assert!(settings_receive.try_recv().is_err());
    fixture.app.roots().shutdown();
}

/// A page names a root, and `open_root` answers the path the shell
/// named it at, to show; each root holds its own files.
#[test]
fn a_page_reaches_each_root_by_name_and_each_holds_its_own_files() {
    let fixture = fixture("two-roots");
    let main = fixture.window("main");
    open_root(&main, Root::Data).unwrap();
    open_root(&main, Root::AppData).unwrap();
    assert_eq!(
        open_root(&main, Root::Data).unwrap(),
        fixture.root.display().to_string()
    );
    assert_eq!(
        open_root(&main, Root::AppData).unwrap(),
        fixture.app_data.display().to_string()
    );
    std::fs::write(fixture.root.join("a.md"), b"data").unwrap();
    std::fs::write(fixture.app_data.join("a.md"), b"settings").unwrap();
    assert_eq!(read_file(&main, "a.md").unwrap(), b"data");
    let InvokeResponseBody::Raw(bytes) = response(
        &main,
        "read_folder_file",
        InvokeBody::Json(json!({ "path": "a.md", "root": "AppData" })),
        Default::default(),
    )
    .unwrap() else {
        panic!("the bytes came back as JSON");
    };
    assert!(bytes.ends_with(b"\0settings"));
    let mut headers = put_headers("theme.md", false, None);
    headers.insert("root", encoded("AppData"));
    request(
        &main,
        "put_folder_file",
        InvokeBody::Raw(b"dark".to_vec()),
        headers,
    )
    .unwrap();
    assert_eq!(
        std::fs::read(fixture.app_data.join("theme.md")).unwrap(),
        b"dark"
    );
    assert!(!fixture.root.join("theme.md").exists());
    // An absolute path, or any name that is not a root, reaches nothing.
    for named in [json!(fixture.root), json!("data"), json!("Elsewhere")] {
        assert!(invoke(&main, "list_folder", json!({ "root": named })).is_err());
    }
    let mut headers = put_headers("theme.md", false, None);
    headers.insert("root", encoded(fixture.root.to_str().unwrap()));
    let refused = request(
        &main,
        "put_folder_file",
        InvokeBody::Raw(b"x".to_vec()),
        headers,
    )
    .unwrap_err();
    assert_eq!(
        refused,
        json!({ "name": "Invalid", "root": fixture.root.display().to_string() })
    );
}

/// A root is made when its folder is missing, and the page's first open
/// is what makes it. Before a page opens a root, no command reaches it, and
/// nothing is made.
#[test]
fn a_root_is_made_when_missing_and_reached_only_once_opened() {
    let fixture = fixture("open-or-create");
    let main = fixture.window("main");
    std::fs::remove_dir(&fixture.root).unwrap();
    let not_open = json!({ "name": "NotOpen", "root": "Data" });
    assert_eq!(
        invoke(&main, "list_folder", json!({ "root": "Data" })).unwrap_err(),
        not_open
    );
    assert_eq!(read_file(&main, "a.md").unwrap_err(), not_open);
    assert_eq!(put(&main, "a.md", Some(b"a"), None).unwrap_err(), not_open);
    assert!(!fixture.root.exists());
    assert_eq!(open(&main).unwrap(), fixture.root.display().to_string());
    assert!(fixture.root.is_dir());
    assert_eq!(
        put(&main, "todos/a.md", Some(b"a"), None).unwrap(),
        "landed"
    );
}

/// A root the shell did not name opens nothing.
#[test]
fn a_root_the_shell_did_not_name_is_refused() {
    let directory = temp("unnamed");
    let app = mock_builder()
        .plugin(init())
        .build(context())
        .expect("mock app");
    let main = window(&app, "main");
    let not_named = json!({ "name": "NotNamed", "root": "Data" });
    assert_eq!(open(&main).unwrap_err(), not_named);
    assert_eq!(open_root(&main, Root::Data).unwrap_err(), not_named);
    assert_eq!(
        invoke(&main, "list_folder", json!({ "root": "Data" })).unwrap_err(),
        not_named
    );
    assert_eq!(std::fs::read_dir(&directory.0).unwrap().count(), 0);
    app.roots().shutdown();
}

/// The data root's path is a link: the folder it names opens and is read
/// and written through the link, and the page is shown the link's path. A
/// link whose target is gone is `Disconnected`, and nothing is made.
#[cfg(unix)]
#[test]
fn a_link_at_the_root_is_followed_and_a_dangling_one_makes_nothing() {
    let fixture = fixture("linked-root");
    let main = fixture.window("main");
    let drive = fixture.root.with_file_name("drive");
    std::fs::remove_dir(&fixture.root).unwrap();
    std::os::unix::fs::symlink(&drive, &fixture.root).unwrap();
    let disconnected = json!({
        "name": "Disconnected",
        "folder": fixture.root,
        "target": drive,
    });
    assert_eq!(open(&main).unwrap_err(), disconnected);
    assert!(!drive.exists());
    std::fs::create_dir(&drive).unwrap();
    open(&main).unwrap();
    assert_eq!(
        open_root(&main, Root::Data).unwrap(),
        fixture.root.display().to_string()
    );
    assert_eq!(put(&main, "a.md", Some(b"there"), None).unwrap(), "landed");
    assert_eq!(std::fs::read(drive.join("a.md")).unwrap(), b"there");
    assert_eq!(read_file(&main, "a.md").unwrap(), b"there");
}

/// Every storage command on a data root behind a link whose target is gone
/// answers `Disconnected` with the link's folder and target, whether the
/// root never opened or the drive went away after it did, and makes
/// nothing: no target, no staged save, no file.
#[cfg(unix)]
#[test]
fn storage_behind_a_dangling_link_is_disconnected_and_makes_nothing() {
    let fixture = fixture("dangling-storage");
    let main = fixture.window("main");
    let drive = fixture.root.with_file_name("drive");
    std::fs::remove_dir(&fixture.root).unwrap();
    std::os::unix::fs::symlink(&drive, &fixture.root).unwrap();
    let disconnected = json!({
        "name": "Disconnected",
        "folder": fixture.root,
        "target": drive,
    });
    let every_command = |main: &WebviewWindow<MockRuntime>| {
        assert_eq!(
            invoke(main, "list_folder", json!({ "root": "Data" })).unwrap_err(),
            disconnected
        );
        assert_eq!(read_file(main, "a.md").unwrap_err(), disconnected);
        assert_eq!(
            put(main, "notes/a.md", Some(b"a"), None).unwrap_err(),
            disconnected
        );
        assert_eq!(
            put(main, "a.md", None, Some(&sha256(b"a"))).unwrap_err(),
            disconnected
        );
    };
    // Never opened: the open failed, as startup's does.
    assert_eq!(open(&main).unwrap_err(), disconnected);
    every_command(&main);
    assert!(!drive.exists());
    // Opened, then the drive went away.
    std::fs::create_dir(&drive).unwrap();
    open(&main).unwrap();
    std::fs::remove_dir_all(&drive).unwrap();
    every_command(&main);
    assert!(!drive.exists());
    assert!(fixture.root.symlink_metadata().unwrap().is_symlink());
    // The other root works all the while.
    open_root(&main, Root::AppData).unwrap();
    let mut headers = put_headers("a.md", false, None);
    headers.insert("root", encoded("AppData"));
    assert_eq!(
        request(
            &main,
            "put_folder_file",
            InvokeBody::Raw(b"a".to_vec()),
            headers
        )
        .unwrap(),
        "landed"
    );
}

/// Asking Epicenter about a folder works for a root the page opened.
#[test]
fn epicenter_is_asked_only_about_an_open_root() {
    let fixture = fixture("synced");
    let main = fixture.window("main");
    open_root(&main, Root::AppData).unwrap();
    assert_eq!(
        invoke(&main, "synced_with_epicenter", json!({})).unwrap_err(),
        json!({ "name": "Folder", "message": "The Data folder is not open." })
    );
    assert_eq!(
        invoke(
            &main,
            "sync_with_epicenter",
            json!({ "contract": "https://capture.epicenter.so/contract.json" })
        )
        .unwrap_err(),
        json!({ "name": "Folder", "message": "The Data folder is not open." })
    );
    open(&main).unwrap();
    assert_eq!(
        invoke(&main, "synced_with_epicenter", json!({})).unwrap(),
        json!(false)
    );
    open_root(&main, Root::AppData).unwrap();
    assert_eq!(
        invoke(&main, "synced_with_epicenter", json!({})).unwrap(),
        json!(false)
    );
}

/// A note the folder made, never edited, then deleted by another program is
/// reported gone. macOS's FSEvents never reports removing a file that ever
/// had a second name, so a create by hard link would leave it listed.
#[test]
fn a_note_the_folder_made_and_another_program_deletes_is_reported_gone() {
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    let fixture = fixture("made-then-deleted");
    let main = fixture.window("main");
    let (send, receive) = mpsc::channel();
    heard(&fixture.app, Root::Data, send);
    open_root(&main, Root::Data).unwrap();
    let names_made = |change: &crate::FolderEvent| {
        change
            .paths
            .as_ref()
            .is_none_or(|paths| paths.iter().any(|path| path == "made.md"))
    };
    let observed = |within: Duration| {
        let until = Instant::now() + within;
        while let Ok(change) = receive.recv_timeout(until.saturating_duration_since(Instant::now()))
        {
            if names_made(&change) {
                return true;
            }
        }
        false
    };

    assert_eq!(put(&main, "made.md", Some(b"new"), None).unwrap(), "landed");
    assert!(observed(Duration::from_secs(5)), "the create is observed");
    // FSEvents may deliver the create in more than one batch.
    std::thread::sleep(Duration::from_millis(500));
    while receive.try_recv().is_ok() {}

    std::fs::remove_file(fixture.root.join("made.md")).unwrap();
    assert!(observed(Duration::from_secs(5)), "the deletion is observed");
    fixture.app.roots().shutdown();
}

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
    // `put_folder_file` takes a raw body and `read_folder_file` returns
    // one, which specta cannot type; the page invokes them by name.
    const RAW: [&str; 2] = ["put_folder_file", "read_folder_file"];
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
    /// The data root, `notes`, as the shell named it.
    root: PathBuf,
    /// The AppData root, `app-data`.
    app_data: PathBuf,
    _directory: TempDirectory,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.app.roots().shutdown();
    }
}

impl Fixture {
    fn window(&self, label: &str) -> WebviewWindow<MockRuntime> {
        window(&self.app, label)
    }
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

/// An app whose windows may call every plugin command, with its data root
/// named at `notes`, an empty directory, and its AppData root at `app-data`.
fn fixture(label: &str) -> Fixture {
    fixture_in(label, context())
}

fn fixture_in(label: &str, context: tauri::Context<MockRuntime>) -> Fixture {
    let directory = temp(label);
    let root = directory.0.join("notes");
    std::fs::create_dir(&root).unwrap();
    let app_data = directory.0.join("app-data");
    let app = mock_builder()
        .plugin(init())
        .build(context)
        .expect("mock app");
    app.roots().name(Root::Data, root.clone(), |_| None);
    app.roots().name(Root::AppData, app_data.clone(), |_| None);
    Fixture {
        app,
        root,
        app_data,
        _directory: directory,
    }
}

/// The fixture with `main`'s page having opened its data root.
fn opened(label: &str) -> (Fixture, WebviewWindow<MockRuntime>) {
    let fixture = fixture(label);
    let main = fixture.window("main");
    open(&main).unwrap();
    (fixture, main)
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

/// `read_folder_file` in the data root, as
/// `device/tauri-store.ts` asks for it: the bytes, which arrive raw, or the
/// refusal.
fn read_file(window: &WebviewWindow<MockRuntime>, path: &str) -> Result<Vec<u8>, Value> {
    match response(
        window,
        "read_folder_file",
        InvokeBody::Json(json!({ "path": path, "root": "Data" })),
        Default::default(),
    )? {
        InvokeResponseBody::Raw(bytes) => {
            let separator = bytes
                .iter()
                .position(|byte| *byte == 0)
                .expect("stamped read");
            assert!(std::str::from_utf8(&bytes[..separator])
                .unwrap()
                .starts_with("v1:"));
            Ok(bytes[separator + 1..].to_vec())
        }
        InvokeResponseBody::Json(json) => panic!("the bytes came back as JSON: {json}"),
    }
}

/// `put_folder_file` in the data root, as
/// `device/tauri-store.ts` sends it: the bytes as the raw body, the rest in
/// percent-encoded headers. `None` removes the file.
fn put(
    window: &WebviewWindow<MockRuntime>,
    path: &str,
    bytes: Option<&[u8]>,
    if_match: Option<&str>,
) -> Result<Value, Value> {
    request(
        window,
        "put_folder_file",
        InvokeBody::Raw(bytes.unwrap_or_default().to_vec()),
        put_headers(path, bytes.is_none(), if_match),
    )
}

/// The headers of a put in the data root expecting the file whose SHA-256
/// is `if_match`, or nothing there for `None`.
fn put_headers(path: &str, remove: bool, if_match: Option<&str>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("path", encoded(path));
    headers.insert("root", encoded("Data"));
    headers.insert("remove", encoded(&remove.to_string()));
    let expected = if_match.map_or("absent".to_string(), |hash| format!("sha256:{hash}"));
    headers.insert("expected", encoded(&expected));
    headers
}

fn encoded(value: &str) -> HeaderValue {
    HeaderValue::from_str(
        &percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC)
            .to_string(),
    )
    .unwrap()
}

fn text(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

/// Write a file over the version there, as a page that just read it does.
fn write(
    fixture: &Fixture,
    window: &WebviewWindow<MockRuntime>,
    relative: &str,
    content: &str,
) -> Result<Value, Value> {
    let there = std::fs::read(fixture.root.join(relative)).ok();
    let landed = put(
        window,
        relative,
        Some(content.as_bytes()),
        there.as_deref().map(sha256).as_deref(),
    )?;
    assert_eq!(landed, "landed");
    Ok(landed)
}

/// Run the real `git` in the data root, as a person or the `epicenter` CLI
/// would; the plugin runs none.
fn git(window: &WebviewWindow<MockRuntime>, args: &[&str]) -> Result<String, String> {
    let directory = window
        .roots()
        .opened(Root::Data)
        .map_err(|refusal| format!("{refusal:?}"))?;
    let output = std::process::Command::new("git")
        .args(["-c", "user.name=Test", "-c", "user.email=test@example.com"])
        .args(args)
        .current_dir(directory.root())
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// `.epicenter/saves` inside the folder, where a put stages its bytes.
fn saves(fixture: &Fixture) -> PathBuf {
    epicenter_folder_core::state::saves(&fixture.root)
}

/// The staged files left in the folder's `saves`.
fn staged(fixture: &Fixture) -> Vec<String> {
    std::fs::read_dir(saves(fixture))
        .map(|entries| {
            entries
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn changes_land_under_the_root_and_never_in_git_state() {
    let (fixture, main) = opened("changes");

    put(&main, "notes/a.md", Some(b"first\n"), None).unwrap();
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("notes/a.md")).unwrap(),
        "first\n"
    );
    assert_eq!(
        put(&main, "notes/a.md", None, Some(&sha256(b"first\n"))).unwrap(),
        "landed"
    );
    assert!(!fixture.root.join("notes/a.md").exists());
    assert_eq!(staged(&fixture), Vec::<String>::new());

    // Git's private state and anything outside the root are refused.
    for refused in [".git/config", "../outside.md", "/outside.md", "notes//a.md"] {
        let answer = put(&main, refused, Some(b"x"), None).unwrap_err();
        assert_eq!(answer["name"], "InvalidPath", "{refused}: {answer}");
        assert_eq!(answer["path"], refused, "{answer}");
    }
    assert!(!fixture.root.join(".git/config").exists());
    assert!(!fixture.root.parent().unwrap().join("outside.md").exists());
    // Saving made no `.git`: a folder has none until the CLI makes one.
    assert!(!fixture.root.join(".git").exists());
}

/// The lowercase hexadecimal SHA-256 the page computes.
fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[test]
fn a_save_lands_only_on_what_the_page_expected() {
    let (fixture, main) = opened("expected");
    git(&main, &["init", "--quiet", "--initial-branch=main"]).unwrap();
    assert_eq!(
        put(&main, "a.md", Some(b"first\n"), None).unwrap(),
        "landed"
    );
    assert_eq!(put(&main, "a.md", Some(b"again\n"), None).unwrap(), "stale");
    let stale = sha256(b"stale\n");
    assert_eq!(
        put(&main, "b.md", Some(b"b\n"), Some(&stale)).unwrap(),
        "stale"
    );
    assert_eq!(
        put(&main, "a.md", Some(b"mine\n"), Some(&stale)).unwrap(),
        "stale"
    );
    assert_eq!(put(&main, "a.md", None, Some(&stale)).unwrap(), "stale");
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("a.md")).unwrap(),
        "first\n"
    );
    assert!(!fixture.root.join("b.md").exists());
    assert_eq!(
        put(&main, "a.md", Some(b"second\n"), Some(&sha256(b"first\n"))).unwrap(),
        "landed"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("a.md")).unwrap(),
        "second\n"
    );
    // A directory where the file would be is refused by name.
    std::fs::create_dir(fixture.root.join("todos")).unwrap();
    assert_eq!(
        put(&main, "todos", Some(b"x"), None).unwrap_err(),
        json!({ "name": "NotAFile", "path": "todos" })
    );
    assert_eq!(
        put(&main, "a.md/b.md", Some(b"x"), None).unwrap_err(),
        json!({ "name": "NotADirectory", "path": "a.md" })
    );
    assert_eq!(staged(&fixture), Vec::<String>::new());
}

/// A put names the version it read, `absent` or a tagged hash, on the wire:
/// a bare hash, a keyword dressed as one, or a word for "whatever is there"
/// is refused before anything changes.
#[test]
fn a_save_names_the_version_it_read_and_a_hash_is_tagged() {
    let (fixture, main) = opened("expected-version");
    assert_eq!(put(&main, "a.md", Some(b"new\n"), None).unwrap(), "landed");
    for refused in [
        sha256(b"new\n"),
        "sha256:absent".to_string(),
        "any".to_string(),
        "present".to_string(),
    ] {
        let mut headers = put_headers("a.md", false, None);
        headers.insert("expected", encoded(&refused));
        let answer = request(
            &main,
            "put_folder_file",
            InvokeBody::Raw(b"x".to_vec()),
            headers,
        )
        .unwrap_err();
        assert_eq!(answer["name"], "Io", "{refused}: {answer}");
        assert!(text(&answer["message"]).contains("sha256:"), "{answer}");
    }
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("a.md")).unwrap(),
        "new\n"
    );
}

#[test]
fn a_put_takes_its_bytes_raw_and_its_path_percent_encoded() {
    let (fixture, main) = opened("raw-write");

    // Every byte value arrives as it is, and the path decodes whole: the
    // headers encode every `/`, `.`, and space in it.
    let bytes: Vec<u8> = (0..=255).collect();
    assert_eq!(
        put(&main, "notes/all of it.bin", Some(&bytes), None).unwrap(),
        "landed"
    );
    assert_eq!(
        std::fs::read(fixture.root.join("notes/all of it.bin")).unwrap(),
        bytes
    );

    // The bytes as a JSON array, Tauri's postMessage fallback, also land.
    request(
        &main,
        "put_folder_file",
        InvokeBody::Json(json!([0, 120, 255])),
        put_headers("fallback.bin", false, None),
    )
    .unwrap();
    assert_eq!(
        std::fs::read(fixture.root.join("fallback.bin")).unwrap(),
        vec![0, 120, 255]
    );

    // Any other JSON body, or a header missing, is refused.
    let json = request(
        &main,
        "put_folder_file",
        InvokeBody::Json(json!({ "bytes": [1] })),
        put_headers("refused.bin", false, None),
    )
    .unwrap_err();
    assert!(text(&json["message"]).contains("raw body"), "{json}");
    for header in ["remove", "path", "root"] {
        let mut headers = put_headers("refused.bin", false, None);
        headers.remove(header);
        let missing = request(
            &main,
            "put_folder_file",
            InvokeBody::Raw(b"x".to_vec()),
            headers,
        )
        .unwrap_err();
        if header == "root" {
            assert_eq!(missing, json!({ "name": "Invalid", "root": "" }));
        } else {
            assert!(text(&missing["message"]).contains(header), "{missing}");
        }
    }
    assert!(!fixture.root.join("refused.bin").exists());
    assert_eq!(staged(&fixture), Vec::<String>::new());
}

#[test]
fn storage_reaches_the_data_paths_of_the_root_and_nothing_else() {
    let (fixture, main) = opened("reads");
    git(&main, &["init", "--quiet", "--initial-branch=main"]).unwrap();
    write(&fixture, &main, "todos/a.md", "first\n").unwrap();
    std::fs::create_dir(fixture.root.join("empty")).unwrap();

    let mut listed = invoke(&main, "list_folder", json!({ "root": "Data" })).unwrap();
    assert!(listed[0]["stamp"].as_str().unwrap().starts_with("v1:"));
    listed[0].as_object_mut().unwrap().remove("stamp");
    assert_eq!(listed, json!([{ "path": "todos/a.md" }]));
    // Every byte value arrives as it is, raw.
    let bytes: Vec<u8> = (0..=255).collect();
    std::fs::write(fixture.root.join("todos/all.bin"), &bytes).unwrap();
    assert_eq!(read_file(&main, "todos/all.bin").unwrap(), bytes);
    assert_eq!(
        read_file(&main, "todos/b.md").unwrap_err(),
        json!({ "name": "NotFound", "path": "todos/b.md" })
    );
    assert_eq!(
        read_file(&main, "todos").unwrap_err(),
        json!({ "name": "NotAFile", "path": "todos" })
    );

    // Git's own files, anything outside the root, and a sibling whose name
    // extends it are refused.
    let outside = fixture.root.parent().unwrap().join("outside.md");
    std::fs::write(&outside, b"theirs").unwrap();
    let root = fixture.root.to_str().unwrap().to_string();
    for path in [
        ".git/HEAD".to_string(),
        "../outside.md".to_string(),
        outside.to_str().unwrap().to_string(),
        format!("{root}2/a.md"),
        "todos/../../outside.md".to_string(),
    ] {
        assert_eq!(
            read_file(&main, &path).unwrap_err()["name"],
            "InvalidPath",
            "{path}"
        );
        assert_eq!(
            put(&main, &path, Some(b"x"), None).unwrap_err()["name"],
            "InvalidPath",
            "{path}"
        );
    }
}

#[cfg(unix)]
#[test]
fn a_path_through_a_link_or_naming_one_is_refused() {
    let (fixture, main) = opened("read-links");
    let elsewhere = fixture.root.parent().unwrap().join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    std::fs::write(elsewhere.join("secret.md"), b"theirs").unwrap();
    std::os::unix::fs::symlink(&elsewhere, fixture.root.join("todos")).unwrap();
    std::os::unix::fs::symlink(elsewhere.join("secret.md"), fixture.root.join("a.md")).unwrap();

    let link = |path: &str| {
        json!({
            "name": "InvalidPath",
            "path": path,
            "reason": "the path passes through a symbolic link",
        })
    };
    for path in ["todos/secret.md", "a.md"] {
        assert_eq!(read_file(&main, path).unwrap_err(), link(path));
        assert_eq!(
            put(&main, path, Some(b"mine"), None).unwrap_err(),
            link(path)
        );
    }
    // A link is listed as a file, never followed.
    let listed = invoke(&main, "list_folder", json!({ "root": "Data" })).unwrap();
    let mut files: Vec<String> = listed
        .as_array()
        .unwrap()
        .iter()
        .map(|file| text(&file["path"]))
        .collect();
    files.sort();
    assert_eq!(files, ["a.md", "todos"]);
    assert_eq!(
        std::fs::read(elsewhere.join("secret.md")).unwrap(),
        b"theirs"
    );
}

/// A save that stopped before its rename leaves its staged file in the
/// folder. Opening removes the ones an hour old, and none younger, which
/// another process's save may still be about to rename.
#[test]
fn opening_sweeps_staged_files_a_stopped_save_left() {
    let fixture = fixture("sweep");
    let saves = saves(&fixture);
    std::fs::create_dir_all(&saves).unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let name = |made: u64| {
        let mut digits = Vec::new();
        let mut value = made;
        while value > 0 {
            digits.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(value % 36) as usize]);
            value /= 36;
        }
        digits.reverse();
        format!(
            "{}-0123456789abcdef0123456789abcdef-0",
            String::from_utf8(digits).unwrap()
        )
    };
    let old = name(now - 2 * 60 * 60 * 1000);
    let young = name(now - 60 * 1000);
    for staged in [&old, &young] {
        std::fs::write(saves.join(staged), b"x").unwrap();
    }
    let main = fixture.window("main");
    open(&main).unwrap();
    assert_eq!(staged(&fixture), [young]);
}

/// A linked worktree's or submodule's `.git` file, or a `.git` link, does
/// not keep a folder from opening: the open and a save go through, and
/// `.git` stays as it was.
#[test]
fn a_folder_with_a_git_file_or_link_opens_and_saves() {
    let worktree = fixture("git-file");
    let gitdir = "gitdir: /elsewhere/.git/worktrees/notes\n";
    std::fs::write(worktree.root.join(".git"), gitdir).unwrap();
    let main = worktree.window("main");
    open(&main).unwrap();
    assert_eq!(
        put(&main, "todos/a.md", Some(b"milk\n"), None).unwrap(),
        "landed"
    );
    assert_eq!(
        std::fs::read_to_string(worktree.root.join(".git")).unwrap(),
        gitdir
    );
    let listed = invoke(&main, "list_folder", json!({ "root": "Data" })).unwrap();
    assert_eq!(listed[0]["path"], "todos/a.md");
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(staged(&worktree), Vec::<String>::new());
    worktree.app.roots().shutdown();

    #[cfg(unix)]
    {
        let linked = fixture("git-link");
        let repository = linked.root.with_file_name("repository");
        std::fs::create_dir_all(&repository).unwrap();
        std::os::unix::fs::symlink(&repository, linked.root.join(".git")).unwrap();
        let main = linked.window("main");
        open(&main).unwrap();
        assert_eq!(
            put(&main, "todos/a.md", Some(b"milk\n"), None).unwrap(),
            "landed"
        );
        assert!(std::fs::read_dir(&repository).unwrap().next().is_none());
        assert_eq!(staged(&linked), Vec::<String>::new());
        linked.app.roots().shutdown();
    }
}

#[test]
fn after_shutdown_a_late_change_and_a_late_open_are_refused() {
    let (fixture, main) = opened("shutdown");
    write(&fixture, &main, "kv.json", "{}\n").unwrap();
    fixture.app.roots().shutdown();
    assert_eq!(
        write(&fixture, &main, "kv.json", "late\n").unwrap_err(),
        json!({ "name": "ShuttingDown" })
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("kv.json")).unwrap(),
        "{}\n"
    );
    assert_eq!(open(&main).unwrap_err(), json!({ "name": "ShuttingDown" }));
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
        assert!(
            text(&refused).contains("not allowed"),
            "{command}: {refused}"
        );
    }
}
