//! The plugin through Tauri's real invoke path, on the mock runtime, beside
//! the file system plugin whose scope says which folders it may write.
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
//! - `start` records only for a folder the file system scope allows, with an
//!   id that is one plain name, whose audio does not exist yet, and records
//!   at its audio's path.
//! - `stop` reaches only a recording the window started; no command deletes
//!   one. It answers once the take is finished at its path.
//! - A destroyed window's recording is finished in place, never deleted.
//! - A window without the plugin's permission cannot call it.

use std::cell::RefCell;
use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
use tauri::utils::acl::ExecutionContext;
use tauri::webview::InvokeRequest;
use tauri::{App, Manager, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_fs::FsExt;

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
        "apps/whispering/packages/recorder/src/native/bindings.gen.ts is stale; run `RECORDER_WRITE_BINDINGS=1 cargo test bindings` in apps/whispering/packages/tauri-plugin-epicenter-recorder"
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
    /// The folder the scope allows.
    root: PathBuf,
    /// Where the recorder records its takes: `recordings/` in the folder.
    takes: PathBuf,
    _directory: tempfile::TempDir,
}

/// The mock context, allowing every command of the recorder.
fn context() -> tauri::Context<MockRuntime> {
    let mut context = mock_context(noop_assets());
    for command in COMMANDS {
        context.runtime_authority_mut().__allow_command(
            format!("plugin:epicenter-recorder|{command}"),
            ExecutionContext::Local,
        );
    }
    context
}

thread_local! {
    /// The folder this test's fixture allows, which `invoke` names as `dir`
    /// for `start` when a test names none.
    static FOLDER: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

/// An app with the file system plugin and the recorder, its scope allowing
/// the folder `notes`, as the shell allows its default folder.
fn fixture() -> Fixture {
    fixture_with_access(|| Ok(()))
}

/// The fixture, with microphone access answered by `access`.
fn fixture_with_access(access: fn() -> crate::recorder::Result<()>) -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let real = std::fs::canonicalize(directory.path()).unwrap();
    let root = real.join("notes");
    let takes = root.join("recordings");
    let app = mock_builder()
        .plugin(tauri_plugin_fs::init())
        .plugin(Builder::new().access(access).build())
        .build(context())
        .expect("mock app");
    std::fs::create_dir_all(&root).unwrap();
    app.fs_scope().allow_directory(&root, true).unwrap();
    FOLDER.with(|folder| *folder.borrow_mut() = Some(root.clone()));
    Fixture {
        app,
        root,
        takes,
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

fn invoke(
    window: &WebviewWindow<MockRuntime>,
    command: &str,
    mut args: Value,
) -> Result<Value, Value> {
    if command == "start" && args.get("folder").is_none() {
        if let Some(folder) = FOLDER.with(|folder| folder.borrow().clone()) {
            args["folder"] = json!(folder);
        }
    }
    call(window, "epicenter-recorder", command, args)
}

/// `start` the take `id` for the fixture's folder, from the system default
/// microphone.
fn start(window: &WebviewWindow<MockRuntime>, id: &str) -> Result<Value, Value> {
    invoke(
        window,
        "start",
        json!({ "id": id, "device": null, "signals": "__CHANNEL__:1" }),
    )
}

/// Whether the fixture's recorder holds a recording that is still capturing.
fn recording(fixture: &Fixture) -> bool {
    fixture.app.state::<Recorders>().lock().is_recording()
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
            json!({ "id": "a", "device": device, "signals": "__CHANNEL__:1" }),
        )
        .unwrap_err();
        assert_eq!(name(&refused), "InputUnavailable", "{device}: {refused}");
    }
    assert_eq!(fixture.app.state::<Recorders>().lock().open_meters(), 0);
    assert!(takes_in(&fixture.takes).is_empty());
}

#[test]
fn a_meter_is_closed_by_its_window_or_with_its_page() {
    let fixture = fixture();
    let main = window(&fixture.app, "main");
    let other = window(&fixture.app, "other");
    let recorders = fixture.app.state::<Recorders>();
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
        !recorders.lock().is_recording(),
        "an open meter is not a recording"
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
    let recorders = fixture.app.state::<Recorders>();
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
        json!({ "id": "a", "device": "not an id", "signals": "__CHANNEL__:1" }),
    )
    .unwrap_err();
    assert_eq!(name(&refused), "PermissionDenied", "{refused}");
    assert!(takes_in(&fixture.takes).is_empty());
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
                json!({ "folder": fixture.root, "id": "a", "device": "not an id", "signals": "__CHANNEL__:1" })
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
        assert!(!fixture.app.state::<Recorders>().lock().is_capturing());
        assert!(takes_in(&fixture.takes).is_empty());
    }
}

#[test]
fn shutdown_closes_meters_and_refuses_a_meter_opened_before_shutdown() {
    let fixture = fixture();
    let recorders = fixture.app.state::<Recorders>();
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
                json!({ "folder": fixture.root, "id": "a", "device": "not an id", "signals": "__CHANNEL__:1" })
            }
        };
        let calling = std::thread::spawn(move || invoke(&main, command, args));

        asked.recv_timeout(Duration::from_secs(5)).unwrap();
        // The exact recorder operation dispatched by the plugin's RunEvent::Exit.
        fixture.app.state::<Recorders>().lock().shutdown();
        grant.send(()).unwrap();

        let refused = calling.join().unwrap().unwrap_err();
        eprintln!("{command} after exit finalization: {refused}");
        refusals.push(name(&refused).to_owned());
        assert!(takes_in(&fixture.takes).is_empty());
    }
    assert_eq!(
        refusals,
        vec!["NotRecording", "NotRecording"],
        "exit finalization must reject deferred capture before device resolution"
    );
}

#[test]
fn start_refuses_a_folder_the_scope_does_not_allow() {
    let fixture = fixture();
    let main = window(&fixture.app, "main");
    let outside = fixture.root.with_file_name("elsewhere");
    std::fs::create_dir_all(&outside).unwrap();
    for folder in [json!(outside), json!("relative/notes")] {
        let refused = invoke(
            &main,
            "start",
            json!({ "folder": folder, "id": "a", "device": null, "signals": "__CHANNEL__:1" }),
        )
        .unwrap_err();
        assert_eq!(name(&refused), "Refused", "{refused}");
    }
    assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
}

#[test]
fn start_refuses_an_id_that_is_not_one_plain_name_before_opening_anything() {
    let fixture = fixture();
    let main = window(&fixture.app, "main");
    for id in [
        "../outside",
        "/absolute",
        "recordings/a",
        "a.webm",
        ".a",
        "a b",
        "",
    ] {
        let refused = start(&main, id).unwrap_err();
        assert_eq!(name(&refused), "Refused", "{id:?}: {refused}");
    }
    assert!(!fixture.root.join("recordings").exists());
    assert!(takes_in(&fixture.takes).is_empty());
}

#[test]
fn start_never_records_an_id_whose_audio_exists() {
    let fixture = fixture();
    let main = window(&fixture.app, "main");
    std::fs::create_dir_all(fixture.root.join("recordings")).unwrap();
    std::fs::write(fixture.root.join("recordings/a.webm"), b"kept").unwrap();
    let refused = start(&main, "a").unwrap_err();
    assert_eq!(name(&refused), "Refused", "{refused}");
    assert_eq!(
        std::fs::read(fixture.root.join("recordings/a.webm")).unwrap(),
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
    let refused = start(&main, "a").unwrap_err();
    assert_eq!(name(&refused), "Refused", "{refused}");
    assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
}

#[test]
fn stop_reaches_only_a_recording_this_window_started() {
    let fixture = fixture();
    let main = window(&fixture.app, "main");
    let other = window(&fixture.app, "other");
    let refused = invoke(&main, "stop", json!({})).unwrap_err();
    assert_eq!(name(&refused), "NotRecording", "{refused}");

    let path = fixture.takes.join("a.webm");
    std::fs::create_dir_all(&fixture.takes).unwrap();
    crate::recorder::tests::hold_recording(&mut recorders(&fixture), &path, "a", "7", "main");
    assert!(path.exists(), "a recording is at its path while it records");
    let refused = invoke(&other, "stop", json!({})).unwrap_err();
    assert_eq!(name(&refused), "NotRecording", "{refused}");
    let stopped = invoke(&main, "stop", json!({})).unwrap();
    assert_eq!(stopped, json!({ "id": "a", "durationMs": 1000 }));
    // Finished at its path when Stop answers.
    assert_eq!(
        decoded_samples(&path),
        crate::recorder::RECORDING_RATE as usize
    );
    assert_eq!(takes_in(&fixture.takes), ["a.webm"], "nothing beside it");
    assert!(
        !recording(&fixture),
        "the recorder is free for the next start"
    );
}

/// How many 16 kHz samples the audio file at `path` decodes to, through the
/// decoder transcription reads a recording with.
fn decoded_samples(path: &std::path::Path) -> usize {
    tauri_plugin_epicenter_transcription::audio::decode_to_pcm16k_mono(
        &std::fs::read(path).unwrap(),
    )
    .unwrap()
    .len()
}

/// The files in the takes directory.
fn takes_in(takes: &std::path::Path) -> Vec<String> {
    std::fs::read_dir(takes)
        .map(|entries| {
            entries
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

fn recorders(fixture: &Fixture) -> std::sync::MutexGuard<'_, crate::recorder::Recorder> {
    fixture.app.state::<Recorders>().inner().lock()
}

/// What the plugin does when a window is destroyed: its page can no longer
/// stop the recording, so it is finished in place for it and the slot is
/// free.
#[test]
fn a_destroyed_window_finalizes_its_recording() {
    let fixture = fixture();
    let path = fixture.takes.join("a.webm");
    std::fs::create_dir_all(&fixture.takes).unwrap();
    crate::recorder::tests::hold_recording(&mut recorders(&fixture), &path, "a", "7", "main");
    assert!(recording(&fixture));
    crate::page_ended(fixture.app.handle(), "other");
    // Another window going leaves this one recording.
    assert!(recording(&fixture));

    crate::page_ended(fixture.app.handle(), "main");
    assert!(!recording(&fixture));
    assert_eq!(
        decoded_samples(&path),
        crate::recorder::RECORDING_RATE as usize
    );
}

#[test]
fn a_window_without_the_permission_cannot_call_the_plugin() {
    let app = mock_builder()
        .plugin(tauri_plugin_fs::init())
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
