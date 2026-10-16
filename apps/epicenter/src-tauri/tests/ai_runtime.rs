//! Opt-in native transcription evidence: the real `list_inference_models` and
//! `transcribe_audio_bytes` handlers and cached inference, behind Tauri's mock
//! window and runtime. No microphone or real settings open.
//!
//! Run with a cached Whisper Tiny and a speech WAV:
//! `EPICENTER_NATIVE_AUDIO=/absolute/speech.wav cargo test --test ai_runtime -- --ignored`

use epicenter_lib::transcription::{LocalTranscriptionSettings, ModelCache, UnloadPolicy};
use serde_json::{json, Value};

const MODEL: &str = "handy-computer/whisper-tiny-gguf@main/whisper-tiny-Q8_0.gguf";

fn invoke(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    args: Value,
) -> Result<Value, Value> {
    tauri::test::get_ipc_response(
        webview,
        tauri::webview::InvokeRequest {
            cmd: command.to_string(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        },
    )
    .map(|body| body.deserialize::<Value>().expect("native JSON response"))
}

#[test]
#[ignore = "needs a cached Whisper Tiny and EPICENTER_NATIVE_AUDIO"]
fn native_transcription_commands() {
    let fixture =
        std::fs::read(std::env::var("EPICENTER_NATIVE_AUDIO").expect("speech fixture path"))
            .expect("read speech fixture");
    let directory = tempfile::tempdir().expect("temporary settings directory");
    let settings_path = directory.path().join("local-transcription.json");
    let cache = ModelCache::new(LocalTranscriptionSettings::load(settings_path.clone()));
    // MockRuntime does not run the real window destruction loop. Release each
    // model through its supported policy before Metal's global teardown runs.
    cache
        .settings()
        .set_unload_policy(UnloadPolicy::Immediately)
        .expect("temporary unload policy");
    let initial_settings = std::fs::read(&settings_path).expect("temporary settings");
    let app = tauri::test::mock_builder()
        .manage(cache.clone())
        .invoke_handler(tauri::generate_handler![
            epicenter_lib::transcription::list_inference_models,
            epicenter_lib::transcription::transcribe_audio_bytes
        ])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock Tauri runtime");
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("mock Tauri window");
    let models = invoke(&webview, "list_inference_models", json!({})).expect("list models");
    assert!(
        models
            .as_array()
            .unwrap()
            .iter()
            .any(|model| model["id"] == MODEL),
        "Whisper Tiny must already be cached"
    );

    let hints = json!({
        "language": "en",
        "initialPrompt": "The application closes its transcription access."
    });
    let transcript = invoke(
        &webview,
        "transcribe_audio_bytes",
        json!({ "modelId": MODEL, "bytes": fixture, "hints": hints }),
    )
    .expect("transcribe speech");
    assert!(
        !transcript["text"].as_str().unwrap_or("").trim().is_empty(),
        "native engine produced speech text: {transcript}"
    );
    assert_eq!(transcript["outcome"], "transcribed");
    assert_eq!(transcript["modelId"], MODEL);
    assert_eq!(
        transcript["applied"],
        json!({ "language": "en", "initialPrompt": true })
    );

    let silence = invoke(
        &webview,
        "transcribe_audio_bytes",
        json!({ "modelId": MODEL, "bytes": [], "hints": {} }),
    )
    .expect("empty audio");
    assert_eq!(silence["outcome"], "empty-audio");

    let unknown = invoke(
        &webview,
        "transcribe_audio_bytes",
        json!({ "modelId": "unknown", "bytes": fixture, "hints": {} }),
    )
    .expect_err("an unknown model is refused");
    assert!(
        unknown
            .to_string()
            .contains("Unknown native transcription model"),
        "{unknown}"
    );

    let invalid = invoke(
        &webview,
        "transcribe_audio_bytes",
        json!({ "modelId": MODEL, "bytes": b"invalid audio".to_vec(), "hints": {} }),
    )
    .expect_err("bytes that are not audio are refused");
    assert!(invalid.to_string().contains("AudioReadError"), "{invalid}");

    assert!(cache.settings().active_model_id().is_none());
    assert_eq!(
        std::fs::read(&settings_path).expect("temporary settings"),
        initial_settings,
        "inference changed model settings"
    );
}
