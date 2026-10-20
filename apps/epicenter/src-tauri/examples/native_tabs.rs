//! macOS runtime regression over real Todos pages, native folder saves and
//! the production tab actions. Run after `bun run --cwd apps/todos build:host`:
//! `cargo run --offline --manifest-path apps/epicenter/src-tauri/Cargo.toml --example native_tabs --features native-tabs-smoke`
//! All folders and WebView storage live in a fresh temporary directory.

#[cfg(target_os = "macos")]
#[path = "../src/macos_tabs.rs"]
mod macos_tabs;

#[cfg(target_os = "macos")]
mod smoke {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::{Duration, Instant};

    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSWindow, NSWindowButton};
    use serde_json::{json, Value};
    use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
    use tauri_plugin_epicenter_folder::{Directory, FolderExt};

    type Reports = mpsc::Receiver<Value>;

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

    // Logical fixture names are titles. Native labels now come exclusively
    // from the production app-and-directory opener.
    fn find_window(app: &AppHandle, name: &str) -> Option<WebviewWindow> {
        app.get_webview_window(name).or_else(|| {
            app.webview_windows()
                .into_values()
                .find(|window| window.title().is_ok_and(|title| title == name))
        })
    }

    fn native(window: &WebviewWindow) -> &NSWindow {
        assert!(MainThreadMarker::new().is_some());
        // Tauri owns this pointer for the lifetime of the borrowed window.
        unsafe { &*window.ns_window().unwrap().cast::<NSWindow>() }
    }

    fn js(app: &AppHandle, reports: &Reports, label: &str, body: &str) -> Value {
        let label = label.to_owned();
        let script = format!("nativeTabsSmoke({})", serde_json::to_string(body).unwrap());
        main_thread(app, move |app| {
            find_window(app, &label).unwrap().eval(script).unwrap()
        });
        let report = reports.recv_timeout(Duration::from_secs(30)).unwrap();
        assert!(report.get("error").is_none(), "{report}");
        report["data"].clone()
    }

    fn until(mut check: impl FnMut() -> bool) {
        let start = Instant::now();
        while !check() {
            assert!(
                start.elapsed() < Duration::from_secs(25),
                "native condition timed out"
            );
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    fn alive(app: &AppHandle, label: &str) -> bool {
        let label = label.to_owned();
        main_thread(app, move |app| find_window(app, &label).is_some())
    }

    fn open(
        app: &AppHandle,
        reports: &Reports,
        root: &Path,
        label: &str,
        send: mpsc::Sender<Value>,
    ) -> PathBuf {
        let directory = root.join(label.replace(':', "-"));
        fs::create_dir_all(directory.join("todos")).unwrap();
        fs::write(
            directory.join("todos/milk.md"),
            "---\ntitle: Milk\ndone: false\n---\n",
        )
        .unwrap();
        let admitted = Directory::existing(&directory).unwrap();
        let cache = root.join(format!("cache-{}", label.replace(':', "-")));
        let label = label.to_owned();
        let opening = label.clone();
        main_thread(app, move |app| {
            app.open_folder_window(
                "todos",
                admitted,
                WebviewUrl::App("/?todo=milk".into()),
                move |builder| {
                    Ok(super::macos_tabs::configure(
                        builder
                            .title(&opening)
                            .data_directory(cache)
                            .initialization_script(include_str!("native-tabs/driver.js"))
                            .on_navigation(move |url| {
                                if url.host_str() == Some("native-tabs.invalid") {
                                    let value = url
                                        .query_pairs()
                                        .find(|(key, _)| key == "result")
                                        .unwrap()
                                        .1;
                                    send.send(serde_json::from_str(&value).unwrap()).unwrap();
                                    false
                                } else {
                                    true
                                }
                            }),
                    ))
                },
            )
            .unwrap();
        });
        // The page renders editable children only after its real close guard is registered.
        let ready = js(
            app,
            reports,
            &label,
            r#"
            for (let n = 0; n < 500; n++) {
                const input = document.querySelector('section[aria-label="Todo"] input[aria-label="Title"]');
                if (input?.value === 'Milk') return nativeTabsSmokeInstance;
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            throw new Error(document.body.innerText);
        "#,
        );
        assert!(ready.is_string());
        directory
    }

    fn group(app: &AppHandle, label: &str, expected: usize) {
        let label = label.to_owned();
        main_thread(app, move |app| {
            let window = find_window(app, &label).unwrap();
            native(&window).mergeAllWindows(None);
            assert_eq!(
                native(&window).tabGroup().unwrap().windows().len(),
                expected
            );
            for label in ["folders", "home"] {
                let builtin = find_window(app, label).unwrap();
                assert!(native(&builtin)
                    .tabGroup()
                    .is_none_or(|group| group.windows().len() == 1));
            }
        });
    }

    fn close_group(app: &AppHandle, label: &str) {
        let label = label.to_owned();
        main_thread(app, move |app| {
            let window = find_window(app, &label).unwrap();
            window.set_focus().unwrap();
            // Activate the installed native menu item, including muda/Tauri
            // dispatch and its lookup of the current native window.
            let main = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
            let menu = main.mainMenu().unwrap();
            let item = menu
                .itemArray()
                .iter()
                .find(|item| item.title().to_string() == "Window")
                .unwrap();
            let submenu = item.submenu().unwrap();
            let index = submenu
                .itemArray()
                .iter()
                .position(|item| item.title().to_string() == "Close Tab Group")
                .unwrap();
            submenu.performActionForItemAtIndex(index as isize);
        });
    }

    fn menu_titles(app: &AppHandle) -> Vec<String> {
        main_thread(app, |_| {
            let main = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
            let menu = main.mainMenu().unwrap();
            let item = menu
                .itemArray()
                .iter()
                .find(|item| item.title().to_string() == "Window")
                .unwrap();
            item.submenu()
                .unwrap()
                .itemArray()
                .iter()
                .map(|item| item.title().to_string())
                .collect()
        })
    }

    fn type_input(app: &AppHandle, reports: &Reports, label: &str, selector: &str, text: &str) {
        js(
            app,
            reports,
            label,
            &format!(
                r#"
            const input = document.querySelector({});
            input.value = {};
            input.dispatchEvent(new Event('input', {{ bubbles: true }}));
            input.setSelectionRange(2, 5);
            return input.value;
        "#,
                json!(selector),
                json!(text)
            ),
        );
    }

    fn red_button(app: &AppHandle, label: &str) {
        let label = label.to_owned();
        main_thread(app, move |app| {
            let window = find_window(app, &label).unwrap();
            window.set_focus().unwrap();
            // The standard close button invokes its native AppKit action.
            unsafe {
                native(&window)
                    .standardWindowButton(NSWindowButton::CloseButton)
                    .unwrap()
                    .performClick(None);
            }
        });
    }

    fn exercise(
        app: &AppHandle,
        reports: &Reports,
        root: &Path,
        send: mpsc::Sender<Value>,
    ) -> Value {
        until(|| !alive(app, "todos:setup"));
        // Concurrent first opens from blocking workers must configure once and
        // return the same real window, while setup above tests the inline path.
        let concurrent = Directory::create(&root.join("concurrent")).unwrap();
        let configured = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let workers: Vec<_> = (0..6)
            .map(|_| {
                let handle = app.clone();
                let directory = concurrent.clone();
                let configured = configured.clone();
                std::thread::spawn(move || {
                    handle
                        .open_folder_window(
                            "todos",
                            directory,
                            WebviewUrl::App("/".into()),
                            move |builder| {
                                configured.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                                Ok(super::macos_tabs::configure(
                                    builder.title("todos:concurrent"),
                                ))
                            },
                        )
                        .unwrap()
                        .label()
                        .to_owned()
                })
            })
            .collect();
        let labels: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert!(labels.iter().all(|label| label == &labels[0]));
        assert_eq!(configured.load(std::sync::atomic::Ordering::SeqCst), 1);
        main_thread(app, |app| {
            find_window(app, "todos:concurrent")
                .unwrap()
                .close()
                .unwrap()
        });
        until(|| !alive(app, "todos:concurrent"));
        let title = "section[aria-label=\"Todo\"] input[aria-label=\"Title\"]";
        let new_title = "[aria-label=\"New todo title\"]";
        open(app, reports, root, "todos:clean", send.clone());
        let delayed = open(app, reports, root, "todos:delayed", send.clone());
        open(app, reports, root, "todos:unsent", send.clone());
        group(app, "todos:clean", 3);
        let menus = menu_titles(app);

        // Moving a native tab must keep its page instance, binding and input.
        type_input(app, reports, "todos:unsent", new_title, "Unsubmitted bread");
        let before = js(
            app,
            reports,
            "todos:unsent",
            "return nativeTabsSmokeInstance;",
        );
        main_thread(app, |app| {
            native(&find_window(app, "todos:unsent").unwrap()).moveTabToNewWindow(None)
        });
        main_thread(app, |app| {
            let window = find_window(app, "todos:unsent").unwrap();
            assert!(app.folders().bound(window.label()).is_ok());
        });
        group(app, "todos:clean", 3);
        let after = js(
            app,
            reports,
            "todos:unsent",
            "return nativeTabsSmokeInstance;",
        );
        assert_eq!(before, after);

        let lock = Directory::existing(&delayed).unwrap().publishing().unwrap();
        type_input(
            app,
            reports,
            "todos:delayed",
            title,
            "Saved during group close",
        );
        main_thread(app, |app| {
            find_window(app, "todos:clean")
                .unwrap()
                .set_focus()
                .unwrap()
        });
        close_group(app, "todos:clean");
        // A second request while saving is pending must not bypass any guard.
        close_group(app, "todos:delayed");
        until(|| !alive(app, "todos:clean"));
        assert!(alive(app, "todos:delayed"));
        assert!(fs::read_to_string(delayed.join("todos/milk.md"))
            .unwrap()
            .contains("title: Milk"));
        let held = js(
            app,
            reports,
            "todos:unsent",
            r#"
            for (let n = 0; n < 500; n++) {
                if (document.body.innerText.includes('The window stayed open'))
                    return { instance: nativeTabsSmokeInstance,
                        input: document.querySelector('[aria-label="New todo title"]').value };
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            throw new Error('no refusal notice');
        "#,
        );
        assert_eq!(held["instance"], before);
        assert_eq!(held["input"], "Unsubmitted bread");
        let selected = main_thread(app, |app| {
            let window = find_window(app, "todos:unsent").unwrap();
            native(&window)
                .tabGroup()
                .unwrap()
                .selectedWindow()
                .as_deref()
                == Some(native(&window))
                && window.is_focused().unwrap()
        });
        assert!(
            selected,
            "the refused inactive tab was not selected and focused"
        );
        drop(lock);
        until(|| !alive(app, "todos:delayed"));
        assert!(fs::read_to_string(delayed.join("todos/milk.md"))
            .unwrap()
            .contains("Saved during group close"));
        type_input(app, reports, "todos:unsent", new_title, "");
        close_group(app, "todos:unsent");
        until(|| !alive(app, "todos:unsent"));

        open(app, reports, root, "todos:peer", send.clone());
        let failed = open(app, reports, root, "todos:failed", send.clone());
        group(app, "todos:peer", 2);
        fs::set_permissions(failed.join("todos"), fs::Permissions::from_mode(0o500)).unwrap();
        type_input(
            app,
            reports,
            "todos:failed",
            title,
            "Kept after filesystem failure",
        );
        main_thread(app, |app| {
            find_window(app, "todos:peer").unwrap().set_focus().unwrap()
        });
        close_group(app, "todos:peer");
        until(|| !alive(app, "todos:peer"));
        let retained = js(
            app,
            reports,
            "todos:failed",
            r#"
            for (let n = 0; n < 500; n++) {
                if (document.body.innerText.includes('The window stayed open'))
                    return document.querySelector('section[aria-label="Todo"] input[aria-label="Title"]').value;
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            throw new Error('failed save did not refuse close');
        "#,
        );
        assert_eq!(retained, "Kept after filesystem failure");
        assert!(fs::read_to_string(failed.join("todos/milk.md"))
            .unwrap()
            .contains("title: Milk"));
        fs::set_permissions(failed.join("todos"), fs::Permissions::from_mode(0o700)).unwrap();
        close_group(app, "todos:failed");
        until(|| !alive(app, "todos:failed"));
        assert!(fs::read_to_string(failed.join("todos/milk.md"))
            .unwrap()
            .contains("Kept after filesystem failure"));
        open(app, reports, root, "todos:red-clean", send.clone());
        open(app, reports, root, "todos:red-unsent", send.clone());
        type_input(
            app,
            reports,
            "todos:red-unsent",
            new_title,
            "Kept through red close button",
        );
        group(app, "todos:red-clean", 2);
        red_button(app, "todos:red-clean");
        until(|| !alive(app, "todos:red-clean"));
        assert!(alive(app, "todos:red-unsent"));
        red_button(app, "todos:red-unsent");
        let red_retained = js(
            app,
            reports,
            "todos:red-unsent",
            r#"
            await new Promise(resolve => setTimeout(resolve, 300));
            return document.querySelector('[aria-label="New todo title"]').value;
        "#,
        );
        assert_eq!(red_retained, "Kept through red close button");
        type_input(app, reports, "todos:red-unsent", new_title, "");
        close_group(app, "todos:red-unsent");
        until(|| !alive(app, "todos:red-unsent"));

        if std::env::args().any(|arg| arg == "--interactive") {
            for label in ["todos:gesture-a", "todos:gesture-b", "todos:gesture-c"] {
                open(app, reports, root, label, send.clone());
                type_input(
                    app,
                    reports,
                    label,
                    new_title,
                    &format!("Unsubmitted {label}"),
                );
            }
            group(app, "todos:gesture-a", 3);
            fs::write(
                root.join("interactive-ready"),
                "Try tab close buttons and Close Other Tabs, then create gestures.done here.\n",
            )
            .unwrap();
            println!("Interactive fixtures: {}", root.display());
            let start = Instant::now();
            while !root.join("gestures.done").exists() {
                assert!(
                    start.elapsed() < Duration::from_secs(240),
                    "interactive checks timed out"
                );
                std::thread::sleep(Duration::from_millis(200));
            }
            for label in ["todos:gesture-a", "todos:gesture-b", "todos:gesture-c"] {
                assert!(alive(app, label), "gesture lost {label}");
                let value = js(
                    app,
                    reports,
                    label,
                    "return document.querySelector('[aria-label=\"New todo title\"]').value;",
                );
                assert_eq!(value, format!("Unsubmitted {label}"));
                let checking = label.to_owned();
                main_thread(app, move |app| {
                    let window = find_window(app, &checking).unwrap();
                    assert!(app.folders().bound(window.label()).is_ok());
                });
                type_input(app, reports, label, new_title, "");
            }
            close_group(app, "todos:gesture-a");
            until(|| {
                !alive(app, "todos:gesture-a")
                    && !alive(app, "todos:gesture-b")
                    && !alive(app, "todos:gesture-c")
            });
        }
        assert!(main_thread(app, |app| app
            .webview_windows()
            .keys()
            .all(|label| !label.starts_with("todos:"))));
        json!({ "passed": true, "unsentRetained": held, "refusedTabSelected": selected,
            "sameInstanceAfterDetachAndMerge": before == after,
            "delayedSaveCompletedBeforeDestruction": true, "failedSaveRetried": true,
            "launcherExcluded": true, "bindingsRemoved": true, "setupAndConcurrentOpening": true, "redButtonPreservesInput": true, "windowMenuTitles": menus })
    }

    pub fn run() {
        let root = tempfile::Builder::new()
            .prefix("epicenter-native-tabs-")
            .tempdir()
            .unwrap()
            .keep();
        let (send, reports) = mpsc::channel();
        let events = Arc::new(Mutex::new(Vec::new()));
        let recording = events.clone();
        let mut context = tauri::generate_context!("examples/native-tabs/tauri.conf.json");
        context.config_mut().app.app_directories_override =
            Some(tauri::utils::config::AppDirectoriesOverride::Root(
                root.join("app-data").try_into().unwrap(),
            ));
        let app = tauri::Builder::default()
            .plugin(tauri_plugin_epicenter_folder::init())
            .on_window_event(move |window, event| {
                let kind = match event { WindowEvent::CloseRequested { .. } => "CloseRequested", WindowEvent::Destroyed => "Destroyed", _ => return };
                recording.lock().unwrap().push(json!({"label": window.label(), "event": kind}));
            })
            .setup(move |app| {
                super::macos_tabs::install(app.handle())?;
                // Reproduce another native window disabling automatic tabbing,
                // then the launcher's distinct identifier used by production.
                WebviewWindowBuilder::new(app, "unconfigured", WebviewUrl::App("index.html".into()))
                    .visible(false).data_directory(root.join("unconfigured-cache")).build()?;
                for label in ["folders", "home"] {
                    WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
                        .title(format!("{label} (test fixture)"))
                        .tabbing_identifier(label).data_directory(root.join(format!("{label}-cache"))).build()?;
                }
                let startup = Directory::create(&root.join("setup"))?;
                app.open_folder_window("todos", startup, WebviewUrl::App("/".into()), |builder| {
                    Ok(super::macos_tabs::configure(builder.title("todos:setup")))
                })?.close()?;
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| exercise(&handle, &reports, &root, send)));
                    let events = events.lock().unwrap().clone();
                    let ordered = events.iter().enumerate().all(|(index, event)| {
                        event["event"] != "Destroyed" || events[..index].iter().any(|before| before["label"] == event["label"] && before["event"] == "CloseRequested")
                    });
                    let cleaned = events.iter().filter(|event| event["event"] == "Destroyed")
                        .all(|event| handle.folders().bound(event["label"].as_str().unwrap()).is_err());
                    let passed = result.is_ok() && ordered && cleaned;
                    let result = json!({"result": result.unwrap_or_else(|_| json!({"passed":false})), "closeRequestedBeforeDestruction": ordered, "destroyedBindingsRemoved": cleaned, "events": events, "root": root});
                    fs::write(root.join("results.json"), serde_json::to_vec_pretty(&result).unwrap()).unwrap();
                    println!("{}", serde_json::to_string_pretty(&result).unwrap());
                    handle.exit(if passed { 0 } else { 1 });
                });
                Ok(())
            }).build(context).unwrap();
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
    smoke::run();
    #[cfg(not(target_os = "macos"))]
    eprintln!("Native tab smoke runs on macOS; other platforms use separate windows.");
}
