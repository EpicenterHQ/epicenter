// Appended only to the disposable copy of lib.rs. Production has no automation
// command, report channel, window-store override, or keychain inspection API.
fn start_catalog_acceptance(app: &DesktopAppHandle) {
    use tauri::Listener;
    let directory = PathBuf::from(std::env::var("EPICENTER_ACCEPTANCE_DIR").unwrap());
    let reports = directory.clone();
    app.listen("catalog-acceptance", move |event| {
        let value: serde_json::Value = serde_json::from_str(event.payload()).unwrap();
        let id = value["id"].as_u64().unwrap();
        let temporary = reports.join(format!("result-{id}.tmp"));
        fs::write(&temporary, event.payload()).unwrap();
        fs::rename(temporary, reports.join(format!("result-{id}.json"))).unwrap();
    });
    let app = app.clone();
    thread::spawn(move || {
        for _ in 0..1200 {
            let path = directory.join("command.json");
            if let Ok(bytes) = fs::read(&path) {
                fs::remove_file(&path).unwrap();
                let command: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                let id = command["id"].as_u64().unwrap();
                let result = (|| -> Result<serde_json::Value> {
                    let product = command["product"].as_str().unwrap_or("catalog-test-a");
                    match command["action"].as_str().unwrap() {
                        "launch" => {
                            launch_application(
                                app.clone(),
                                app.state::<HostState>(),
                                product.into(),
                            )
                            .map_err(|e| anyhow!(e))?;
                            let state = app.state::<HostState>();
                            let process = state.process.lock().unwrap();
                            Ok(
                                serde_json::json!({"nativePid": std::process::id(), "bunPid": process.as_ref().unwrap().child.id()}),
                            )
                        }
                        "eval" => {
                            let label = if BuiltInApp::from_id(product).is_some() {
                                product.to_string()
                            } else {
                                app_window_label(product)
                            };
                            app.get_webview_window(&label)
                                .context("test window absent")?
                                .eval(command["script"].as_str().unwrap())?;
                            Ok(serde_json::Value::Null)
                        }
                        "destroy" => {
                            let label = if BuiltInApp::from_id(product).is_some() {
                                product.to_string()
                            } else {
                                app_window_label(product)
                            };
                            app.get_webview_window(&label)
                                .context("test window absent")?
                                .destroy()?;
                            Ok(serde_json::Value::Bool(true))
                        }
                        "delete-key" => {
                            delete_app_secret(
                                &app.config().identifier,
                                "so.epicenter.ai-catalog",
                                command["label"].as_str().unwrap(),
                                None,
                            )?;
                            Ok(serde_json::Value::Bool(true))
                        }
                        "quit" => {
                            app.exit(0);
                            Ok(serde_json::Value::Bool(true))
                        }
                        _ => bail!("unknown acceptance action"),
                    }
                })();
                if command["action"] != "eval" || result.is_err() {
                    let report = match result {
                        Ok(value) => serde_json::json!({"id": id, "value": value}),
                        Err(error) => serde_json::json!({"id": id, "error": format!("{error:#}")}),
                    };
                    let temporary = directory.join(format!("result-{id}.tmp"));
                    fs::write(&temporary, report.to_string()).unwrap();
                    fs::rename(temporary, directory.join(format!("result-{id}.json"))).unwrap();
                }
            }
            thread::sleep(Duration::from_millis(100));
        }
        app.exit(2);
    });
}
