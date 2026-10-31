//! The plugin driven through the mock runtime: where settings live, lazy
//! cache creation, and what `transcribe_file` refuses before any model runs.

use super::*;
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
use tauri::utils::acl::ExecutionContext;
use tauri::webview::InvokeRequest;
use tauri::{App, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_epicenter_folder::{BindError, Directory, FolderExt};

const IDENTIFIER: &str = "so.epicenter.transcription-plugin-test";

/// The mock context, allowing every command of both plugins when `allow`.
fn context(allow: bool) -> tauri::Context<MockRuntime> {
    let mut context = mock_context(noop_assets());
    context.config_mut().identifier = IDENTIFIER.into();
    if allow {
        for (plugin, commands) in [
            ("epicenter-transcription", COMMANDS),
            ("epicenter-folder", tauri_plugin_epicenter_folder::COMMANDS),
        ] {
            for command in commands {
                context.runtime_authority_mut().__allow_command(
                    format!("plugin:{plugin}|{command}"),
                    ExecutionContext::Local,
                );
            }
        }
    }
    context
}

struct Fixture {
    app: App<MockRuntime>,
    root: PathBuf,
    _directory: tempfile::TempDir,
}

/// An app with both plugins and the directory `notes` bound to `main`
/// before any window exists, as a shell binds it.
fn fixture_with(allow: bool) -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(directory.path())
        .unwrap()
        .join("notes");
    let app = mock_builder()
        .plugin(tauri_plugin_epicenter_folder::init())
        .plugin(init())
        .build(context(allow))
        .expect("mock app");
    app.folders()
        .bind_while_building("main", Directory::create(&root).unwrap(), || {
            Ok::<_, BindError>(window(&app, "main"))
        })
        .unwrap();
    Fixture {
        app,
        root,
        _directory: directory,
    }
}

fn fixture() -> Fixture {
    fixture_with(true)
}

fn window(app: &App<MockRuntime>, label: &str) -> WebviewWindow<MockRuntime> {
    app.get_webview_window(label).unwrap_or_else(|| {
        WebviewWindowBuilder::new(app, label, Default::default())
            .build()
            .expect("mock window")
    })
}

fn invoke(window: &WebviewWindow<MockRuntime>, command: &str, args: Value) -> Result<Value, Value> {
    tauri::test::get_ipc_response(
        window,
        InvokeRequest {
            cmd: format!("plugin:epicenter-transcription|{command}"),
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

fn transcribe(
    window: &WebviewWindow<MockRuntime>,
    model_id: &str,
    path: &str,
) -> Result<Value, Value> {
    invoke(
        window,
        "transcribe_file",
        json!({ "modelId": model_id, "root": null, "path": path, "hints": {} }),
    )
}

fn transcribe_in(
    window: &WebviewWindow<MockRuntime>,
    root: &str,
    path: &str,
) -> Result<Value, Value> {
    invoke(
        window,
        "transcribe_file",
        json!({ "modelId": "unknown-model", "root": root, "path": path, "hints": {} }),
    )
}

fn name(refusal: &Value) -> &str {
    refusal["name"].as_str().unwrap_or_default()
}

fn state(app: &App<MockRuntime>) -> tauri::State<'_, PluginState<MockRuntime>> {
    app.state::<PluginState<MockRuntime>>()
}

#[test]
fn settings_live_in_the_app_s_own_local_data_and_the_cache_is_lazy() {
    let fixture = fixture();
    let app = &fixture.app;
    let own = app.path().app_local_data_dir().unwrap();
    assert!(own.ends_with(IDENTIFIER), "{}", own.display());
    assert_eq!(state(app).settings_path, own.join(SETTINGS_FILE));
    assert!(state(app).cache.lock().unwrap().is_none());

    // Navigation refuses by default and creates no cache.
    let main = window(app, "main");
    assert_eq!(
        invoke(&main, "open_model_settings", json!({})).unwrap_err(),
        json!("This app has no model settings.")
    );
    assert!(state(app).cache.lock().unwrap().is_none());

    let first = model_cache(app.handle()).unwrap();
    let second = model_cache(app.handle()).unwrap();
    assert!(std::ptr::eq(first.settings(), second.settings()));
}

#[test]
fn the_open_settings_callback_is_the_app_s() {
    let app = mock_builder()
        .plugin(Builder::new().open_settings(|_| Ok(())).build())
        .build(context(true))
        .unwrap();
    let main = window(&app, "main");
    assert_eq!(
        invoke(&main, "open_model_settings", json!({})).unwrap(),
        Value::Null
    );
}

#[test]
fn the_accessor_reports_a_missing_plugin() {
    let app = mock_builder().build(context(true)).unwrap();
    assert!(
        matches!(model_cache(app.handle()), Err(message) if message == "Transcription plugin is not installed")
    );
}

#[test]
fn transcribe_file_reaches_only_the_folder_bound_to_the_calling_window() {
    let fixture = fixture();
    std::fs::create_dir_all(fixture.root.join("recordings")).unwrap();
    std::fs::write(fixture.root.join("recordings/a.wav"), b"not audio").unwrap();
    let other = window(&fixture.app, "other");

    // A window bound to no folder reads nothing, whatever the page passes.
    let elsewhere = fixture.root.join("recordings/a.wav");
    for path in ["recordings/a.wav", elsewhere.to_str().unwrap()] {
        let refused = transcribe(&other, "unknown-model", path).unwrap_err();
        assert_eq!(name(&refused), "FolderUnavailable", "{refused}");
    }

    // Folder shutdown refuses a previously bound window too.
    let main = window(&fixture.app, "main");
    fixture.app.folders().shutdown();
    let refused = transcribe(&main, "unknown-model", "recordings/a.wav").unwrap_err();
    assert_eq!(name(&refused), "FolderUnavailable", "{refused}");
}

#[test]
fn transcribe_file_reaches_a_named_root_only_when_the_window_opened_it() {
    let fixture = fixture();
    let main = window(&fixture.app, "main");
    std::fs::create_dir_all(fixture.root.join("recordings")).unwrap();
    std::fs::write(fixture.root.join("recordings/a.wav"), b"not audio").unwrap();

    // The window's own folder, named by its path, is reached: the unknown
    // model is what refuses.
    let refused =
        transcribe_in(&main, fixture.root.to_str().unwrap(), "recordings/a.wav").unwrap_err();
    assert_eq!(name(&refused), "LocalRouteUnavailable", "{refused}");

    // A folder the page never opened is refused before its file is looked at.
    let other = fixture.root.parent().unwrap().join("other");
    std::fs::create_dir_all(other.join("recordings")).unwrap();
    std::fs::write(other.join("recordings/a.wav"), b"not audio").unwrap();
    let refused = transcribe_in(&main, other.to_str().unwrap(), "recordings/a.wav").unwrap_err();
    assert_eq!(name(&refused), "FolderUnavailable", "{refused}");
}

#[test]
fn transcribe_file_refuses_a_path_the_path_rule_refuses() {
    let fixture = fixture();
    let main = window(&fixture.app, "main");
    std::fs::write(fixture.root.parent().unwrap().join("outside.wav"), b"x").unwrap();
    for path in [
        "../outside.wav",
        "/absolute.wav",
        ".git/config",
        "recordings/HEAD/a.wav",
        "recordings//a.wav",
        "recordings/./a.wav",
        "recordings/a:b.wav",
        "",
    ] {
        let refused = transcribe(&main, "unknown-model", path).unwrap_err();
        assert_eq!(name(&refused), "PathRefused", "{path:?}: {refused}");
    }
}

#[cfg(unix)]
#[test]
fn transcribe_file_never_reads_through_a_link() {
    let fixture = fixture();
    let main = window(&fixture.app, "main");
    let outside = fixture.root.parent().unwrap().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("a.wav"), b"x").unwrap();
    std::os::unix::fs::symlink(&outside, fixture.root.join("recordings")).unwrap();
    std::os::unix::fs::symlink(outside.join("a.wav"), fixture.root.join("b.wav")).unwrap();
    for path in ["recordings/a.wav", "b.wav"] {
        let refused = transcribe(&main, "unknown-model", path).unwrap_err();
        assert_eq!(name(&refused), "PathRefused", "{path}: {refused}");
    }
}

#[test]
fn transcribe_file_refuses_a_missing_file_or_a_directory() {
    let fixture = fixture();
    let main = window(&fixture.app, "main");
    std::fs::create_dir_all(fixture.root.join("recordings/a.wav")).unwrap();
    for path in ["recordings/missing.wav", "recordings/a.wav", "absent/a.wav"] {
        let refused = transcribe(&main, "unknown-model", path).unwrap_err();
        assert_eq!(name(&refused), "FileMissing", "{path}: {refused}");
    }
}

#[test]
fn an_unknown_model_is_refused_before_the_file_is_decoded() {
    let fixture = fixture();
    let main = window(&fixture.app, "main");
    std::fs::create_dir_all(fixture.root.join("recordings")).unwrap();
    // Decoding these bytes would answer AudioReadError.
    std::fs::write(fixture.root.join("recordings/a.wav"), b"not audio").unwrap();
    let refused = transcribe(&main, "unknown-model", "recordings/a.wav").unwrap_err();
    assert_eq!(name(&refused), "LocalRouteUnavailable", "{refused}");
    assert_eq!(refused["reason"], json!("active-model-unavailable"));
    assert!(
        refused["message"]
            .as_str()
            .unwrap()
            .contains("unknown-model"),
        "{refused}"
    );
}

#[test]
fn a_window_without_the_permission_cannot_transcribe() {
    let fixture = fixture_with(false);
    let main = window(&fixture.app, "main");
    std::fs::create_dir_all(fixture.root.join("recordings")).unwrap();
    std::fs::write(fixture.root.join("recordings/a.wav"), b"not audio").unwrap();
    let refused = transcribe(&main, "unknown-model", "recordings/a.wav").unwrap_err();
    assert!(refused.to_string().contains("not allowed"), "{refused}");
}
