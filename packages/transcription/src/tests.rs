//! The plugin driven through the mock runtime: where settings live, lazy
//! cache creation, and what the commands refuse before any model runs.

use super::*;
use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
use tauri::utils::acl::ExecutionContext;
use tauri::webview::InvokeRequest;
use tauri::{App, WebviewWindow, WebviewWindowBuilder};

const IDENTIFIER: &str = "so.epicenter.transcription-plugin-test";

/// The mock context, allowing every command of the plugin when `allow`.
fn context(allow: bool) -> tauri::Context<MockRuntime> {
    let mut context = mock_context(noop_assets());
    context.config_mut().identifier = IDENTIFIER.into();
    if allow {
        for command in COMMANDS {
            context.runtime_authority_mut().__allow_command(
                format!("plugin:epicenter-transcription|{command}"),
                ExecutionContext::Local,
            );
        }
    }
    context
}

struct Fixture {
    app: App<MockRuntime>,
}

/// An app with the plugin installed.
fn fixture_with(allow: bool) -> Fixture {
    let app = mock_builder()
        .plugin(init())
        .build(context(allow))
        .expect("mock app");
    Fixture { app }
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
fn a_window_without_the_permission_cannot_transcribe() {
    let fixture = fixture_with(false);
    let main = window(&fixture.app, "main");
    let refused = invoke(
        &main,
        "transcribe_audio",
        json!({ "modelId": "unknown-model", "audio": "bm90IGF1ZGlv", "hints": {} }),
    )
    .unwrap_err();
    assert!(refused.to_string().contains("not allowed"), "{refused}");
}

#[test]
fn uploaded_audio_is_refused_before_any_model_runs() {
    let fixture = fixture();
    let main = window(&fixture.app, "main");
    let upload = |model: &str, audio: &str| {
        invoke(
            &main,
            "transcribe_audio",
            json!({ "modelId": model, "audio": audio, "hints": {} }),
        )
        .unwrap_err()
    };
    // Not base64: nothing to decode.
    let refused = upload("unknown-model", "not base64!");
    assert_eq!(name(&refused), "AudioReadError", "{refused}");
    // An unknown model is refused before the bytes are decoded as audio.
    let refused = upload("unknown-model", "bm90IGF1ZGlv");
    assert_eq!(name(&refused), "LocalRouteUnavailable", "{refused}");
}

#[test]
fn loading_an_unknown_model_is_refused_and_unloading_one_is_a_no_op() {
    let fixture = fixture();
    let main = window(&fixture.app, "main");
    let refused = invoke(&main, "load_model", json!({ "modelId": "unknown-model" })).unwrap_err();
    assert_eq!(name(&refused), "LocalRouteUnavailable", "{refused}");
    assert_eq!(
        invoke(&main, "unload_model", json!({ "modelId": "unknown-model" })).unwrap(),
        Value::Null
    );
}

#[test]
fn removing_an_unknown_model_is_refused() {
    let fixture = fixture();
    let main = window(&fixture.app, "main");
    let refused = invoke(&main, "remove_model", json!({ "modelId": "unknown-model" })).unwrap_err();
    assert_eq!(name(&refused), "UnknownModel", "{refused}");
}
