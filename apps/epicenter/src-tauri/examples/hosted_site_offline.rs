//! Experiment gate, not product code: a hosted site at its real HTTPS origin,
//! opened by the production `hosted_sites::open`, loaded through the
//! offline-proxy fixture in its own persistent WebKit store. Run it through
//! `bun apps/epicenter/evidence/offline-proxy/run-tauri.ts`, which starts the
//! fixture and runs this once per phase: `online`, `offline` (a cold process
//! with the upstream stopped), and `wrong-pin`.
//!
//! Arguments: `<phase> <fixture .tmp directory>`. The driver also sets
//! `EPICENTER_DATA_DIR`, `EPICENTER_FOLDER_DIR`, and `GATE_STORE_SALT`.

#[cfg(target_os = "macos")]
mod gate {
    use std::ffi::c_void;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::{mpsc, Mutex};
    use std::time::{Duration, Instant};

    use base64::Engine as _;
    use epicenter_lib::offline_gate::{self, Store, Transport};
    use serde_json::{json, Map, Value};
    use tauri::webview::PageLoadEvent;
    use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
    use tauri_plugin_epicenter_folder::defaults::DesktopPaths;
    use tauri_plugin_epicenter_folder::{Directory, FolderExt};

    const SITE: &str = "https://probe.epicenter.test/";
    const HOST: &str = "probe.epicenter.test";
    const ORIGIN: &str = "https://probe.epicenter.test";
    const AREA: &str = "test.epicenter.probe";
    const PROXY: &str = "http://127.0.0.1:38474";
    /// The driver's loopback page (`foreign.ts`), which logs every connection.
    const FOREIGN: &str = "http://127.0.0.1:38476/foreign";
    const FOREIGN_ORIGIN: &str = "http://127.0.0.1:38476";

    /// Every page-load callback Tauri reported, from an app-level hook of
    /// this example alone.
    static PAGE_LOADS: Mutex<Vec<Value>> = Mutex::new(Vec::new());

    fn page_loads() -> Vec<Value> {
        PAGE_LOADS.lock().unwrap().clone()
    }

    /// The page's state, read through WebKit rather than Tauri's IPC.
    const STATE: &str = "JSON.stringify({ href: location.href, origin: location.origin, \
        body: document.body ? document.body.innerText : null, ran: window.__ran || 0, \
        ready: !!window.__ready, inline: window.__inline || 0, \
        instance: window.__gateInstance || null, ipc: typeof window.__TAURI_INTERNALS__, \
        gate: window.__gate || null })";

    /// Folder IPC, refusals, and navigation, run in the site page. It reports
    /// through `window.__gate`, which `STATE` reads.
    const CHECKS: &str = r#"(async (GATE) => {
  const gate = (window.__gate = { step: 'start' });
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const folder = (command, args, options) =>
    invoke(`plugin:epicenter-folder|${command}`, args, options);
  const put = (path, text, expected) =>
    folder('put_folder_file', new TextEncoder().encode(text), {
      headers: { path: encodeURIComponent(path), remove: 'false', expected },
    });
  const text = (bytes) =>
    new TextDecoder().decode(bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes));
  const failure = (error) =>
    error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error);
  const refused = (call) => call().then(() => 'allowed', failure);
  const pause = () => new Promise((resolve) => setTimeout(resolve, 800));
  try {
    gate.stored = localStorage.getItem('gate');
    localStorage.setItem('gate', GATE.salt);
    gate.step = 'read';
    gate.read = text(await folder('read_folder_file', { path: GATE.read }));
    if (GATE.write) {
      gate.step = 'write';
      gate.write = await put(GATE.write.path, GATE.write.text, 'absent');
      gate.listed = (await folder('list_folder', {})).files.map((file) => file.path).sort();
      gate.step = 'refusals';
      gate.escape = await refused(() => put('../outside.txt', 'escaped', 'any'));
      gate.appVersion = await refused(() => invoke('plugin:app|version', {}));
      gate.webviews = await refused(() => invoke('plugin:webview|get_all_webviews', {}));
      gate.step = 'navigation';
      gate.instance = window.__gateInstance = crypto.randomUUID();
      location.href = 'about:blank';
      await pause();
      location.href = GATE.foreign;
      await pause();
      gate.opened = window.open(GATE.foreign) === null ? 'null' : 'window';
      await pause();
      gate.stayed = location.origin === GATE.origin && window.__gateInstance === gate.instance;
    }
    gate.done = true;
  } catch (error) {
    gate.error = failure(error);
    gate.done = true;
  }
})"#;

    /// Folder IPC from the foreign page in the control window. Each answer is
    /// `allowed` or the exact rejection text.
    const FOREIGN_CHECKS: &str = r#"(async () => {
  const gate = (window.__gate = { step: 'start' });
  const failure = (error) =>
    error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error);
  try {
    gate.origin = location.origin;
    gate.ipc = typeof window.__TAURI_INTERNALS__?.invoke;
    const invoke = window.__TAURI_INTERNALS__.invoke;
    gate.step = 'read';
    gate.read = await invoke('plugin:epicenter-folder|read_folder_file', { path: 'seed.txt' })
      .then(() => 'allowed', failure);
    gate.step = 'write';
    gate.write = await invoke(
      'plugin:epicenter-folder|put_folder_file',
      new TextEncoder().encode('foreign'),
      { headers: { path: 'foreign.txt', remove: 'false', expected: 'absent' } },
    ).then(() => 'allowed', failure);
  } catch (error) {
    gate.error = failure(error);
  }
  gate.done = true;
})"#;

    fn main_thread<T: Send + 'static>(
        app: &AppHandle,
        work: impl FnOnce(&AppHandle) -> T + Send + 'static,
    ) -> T {
        let (send, receive) = mpsc::sync_channel(1);
        let handle = app.clone();
        app.run_on_main_thread(move || {
            send.send(work(&handle)).unwrap();
        })
        .unwrap();
        receive.recv_timeout(Duration::from_secs(30)).unwrap()
    }

    /// Run `work` on the main thread with the window's `WKWebView`.
    fn on_webview<T: Send + 'static>(
        window: &WebviewWindow,
        work: impl FnOnce(*mut c_void) -> T + Send + 'static,
    ) -> T {
        let (send, receive) = mpsc::sync_channel(1);
        window
            .with_webview(move |webview| {
                let _ = send.send(work(webview.inner()));
            })
            .unwrap();
        receive.recv_timeout(Duration::from_secs(10)).unwrap()
    }

    /// Wait until Wry has built the window's native WebView. A window built
    /// during setup exists to Tauri at once, but Wry creates its `WKWebView`,
    /// and registers its navigation delegate class, once the event loop runs.
    /// Until then Tauri drops a `with_webview` closure without calling it.
    fn wait_for_webview(window: &WebviewWindow) {
        let start = Instant::now();
        loop {
            let (send, receive) = mpsc::sync_channel(1);
            let sent = window.with_webview(move |_| {
                let _ = send.send(());
            });
            if sent.is_ok() && receive.recv_timeout(Duration::from_secs(1)).is_ok() {
                return;
            }
            assert!(
                start.elapsed() < Duration::from_secs(30),
                "{} has no native WebView",
                window.label()
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    fn store(window: &WebviewWindow) -> Store {
        // The closure runs on the main thread with the window's live WebView.
        on_webview(window, |webview| unsafe { offline_gate::store_of(webview) })
    }

    fn page(window: &WebviewWindow) -> Value {
        let (reply, answer) = mpsc::channel();
        on_webview(window, move |webview| unsafe {
            offline_gate::evaluate(webview, STATE, reply)
        });
        answer
            .recv_timeout(Duration::from_secs(10))
            .ok()
            .flatten()
            .and_then(|state| serde_json::from_str(&state).ok())
            .unwrap_or(Value::Null)
    }

    fn wait(window: &WebviewWindow, seconds: u64, check: impl Fn(&Value) -> bool) -> (bool, Value) {
        let start = Instant::now();
        loop {
            let state = page(window);
            if check(&state) {
                return (true, state);
            }
            if start.elapsed() > Duration::from_secs(seconds) {
                return (false, state);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// The fixture page ran at its origin, its module Worker answered, and its
    /// HTTP CSP blocked the inline script.
    fn loaded(state: &Value) -> bool {
        state["origin"] == ORIGIN
            && state["body"] == "WORKER READY"
            && state["ran"] == 1
            && state["ready"] == true
            && state["inline"] == 0
    }

    fn run_checks(window: &WebviewWindow, config: Value) -> Value {
        run_script(window, CHECKS, config)
    }

    fn run_script(window: &WebviewWindow, script: &str, config: Value) -> Value {
        window.eval(format!("{script}({config});")).unwrap();
        let (_, state) = wait(window, 15, |state| state["gate"]["done"] == true);
        if state["gate"].is_null() {
            json!({ "error": "no report", "state": state })
        } else {
            state["gate"].clone()
        }
    }

    fn files(directory: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(directory)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    fn certificate(path: &Path) -> Vec<u8> {
        let pem = fs::read_to_string(path).unwrap();
        let body: String = pem
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect();
        base64::engine::general_purpose::STANDARD
            .decode(body)
            .unwrap()
    }

    fn check(checks: &mut Map<String, Value>, name: &str, passed: bool) {
        checks.insert(name.into(), passed.into());
    }

    /// TCP connections the foreign page's server has accepted so far.
    fn foreign_connections(scratch: &Path) -> usize {
        fs::read_to_string(scratch.join("foreign-requests.log"))
            .unwrap_or_default()
            .lines()
            .filter(|line| *line == "CONNECTION")
            .count()
    }

    fn until(seconds: u64, mut condition: impl FnMut() -> bool) -> bool {
        let start = Instant::now();
        while !condition() {
            if start.elapsed() > Duration::from_secs(seconds) {
                return false;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        true
    }

    /// Tauri's ACL refusing `command` to this label because the calling page
    /// is at the foreign origin, while the command's only grant is this label
    /// at the site's HTTPS origin. Tauri 2.12 answers:
    ///
    /// ```text
    /// epicenter-folder.<command> not allowed on window "<label>", webview "<label>", URL: http://127.0.0.1:38476/
    ///
    /// allowed on: [windows: "<label>", URL: https://probe.epicenter.test]
    /// ...
    /// ```
    ///
    /// It reports the calling origin's URL, not the page path. A missing
    /// bridge, plugin, command, or binding answers differently.
    fn origin_denial(answer: &Value, command: &str, label: &str) -> bool {
        let Some(answer) = answer.as_str() else {
            return false;
        };
        let refused = format!(
            "epicenter-folder.{command} not allowed on window \"{label}\", webview \"{label}\", URL: "
        );
        let Some(rest) = answer.strip_prefix(&refused) else {
            return false;
        };
        let Some((url, rest)) = rest.split_once('\n') else {
            return false;
        };
        let calling = url
            .parse::<tauri::Url>()
            .is_ok_and(|url| url.origin().ascii_serialization() == FOREIGN_ORIGIN);
        let only_grant = format!("\nallowed on: [windows: \"{label}\", URL: {ORIGIN}]\n");
        calling && rest.contains(&only_grant)
    }

    fn site_window_gone(app: &AppHandle, label: &str) -> bool {
        let label = label.to_owned();
        main_thread(app, move |app| {
            app.get_webview_window(&label).is_none() && app.folders().bound(&label).is_err()
        })
    }

    /// Negative control, in this example only: the closed site's own label,
    /// runtime capability, and folder binding, on a foreign origin, without
    /// the production navigation filter. Only the page's origin differs from
    /// the site window whose Folder calls succeeded.
    fn foreign_control(
        app: &AppHandle,
        label: &str,
        area: &Path,
        scratch: &Path,
        checks: &mut Map<String, Value>,
        report: &mut Map<String, Value>,
    ) {
        check(
            checks,
            "siteWindowAndBindingReleased",
            until(10, || site_window_gone(app, label)),
        );
        let directory = Directory::existing(area).unwrap();
        let connections = foreign_connections(scratch);
        let start = Instant::now();
        // A destroyed label is free once its binding has finished retiring.
        let opened = loop {
            match app.open_folder_window(
                "site",
                directory.clone(),
                WebviewUrl::External(FOREIGN.parse().unwrap()),
                |builder| Ok(builder.title("Foreign-origin control")),
            ) {
                Ok(window) => break Ok(window),
                Err(error) if start.elapsed() > Duration::from_secs(10) => {
                    break Err(error.to_string())
                }
                Err(_) => std::thread::sleep(Duration::from_millis(100)),
            }
        };
        let control = match opened {
            Ok(window) => window,
            Err(error) => {
                report.insert("controlOpenError".into(), error.into());
                check(checks, "foreignControlOpened", false);
                return;
            }
        };
        check(checks, "controlReusesSiteLabel", control.label() == label);
        check(
            checks,
            "controlBoundToSiteFolder",
            app.folders().bound(label).ok().as_ref() == Some(&directory),
        );
        wait_for_webview(&control);
        let (foreign_loaded, state) = wait(&control, 15, |state| {
            state["origin"] == FOREIGN_ORIGIN && state["body"] == "FOREIGN PAGE"
        });
        report.insert("controlPage".into(), state);
        let finished = page_loads().iter().any(|load| {
            load["label"] == label && load["url"] == FOREIGN && load["event"] == "finished"
        });
        check(
            checks,
            "foreignUrlLoadsInControl",
            foreign_loaded && finished && foreign_connections(scratch) > connections,
        );
        let gate = run_script(&control, FOREIGN_CHECKS, json!({}));
        report.insert("control".into(), gate.clone());
        check(
            checks,
            "controlObservesForeignOrigin",
            gate["origin"] == FOREIGN_ORIGIN,
        );
        check(checks, "controlHasIpcBridge", gate["ipc"] == "function");
        check(
            checks,
            "foreignReadDeniedByOriginAcl",
            origin_denial(&gate["read"], "read_folder_file", label),
        );
        check(
            checks,
            "foreignWriteDeniedByOriginAcl",
            origin_denial(&gate["write"], "put_folder_file", label)
                && !area.join("foreign.txt").exists(),
        );
        control.destroy().unwrap();
        check(
            checks,
            "controlReleased",
            until(10, || site_window_gone(app, label)),
        );
    }

    fn exercise(app: &AppHandle, phase: &str, salt: &str, scratch: &Path) -> Value {
        let folder_dir = app.state::<DesktopPaths>().folder_dir.clone();
        let area = folder_dir.join(AREA);
        let online = phase == "online";
        let mut checks = Map::new();
        let mut report = Map::new();
        if online {
            fs::create_dir_all(&area).unwrap();
            fs::write(area.join("seed.txt"), format!("host seed {salt}")).unwrap();
        }
        let before = files(&area);

        // The challenge method joins Wry's delegate class, which exists only
        // once the built-in window's WebView does, before the site's is built.
        let folders = main_thread(app, |app| app.get_webview_window("folders")).unwrap();
        wait_for_webview(&folders);
        let installed = on_webview(&folders, |webview| unsafe {
            offline_gate::install_challenge_method(webview)
        });
        report.insert(
            "delegateClass".into(),
            serde_json::to_value(&installed).unwrap(),
        );
        if installed.is_err() {
            return json!({ "passed": false, "installError": installed.err() });
        }
        let label = match offline_gate::open(app, SITE) {
            Ok(label) => label,
            Err(error) => return json!({ "passed": false, "openError": format!("{error:#}") }),
        };
        let site_label = label.clone();
        let foreign_before = foreign_connections(scratch);
        let site = main_thread(app, move |app| app.get_webview_window(&label)).unwrap();
        wait_for_webview(&site);
        let site_delegate = on_webview(&site, |webview| unsafe {
            offline_gate::delegate_answers_challenges(webview)
        });
        report.insert(
            "siteDelegate".into(),
            serde_json::to_value(&site_delegate).unwrap(),
        );
        check(
            &mut checks,
            "siteDelegateAnswersChallenges",
            site_delegate.as_ref().is_ok_and(|(name, answers)| {
                *answers && installed.as_ref().is_ok_and(|installed| installed == name)
            }),
        );
        let expected_store = offline_gate::store_identifier(HOST, salt);
        let site_store = store(&site);
        let folders_store = store(&folders);
        report.insert(
            "stores".into(),
            json!({ "site": format!("{site_store:?}"), "folders": format!("{folders_store:?}") }),
        );
        check(
            &mut checks,
            "siteHasItsOwnProxiedPersistentStore",
            site_store.identifier == Some(expected_store)
                && site_store.persistent
                && site_store.proxies == 1,
        );
        check(
            &mut checks,
            "builtInWindowKeepsDefaultUnproxiedStore",
            folders_store.identifier.is_none()
                && folders_store.proxies == 0
                && folders_store.address != site_store.address,
        );

        if phase == "wrong-pin" {
            let (page_loaded, state) = wait(&site, 8, loaded);
            let trust = offline_gate::trust_counts();
            report.insert("page".into(), state.clone());
            check(
                &mut checks,
                "pageDidNotLoad",
                !page_loaded && state["origin"] != ORIGIN,
            );
            check(
                &mut checks,
                "wrongPinRejected",
                trust.rejected > 0 && trust.matched == 0,
            );
            check(&mut checks, "areaUnchanged", files(&area) == before);
        } else {
            let (page_loaded, state) = wait(&site, 20, loaded);
            report.insert("page".into(), state);
            check(&mut checks, "loadedAtOriginWithWorkerAndCsp", page_loaded);
            let trust = offline_gate::trust_counts();
            check(
                &mut checks,
                "pinMatched",
                trust.matched > 0 && trust.rejected == 0,
            );

            let seed = format!("host seed {salt}");
            let online_text = format!("online {salt}");
            let offline_text = format!("offline {salt}");
            let (read, expected_read, write, write_text) = if online {
                ("seed.txt", &seed, "site-online.txt", &online_text)
            } else {
                (
                    "site-online.txt",
                    &online_text,
                    "site-offline.txt",
                    &offline_text,
                )
            };
            let gate = run_checks(
                &site,
                json!({ "read": read, "write": { "path": write, "text": write_text },
                    "salt": salt, "origin": ORIGIN, "foreign": FOREIGN }),
            );
            report.insert("gate".into(), gate.clone());
            check(
                &mut checks,
                "folderReadExact",
                gate["read"] == expected_read.as_str(),
            );
            check(
                &mut checks,
                "folderWriteExact",
                gate["write"] == "landed"
                    && fs::read_to_string(area.join(write)).ok().as_ref() == Some(write_text),
            );
            check(
                &mut checks,
                "siteStorePersistsAcrossProcesses",
                gate["stored"] == (if online { Value::Null } else { json!(salt) }),
            );
            check(
                &mut checks,
                "pathEscapeRefused",
                gate["escape"]
                    .as_str()
                    .is_some_and(|answer| answer != "allowed")
                    && !folder_dir.join("outside.txt").exists(),
            );
            check(
                &mut checks,
                "nonFolderCommandsRefused",
                ["appVersion", "webviews"].iter().all(|name| {
                    gate[*name]
                        .as_str()
                        .is_some_and(|answer| answer != "allowed")
                }),
            );
            // The page staying could also mean a load that failed or stalled.
            // A refusal sends nothing: no connection reached the foreign
            // server, the driver checks that the proxy refused no tunnel, and
            // the control below loads this same URL.
            check(
                &mut checks,
                "foreignNavigationKeptPage",
                gate["stayed"] == true,
            );
            check(
                &mut checks,
                "foreignUrlNeverRequestedBySite",
                foreign_connections(scratch) == foreign_before
                    && !page_loads().iter().any(|load| {
                        load["label"] == site_label.as_str()
                            && load["url"]
                                .as_str()
                                .is_some_and(|url| !url.starts_with(ORIGIN))
                    }),
            );
            // Only what the page and Tauri show: no callback from the
            // production new-window handler is observed.
            let windows = main_thread(app, |app| app.webview_windows().len());
            check(
                &mut checks,
                "windowOpenReturnedNullAndNoWindowCreated",
                gate["opened"] == "null" && windows == 2,
            );

            site.eval("location.reload()").unwrap();
            let (reloaded, state) = wait(&site, 20, |state| {
                loaded(state) && state["instance"].is_null()
            });
            report.insert("reloaded".into(), state);
            check(&mut checks, "sameOriginReloadLoads", reloaded);
            let again = run_checks(
                &site,
                json!({ "read": "seed.txt", "write": null, "salt": salt, "origin": ORIGIN }),
            );
            check(
                &mut checks,
                "folderReadAfterReload",
                again["read"] == seed.as_str(),
            );
        }

        site.destroy().unwrap();
        // WebKit writes local storage after a delay; let it land before exit.
        std::thread::sleep(Duration::from_secs(2));
        if phase != "wrong-pin" {
            foreign_control(app, &site_label, &area, scratch, &mut checks, &mut report);
        }
        report.insert("pageLoads".into(), page_loads().into());
        if phase == "wrong-pin" {
            // The last phase deletes this run's persistent store.
            let answer = main_thread(app, move |_| {
                let (reply, answer) = mpsc::channel();
                unsafe { offline_gate::remove_store(expected_store, reply) };
                answer
            });
            report.insert(
                "storeRemovalError".into(),
                match answer.recv_timeout(Duration::from_secs(10)) {
                    Ok(error) => json!(error),
                    Err(_) => json!("no answer"),
                },
            );
        }
        let trust = offline_gate::trust_counts();
        report.insert(
            "trust".into(),
            json!({ "matched": trust.matched, "rejected": trust.rejected,
                "defaultHandling": trust.default_handling }),
        );
        let passed = checks.values().all(|value| value == true);
        report.insert("checks".into(), Value::Object(checks));
        report.insert("passed".into(), passed.into());
        Value::Object(report)
    }

    pub fn run() {
        let mut arguments = std::env::args().skip(1);
        let phase = arguments.next().expect("a phase");
        assert!(
            matches!(phase.as_str(), "online" | "offline" | "wrong-pin"),
            "unknown phase {phase}"
        );
        let scratch = PathBuf::from(arguments.next().expect("the fixture .tmp directory"));
        let salt = std::env::var("GATE_STORE_SALT").expect("GATE_STORE_SALT");
        let data =
            PathBuf::from(std::env::var_os("EPICENTER_DATA_DIR").expect("EPICENTER_DATA_DIR"));
        let pinned_leaf = certificate(&scratch.join(if phase == "wrong-pin" {
            "upstream-cert.pem"
        } else {
            "cert.pem"
        }));
        let store_salt = salt.clone();

        let mut context = tauri::generate_context!("examples/hosted-site-offline/tauri.conf.json");
        context.config_mut().app.app_directories_override =
            Some(tauri::utils::config::AppDirectoriesOverride::Root(
                data.join("tauri").try_into().unwrap(),
            ));
        let app = tauri::Builder::default()
            .plugin(tauri_plugin_epicenter_folder::init())
            .plugin(tauri_plugin_dialog::init())
            .on_page_load(|webview, payload| {
                let event = match payload.event() {
                    PageLoadEvent::Started => "started",
                    PageLoadEvent::Finished => "finished",
                };
                PAGE_LOADS.lock().unwrap().push(json!({
                    "label": webview.label(),
                    "url": payload.url().as_str(),
                    "event": event,
                }));
            })
            .setup(move |app| {
                app.manage(DesktopPaths::resolve(app.handle())?);
                offline_gate::manage(
                    app.handle(),
                    Transport {
                        proxy: PROXY.parse()?,
                        pinned_leaf,
                        store_salt,
                    },
                );
                // Epicenter's own window, on the default store, opens before
                // any site, as the Folders window does at launch.
                WebviewWindowBuilder::new(app, "folders", WebviewUrl::App("index.html".into()))
                    .title("Folders (gate fixture)")
                    .build()?;
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        exercise(&handle, &phase, &salt, &scratch)
                    }));
                    let mut report =
                        result.unwrap_or_else(|_| json!({ "passed": false, "panicked": true }));
                    report["phase"] = Value::from(phase.as_str());
                    let passed = report["passed"] == true;
                    let text = serde_json::to_string_pretty(&report).unwrap();
                    fs::write(scratch.join(format!("tauri-{phase}.json")), &text).unwrap();
                    println!("{text}");
                    println!("GATE {phase} {}", if passed { "PASSED" } else { "FAILED" });
                    handle.exit(if passed { 0 } else { 1 });
                });
                Ok(())
            })
            .build(context)
            .unwrap();
        app.run(|_, event| {
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
                api.prevent_exit();
            }
        });
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    gate::run();
    #[cfg(not(target_os = "macos"))]
    eprintln!("The hosted-site offline gate needs macOS 14 or later.");
}
