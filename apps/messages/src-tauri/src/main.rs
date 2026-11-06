//! Messages' desktop shell: starts the one Bun program that owns the folder,
//! journal, keychain and send path, then opens its same-origin page.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const RELEASE_IDENTITY: &str = "so.epicenter.messages";
const STDERR_TAIL_BYTES: usize = 64 * 1024;

type ChildSlot = Arc<Mutex<Option<Child>>>;

fn parse_ready(line: &str) -> Result<Url, String> {
    let value = line
        .strip_prefix("Messages: ")
        .ok_or_else(|| "the local program did not print its readiness line".to_string())?;
    let url = Url::parse(value.trim()).map_err(|error| error.to_string())?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port().is_none() {
        return Err("the local program returned an invalid address".into());
    }
    Ok(url)
}

fn drain_stdout(stdout: impl Read, ready: mpsc::Sender<Result<Url, String>>) {
    let mut stdout = BufReader::new(stdout);
    let mut line = String::new();
    let result = stdout
        .read_line(&mut line)
        .map_err(|error| error.to_string())
        .and_then(|read| {
            if read == 0 {
                Err("the local program exited before it was ready".into())
            } else {
                parse_ready(&line)
            }
        });
    let _ = ready.send(result);
    let _ = io::copy(&mut stdout, &mut io::sink());
}

fn isolated_environment(
    identity: &str,
    app_local_data: &Path,
    home: &Path,
) -> Vec<(String, PathBuf)> {
    if identity == RELEASE_IDENTITY {
        Vec::new()
    } else {
        vec![
            ("EPICENTER_DATA_DIR".into(), app_local_data.to_path_buf()),
            ("EPICENTER_FOLDER_DIR".into(), home.join("Epicenter Dev")),
        ]
    }
}

fn stderr_tail(stderr: impl Read + Send + 'static) -> Arc<Mutex<VecDeque<u8>>> {
    let tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_BYTES)));
    let output = Arc::clone(&tail);
    std::thread::spawn(move || {
        let mut stderr = BufReader::new(stderr);
        let mut chunk = [0; 8192];
        while let Ok(read) = stderr.read(&mut chunk) {
            if read == 0 {
                break;
            }
            let mut bytes = output.lock().unwrap_or_else(|value| value.into_inner());
            for byte in &chunk[..read] {
                if bytes.len() == STDERR_TAIL_BYTES {
                    bytes.pop_front();
                }
                bytes.push_back(*byte);
            }
        }
    });
    tail
}

fn tail_text(tail: &Arc<Mutex<VecDeque<u8>>>) -> String {
    let bytes: Vec<_> = tail
        .lock()
        .unwrap_or_else(|value| value.into_inner())
        .iter()
        .copied()
        .collect();
    String::from_utf8_lossy(&bytes).trim().to_string()
}

fn program(root: &Path) -> Result<Command, String> {
    #[cfg(not(debug_assertions))]
    let mut command = {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        Command::new(
            executable
                .parent()
                .ok_or("the Messages executable has no parent directory")?
                .join("messages-server"),
        )
    };
    #[cfg(debug_assertions)]
    let mut command = {
        let mut command = Command::new("bun");
        command
            .arg("--no-install")
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/serve.ts"));
        command
    };
    command
        .arg("--root")
        .arg(root)
        .args(["--port", "0", "--lifeline"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    Ok(command)
}

fn quit_with(handle: &tauri::AppHandle, title: String, message: String) {
    let exit = handle.clone();
    handle
        .dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCustom("Quit".into()))
        .show(move |_| exit.exit(1));
}

fn main() {
    let child: ChildSlot = Arc::new(Mutex::new(None));
    let quitting = Arc::new(AtomicBool::new(false));
    let setup_child = Arc::clone(&child);
    let setup_quitting = Arc::clone(&quitting);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |application| {
            let handle = application.handle().clone();
            let identity = handle.config().identifier.clone();
            let root = if cfg!(debug_assertions) {
                Path::new(env!("CARGO_MANIFEST_DIR")).join("../build-desktop")
            } else {
                handle.path().resource_dir()?.join("site")
            };
            let mut command = program(&root).map_err(std::io::Error::other)?;
            for (name, value) in isolated_environment(
                &identity,
                &handle.path().app_local_data_dir()?,
                &handle.path().home_dir()?,
            ) {
                command.env(name, value);
            }
            let mut started = command.spawn()?;
            let stdout = started.stdout.take().ok_or("missing child stdout")?;
            let stderr = started.stderr.take().ok_or("missing child stderr")?;
            let tail = stderr_tail(stderr);
            *setup_child
                .lock()
                .unwrap_or_else(|value| value.into_inner()) = Some(started);

            let startup_child = Arc::clone(&setup_child);
            let startup_quitting = Arc::clone(&setup_quitting);
            std::thread::spawn(move || {
                let (send, receive) = mpsc::channel();
                std::thread::spawn(move || {
                    drain_stdout(stdout, send);
                });
                match receive.recv_timeout(Duration::from_secs(30)) {
                    Ok(Ok(url)) => {
                        let open = handle.clone();
                        let title = handle.package_info().name.clone();
                        let failure_title = format!("{title} could not start");
                        let cache = handle
                            .path()
                            .app_cache_dir()
                            .map(|path| path.join("webview"));
                        let origin = url.origin().ascii_serialization();
                        let result = handle.run_on_main_thread(move || {
                            let window =
                                cache.map_err(|error| error.to_string()).and_then(|cache| {
                                    WebviewWindowBuilder::new(
                                        &open,
                                        "messages",
                                        WebviewUrl::External(url),
                                    )
                                    .title(title)
                                    .inner_size(1100.0, 760.0)
                                    .min_inner_size(720.0, 520.0)
                                    .data_directory(cache)
                                    .on_navigation(move |next| {
                                        next.origin().ascii_serialization() == origin
                                    })
                                    .build()
                                    .map_err(|error| error.to_string())
                                });
                            if let Err(error) = window {
                                quit_with(&open, failure_title, error);
                            }
                        });
                        if result.is_err() {
                            return;
                        }
                    }
                    Ok(Err(error)) => {
                        quit_with(
                            &handle,
                            format!("{} could not start", handle.package_info().name),
                            format!("{error}\n{}", tail_text(&tail)),
                        );
                        return;
                    }
                    Err(_) => {
                        quit_with(
                            &handle,
                            format!("{} could not start", handle.package_info().name),
                            format!(
                                "The local program did not start within 30 seconds.\n{}",
                                tail_text(&tail)
                            ),
                        );
                        return;
                    }
                }

                loop {
                    std::thread::sleep(Duration::from_millis(200));
                    let status = startup_child
                        .lock()
                        .unwrap_or_else(|value| value.into_inner())
                        .as_mut()
                        .and_then(|child| child.try_wait().ok().flatten());
                    if let Some(status) = status {
                        startup_child
                            .lock()
                            .unwrap_or_else(|value| value.into_inner())
                            .take();
                        if !startup_quitting.load(Ordering::SeqCst) {
                            quit_with(
                                &handle,
                                format!("{} stopped", handle.package_info().name),
                                format!(
                                    "The local program exited with {status}.\n{}",
                                    tail_text(&tail)
                                ),
                            );
                        }
                        break;
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Messages could not start");

    app.run(move |_handle, event| {
        if let RunEvent::Exit = event {
            quitting.store(true, Ordering::SeqCst);
            if let Some(mut process) = child
                .lock()
                .unwrap_or_else(|value| value.into_inner())
                .take()
            {
                process.stdin.take();
                let deadline = Instant::now() + Duration::from_secs(2);
                while Instant::now() < deadline {
                    if process.try_wait().ok().flatten().is_some() {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
                let _ = process.kill();
                let _ = process.wait();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn ready_line_accepts_only_http_loopback_with_a_port() {
        assert!(parse_ready("Messages: http://127.0.0.1:1234/").is_ok());
        for line in [
            "Messages: https://127.0.0.1:1234/",
            "Messages: http://localhost:1234/",
            "Messages: http://127.0.0.1/",
            "garbage",
        ] {
            assert!(parse_ready(line).is_err(), "{line}");
        }
    }

    #[test]
    fn only_non_release_identities_override_messages_paths() {
        let data = Path::new("/tmp/messages-data");
        let home = Path::new("/tmp/home");
        assert!(isolated_environment(RELEASE_IDENTITY, data, home).is_empty());
        assert_eq!(
            isolated_environment("so.epicenter.messages.dev", data, home),
            vec![
                ("EPICENTER_DATA_DIR".into(), data.into()),
                ("EPICENTER_FOLDER_DIR".into(), home.join("Epicenter Dev")),
            ]
        );
    }

    #[test]
    fn configuration_has_no_page_capabilities_and_bundles_the_program_and_site() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let dev: Value = serde_json::from_str(include_str!("../tauri.dev.conf.json")).unwrap();
        let bundle: Value =
            serde_json::from_str(include_str!("../tauri.bundle.conf.json")).unwrap();
        assert_eq!(config["identifier"], RELEASE_IDENTITY);
        assert_eq!(config["productName"], "Messages");
        assert_eq!(dev["identifier"], "so.epicenter.messages.dev");
        assert_eq!(dev["productName"], "Messages Dev");
        assert_eq!(config["app"]["windows"], json!([]));
        assert_eq!(config["app"]["security"]["capabilities"], json!([]));
        assert_eq!(dev["app"]["security"]["capabilities"], json!([]));
        assert_eq!(config["bundle"]["active"], true);
        assert_eq!(
            bundle["bundle"]["externalBin"],
            json!(["binaries/messages-server"])
        );
        assert_eq!(bundle["bundle"]["resources"]["../build-desktop"], "site");
    }

    #[test]
    fn dropping_a_stub_child_stdin_ends_its_lifeline() {
        let mut child = Command::new("sh")
            .args(["-c", "cat >/dev/null"])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take();
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn stdout_reader_keeps_the_pipe_open_after_the_ready_line() {
        let mut ready = Command::new("sh")
            .args([
                "-c",
                "printf 'Messages: http://127.0.0.1:4321/\\n'; sleep 0.1; printf 'Replies: /tmp/replies\\nmore output\\n'",
            ])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let (send, receive) = mpsc::channel();
        let stdout = ready.stdout.take().unwrap();
        let reader = std::thread::spawn(move || drain_stdout(stdout, send));
        assert_eq!(
            receive
                .recv_timeout(Duration::from_secs(1))
                .unwrap()
                .unwrap()
                .as_str(),
            "http://127.0.0.1:4321/"
        );
        assert!(ready.wait().unwrap().success());
        reader.join().unwrap();
    }

    #[test]
    fn stdout_reader_reports_an_exit_before_readiness() {
        let mut failed = Command::new("sh")
            .args(["-c", "printf 'stub failed' >&2; exit 1"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let (send, receive) = mpsc::channel();
        let stdout = failed.stdout.take().unwrap();
        let reader = std::thread::spawn(move || drain_stdout(stdout, send));
        let reason = receive
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .unwrap_err();
        let mut stderr = String::new();
        failed
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        assert!(!failed.wait().unwrap().success());
        reader.join().unwrap();
        assert!(format!("{reason}: {stderr}").contains("stub failed"));
    }
}
