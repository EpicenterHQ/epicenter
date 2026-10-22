//! The plugin through Tauri's real invoke path, on the mock runtime, beside
//! the folder plugin whose window bindings it reads.
//!
//! No test opens a microphone: every refusal checked here happens before the
//! device is resolved, and the lifecycle of a held recording is driven with
//! the recorder's own stand-in worker.
//!
//! Key behaviors:
//! - The generated TypeScript bindings match the registered commands.
//! - `inputs` lists without opening anything; a meter or a recording asks for
//!   a microphone by that id, and an id that is not connected is refused.
//! - A meter is closed only by its window, and with its page, and counts as
//!   an open microphone while it is open.
//! - Without microphone access no meter or recording resolves a device;
//!   listing asks for nothing.
//! - Permission granted after page departure resolves no device for that page.
//! - `start` records only into the folder bound to the calling window, at a
//!   data path the shared path rule accepts, with nothing at it yet. A page
//!   names no folder; a window with no binding, or a page whose folders have shut down, is refused.
//! - `stop` reaches only a recording the window started; no command deletes
//!   one.
//! - `recover` repairs cut-off WAVs in the bound folder and is idempotent.
//! - A destroyed window's recording is finalized, never deleted.
//! - A window without the plugin's permission cannot call it.

use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
use tauri::utils::acl::ExecutionContext;
use tauri::webview::InvokeRequest;
use tauri::{App, Manager, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_epicenter_folder::{BindError, Directory, FolderExt};

use crate::{init, Builder, Recorders, COMMANDS};

const BINDINGS: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../recorder/src/native/bindings.gen.ts"
);

/// Set `RECORDER_WRITE_BINDINGS=1` to rewrite the committed bindings.
#[test]
fn the_committed_typescript_bindings_match_the_registered_commands() {
    let generated =
        std::env::temp_dir().join(format!("recorder-bindings-{}.ts", std::process::id()));
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
    if std::env::var_os("RECORDER_WRITE_BINDINGS").is_some() {
        std::fs::write(BINDINGS, &fresh).unwrap();
    }
    let committed = std::fs::read_to_string(BINDINGS).unwrap_or_default();
    assert!(
        committed == fresh,
        "packages/recorder/src/native/bindings.gen.ts is stale; run `RECORDER_WRITE_BINDINGS=1 cargo test bindings` in packages/tauri-plugin-epicenter-recorder"
    );
    for command in COMMANDS {
        assert!(
            fresh.contains(&format!("'plugin:epicenter-recorder|{command}'"))
                || fresh.contains(&format!("\"plugin:epicenter-recorder|{command}\"")),
            "{command} is listed for permissions but not registered"
        );
    }
}

struct Fixture {
    app: App<MockRuntime>,
    root: PathBuf,
    _directory: tempfile::TempDir,
}

/// The mock context, allowing every command of both plugins.
fn context() -> tauri::Context<MockRuntime> {
    let mut context = mock_context(noop_assets());
    for command in COMMANDS {
        context.runtime_authority_mut().__allow_command(
            format!("plugin:epicenter-recorder|{command}"),
            ExecutionContext::Local,
        );
    }
    for command in tauri_plugin_epicenter_folder::COMMANDS {
        context.runtime_authority_mut().__allow_command(
            format!("plugin:epicenter-folder|{command}"),
            ExecutionContext::Local,
        );
    }
    context
}

/// An app with both plugins, and the directory `notes` bound to `main`
/// before any window exists, as a shell binds it.
fn fixture() -> Fixture {
    fixture_with_access(|| Ok(()))
}

/// The fixture, with microphone access answered by `access`.
fn fixture_with_access(access: fn() -> crate::recorder::Result<()>) -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(directory.path())
        .unwrap()
        .join("notes");
    let app = mock_builder()
        .plugin(tauri_plugin_epicenter_folder::init())
        .plugin(Builder::new().access(access).build())
        .build(context())
        .expect("mock app");
    let folders = app.folders();
    folders
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

fn window(app: &App<MockRuntime>, label: &str) -> WebviewWindow<MockRuntime> {
    app.get_webview_window(label).unwrap_or_else(|| {
        WebviewWindowBuilder::new(app, label, Default::default())
            .build()
            .expect("mock window")
    })
}

fn call(
    window: &WebviewWindow<MockRuntime>,
    plugin: &str,
    command: &str,
    args: Value,
) -> Result<Value, Value> {
    tauri::test::get_ipc_response(
        window,
        InvokeRequest {
            cmd: format!("plugin:{plugin}|{command}"),
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

fn invoke(window: &WebviewWindow<MockRuntime>, command: &str, args: Value) -> Result<Value, Value> {
    call(window, "epicenter-recorder", command, args)
}

fn start(window: &WebviewWindow<MockRuntime>, path: &str) -> Result<Value, Value> {
    invoke(
        window,
        "start",
        json!({ "path": path, "device": null, "signals": "__CHANNEL__:1" }),
    )
}

fn name(refusal: &Value) -> &str {
    refusal["name"].as_str().unwrap_or_default()
}

#[test]
fn inputs_answers_each_microphone_with_an_id_and_at_most_one_default() {
    let fixture = fixture();
    let main = window(&fixture.app, "main");
    let listed = invoke(&main, "inputs", json!({})).unwrap();
    let inputs = listed.as_array().expect("a list");
    for input in inputs {
        assert!(
            input["id"].as_str().is_some_and(|id| !id.is_empty()),
            "{input}"
        );
        assert!(input["name"].is_string(), "{input}");
    }
    let defaults = inputs
        .iter()
        .filter(|input| input["isDefault"] == json!(true))
        .count();
    assert!(defaults <= 1, "{listed}");
}

#[test]
fn a_microphone_that_is_not_connected_is_refused_not_replaced() {
    let fixture = fixture();
    let main = window(&fixture.app, "main");
    for device in ["coreaudio:no-such-device", "not an id"] {
        let refused = invoke(
            &main,
            "open_meter",
            json!({ "device": device, "levels": "__CHANNEL__:1" }),
        )
        .unwrap_err();
        assert_eq!(name(&refused), "InputUnavailable", "{device}: {refused}");
        let refused = invoke(
            &main,
            "start",
            json!({ "path": "recordings/a", "device": device, "signals": "__CHANNEL__:1" }),
        )
        .unwrap_err();
        assert_eq!(name(&refused), "InputUnavailable", "{device}: {refused}");
    }
    assert_eq!(
        fixture
            .app
            .state::<Recorders<MockRuntime>>()
            .lock()
            .open_meters(),
        0
    );
    assert!(!fixture.root.join("recordings/a.wav").exists());
}

#[test]
fn a_meter_is_closed_by_its_window_or_with_its_page() {
    let fixture = fixture();
    let main = window(&fixture.app, "main");
    let other = window(&fixture.app, "other");
    let recorders = fixture.app.state::<Recorders<MockRuntime>>();
    let refused = invoke(&main, "close_meter", json!({ "id": "1" })).unwrap_err();
    assert_eq!(name(&refused), "NotRecording", "{refused}");

    let page = recorders.lock().page("main");
    let first = "m1";
    recorders
        .lock()
        .add_meter(first, page, "main", crate::meter::Meter::stand_in())
        .unwrap();
    assert!(
        recorders.lock().is_capturing(),
        "an open meter is an open microphone"
    );
    assert!(
        !crate::is_recording(fixture.app.handle()),
        "a microphone meter must not add a recording warning to Quit"
    );
    let refused = invoke(&other, "close_meter", json!({ "id": first })).unwrap_err();
    assert_eq!(name(&refused), "NotRecording", "{refused}");
    assert_eq!(
        invoke(&main, "close_meter", json!({ "id": first })).unwrap(),
        Value::Null
    );
    assert_eq!(recorders.lock().open_meters(), 0);
    assert!(!recorders.lock().is_capturing());

    recorders
        .lock()
        .add_meter("m2", page, "main", crate::meter::Meter::stand_in())
        .unwrap();
    crate::page_ended(fixture.app.handle(), "other");
    assert_eq!(recorders.lock().open_meters(), 1);
    crate::page_ended(fixture.app.handle(), "main");
    assert_eq!(recorders.lock().open_meters(), 0);

    // A meter that finished opening after its page left is closed, not kept.
    let refused = recorders
        .lock()
        .add_meter("m3", page, "main", crate::meter::Meter::stand_in())
        .unwrap_err();
    assert!(
        matches!(refused, crate::RecorderError::NotRecording { .. }),
        "{refused:?}"
    );
    // So is one whose microphone stopped before it could be kept.
    let page = recorders.lock().page("main");
    let refused = recorders
        .lock()
        .add_meter("m4", page, "main", crate::meter::Meter::stand_in_gone())
        .unwrap_err();
    assert!(
        matches!(refused, crate::RecorderError::Failed { .. }),
        "{refused:?}"
    );
    assert_eq!(recorders.lock().open_meters(), 0);
    assert!(!recorders.lock().is_capturing());
}

#[test]
fn a_meter_that_stopped_on_its_own_is_dropped_and_no_longer_counts_as_open() {
    let fixture = fixture();
    let recorders = fixture.app.state::<Recorders<MockRuntime>>();
    let page = recorders.lock().page("main");
    recorders
        .lock()
        .add_meter("m1", page, "main", crate::meter::Meter::stand_in())
        .unwrap();
    assert!(recorders.lock().remove_meter("m1"));
    assert!(!recorders.lock().remove_meter("m1"));
    assert!(!recorders.lock().is_capturing());
}

#[test]
fn without_microphone_access_no_meter_or_recording_resolves_a_device() {
    let fixture = fixture_with_access(|| {
        Err(crate::RecorderError::PermissionDenied {
            message: "denied".to_string(),
        })
    });
    let main = window(&fixture.app, "main");
    // An id that is not connected would be `InputUnavailable` if the device
    // were resolved; the denial comes first.
    let refused = invoke(
        &main,
        "open_meter",
        json!({ "device": "not an id", "levels": "__CHANNEL__:1" }),
    )
    .unwrap_err();
    assert_eq!(name(&refused), "PermissionDenied", "{refused}");
    let refused = invoke(
        &main,
        "start",
        json!({ "path": "recordings/a", "device": "not an id", "signals": "__CHANNEL__:1" }),
    )
    .unwrap_err();
    assert_eq!(name(&refused), "PermissionDenied", "{refused}");
    assert!(!fixture.root.join("recordings/a.wav").exists());
    // Listing asks for nothing.
    assert!(invoke(&main, "inputs", json!({})).is_ok());
}

#[test]
fn permission_granted_after_page_departure_resolves_no_device() {
    use std::sync::{mpsc, Mutex};
    use std::time::Duration;

    // The existing permission seam is a function pointer. Keep this gate local
    // to this test, and take it before waiting so departure holds no test lock.
    static PERMISSION: Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>> = Mutex::new(None);

    for command in ["open_meter", "start"] {
        let (asking, asked) = mpsc::channel();
        let (grant, granted) = mpsc::channel();
        *PERMISSION.lock().unwrap() = Some((asking, granted));
        let fixture = fixture_with_access(|| {
            let (asking, granted) = PERMISSION.lock().unwrap().take().unwrap();
            asking.send(()).unwrap();
            granted.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(())
        });
        let main = window(&fixture.app, "main");
        let args = match command {
            "open_meter" => json!({ "device": "not an id", "levels": "__CHANNEL__:1" }),
            _ => {
                json!({ "path": "recordings/a", "device": "not an id", "signals": "__CHANNEL__:1" })
            }
        };
        let calling = std::thread::spawn(move || invoke(&main, command, args));

        asked.recv_timeout(Duration::from_secs(5)).unwrap();
        crate::page_ended(fixture.app.handle(), "main");
        grant.send(()).unwrap();

        let refused = calling.join().unwrap().unwrap_err();
        // Resolving the deliberately invalid id would answer InputUnavailable.
        // Page ownership must be checked first, without attempting a microphone.
        assert_eq!(name(&refused), "NotRecording", "{command}: {refused}");
        assert!(!fixture
            .app
            .state::<Recorders<MockRuntime>>()
            .lock()
            .is_capturing());
        assert!(!fixture.root.join("recordings/a.wav").exists());
    }
}

#[test]
fn shutdown_closes_meters_and_refuses_a_meter_opened_before_shutdown() {
    let fixture = fixture();
    let recorders = fixture.app.state::<Recorders<MockRuntime>>();
    let mut recorder = recorders.lock();
    let page = recorder.page("main");
    recorder
        .add_meter("held", page, "main", crate::meter::Meter::stand_in())
        .unwrap();
    let arriving = crate::meter::Meter::stand_in();

    recorder.shutdown();
    recorder.shutdown();
    assert!(!recorder.is_capturing());
    let refused = recorder
        .add_meter("arriving", page, "main", arriving)
        .unwrap_err();
    assert!(matches!(refused, crate::RecorderError::NotRecording { .. }));
    assert_eq!(recorder.open_meters(), 0);
}

#[test]
fn permission_granted_after_exit_finalization_resolves_no_device() {
    use std::sync::{mpsc, Mutex};
    use std::time::Duration;

    static PERMISSION: Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>> = Mutex::new(None);
    let mut refusals = Vec::new();
    for command in ["open_meter", "start"] {
        let (asking, asked) = mpsc::channel();
        let (grant, granted) = mpsc::channel();
        *PERMISSION.lock().unwrap() = Some((asking, granted));
        let fixture = fixture_with_access(|| {
            let (asking, granted) = PERMISSION.lock().unwrap().take().unwrap();
            asking.send(()).unwrap();
            granted.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(())
        });
        let main = window(&fixture.app, "main");
        let args = match command {
            "open_meter" => json!({ "device": "not an id", "levels": "__CHANNEL__:1" }),
            _ => {
                json!({ "path": "recordings/a", "device": "not an id", "signals": "__CHANNEL__:1" })
            }
        };
        let calling = std::thread::spawn(move || invoke(&main, command, args));

        asked.recv_timeout(Duration::from_secs(5)).unwrap();
        // The exact recorder operation dispatched by the plugin's RunEvent::Exit.
        fixture
            .app
            .state::<Recorders<MockRuntime>>()
            .lock()
            .shutdown();
        grant.send(()).unwrap();

        let refused = calling.join().unwrap().unwrap_err();
        eprintln!("{command} after exit finalization: {refused}");
        refusals.push(name(&refused).to_owned());
        assert!(!fixture.root.join("recordings/a.wav").exists());
    }
    assert_eq!(
        refusals,
        vec!["NotRecording", "NotRecording"],
        "exit finalization must reject deferred capture before device resolution"
    );
}

#[test]
fn start_and_recover_reach_only_the_folder_bound_to_the_calling_window() {
    let fixture = fixture();
    let main = window(&fixture.app, "main");
    let other = window(&fixture.app, "other");

    // A window the shell bound no folder to records and repairs nothing,
    // whatever the page passes.
    let elsewhere = fixture.root.to_str().unwrap();
    for args in [
        json!({ "path": "recordings/a", "device": null, "signals": "__CHANNEL__:1" }),
        json!({ "scope": "notes", "root": elsewhere, "path": "recordings/a", "device": null, "signals": "__CHANNEL__:1" }),
    ] {
        let refused = invoke(&other, "start", args).unwrap_err();
        assert_eq!(name(&refused), "Refused", "{refused}");
        assert!(
            refused["message"].as_str().unwrap().contains("NotBound"),
            "{refused}"
        );
    }
    let refused = invoke(&other, "recover", json!({ "under": "recordings" })).unwrap_err();
    assert_eq!(name(&refused), "Refused", "{refused}");

    // Folder shutdown also refuses recorder calls from a previously bound page.
    assert_eq!(
        invoke(&main, "recover", json!({ "under": "recordings" })).unwrap(),
        json!([])
    );
    fixture.app.folders().shutdown();
    let refused = start(&main, "recordings/a").unwrap_err();
    assert_eq!(name(&refused), "Refused", "{refused}");
    let refused = invoke(&main, "recover", json!({ "under": "recordings" })).unwrap_err();
    assert_eq!(name(&refused), "Refused", "{refused}");
    assert!(!fixture.root.join("recordings").exists());
}

#[test]
fn start_refuses_a_path_the_path_rule_refuses_before_opening_anything() {
    let fixture = fixture();
    let main = window(&fixture.app, "main");
    for path in [
        ".git/hooks/post-commit",
        "../outside",
        "/absolute",
        "recordings/HEAD/a",
        "recordings//a",
        "recordings/a:b",
        "",
    ] {
        let refused = start(&main, path).unwrap_err();
        assert_eq!(name(&refused), "Refused", "{path:?}: {refused}");
    }
    assert!(!fixture.root.join("recordings").exists());
    assert!(!fixture.root.join(".git/hooks").exists());
}

#[test]
fn start_never_records_over_a_file_already_there() {
    let fixture = fixture();
    let main = window(&fixture.app, "main");
    std::fs::create_dir_all(fixture.root.join("recordings")).unwrap();
    std::fs::write(fixture.root.join("recordings/a.wav"), b"kept").unwrap();
    let refused = start(&main, "recordings/a").unwrap_err();
    assert_eq!(name(&refused), "Refused", "{refused}");
    assert_eq!(
        std::fs::read(fixture.root.join("recordings/a.wav")).unwrap(),
        b"kept"
    );
}

#[cfg(unix)]
#[test]
fn start_never_records_through_a_link() {
    let fixture = fixture();
    let main = window(&fixture.app, "main");
    let outside = fixture.root.parent().unwrap().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, fixture.root.join("recordings")).unwrap();
    let refused = start(&main, "recordings/a").unwrap_err();
    assert_eq!(name(&refused), "Refused", "{refused}");
    assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
}

#[test]
fn stop_reaches_only_a_recording_this_window_started() {
    let fixture = fixture();
    let main = window(&fixture.app, "main");
    let other = window(&fixture.app, "other");
    let refused = invoke(&main, "stop", json!({ "id": "1" })).unwrap_err();
    assert_eq!(name(&refused), "NotRecording", "{refused}");

    std::fs::create_dir_all(fixture.root.join("recordings")).unwrap();
    let path = fixture.root.join("recordings/a.wav");
    crate::recorder::tests::hold_recording(
        &mut fixture.app.state::<Recorders<MockRuntime>>().lock(),
        &path,
        "recordings/a.wav",
        "7",
        "main",
    );
    let refused = invoke(&other, "stop", json!({ "id": "7" })).unwrap_err();
    assert_eq!(name(&refused), "NotRecording", "{refused}");
    let stopped = invoke(&main, "stop", json!({ "id": "7" })).unwrap();
    assert_eq!(
        stopped,
        json!({ "path": "recordings/a.wav", "durationMs": 1000 })
    );
    assert_eq!(
        hound::WavReader::open(&path).unwrap().duration(),
        crate::recorder::RECORDING_RATE
    );
}

/// What the plugin does when a window is destroyed: its page can no longer
/// stop the recording, so it is finalized for it and the slot is free.
#[test]
fn a_destroyed_window_finalizes_its_recording() {
    let fixture = fixture();
    let path = fixture.root.join("a.wav");
    crate::recorder::tests::hold_recording(
        &mut fixture.app.state::<Recorders<MockRuntime>>().lock(),
        &path,
        "a.wav",
        "7",
        "main",
    );
    assert!(crate::is_recording(fixture.app.handle()));
    crate::page_ended(fixture.app.handle(), "other");
    assert!(fixture
        .app
        .state::<Recorders<MockRuntime>>()
        .lock()
        .held_path()
        .is_some());
    // Another window going leaves this one recording.
    assert!(crate::is_recording(fixture.app.handle()));

    crate::page_ended(fixture.app.handle(), "main");
    assert!(!crate::is_recording(fixture.app.handle()));
    assert!(fixture
        .app
        .state::<Recorders<MockRuntime>>()
        .lock()
        .held_path()
        .is_none());
    assert_eq!(
        hound::WavReader::open(&path).unwrap().duration(),
        crate::recorder::RECORDING_RATE
    );
}

#[test]
fn recover_repairs_cut_off_recordings_in_the_bound_folder() {
    let fixture = fixture();
    let main = window(&fixture.app, "main");
    assert_eq!(
        invoke(&main, "recover", json!({ "under": "recordings" })).unwrap(),
        json!([]),
        "a folder without recordings has nothing to repair"
    );

    std::fs::create_dir_all(fixture.root.join("recordings")).unwrap();
    let path = fixture.root.join("recordings/a.wav");
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 16_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    hound::WavWriter::create(&path, spec)
        .unwrap()
        .finalize()
        .unwrap();
    {
        use std::io::Write;
        let mut file = std::fs::File::options().append(true).open(&path).unwrap();
        file.write_all(&[1u8; 3_200]).unwrap();
    }
    assert_eq!(
        invoke(&main, "recover", json!({ "under": "recordings" })).unwrap(),
        json!(["recordings/a.wav"])
    );
    assert_eq!(hound::WavReader::open(&path).unwrap().duration(), 1_600);
    assert_eq!(
        invoke(&main, "recover", json!({ "under": "recordings" })).unwrap(),
        json!([])
    );
    let refused = invoke(&main, "recover", json!({ "under": ".git" })).unwrap_err();
    assert_eq!(name(&refused), "Refused", "{refused}");
}

#[test]
fn a_window_without_the_permission_cannot_call_the_plugin() {
    let app = mock_builder()
        .plugin(tauri_plugin_epicenter_folder::init())
        .plugin(init())
        .build(mock_context(noop_assets()))
        .unwrap();
    let main = window(&app, "main");
    for command in COMMANDS {
        let refused = invoke(&main, command, json!({})).unwrap_err();
        let text = refused
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| refused.to_string());
        assert!(text.contains("not allowed"), "{command}: {refused}");
    }
}
