//! The plugin through Tauri's real invoke path, on the mock runtime.
//!
//! Each test builds an app with the plugin installed, creates windows, and
//! sends `plugin:epicenter-folder|...` requests exactly as a page's `invoke`
//! would. The folder is a real directory; a test makes its repository with
//! the real `git`, which the plugin itself never runs (ADR-0559).
//!
//! Key behaviors:
//! - The generated TypeScript bindings match the registered commands.
//! - A scope is granted only to the windows registered or permitted for it,
//!   each the same root, and a page never supplies a root.
//! - Two windows of one scope racing to save one file over the same version
//!   publish one at a time: exactly one lands, and the other is `stale`.
//! - Storage reaches the data paths of the granted root and nothing else:
//!   never `.git`, never another window's root, never through a link.
//! - A grant adds nothing to the app's access control, so an app that
//!   already scopes another permission grants and reads as any other does.
//! - Changes land only after a grant, only under the root, and never in
//!   Git's private state. A grant sweeps staged files a stopped save left.
//! - A put takes its bytes as a raw body and its arguments as
//!   percent-encoded headers; a JSON array of bytes, Tauri's postMessage
//!   fallback, is accepted too. A file read returns its bytes raw. A
//!   refusal is a `StorageError` naming the page's `FileError`.
//! - `granted_root` names a granted scope's root to its windows alone, for
//!   the `epicenter` CLI the shell runs.
//! - From its first grant a folder is watched: every window permitted into
//!   its scope hears what changed outside it, as folder-relative paths, a
//!   ref moving as `.git`, and everything when watching begins; Git's own
//!   noise and other windows hear nothing.
//! - `window_folder` answers each window the app and folder the shell handed
//!   it, and `None` to a window it handed nothing; a page cannot set it.
//! - After shutdown, a late change is refused.
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

use crate::{init, FolderConfig, FolderExt, ScopeConfig, WindowFolder, COMMANDS};

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
            folder: FolderConfig::new(&root),
            windows: vec!["main".to_string()],
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

/// `read_folder_file` as `tauri-files.ts` asks for it: the bytes, which
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

fn children(window: &WebviewWindow<MockRuntime>, scope: &str, directory: &str) -> Result<Value, Value> {
    invoke(
        window,
        "read_folder_children",
        json!({ "scope": scope, "directory": directory }),
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
}

fn put_headers(path: &str, remove: bool, if_match: Option<&str>) -> HeaderMap {
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
    headers.insert("remove", encoded(&remove.to_string()));
    if let Some(if_match) = if_match {
        headers.insert("if-match", encoded(if_match));
    }
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

/// Run the real `git` in the root `window` was granted for `notes`, as a
/// person or the `epicenter` CLI would; the plugin runs none.
fn git(window: &WebviewWindow<MockRuntime>, args: &[&str]) -> Result<String, String> {
    let root = window
        .folders()
        .granted_root("notes", window.label())
        .map_err(|refusal| format!("{refusal:?}"))?;
    let output = std::process::Command::new("git")
        .args(["-c", "user.name=Test", "-c", "user.email=test@example.com"])
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[test]
fn a_scope_is_granted_to_its_windows_and_no_other() {
    let fixture = fixture("grant");
    let main = window(&fixture.app, "main");
    let other = window(&fixture.app, "other");
    let side = window(&fixture.app, "side");
    assert_eq!(
        grant(&other).unwrap_err(),
        json!({ "name": "WindowNotPermitted", "scope": "notes", "window": "other" })
    );
    assert_eq!(
        invoke(&main, "grant_directory", json!({ "scope": "elsewhere" })).unwrap_err(),
        json!({ "name": "UnknownScope", "scope": "elsewhere" })
    );
    // Nothing reaches the folder before a grant, from any window.
    let early = write(&fixture, &main, "a.md", "a").unwrap_err();
    assert_eq!(early["name"], "Io", "{early}");
    assert!(text(&early["message"]).contains("not been granted"), "{early}");
    assert!(!fixture.root.exists());

    let granted = grant(&main).unwrap();
    assert_eq!(
        granted,
        json!({ "root": fixture.root.to_str().unwrap() })
    );
    // A reloaded page asks again and gets the same folder.
    assert_eq!(grant(&main).unwrap(), granted);
    assert!(text(&write(&fixture, &other, "a.md", "a").unwrap_err())
        .contains("WindowNotPermitted"));

    // A window the shell permits later gets the same folder, and both
    // windows read and change it.
    fixture.app.folders().permit("notes", "side").unwrap();
    assert_eq!(grant(&side).unwrap(), granted);
    git(&main, &["init", "--quiet", "--initial-branch=main"]).unwrap();
    write(&fixture, &main, "a.md", "main's\n").unwrap();
    assert_eq!(read_file(&side, "notes", "a.md").unwrap(), b"main's\n");
    write(&fixture, &side, "b.md", "side's\n").unwrap();
    assert_eq!(read_file(&main, "notes", "b.md").unwrap(), b"side's\n");
    assert!(text(&grant(&other).unwrap_err()).contains("WindowNotPermitted"));
}

#[test]
fn each_window_is_answered_the_app_and_folder_the_shell_handed_it() {
    let fixture = fixture("handed");
    let todos = window(&fixture.app, "app:so_epicenter_todos:6e6f746573");
    let settings = window(&fixture.app, "home");
    let plain = window(&fixture.app, "main");
    fixture.app.folders().hand(
        todos.label(),
        WindowFolder {
            app: "so.epicenter.todos".into(),
            folder: "notes".into(),
        },
    );
    fixture.app.folders().hand(
        settings.label(),
        WindowFolder {
            app: "so.epicenter".into(),
            folder: "so.epicenter".into(),
        },
    );

    assert_eq!(
        invoke(&todos, "window_folder", json!({})).unwrap(),
        json!({ "app": "so.epicenter.todos", "folder": "notes" })
    );
    assert_eq!(
        invoke(&settings, "window_folder", json!({})).unwrap(),
        json!({ "app": "so.epicenter", "folder": "so.epicenter" })
    );
    // A window the shell handed nothing runs no app.
    assert_eq!(invoke(&plain, "window_folder", json!({})).unwrap(), Value::Null);
    // The answer is the window's, whatever the page passes or navigates to.
    assert_eq!(
        invoke(&todos, "window_folder", json!({ "folder": "so.epicenter" })).unwrap()["folder"],
        "notes"
    );
}

/// A data folder is opened only as a person left it: a missing one is
/// `Missing` and is not created, and one inside another repository's working
/// tree is granted as it is. `granted_root` names it to its window alone,
/// for the `epicenter` CLI, which refuses a nested `git init` itself.
#[test]
fn a_data_folder_is_never_created_or_given_a_nested_repository() {
    let directory = temp("data-folder");
    std::fs::create_dir(directory.0.join(".git")).unwrap();
    let root = directory.0.join("vault");
    let app = mock_builder()
        .plugin(init())
        .build(context())
        .expect("mock app");
    app.folders()
        .register(ScopeConfig {
            scope: "notes".to_string(),
            folder: FolderConfig::data(&root),
            windows: vec!["main".to_string()],
        })
        .unwrap();
    let main = window(&app, "main");
    assert_eq!(
        grant(&main).unwrap_err(),
        json!({ "name": "Missing", "root": root.to_str().unwrap() })
    );
    assert!(!root.exists());

    std::fs::create_dir(&root).unwrap();
    grant(&main).unwrap();
    assert_eq!(
        app.folders().granted_root("notes", "main").unwrap(),
        std::fs::canonicalize(&root).unwrap()
    );
    assert!(app.folders().granted_root("notes", "other").is_err());
    assert!(!root.join(".git").exists());
    app.folders().shutdown();
}

/// Two windows of one scope save the same file over the version both read,
/// at once. The shell checks and renames under the root's mutex, so exactly
/// one save lands and the other is `stale`, whichever wins.
#[test]
fn two_windows_saving_one_file_over_the_same_version_publish_once() {
    const ROUNDS: usize = 8;
    let fixture = fixture("two-editors");
    fixture.app.folders().permit("notes", "side").unwrap();
    let main = window(&fixture.app, "main");
    let side = window(&fixture.app, "side");
    grant(&main).unwrap();
    grant(&side).unwrap();
    git(&main, &["init", "--quiet", "--initial-branch=main"]).unwrap();
    write(&fixture, &main, "a.md", "round 0\n").unwrap();
    for round in 1..=ROUNDS {
        let expected = sha256(format!("round {}\n", round - 1).as_bytes());
        let start = std::sync::Arc::new(std::sync::Barrier::new(2));
        let saves: Vec<_> = [&main, &side]
            .into_iter()
            .map(|editor| {
                let content = format!("round {round}\n{}\n", editor.label());
                let (editor, start, expected) =
                    (editor.clone(), std::sync::Arc::clone(&start), expected.clone());
                std::thread::spawn(move || {
                    start.wait();
                    let outcome = put(&editor, "a.md", Some(content.as_bytes()), Some(&expected));
                    (content, outcome)
                })
            })
            .collect();
        let outcomes: Vec<_> = saves.into_iter().map(|save| save.join().unwrap()).collect();
        let landed: Vec<_> = outcomes
            .iter()
            .filter(|(_, outcome)| *outcome == Ok(json!("landed")))
            .collect();
        assert_eq!(landed.len(), 1, "round {round}: {outcomes:?}");
        let won = &landed[0].0;
        assert_eq!(&std::fs::read_to_string(fixture.root.join("a.md")).unwrap(), won);
        assert!(
            outcomes.iter().any(|(_, outcome)| *outcome == Ok(json!("stale"))),
            "round {round}: {outcomes:?}"
        );
        // The next round expects what landed, as an editor that read again
        // after its `stale` would.
        write(&fixture, &main, "a.md", &format!("round {round}\n")).unwrap();
    }
    assert_eq!(staged(&fixture), Vec::<String>::new());
}

/// The staged files left in the folder.
fn staged(fixture: &Fixture) -> Vec<String> {
    std::fs::read_dir(fixture.root.join(".git/epicenter/scratch"))
        .map(|entries| {
            entries
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn changes_land_under_the_root_and_never_in_git_state() {
    let fixture = fixture("changes");
    let main = window(&fixture.app, "main");
    grant(&main).unwrap();

    invoke(
        &main,
        "make_folder_directory",
        json!({ "scope": "notes", "path": "notes/sub" }),
    )
    .unwrap();
    assert!(fixture.root.join("notes/sub").is_dir());
    assert_eq!(
        invoke(&main, "remove_folder_directory", json!({ "scope": "notes", "path": "notes" }))
            .unwrap_err(),
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
        invoke(&main, "remove_folder_directory", json!({ "scope": "notes", "path": path }))
            .unwrap();
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
}

/// The lowercase hexadecimal SHA-256 the page computes.
fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn a_save_lands_only_on_what_the_page_expected() {
    let fixture = fixture("expected");
    let main = window(&fixture.app, "main");
    grant(&main).unwrap();
    git(&main, &["init", "--quiet", "--initial-branch=main"]).unwrap();
    assert_eq!(put(&main, "a.md", Some(b"first\n"), None).unwrap(), "landed");
    assert_eq!(put(&main, "a.md", Some(b"again\n"), None).unwrap(), "stale");
    let stale = sha256(b"stale\n");
    assert_eq!(put(&main, "b.md", Some(b"b\n"), Some(&stale)).unwrap(), "stale");
    assert_eq!(put(&main, "a.md", Some(b"mine\n"), Some(&stale)).unwrap(), "stale");
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
    let fixture = fixture("raw-write");
    let main = window(&fixture.app, "main");
    grant(&main).unwrap();

    // Every byte value arrives as it is, and the path decodes whole: the
    // headers encode every `/`, `.`, and space in it.
    let bytes: Vec<u8> = (0..=255).collect();
    assert_eq!(put(&main, "notes/all of it.bin", Some(&bytes), None).unwrap(), "landed");
    assert_eq!(std::fs::read(fixture.root.join("notes/all of it.bin")).unwrap(), bytes);

    // The bytes as a JSON array, Tauri's postMessage fallback, also land.
    request(
        &main,
        "put_folder_file",
        InvokeBody::Json(json!([0, 120, 255])),
        put_headers("fallback.bin", false, None),
    )
    .unwrap();
    assert_eq!(std::fs::read(fixture.root.join("fallback.bin")).unwrap(), vec![0, 120, 255]);

    // Any other JSON body, or a header missing, is refused.
    let json = request(
        &main,
        "put_folder_file",
        InvokeBody::Json(json!({ "bytes": [1] })),
        put_headers("refused.bin", false, None),
    )
    .unwrap_err();
    assert!(text(&json["message"]).contains("raw body"), "{json}");
    for header in ["remove", "scope", "path"] {
        let mut headers = put_headers("refused.bin", false, None);
        headers.remove(header);
        let missing = request(&main, "put_folder_file", InvokeBody::Raw(b"x".to_vec()), headers)
            .unwrap_err();
        assert!(text(&missing["message"]).contains(header), "{missing}");
    }
    assert!(!fixture.root.join("refused.bin").exists());
    assert_eq!(staged(&fixture), Vec::<String>::new());
}

#[test]
fn storage_reaches_the_data_paths_of_the_granted_root_and_nothing_else() {
    let fixture = fixture("reads");
    let main = window(&fixture.app, "main");
    // Nothing is read before a grant.
    let early = invoke(&main, "list_folder", json!({ "scope": "notes" })).unwrap_err();
    assert!(text(&early["message"]).contains("not been granted"), "{early}");
    grant(&main).unwrap();
    git(&main, &["init", "--quiet", "--initial-branch=main"]).unwrap();
    write(&fixture, &main, "todos/a.md", "first\n").unwrap();
    std::fs::create_dir(fixture.root.join("empty")).unwrap();

    let mut listed = invoke(&main, "list_folder", json!({ "scope": "notes" })).unwrap();
    listed["directories"]
        .as_array_mut()
        .unwrap()
        .sort_by_key(text);
    assert_eq!(
        listed,
        json!({ "files": [{ "path": "todos/a.md", "size": 6 }], "directories": ["empty", "todos"] })
    );
    let mut top = children(&main, "notes", "").unwrap();
    top["directories"]
        .as_array_mut()
        .unwrap()
        .sort_by_key(text);
    assert_eq!(top, json!({ "files": [], "directories": ["empty", "todos"] }));
    assert_eq!(
        children(&main, "notes", "todos").unwrap(),
        json!({ "files": ["a.md"], "directories": [] })
    );
    assert_eq!(
        children(&main, "notes", "todos/a.md").unwrap_err(),
        json!({ "name": "NotADirectory", "path": "todos/a.md" })
    );
    // Every byte value arrives as it is, raw.
    let bytes: Vec<u8> = (0..=255).collect();
    std::fs::write(fixture.root.join("todos/all.bin"), &bytes).unwrap();
    assert_eq!(read_file(&main, "notes", "todos/all.bin").unwrap(), bytes);
    assert_eq!(
        read_file(&main, "notes", "todos/b.md").unwrap_err(),
        json!({ "name": "NotFound", "path": "todos/b.md" })
    );
    assert_eq!(
        read_file(&main, "notes", "todos").unwrap_err(),
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
        assert_eq!(read_file(&main, "notes", &path).unwrap_err()["name"], "InvalidPath", "{path}");
        assert_eq!(children(&main, "notes", &path).unwrap_err()["name"], "InvalidPath", "{path}");
    }
}

#[cfg(unix)]
#[test]
fn a_path_through_a_link_or_naming_one_is_refused() {
    let fixture = fixture("read-links");
    let main = window(&fixture.app, "main");
    grant(&main).unwrap();
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
        assert_eq!(read_file(&main, "notes", path).unwrap_err(), link(path));
        assert_eq!(put(&main, path, Some(b"mine"), None).unwrap_err(), link(path));
    }
    assert_eq!(children(&main, "notes", "todos").unwrap_err(), link("todos"));
    // A link is listed as a file, never followed.
    let listed = children(&main, "notes", "").unwrap();
    let mut files: Vec<String> = listed["files"].as_array().unwrap().iter().map(text).collect();
    files.sort();
    assert_eq!(files, ["a.md", "todos"]);
    assert_eq!(std::fs::read(elsewhere.join("secret.md")).unwrap(), b"theirs");
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
            folder: FolderConfig::new(&other_root),
            windows: vec!["other".to_string()],
        })
        .unwrap();
    let main = window(&fixture.app, "main");
    let other = window(&fixture.app, "other");
    grant(&main).unwrap();
    invoke(&other, "grant_directory", json!({ "scope": "other-notes" })).unwrap();
    std::fs::write(fixture.root.join("mine.md"), b"main's").unwrap();
    std::fs::write(other_root.join("mine.md"), b"other's").unwrap();

    assert_eq!(read_file(&main, "notes", "mine.md").unwrap(), b"main's");
    assert_eq!(read_file(&other, "other-notes", "mine.md").unwrap(), b"other's");
    // Neither reaches the other's root by the other's scope.
    assert!(text(&read_file(&main, "other-notes", "mine.md").unwrap_err())
        .contains("WindowNotPermitted"));
    assert!(text(&children(&other, "notes", "").unwrap_err()).contains("WindowNotPermitted"));
}

/// A save that stopped before its rename leaves its staged file. A grant
/// removes the ones an hour old, and none younger, which another process's
/// save may still be about to rename.
#[test]
fn a_grant_sweeps_staged_files_a_stopped_save_left() {
    let fixture = fixture("sweep");
    let scratch = fixture.root.join(".git/epicenter/scratch");
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
        format!("{}-0123456789abcdef0123456789abcdef-0", String::from_utf8(digits).unwrap())
    };
    let old = name(now - 2 * 60 * 60 * 1000);
    let young = name(now - 60 * 1000);
    for staged in [&old, &young] {
        std::fs::write(scratch.join(staged), b"x").unwrap();
    }
    let main = window(&fixture.app, "main");
    grant(&main).unwrap();
    assert_eq!(staged(&fixture), [young]);
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
    assert_eq!(read_file(&main, "notes", "a.md").unwrap(), b"read");
    assert_eq!(children(&main, "notes", "").unwrap()["files"], json!(["a.md"]));
}

#[test]
fn after_shutdown_a_late_change_is_refused() {
    let fixture = fixture("shutdown");
    let main = window(&fixture.app, "main");
    grant(&main).unwrap();
    write(&fixture, &main, "kv.json", "{}\n").unwrap();
    fixture.app.folders().shutdown();
    assert!(text(&write(&fixture, &main, "kv.json", "late\n").unwrap_err())
        .contains("ShuttingDown"));
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("kv.json")).unwrap(),
        "{}\n"
    );
    assert_eq!(grant(&main).unwrap_err(), json!({ "name": "ShuttingDown" }));
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

/// The change events `window` hears: each one's scope and paths, `None` for
/// everything.
fn hear(window: &WebviewWindow<MockRuntime>) -> std::sync::mpsc::Receiver<(String, Option<Vec<String>>)> {
    use tauri::Listener;
    let (sender, receiver) = std::sync::mpsc::channel();
    window.listen(crate::FOLDER_CHANGED_EVENT, move |event| {
        let change: Value = serde_json::from_str(event.payload()).unwrap();
        let paths = change["paths"].as_array().map(|paths| {
            paths
                .iter()
                .map(|path| path.as_str().unwrap().to_string())
                .collect()
        });
        let _ = sender.send((change["scope"].as_str().unwrap().to_string(), paths));
    });
    receiver
}

/// Every path `changes` reports until each of `expected` has been reported.
/// A batch names each path once, sorted. A report of everything on the way
/// is allowed: the operating system may ask for a rescan at any time.
fn until_heard(
    changes: &std::sync::mpsc::Receiver<(String, Option<Vec<String>>)>,
    expected: &[&str],
) -> std::collections::BTreeSet<String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let mut heard = std::collections::BTreeSet::new();
    while !expected.iter().all(|path| heard.contains(*path)) {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        let Ok((scope, paths)) = changes.recv_timeout(left) else {
            panic!("heard {heard:?}, never all of {expected:?}");
        };
        assert_eq!(scope, "notes");
        if let Some(paths) = paths {
            assert!(paths.windows(2).all(|pair| pair[0] < pair[1]), "{paths:?}");
            heard.extend(paths);
        }
    }
    heard
}

/// Give a new watch a moment to start before the disk changes under it.
fn settle() {
    std::thread::sleep(std::time::Duration::from_millis(300));
}

/// ADR-0548: from its first grant a folder is watched, and every window
/// permitted into its scope, then or later, hears what changed outside it,
/// relative to the root, and no other window hears anything. Watching
/// begins with a report of everything.
#[test]
fn the_folder_watcher_reports_changes_to_the_scopes_windows_and_no_other() {
    let fixture = fixture("watch");
    let main = window(&fixture.app, "main");
    let other = window(&fixture.app, "other");
    let side = window(&fixture.app, "side");
    let main_hears = hear(&main);
    let other_hears = hear(&other);
    let side_hears = hear(&side);

    grant(&main).unwrap();
    assert_eq!(
        main_hears.recv_timeout(std::time::Duration::from_secs(5)).unwrap(),
        ("notes".to_string(), None)
    );
    // A reloaded page's grant does not start a second watch.
    grant(&main).unwrap();
    settle();

    let root = &fixture.root;
    std::fs::create_dir_all(root.join("todos")).unwrap();
    std::fs::write(root.join("todos/a.md"), "a\n").unwrap();
    std::fs::write(root.join("todos/b.md"), "b\n").unwrap();
    until_heard(&main_hears, &["todos/a.md", "todos/b.md"]);
    std::fs::write(root.join("todos/a.md"), "a, changed\n").unwrap();
    until_heard(&main_hears, &["todos/a.md"]);
    std::fs::rename(root.join("todos/b.md"), root.join("todos/c.md")).unwrap();
    until_heard(&main_hears, &["todos/b.md", "todos/c.md"]);
    std::fs::remove_file(root.join("todos/c.md")).unwrap();
    until_heard(&main_hears, &["todos/c.md"]);

    // A save through the plugin, before the folder has a repository, stages
    // in `.git/epicenter/scratch`. The saved path is reported, and `.git`
    // once for the directory the save made; the staged file is not.
    settle();
    while main_hears.try_recv().is_ok() {}
    write(&fixture, &main, "kv.json", "{}\n").unwrap();
    let heard = until_heard(&main_hears, &["kv.json"]);
    assert!(
        heard.iter().all(|path| path == "kv.json" || path == ".git"),
        "{heard:?}"
    );

    // A window permitted later hears what changes from then on.
    fixture.app.folders().permit("notes", "side").unwrap();
    std::fs::write(root.join("todos/d.md"), "d\n").unwrap();
    until_heard(&side_hears, &["todos/d.md"]);

    std::thread::sleep(std::time::Duration::from_millis(300));
    assert!(other_hears.try_recv().is_err(), "a window outside the scope heard a change");
    fixture.app.folders().shutdown();
}

/// Inside `.git`, a ref moving is reported as the one path `.git`, and Git's
/// objects, index, and logs are not reported at all.
#[test]
fn the_folder_watcher_reports_history_moving_and_not_gits_own_noise() {
    let fixture = fixture("watch-git");
    let main = window(&fixture.app, "main");
    let main_hears = hear(&main);
    grant(&main).unwrap();
    settle();
    git(&main, &["init", "--quiet", "--initial-branch=main"]).unwrap();
    std::fs::write(fixture.root.join("a.md"), "a\n").unwrap();
    until_heard(&main_hears, &[".git", "a.md"]);
    settle();
    while main_hears.try_recv().is_ok() {}

    // Staging writes objects and the index, which move no history.
    let git_in_root = |args: &[&str]| {
        let status = std::process::Command::new("git")
            .args(["-c", "user.name=Test", "-c", "user.email=test@example.com"])
            .args(args)
            .current_dir(&fixture.root)
            .status()
            .unwrap();
        assert!(status.success(), "{args:?}");
    };
    git_in_root(&["add", "a.md"]);
    assert!(
        main_hears
            .recv_timeout(std::time::Duration::from_secs(1))
            .is_err(),
        "staging reported a change"
    );

    // A commit moves the branch: history, and nothing else.
    git_in_root(&["commit", "--quiet", "-m", "first"]);
    assert_eq!(
        until_heard(&main_hears, &[".git"]).into_iter().collect::<Vec<_>>(),
        [".git"]
    );
    fixture.app.folders().shutdown();
}
