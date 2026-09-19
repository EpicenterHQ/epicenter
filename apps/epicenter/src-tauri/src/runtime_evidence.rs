//! Explicit, isolated acceptance executable. Uses the production Bun launch,
//! native admitted-window creation and shutdown paths; never reads a real account.
use super::*;
use std::sync::atomic::AtomicUsize;

const APP_ID: &str = "so.epicenter.runtimeevidence";
struct Evidence {
    root: PathBuf,
    cycle: usize,
    document: AtomicUsize,
}

fn record(app: &DesktopAppHandle, value: serde_json::Value) {
    let root = &app.state::<Evidence>().root;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("events.jsonl"))
        .unwrap();
    file.write_all(format!("{value}\n").as_bytes()).unwrap();
    file.sync_all().unwrap();
    if value["event"] != "page-load" {
        eprintln!("RUNTIME_EVIDENCE {value}");
    }
}

#[tauri::command]
fn evidence_boot(app: DesktopAppHandle) -> serde_json::Value {
    let state = app.state::<Evidence>();
    let document = state.document.fetch_add(1, Ordering::SeqCst);
    record(
        &app,
        serde_json::json!({"event":"document", "cycle":state.cycle,"document":document}),
    );
    serde_json::json!({"cycle":state.cycle,"document":document})
}

#[tauri::command]
fn evidence_result(app: DesktopAppHandle, error: Option<String>) {
    if let Some(error) = error {
        record(&app, serde_json::json!({"event":"failure","error":error}));
        app.exit(1);
        return;
    }
    thread::spawn(move || {
        let evidence = app.state::<Evidence>();
        let cycle = evidence.cycle;
        if evidence.document.load(Ordering::SeqCst) == 1 && cycle < 20 {
            let window = app.get_webview_window(&app_window_label(APP_ID)).unwrap();
            let (send, receive) = mpsc::channel();
            window.on_window_event(move |event| {
                if matches!(event, WindowEvent::Destroyed) {
                    let _ = send.send(());
                }
            });
            window.destroy().unwrap();
            receive.recv_timeout(Duration::from_secs(10)).unwrap();
            let state = app.state::<HostState>();
            let token = state.active_token.lock().unwrap().clone().unwrap();
            launch_on_main_thread(
                &app,
                Application::Admitted(APP_ID.into()),
                state.port().unwrap(),
                &token,
            )
            .unwrap();
            return;
        }
        record(
            &app,
            serde_json::json!({"event":"committed-survived","cycle":cycle}),
        );
        if cycle == 20 {
            record(
                &app,
                serde_json::json!({"event":"passed","restarts":20,"immediateReopens":20}),
            );
            app.exit(0);
            return;
        }
        fs::write(evidence.root.join("cycle"), (cycle + 1).to_string()).unwrap();
        // Production relaunch arrives on the sidecar reader thread. Tauri only
        // guarantees Exit delivery for restart() off the main thread.
        handle_native_frame(&app, 1, BunToRustNativeFrame::Relaunch {}).unwrap();
    });
}

pub fn run() {
    let root = PathBuf::from(
        std::env::var_os("EPICENTER_RUNTIME_EVIDENCE_ROOT").expect("isolated evidence root"),
    );
    assert!(root.is_absolute());
    if std::env::var_os("EPICENTER_RUNTIME_EVIDENCE_CLEANUP").is_some() {
        #[cfg(target_os = "macos")]
        {
            let bytes: [u8; 16] = fs::read(root.join("website-store"))
                .unwrap()
                .try_into()
                .unwrap();
            tauri::Builder::default()
                .setup(move |app| {
                    WebviewWindowBuilder::new(
                        app,
                        "cleanup",
                        WebviewUrl::External("about:blank".parse().unwrap()),
                    )
                    .visible(false)
                    .build()?;
                    let app = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        let result = app.remove_data_store(bytes).await;
                        if let Err(error) = &result {
                            eprintln!("Failed to remove isolated WebKit profile: {error}");
                        }
                        app.exit(if result.is_ok() { 0 } else { 1 });
                    });
                    Ok(())
                })
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .unwrap()
                .run(|_, _| {});
        }
        return;
    }
    let cycle: usize = fs::read_to_string(root.join("cycle"))
        .unwrap_or_else(|_| "0".into())
        .parse()
        .unwrap();
    let identifier = fs::read_to_string(root.join("identifier")).unwrap();
    assert!(identifier.starts_with("so.epicenter.evidence."));
    let port: u16 = fs::read_to_string(root.join("port"))
        .unwrap()
        .parse()
        .unwrap();
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = identifier;
    for command in ["evidence_boot", "evidence_result"] {
        context.runtime_authority_mut().__allow_command(
            command.into(),
            tauri::utils::acl::ExecutionContext::Remote {
                url: format!("http://127.0.0.1:{port}/*").parse().unwrap(),
            },
        );
    }
    let app = tauri::Builder::default()
        .on_page_load(|webview, payload| {
            record(webview.app_handle(), serde_json::json!({"event":"page-load","url":payload.url().to_string(),"phase":format!("{:?}",payload.event())}));

        })
        .manage(HostState::new(Ok(port)))
        .manage(Mutex::new(Recorder::new()))
        .manage(Evidence { root: root.clone(), cycle, document: AtomicUsize::new(0) })
        .manage(app_data::DesktopPaths { data_dir: root.join("data"), folder_dir: root.join("folder") })
        .invoke_handler(tauri::generate_handler![evidence_boot, evidence_result])
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "evidence-anchor", WebviewUrl::External("about:blank".parse().unwrap())).visible(false).build()?;
            let app = app.handle().clone();
            record(&app, serde_json::json!({"event":"host","cycle":cycle,"pid":std::process::id()}));
            thread::spawn(move || {
                let result = (|| -> Result<()> {
                    let LaunchedHost { child, mut stdin, stdout, token } = launch_host(&app, port)?;
                    let pid = child.id();
                    let (sender, receiver) = mpsc::sync_channel::<String>(64);
                    let writer = thread::spawn(move || { for line in receiver { if writeln!(stdin,"{line}").and_then(|_| stdin.flush()).is_err() { break; } } });
                    let sqlite = sqlite::Worker::new(app.state::<app_data::DesktopPaths>().data_dir.clone(), 1, sender.clone(), Arc::new(AtomicBool::new(false)));
                    let state = app.state::<HostState>();
                    *state.process.lock().unwrap() = Some(ManagedChild { generation:1, child, stdin:Some(sender), sqlite, writer:Some(writer) });
                    state.activate(&token);
                    for frame in [
                        BunToRustNativeFrame::StoreAuth { request_id: "stale".into(), serialized: None },
                        BunToRustNativeFrame::Relaunch {},
                    ] {
                        assert!(handle_native_frame(&app, 0, frame).unwrap_err().to_string().contains("retired Bun generation"));
                    }
                    record(&app, serde_json::json!({"event":"retired-frames-fenced","cycle":cycle}));
                    record(&app, serde_json::json!({"event":"sidecar","cycle":cycle,"pid":pid}));
                    monitor_host(app.clone(),1,stdout);
                    launch_on_main_thread(&app, Application::Admitted(APP_ID.into()),port,&token)?;
                    Ok(())
                })();
                if let Err(error) = result { record(&app, serde_json::json!({"event":"failure","error":format!("{error:#}")}));app.exit(1); }
            });
            Ok(())
        }).build(context).unwrap();
    let handle = app.handle().clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(30));
        record(
            &handle,
            serde_json::json!({"event":"failure","error":"native evidence timed out"}),
        );
        handle.exit(2);
    });
    app.run(|app,event| {
        if matches!(event,RunEvent::Exit) {
            let pid = app.state::<HostState>().process.lock().unwrap().as_ref().map(|process|process.child.id());
            shutdown_host(app);
            for frame in [
                BunToRustNativeFrame::StoreAuth { request_id: "stopped".into(), serialized: None },
                BunToRustNativeFrame::Relaunch {},
            ] {
                assert!(handle_native_frame(app, 1, frame).unwrap_err().to_string().contains("shutdown began"));
            }
            if let Some(pid) = pid { assert_eq!(unsafe { libc::kill(pid as i32,0) },-1); }
            record(app,serde_json::json!({"event":"shutdown","sidecarDead":true,"cycle":app.state::<Evidence>().cycle}));
        }
    });
}

pub(super) fn isolate_webview<'a>(
    builder: WebviewWindowBuilder<'a, Wry, DesktopAppHandle>,
) -> WebviewWindowBuilder<'a, Wry, DesktopAppHandle> {
    let root = PathBuf::from(std::env::var_os("EPICENTER_RUNTIME_EVIDENCE_ROOT").unwrap());
    #[cfg(target_os = "macos")]
    {
        let bytes: [u8; 16] = fs::read(root.join("website-store"))
            .unwrap()
            .try_into()
            .unwrap();
        builder.data_store_identifier(bytes)
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder.data_directory(root.join("website-store"))
    }
}
