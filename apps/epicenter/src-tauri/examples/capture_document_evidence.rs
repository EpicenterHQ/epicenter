//! Explicit native acceptance probe. Opens the physical default microphone in
//! a real hidden WebView, reloads during capture, then saves under a fresh
//! document. Uses temporary storage and does not start the application sidecar.
//! Run with: cargo run --example capture_document_evidence
use epicenter_lib::app_data::DesktopPaths;
use epicenter_lib::blobs::BlobDestination;
use epicenter_lib::recorder::commands::*;
use epicenter_lib::recorder::recorder::Recorder;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
fn evidence_boot(phase: State<'_, AtomicUsize>) -> usize {
    phase.fetch_add(1, Ordering::SeqCst)
}

#[tauri::command]
fn evidence_mode() -> String {
    std::env::var("EPICENTER_CAPTURE_EVIDENCE_MODE").unwrap_or_default()
}

#[tauri::command]
fn evidence_ready(app: tauri::AppHandle) {
    assert!(app
        .state::<Mutex<Recorder>>()
        .lock()
        .unwrap()
        .is_capturing());
    eprintln!("NATIVE_WEBVIEW_READY_FOR_INTERRUPTION physical_capture_active=true");
}

#[tauri::command]
fn evidence_done(app: tauri::AppHandle, error: Option<String>, blob_id: Option<String>) {
    if let Some(error) = error {
        eprintln!("NATIVE_WEBVIEW_FAILURE {error}");
        app.exit(1);
        return;
    }
    let destination = BlobDestination {
        app_id: "com.epicenter.captureevidence".into(),
    };
    let bytes =
        epicenter_lib::blobs::read_blob_bytes(&app, &blob_id.expect("saved blob id"), &destination)
            .unwrap();
    let samples = epicenter_lib::audio::decode_to_pcm16k_mono(&bytes).unwrap();
    assert!(!samples.is_empty());
    let recorder = app.state::<Mutex<Recorder>>();
    let recorder = recorder.lock().unwrap();
    assert!(!recorder.is_capturing());
    assert!(recorder
        .require_session("app-capture-evidence", "old-document")
        .is_err());
    assert!(recorder
        .require_session("app-capture-evidence", "new-document")
        .is_err());
    eprintln!("NATIVE_WEBVIEW_PASS mode={} microphone_reopened=true saved_after_close_bytes={} decoded_samples={}", evidence_mode(), bytes.len(), samples.len());
    app.exit(0);
}

const SCRIPT: &str = r#"
(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  try {
    const phase = await invoke('evidence_boot');
    const mode = await invoke('evidence_mode');
    if (mode === 'recover') {
      await invoke('register_recording_session', { appId: 'com.epicenter.captureevidence', sessionId: 'new-document' });
      const live = await invoke('start_recording', { appId: 'com.epicenter.captureevidence', sessionId: 'new-document', requestId: 'restart-start', deviceIdentifier: null });
      await delay(1100);
      const stopped = await invoke('stop_recording', { appId: 'com.epicenter.captureevidence', sessionId: 'new-document', audioBlobId: live.audioBlobId });
      if (stopped.byteLength <= 44) throw new Error('restarted physical input delivered no samples');
      await invoke('close_recording_session', { appId: 'com.epicenter.captureevidence', sessionId: 'new-document' });
      await invoke('evidence_done', { error: null, blobId: stopped.blobId });
      return;
    }
    if (phase === 0) {
      await invoke('register_recording_session', { appId: 'com.epicenter.captureevidence', sessionId: 'old-document' });
      const live = await invoke('start_recording', { appId: 'com.epicenter.captureevidence', sessionId: 'old-document', requestId: 'old-start', deviceIdentifier: null });
      sessionStorage.setItem('oldCaptureId', live.audioBlobId);
      await delay(300);
      location.reload();
      return;
    }
    if (phase !== 1) throw new Error('unexpected document reload count');
    await invoke('register_recording_session', { appId: 'com.epicenter.captureevidence', sessionId: 'new-document' });
    let refused = false;
    try { await invoke('stop_recording', { appId: 'com.epicenter.captureevidence', sessionId: 'old-document', audioBlobId: sessionStorage.getItem('oldCaptureId') }); }
    catch (error) { refused = error.name === 'NotRecording'; }
    if (!refused) throw new Error('old document stop was not fenced');
    const live = await invoke('start_recording', { appId: 'com.epicenter.captureevidence', sessionId: 'new-document', requestId: 'new-start', deviceIdentifier: null });
    await invoke('close_recording_session', { appId: 'com.epicenter.captureevidence', sessionId: 'old-document' });
    await delay(1100);
    const stopped = await invoke('stop_recording', { appId: 'com.epicenter.captureevidence', sessionId: 'new-document', audioBlobId: live.audioBlobId });
    const retry = await invoke('stop_recording', { sessionId: 'new-document', audioBlobId: live.audioBlobId });
    if (stopped.blobId !== retry.blobId || stopped.byteLength !== retry.byteLength) throw new Error('stop retry changed saved output');
    await invoke('close_recording_session', { appId: 'com.epicenter.captureevidence', sessionId: 'new-document' });
    if (mode === 'interrupt') {
      await invoke('register_recording_session', { appId: 'com.epicenter.captureevidence', sessionId: 'interrupted-document' });
      await invoke('start_recording', { appId: 'com.epicenter.captureevidence', sessionId: 'interrupted-document', requestId: 'interrupted-start', deviceIdentifier: null });
      await delay(300);
      await invoke('evidence_ready');
      return;
    }
    await invoke('evidence_done', { error: null, blobId: stopped.blobId });
  } catch (error) {
    await invoke('evidence_done', { error: JSON.stringify(error, Object.getOwnPropertyNames(error)) });
  }
})();
"#;

fn main() {
    let root = tempfile::tempdir().unwrap();
    let evidence_root = std::env::var_os("EPICENTER_CAPTURE_EVIDENCE_ROOT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| root.path().into());
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    let embedded: tauri::Context = tauri::generate_context!();
    context.assets = embedded.assets;
    let app = tauri::Builder::default()
        .manage(DesktopPaths {
            data_dir: evidence_root.join("data"),
            folder_dir: evidence_root.join("folder"),
        })
        .manage(Mutex::new(Recorder::new()))
        .manage(AtomicUsize::new(0))
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                cancel_recording_owned_by(webview.app_handle(), webview.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            evidence_boot,
            evidence_mode,
            evidence_ready,
            evidence_done,
            register_recording_session,
            close_recording_session,
            start_recording,
            stop_recording,
            cancel_recording,
        ])
        .setup(|app| {
            WebviewWindowBuilder::new(
                app,
                "app-capture-evidence",
                WebviewUrl::App("index.html".into()),
            )
            .title("Epicenter native capture evidence")
            .visible(false)
            .initialization_script(SCRIPT)
            .build()?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(20));
                eprintln!("NATIVE_WEBVIEW_TIMEOUT");
                handle.exit(2);
            });
            Ok(())
        })
        .build(context)
        .unwrap();
    let code = app.run_return(|_, _| {});
    drop(root);
    std::process::exit(code);
}
