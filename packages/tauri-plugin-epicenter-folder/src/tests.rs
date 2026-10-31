//! The plugin through Tauri's real invoke path, on the mock runtime.
//!
//! Each test builds an app with the plugin installed, binds directories to
//! labels as a shell does before building a window, creates the windows, and
//! sends `plugin:epicenter-folder|...` requests exactly as a page's `invoke`
//! would. The folder is a real directory; a test makes its repository with
//! the real `git`, which the plugin itself never runs (ADR-0559).
//!
//! Key behaviors:
//! - The generated TypeScript bindings match the registered commands.
//! - Each window reaches the directory bound to its label and no other
//!   unless it opened it; a window with no binding is refused before
//!   anything is read or created.
//! - A page opens another root only when Tauri's runtime file-system scope
//!   allows it, as the dialog's `open` allows a picked folder. A refused
//!   folder never opens, a missing one is made only when asked, and an
//!   opened root is reached by its path.
//! - A live label is never bound again; once unbound, as a destroyed window
//!   is, its page is refused and the label may be bound to another folder.
//!   A window whose construction failed leaves no binding behind.
//! - Opening refuses a bound directory that is gone and does not make it
//!   again.
//! - Two windows bound to one root racing to save one file over the same
//!   version publish one at a time: exactly one lands, and the other is
//!   `stale`.
//! - Storage reaches the data paths of the bound root and nothing else:
//!   never `.git`, never another window's root, never through a link. A save
//!   stages in the root's `.epicenter` and makes no `.git`; a `.git` file or link opens
//!   and saves and is left as it is. Opening sweeps staged files a stopped
//!   save left.
//! - A put takes its bytes as a raw body and its arguments as
//!   percent-encoded headers; a JSON array of bytes, Tauri's postMessage
//!   fallback, is accepted too. A file read returns its bytes raw. A
//!   refusal is a `StorageError` naming the page's `FileError`.
//! - Binding adds nothing to the app's access control, so an app that
//!   already scopes another permission opens and reads as any other does.
//! - After shutdown, a late change and a late bind are refused.
//! - A window without the plugin's permission cannot call it.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::http::{HeaderMap, HeaderValue};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody, RuntimeAuthority};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
use tauri::utils::acl::capability::Capability;
use tauri::utils::acl::manifest::Manifest;
use tauri::utils::acl::resolved::Resolved;
use tauri::utils::acl::ExecutionContext;
use tauri::utils::platform::Target;
use tauri::webview::InvokeRequest;
use tauri::{App, WebviewWindow, WebviewWindowBuilder};

use tauri_plugin_fs::FsExt;

use crate::{init, BindError, Directory, FolderExt, COMMANDS};

#[test]
fn observations_use_only_the_callers_channel() {
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::ipc::{Channel, InvokeResponseBody};

    let fixture = fixture("caller-channel");
    let window = fixture.bound_window("files:caller", &fixture.root);
    let webview: tauri::Webview<MockRuntime> = window.as_ref().clone();
    let (send, receive) = mpsc::channel();
    let channel = Channel::new(move |body: InvokeResponseBody| {
        if let InvokeResponseBody::Json(json) = body {
            if let Ok(change) = serde_json::from_str::<crate::FolderChanged>(&json) {
                let _ = send.send(change);
            }
        }
        Ok(())
    });
    tauri::async_runtime::block_on(crate::commands::open_folder(webview, None, false, channel))
        .unwrap();
    std::fs::write(fixture.root.join("change.md"), b"changed").unwrap();
    let until = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let notice = receive
            .recv_timeout(until.saturating_duration_since(std::time::Instant::now()))
            .unwrap();
        if notice
            .paths
            .is_none_or(|paths| paths.contains(&"change.md".to_string()))
        {
            break;
        }
    }
    while receive.try_recv().is_ok() {}
    // A WebView reload keeps the window binding and watcher, but its old
    // JavaScript channel is gone. Opening from the new page replaces it.
    let (next_send, next_receive) = mpsc::channel();
    let next_channel = Channel::new(move |body: InvokeResponseBody| {
        if let InvokeResponseBody::Json(json) = body {
            if let Ok(change) = serde_json::from_str::<crate::FolderChanged>(&json) {
                let _ = next_send.send(change);
            }
        }
        Ok(())
    });
    let webview: tauri::Webview<MockRuntime> = window.as_ref().clone();
    tauri::async_runtime::block_on(crate::commands::open_folder(
        webview,
        None,
        false,
        next_channel,
    ))
    .unwrap();
    std::fs::write(fixture.root.join("after-reload.md"), b"changed").unwrap();
    let until = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let notice = next_receive
            .recv_timeout(until.saturating_duration_since(std::time::Instant::now()))
            .unwrap();
        if notice
            .paths
            .is_none_or(|paths| paths.contains(&"after-reload.md".to_string()))
        {
            break;
        }
    }
    assert!(receive.try_iter().all(|change| change
        .paths
        .is_none_or(|paths| !paths.contains(&"after-reload.md".to_string()))));
}

/// Real notify delivery through each bound WebView's private channel.
/// No file content or absolute root crosses the channel.
#[test]
fn external_writes_and_atomic_replacements_reach_only_the_bound_webview() {
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::ipc::{Channel, InvokeResponseBody};

    let channel = |send: mpsc::Sender<crate::FolderChanged>| {
        Channel::new(move |body: InvokeResponseBody| {
            if let InvokeResponseBody::Json(json) = body {
                if let Ok(change) = serde_json::from_str(&json) {
                    let _ = send.send(change);
                }
            }
            Ok(())
        })
    };

    let fixture = fixture("native-watch");
    let main = fixture.bound_window("main", &fixture.root);
    let elsewhere = fixture.root.with_file_name("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();
    let other = fixture.bound_window("other", &elsewhere);
    let (send, receive) = mpsc::channel();
    let (other_send, other_receive) = mpsc::channel();
    let view: tauri::Webview<MockRuntime> = main.as_ref().clone();
    let other_view: tauri::Webview<MockRuntime> = other.as_ref().clone();
    tauri::async_runtime::block_on(crate::commands::open_folder(
        view,
        None,
        false,
        channel(send),
    ))
    .unwrap();
    tauri::async_runtime::block_on(crate::commands::open_folder(
        other_view,
        None,
        false,
        channel(other_send),
    ))
    .unwrap();

    std::fs::create_dir(fixture.root.join("notes")).unwrap();
    std::fs::write(fixture.root.join("notes/a.md"), b"external").unwrap();
    let wait_for = |path: &str| {
        let until = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let notice = receive
                .recv_timeout(until.saturating_duration_since(std::time::Instant::now()))
                .expect("native observation");
            if notice.paths.as_ref().is_none_or(|paths| {
                paths
                    .iter()
                    .any(|hint| path == hint || path.starts_with(&format!("{hint}/")))
            }) {
                break;
            }
        }
    };
    wait_for("notes/a.md");
    assert!(other_receive.try_recv().is_err());

    let staged = fixture.root.with_file_name("replacement");
    std::fs::write(&staged, b"replaced").unwrap();
    std::fs::rename(staged, fixture.root.join("notes/a.md")).unwrap();
    wait_for("notes/a.md");
    assert_eq!(read_file(&main, "notes/a.md").unwrap(), b"replaced");

    std::fs::rename(fixture.root.join("notes"), fixture.root.join("archive")).unwrap();
    wait_for("notes/a.md");
    assert_eq!(read_file(&main, "archive/a.md").unwrap(), b"replaced");
    assert!(other_receive.try_recv().is_err());
    fixture.app.folders().shutdown();
}

#[test]
fn one_watch_belongs_to_each_binding_and_unbind_or_shutdown_stops_it() {
    use std::sync::mpsc;
    use std::time::Duration;

    let fixture = fixture("watch-lifetime");
    let directory = Directory::existing(&fixture.root).unwrap();
    fixture
        .app
        .folders()
        .bind("main", directory.clone())
        .unwrap();
    let (send, receive) = mpsc::channel();
    let (duplicate_send, duplicate_receive) = mpsc::channel();
    fixture
        .app
        .folders()
        .watch_current("main", &directory, move |event| {
            let _ = send.send(event);
        })
        .unwrap();
    std::fs::write(fixture.root.join("first.md"), b"first").unwrap();
    receive.recv_timeout(Duration::from_secs(5)).unwrap();
    while receive.try_recv().is_ok() {}
    fixture
        .app
        .folders()
        .watch_current("main", &directory, move |event| {
            let _ = duplicate_send.send(event);
        })
        .unwrap();
    std::fs::write(fixture.root.join("second.md"), b"second").unwrap();
    duplicate_receive
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    assert!(receive.try_iter().all(|change| change
        .paths
        .is_none_or(|paths| !paths.contains(&"second.md".to_string()))));
    fixture.app.folders().unbind("main");
    while duplicate_receive.try_recv().is_ok() {}
    std::fs::write(fixture.root.join("detached.md"), b"detached").unwrap();
    assert!(duplicate_receive
        .recv_timeout(Duration::from_millis(200))
        .is_err());

    let (send, receive) = mpsc::channel();
    fixture
        .app
        .folders()
        .bind("main", directory.clone())
        .unwrap();
    fixture
        .app
        .folders()
        .watch_current("main", &directory, move |event| {
            let _ = send.send(event);
        })
        .unwrap();
    fixture.app.folders().shutdown();
    std::fs::write(fixture.root.join("shutdown.md"), b"shutdown").unwrap();
    assert!(receive.recv_timeout(Duration::from_millis(200)).is_err());
    assert_eq!(
        fixture.app.folders().bound("main"),
        Err(crate::WindowError::ShuttingDown)
    );
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
    root: PathBuf,
    _directory: TempDirectory,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.app.folders().shutdown();
    }
}

impl Fixture {
    /// Bind the directory before building the window, as the shell does.
    fn bound_window(&self, label: &str, path: &Path) -> WebviewWindow<MockRuntime> {
        let folders = self.app.folders();
        folders
            .bind(label, Directory::create(path).unwrap())
            .unwrap();
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

/// An app whose windows may call every plugin command, and `notes`, an
/// empty directory no window is bound to yet.
fn fixture(label: &str) -> Fixture {
    fixture_in(label, context())
}

fn fixture_in(label: &str, context: tauri::Context<MockRuntime>) -> Fixture {
    let directory = temp(label);
    let root = directory.0.join("notes");
    std::fs::create_dir(&root).unwrap();
    let app = mock_builder()
        .plugin(tauri_plugin_fs::init())
        .plugin(init())
        .build(context)
        .expect("mock app");
    Fixture {
        app,
        root,
        _directory: directory,
    }
}

/// The fixture with `main` bound to `notes` and opened.
fn opened(label: &str) -> (Fixture, WebviewWindow<MockRuntime>) {
    let fixture = fixture(label);
    let main = fixture.bound_window("main", &fixture.root);
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

fn open(window: &WebviewWindow<MockRuntime>) -> Result<Value, Value> {
    use tauri::ipc::{Channel, InvokeResponseBody};
    let webview: tauri::Webview<MockRuntime> = window.as_ref().clone();
    tauri::async_runtime::block_on(crate::commands::open_folder(
        webview,
        None,
        false,
        Channel::new(|_: InvokeResponseBody| Ok(())),
    ))
    .map(|_| Value::Null)
    .map_err(|error| serde_json::to_value(error).unwrap())
}

/// `open_folder` at `root` as a page asks for it: the root's canonical path,
/// or the refusal.
fn open_root(
    window: &WebviewWindow<MockRuntime>,
    root: &Path,
    create: bool,
) -> Result<String, Value> {
    use tauri::ipc::{Channel, InvokeResponseBody};
    let webview: tauri::Webview<MockRuntime> = window.as_ref().clone();
    tauri::async_runtime::block_on(crate::commands::open_folder(
        webview,
        Some(root.to_string_lossy().into_owned()),
        create,
        Channel::new(|_: InvokeResponseBody| Ok(())),
    ))
    .map_err(|error| serde_json::to_value(error).unwrap())
}

/// `read_folder_file` as `tauri-files.ts` asks for it: the bytes, which
/// arrive raw, or the refusal.
fn read_file(window: &WebviewWindow<MockRuntime>, path: &str) -> Result<Vec<u8>, Value> {
    match response(
        window,
        "read_folder_file",
        InvokeBody::Json(json!({ "path": path })),
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

fn children(window: &WebviewWindow<MockRuntime>, directory: &str) -> Result<Value, Value> {
    invoke(
        window,
        "read_folder_children",
        json!({ "directory": directory }),
    )
}

/// `put_folder_file` as `tauri-files.ts` sends it: the bytes as the raw
/// body, the rest in percent-encoded headers. `None` removes the file.
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
    .map(|outcome| outcome["kind"].clone())
}

/// The headers of a put expecting the file whose SHA-256 is `if_match`, or
/// nothing there for `None`.
fn put_headers(path: &str, remove: bool, if_match: Option<&str>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("path", encoded(path));
    headers.insert("remove", encoded(&remove.to_string()));
    headers.insert("expected", encoded(if_match.unwrap_or("absent")));
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

/// Write a file over whatever is there, as a page that just read it does.
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

/// Run the real `git` in the root bound to `window`, as a person or the
/// `epicenter` CLI would; the plugin runs none.
fn git(window: &WebviewWindow<MockRuntime>, args: &[&str]) -> Result<String, String> {
    let directory = window
        .folders()
        .bound(window.label())
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

#[test]
fn each_window_reaches_its_own_bound_folder_and_no_other() {
    let fixture = fixture("isolation");
    let other_root = fixture.root.with_file_name("other-notes");
    std::fs::create_dir(&other_root).unwrap();
    let main = fixture.bound_window("main", &fixture.root);
    let other = fixture.bound_window("other", &other_root);
    open(&main).unwrap();
    open(&other).unwrap();
    std::fs::write(fixture.root.join("mine.md"), b"main's").unwrap();
    std::fs::write(other_root.join("mine.md"), b"other's").unwrap();

    assert_eq!(read_file(&main, "mine.md").unwrap(), b"main's");
    assert_eq!(read_file(&other, "mine.md").unwrap(), b"other's");
    // Other arguments a page adds name nothing: the root is the calling window's.
    let extra = json!({ "path": "mine.md", "scope": "other", "window": "other" });
    let InvokeResponseBody::Raw(bytes) = response(
        &main,
        "read_folder_file",
        InvokeBody::Json(extra),
        Default::default(),
    )
    .unwrap() else {
        panic!("the bytes came back as JSON");
    };
    let separator = bytes.iter().position(|byte| *byte == 0).unwrap();
    assert!(std::str::from_utf8(&bytes[..separator])
        .unwrap()
        .starts_with("v1:"));
    assert_eq!(&bytes[separator + 1..], b"main's");
    // Naming another window's root is refused, for reads and for changes.
    let other_path = other_root.to_str().unwrap();
    let refusal = invoke(
        &main,
        "read_folder_file",
        json!({ "path": "mine.md", "root": other_path }),
    )
    .unwrap_err();
    assert_eq!(refusal["name"], "Io");
    assert!(refusal["message"]
        .as_str()
        .unwrap()
        .starts_with("NotGranted"));
    let mut headers = put_headers("mine.md", false, Some(&sha256(b"other's")));
    headers.insert("root", encoded(other_path));
    assert!(request(
        &main,
        "put_folder_file",
        InvokeBody::Raw(b"changed".to_vec()),
        headers,
    )
    .is_err());
    let mut headers = put_headers("mine.md", false, Some(&sha256(b"main's")));
    headers.insert("scope", encoded("other"));
    request(
        &main,
        "put_folder_file",
        InvokeBody::Raw(b"changed".to_vec()),
        headers,
    )
    .unwrap();
    assert_eq!(
        std::fs::read(fixture.root.join("mine.md")).unwrap(),
        b"changed"
    );
    assert_eq!(
        std::fs::read(other_root.join("mine.md")).unwrap(),
        b"other's"
    );
}

/// A root the runtime file-system scope allows, as the dialog's `open`
/// allows a folder a person picked, opens with its files where they are and
/// is reached by its path beside the window's own directory. Before it is
/// opened, or without the scope, it is `NotGranted`; one the scope allows
/// inside it is not reached through it.
#[test]
fn a_root_the_scope_allows_opens_and_is_reached_by_its_path() {
    let fixture = fixture("allowed-root");
    let data = fixture.root.with_file_name("data");
    std::fs::create_dir(&data).unwrap();
    std::fs::write(data.join("note.md"), b"note").unwrap();
    std::fs::write(fixture.root.join("settings.md"), b"settings").unwrap();
    let main = fixture.bound_window("main", &fixture.root);
    open(&main).unwrap();
    let data_path = data.to_str().unwrap();
    let list = |root: Option<&str>| {
        invoke(&main, "list_folder", json!({ "root": root }))
            .map(|listing| listing["files"][0]["path"].clone())
    };
    assert_eq!(
        open_root(&main, &data, false).unwrap_err(),
        json!({ "name": "NotGranted", "root": data_path })
    );
    assert!(text(&list(Some(data_path)).unwrap_err()).contains("NotGranted"));

    fixture.app.fs_scope().allow_directory(&data, true).unwrap();
    assert!(text(&list(Some(data_path)).unwrap_err()).contains("NotGranted"));
    assert_eq!(open_root(&main, &data, false).unwrap(), data_path);
    assert_eq!(list(Some(data_path)).unwrap(), "note.md");
    assert_eq!(list(None).unwrap(), "settings.md");
    assert_eq!(
        list(Some(fixture.root.to_str().unwrap())).unwrap(),
        "settings.md"
    );
    let mut headers = put_headers("theme.md", false, None);
    headers.insert("root", encoded(data_path));
    request(
        &main,
        "put_folder_file",
        InvokeBody::Raw(b"dark".to_vec()),
        headers,
    )
    .unwrap();
    assert_eq!(std::fs::read(data.join("theme.md")).unwrap(), b"dark");
    for refused in [
        data.join("nested").to_str().unwrap().to_string(),
        format!("{}/../data", fixture.root.to_str().unwrap()),
        "/".to_string(),
    ] {
        assert!(
            text(&list(Some(&refused)).unwrap_err()).contains("NotGranted"),
            "{refused}"
        );
    }
    // Asking Epicenter about a folder works only for a root the window reaches.
    assert_eq!(
        invoke(&main, "synced_with_epicenter", json!({ "path": data_path })).unwrap(),
        json!(false)
    );
    let elsewhere = fixture.root.parent().unwrap().to_str().unwrap();
    assert_eq!(
        invoke(&main, "synced_with_epicenter", json!({ "path": elsewhere })).unwrap_err(),
        json!({ "name": "Folder", "path": elsewhere })
    );
}

/// An allowed root that is not there is `Missing` and is made only when the
/// page asks (the default data folder); a refused one never opens, whatever
/// the scope allows; and an allowed root that is gone is not made again.
#[test]
fn a_missing_root_is_made_only_when_asked_and_a_refused_one_never_opens() {
    let fixture = fixture("missing-root");
    let main = fixture.bound_window("main", &fixture.root);
    let fresh = fixture.root.with_file_name("Epicenter").join("Notes");
    fixture
        .app
        .fs_scope()
        .allow_directory(&fresh, true)
        .unwrap();
    assert_eq!(
        open_root(&main, &fresh, false).unwrap_err(),
        json!({ "name": "Missing" })
    );
    assert!(!fresh.exists());
    assert_eq!(
        open_root(&main, &fresh, true).unwrap(),
        fresh.to_str().unwrap()
    );
    assert!(fresh.is_dir());

    let repository = fixture.root.with_file_name("repository");
    std::fs::create_dir_all(repository.join(".git")).unwrap();
    let git = repository.join(".git");
    fixture.app.fs_scope().allow_directory(&git, true).unwrap();
    let refused = open_root(&main, &git, false).unwrap_err();
    assert_eq!(refused["name"], "Refused");
    assert!(
        text(&refused["reason"]).contains("own .git folder"),
        "{refused}"
    );
    assert!(
        text(&open_root(&main, Path::new("relative"), true).unwrap_err()["reason"])
            .contains("not a full path")
    );
}

#[test]
fn a_window_with_no_binding_is_refused_and_nothing_is_made() {
    let fixture = fixture("unbound");
    let stray = window(&fixture.app, "stray");
    assert_eq!(open(&stray).unwrap_err(), json!({ "name": "NotBound" }));
    for (command, args) in [
        ("list_folder", json!({})),
        ("read_folder_children", json!({ "directory": "" })),
        ("make_folder_directory", json!({ "path": "todos" })),
    ] {
        let refused = invoke(&stray, command, args).unwrap_err();
        assert_eq!(refused["name"], "Io", "{command}: {refused}");
        assert!(text(&refused["message"]).contains("NotBound"), "{refused}");
    }
    assert!(text(&read_file(&stray, "a.md").unwrap_err()).contains("NotBound"));
    assert!(text(&put(&stray, "a.md", Some(b"a"), None).unwrap_err()).contains("NotBound"));
    assert_eq!(std::fs::read_dir(&fixture.root).unwrap().count(), 0);
}

/// A live label keeps its folder: binding it again is refused, whichever
/// directory. Once unbound, as the plugin does when a window is destroyed,
/// the old page is refused, and the label may be bound to another folder.
#[test]
fn a_binding_lasts_for_its_window_and_a_closed_label_is_refused() {
    let (fixture, main) = opened("immutable");
    let other_root = fixture.root.with_file_name("other-notes");
    std::fs::create_dir(&other_root).unwrap();
    std::fs::write(fixture.root.join("a.md"), b"first").unwrap();
    std::fs::write(other_root.join("a.md"), b"second").unwrap();
    let folders = fixture.app.folders();
    for again in [&other_root, &fixture.root] {
        assert_eq!(
            folders.bind("main", Directory::existing(again).unwrap()),
            Err(BindError::Bound {
                label: "main".into()
            })
        );
    }
    assert_eq!(read_file(&main, "a.md").unwrap(), b"first");

    folders.unbind("main");
    assert_eq!(open(&main).unwrap_err(), json!({ "name": "NotBound" }));
    assert!(text(&read_file(&main, "a.md").unwrap_err()).contains("NotBound"));

    folders
        .bind("main", Directory::existing(&other_root).unwrap())
        .unwrap();
    open(&main).unwrap();
    assert_eq!(read_file(&main, "a.md").unwrap(), b"second");
}

/// A failed window construction releases its binding, including an early page open.
#[test]
fn a_failed_window_construction_unbinds_its_label() {
    let fixture = fixture("rollback");
    let folders = fixture.app.folders();
    let directory = Directory::existing(&fixture.root).unwrap();
    let failed: Result<(), BindError> =
        folders.bind_while_building("main", directory.clone(), || Err(BindError::ShuttingDown));
    assert_eq!(failed, Err(BindError::ShuttingDown));
    assert!(folders.bound("main").is_err());
    // This page opened its folder before its window's build failed.
    let failed: Result<(), BindError> =
        folders.bind_while_building("early", directory.clone(), || {
            open(&window(&fixture.app, "early")).unwrap();
            Err(BindError::ShuttingDown)
        });
    assert_eq!(failed, Err(BindError::ShuttingDown));
    assert!(folders.bound("early").is_err());

    let built = folders.bind_while_building("main", directory.clone(), || {
        Ok::<_, BindError>(window(&fixture.app, "main"))
    });
    let main = built.unwrap();
    open(&main).unwrap();
    // A second construction on a live label is refused before it builds.
    let mut built_again = false;
    let refused = folders.bind_while_building("main", directory, || {
        built_again = true;
        Ok::<_, BindError>(())
    });
    assert_eq!(
        refused,
        Err(BindError::Bound {
            label: "main".into()
        })
    );
    assert!(!built_again);
    assert!(folders.bound("main").is_ok());
}

/// A bound folder removed later is refused when the page opens it, and
/// nothing makes it again: creating a default belongs to the shell's launch.
#[test]
fn opening_a_bound_folder_that_is_gone_is_refused_and_makes_nothing() {
    let (fixture, main) = opened("gone");
    std::fs::remove_dir(&fixture.root).unwrap();
    assert_eq!(open(&main).unwrap_err(), json!({ "name": "Missing" }));
    assert!(put(&main, "todos/a.md", Some(b"a"), None).is_err());
    assert!(!fixture.root.exists());
}

/// The scratch directory inside the folder, where a put stages its bytes.
fn scratch(fixture: &Fixture) -> PathBuf {
    epicenter_folder_core::storage::scratch_directory(&fixture.root)
}

/// The staged files left in the folder's scratch directory.
fn staged(fixture: &Fixture) -> Vec<String> {
    std::fs::read_dir(scratch(fixture))
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

    invoke(
        &main,
        "make_folder_directory",
        json!({ "path": "notes/sub" }),
    )
    .unwrap();
    assert!(fixture.root.join("notes/sub").is_dir());
    assert_eq!(
        invoke(&main, "remove_folder_directory", json!({ "path": "notes" })).unwrap_err(),
        json!({ "name": "DirectoryNotEmpty", "path": "notes" })
    );
    put(&main, "notes/a.md", Some(b"first\n"), None).unwrap();
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("notes/a.md")).unwrap(),
        "first\n"
    );
    assert_eq!(
        put(&main, "notes/a.md", None, Some(&sha256(b"first\n"))).unwrap(),
        "landed"
    );
    for path in ["notes/sub", "notes"] {
        invoke(&main, "remove_folder_directory", json!({ "path": path })).unwrap();
    }
    assert!(!fixture.root.join("notes").exists());
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
    for header in ["remove", "path"] {
        let mut headers = put_headers("refused.bin", false, None);
        headers.remove(header);
        let missing = request(
            &main,
            "put_folder_file",
            InvokeBody::Raw(b"x".to_vec()),
            headers,
        )
        .unwrap_err();
        assert!(text(&missing["message"]).contains(header), "{missing}");
    }
    assert!(!fixture.root.join("refused.bin").exists());
    assert_eq!(staged(&fixture), Vec::<String>::new());
}

#[test]
fn storage_reaches_the_data_paths_of_the_bound_root_and_nothing_else() {
    let (fixture, main) = opened("reads");
    git(&main, &["init", "--quiet", "--initial-branch=main"]).unwrap();
    write(&fixture, &main, "todos/a.md", "first\n").unwrap();
    std::fs::create_dir(fixture.root.join("empty")).unwrap();

    let mut listed = invoke(&main, "list_folder", json!({})).unwrap();
    listed["directories"]
        .as_array_mut()
        .unwrap()
        .sort_by_key(text);
    assert!(listed["files"][0]["stamp"]
        .as_str()
        .unwrap()
        .starts_with("v1:"));
    listed["files"][0].as_object_mut().unwrap().remove("stamp");
    assert_eq!(
        listed,
        json!({ "files": [{ "path": "todos/a.md", "size": 6 }], "directories": ["empty", "todos"] })
    );
    let mut top = children(&main, "").unwrap();
    top["directories"].as_array_mut().unwrap().sort_by_key(text);
    assert_eq!(
        top,
        json!({ "files": [], "directories": ["empty", "todos"] })
    );
    assert_eq!(
        children(&main, "todos").unwrap(),
        json!({ "files": ["a.md"], "directories": [] })
    );
    assert_eq!(
        children(&main, "todos/a.md").unwrap_err(),
        json!({ "name": "NotADirectory", "path": "todos/a.md" })
    );
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
            children(&main, &path).unwrap_err()["name"],
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
    assert_eq!(children(&main, "todos").unwrap_err(), link("todos"));
    // A link is listed as a file, never followed.
    let listed = children(&main, "").unwrap();
    let mut files: Vec<String> = listed["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(text)
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
    let scratch = scratch(&fixture);
    std::fs::create_dir_all(&scratch).unwrap();
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
        std::fs::write(scratch.join(staged), b"x").unwrap();
    }
    let main = fixture.bound_window("main", &fixture.root);
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
    let main = worktree.bound_window("main", &worktree.root);
    open(&main).unwrap();
    assert_eq!(
        put(&main, "todos/a.md", Some(b"milk\n"), None).unwrap(),
        "landed"
    );
    assert_eq!(
        std::fs::read_to_string(worktree.root.join(".git")).unwrap(),
        gitdir
    );
    assert_eq!(
        children(&main, "").unwrap(),
        json!({ "files": [], "directories": ["todos"] })
    );
    assert_eq!(staged(&worktree), Vec::<String>::new());
    worktree.app.folders().shutdown();

    #[cfg(unix)]
    {
        let linked = fixture("git-link");
        let repository = linked.root.with_file_name("repository");
        std::fs::create_dir_all(&repository).unwrap();
        std::os::unix::fs::symlink(&repository, linked.root.join(".git")).unwrap();
        let main = linked.bound_window("main", &linked.root);
        open(&main).unwrap();
        assert_eq!(
            put(&main, "todos/a.md", Some(b"milk\n"), None).unwrap(),
            "landed"
        );
        assert!(std::fs::read_dir(&repository).unwrap().next().is_none());
        assert_eq!(staged(&linked), Vec::<String>::new());
        linked.app.folders().shutdown();
    }
}

/// Before Tauri 2.12 a capability added at run time numbered its scopes from
/// zero, so a grant that added one collided with a scope the app already
/// had. Binding adds nothing to the app's access control: here the app
/// scopes a permission of another plugin, and opening and reading work as
/// they do in any app.
#[test]
fn opening_in_an_app_that_already_scopes_a_permission_still_reads() {
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
    assert!(
        !resolved.command_scope.is_empty(),
        "the app scopes a permission"
    );
    *context.runtime_authority_mut() = RuntimeAuthority::new(acl, resolved);
    allow_plugin(&mut context);
    let fixture = fixture_in("scoped-app", context);
    let main = fixture.bound_window("main", &fixture.root);
    open(&main).unwrap();
    std::fs::write(fixture.root.join("a.md"), b"read").unwrap();
    assert_eq!(read_file(&main, "a.md").unwrap(), b"read");
    assert_eq!(children(&main, "").unwrap()["files"], json!(["a.md"]));
}

#[test]
fn after_shutdown_a_late_change_and_a_late_bind_are_refused() {
    let (fixture, main) = opened("shutdown");
    write(&fixture, &main, "kv.json", "{}\n").unwrap();
    let directory = fixture.app.folders().bound("main").unwrap();
    fixture.app.folders().shutdown();
    assert!(
        text(&write(&fixture, &main, "kv.json", "late\n").unwrap_err()).contains("ShuttingDown")
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("kv.json")).unwrap(),
        "{}\n"
    );
    assert_eq!(open(&main).unwrap_err(), json!({ "name": "ShuttingDown" }));
    assert_eq!(
        fixture.app.folders().bind("late", directory),
        Err(BindError::ShuttingDown)
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
        assert!(
            text(&refused).contains("not allowed"),
            "{command}: {refused}"
        );
    }
}

/// Work admitted before a label is reused still writes to its original root.
#[test]
fn admitted_work_keeps_its_root_after_the_label_is_reused() {
    let fixture = fixture("admitted-root");
    let folders = fixture.app.folders();
    folders
        .bind("main", Directory::existing(&fixture.root).unwrap())
        .unwrap();
    let admitted = folders.bound("main").unwrap();
    let other = fixture.root.join("other");
    let next = Directory::create(&other).unwrap();
    folders.unbind("main");
    folders.bind("main", next).unwrap();
    let landed = epicenter_folder_core::storage::put(
        admitted.root(),
        "a.md",
        Some(b"first"),
        &epicenter_folder_core::storage::Expectation::Absent,
    )
    .unwrap();
    assert!(matches!(
        landed,
        epicenter_folder_core::storage::PutOutcome::Landed { stamp: Some(_) }
    ));
    assert_eq!(std::fs::read(fixture.root.join("a.md")).unwrap(), b"first");
    assert!(!other.join("a.md").exists());
}

/// The folder picker answers the path the person reached, which may pass
/// through a link (`/tmp` is `/private/tmp` on macOS), so "Choose folder…"
/// and "Allow access" could name one folder two ways. `resolve_folder`
/// answers the one canonical path a page remembers, for a folder Tauri's
/// scope allows, and opens, watches and makes nothing.
#[cfg(unix)]
#[test]
fn resolve_folder_answers_the_canonical_path_of_an_allowed_folder() {
    let (fixture, main) = opened("resolve");
    let base = fixture.root.parent().unwrap().to_path_buf();
    let chosen = base.join("Chosen");
    std::fs::create_dir(&chosen).unwrap();
    let alias = base.join("alias");
    std::os::unix::fs::symlink(&base, &alias).unwrap();
    let picked = alias.join("Chosen");
    let resolve = |path: &Path| invoke(&main, "resolve_folder", json!({ "root": path }));
    assert_eq!(
        resolve(&picked).unwrap_err(),
        json!({ "name": "NotGranted", "root": picked })
    );
    // The picker allows the path it answered, as the dialog plugin does.
    fixture
        .app
        .fs_scope()
        .allow_directory(&picked, true)
        .unwrap();
    assert_eq!(resolve(&picked).unwrap(), json!(chosen));
    assert_eq!(resolve(&chosen).unwrap(), json!(chosen));
    let gone = alias.join("Gone");
    fixture.app.fs_scope().allow_directory(&gone, true).unwrap();
    assert_eq!(resolve(&gone).unwrap_err(), json!({ "name": "Missing" }));
    assert!(!base.join("Gone").exists());
    assert_eq!(std::fs::read_dir(&chosen).unwrap().count(), 0);
}
