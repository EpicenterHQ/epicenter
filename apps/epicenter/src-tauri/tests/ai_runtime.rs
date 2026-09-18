//! Opt-in SDK evidence bridge: real command handlers and cached inference, with
//! Tauri's mock window/runtime. Bun owns the assertions and stdin protocol in
//! `packages/app/scripts/native-ai-smoke.ts`; no microphone or real settings open.

use epicenter_lib::transcription::{LocalTranscriptionSettings, ModelCache, UnloadPolicy};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{BufRead, Write};

#[derive(Deserialize)]
struct Request {
    id: u32,
    command: String,
    args: Value,
}

fn emit(value: Value) {
    println!("EPICENTER_AI {value}");
    std::io::stdout().flush().expect("flush bridge response");
}

#[test]
#[ignore = "run through packages/app/scripts/native-ai-smoke.ts with cached model and speech fixture"]
fn sdk_native_command_bridge() {
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
    emit(json!({ "event": "ready", "runtime": "mock", "inference": "real" }));

    for line in std::io::stdin().lock().lines() {
        let request: Request = serde_json::from_str(&line.expect("read bridge request"))
            .expect("decode bridge request");
        assert!(matches!(
            request.command.as_str(),
            "list_inference_models" | "transcribe_audio_bytes"
        ));
        let bytes = request.args.get("bytes").map(|value| {
            serde_json::from_value::<Vec<u8>>(value.clone()).expect("uploaded byte array")
        });
        emit(json!({
            "event": "admitted",
            "id": request.id,
            "command": request.command,
            "modelId": request.args.get("modelId"),
            "hints": request.args.get("hints"),
            "byteLength": bytes.as_ref().map(Vec::len),
            "matchesFixture": bytes.as_ref().map(|bytes| bytes == &fixture),
        }));
        let result = tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: request.command,
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(request.args),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        );
        emit(match result {
            Ok(body) => json!({
                "event": "completed", "id": request.id,
                "value": body.deserialize::<Value>().expect("native JSON response"),
            }),
            Err(error) => json!({ "event": "completed", "id": request.id, "error": error }),
        });
    }
    assert!(cache.settings().active_model_id().is_none());
    assert_eq!(
        std::fs::read(&settings_path).expect("temporary settings"),
        initial_settings,
        "inference changed model settings"
    );
    emit(json!({ "event": "finished", "settingsUnchanged": true }));
}
