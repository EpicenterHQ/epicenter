//! The narrow runner for the `epicenter` CLI (ADR-0556).
//!
//! A page calls a fixed command here, never a generic exec. Each command maps
//! to one fixed `epicenter` invocation with typed arguments, runs the binary
//! the app bundles, and streams what it prints on stdout, one JSON value per
//! line, to the page's `Channel`. Secrets and bodies cross on stdin, never in
//! arguments.
//!
//! The runner writes stdin on its own task and drains stderr on another while
//! it reads stdout, so a child that prints before it finishes reading cannot
//! deadlock on a full pipe. Lines are read whole, however long, and the run
//! ends only when stdout closes and the child exits.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{Runtime, Webview};
use tauri_plugin_epicenter_folder::{FolderExt, GrantError};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

/// How much of the child's stderr a result keeps: the end, where the reason is.
const STDERR_TAIL_BYTES: usize = 64 * 1024;

/// How to start the `epicenter` binary: a program and the arguments that
/// come before a command's own.
#[derive(Debug, Clone)]
pub struct Program {
    pub program: PathBuf,
    pub prefix: Vec<OsString>,
}

/// The binary a release bundles beside the shell's executable, named
/// `epicenter-cli` because Tauri refuses a sidecar named like the Cargo
/// package.
#[cfg(not(debug_assertions))]
pub(crate) fn bundled_program() -> Result<Program, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("the Epicenter executable could not be found: {error}"))?;
    let directory = executable
        .parent()
        .ok_or("the Epicenter executable has no parent directory")?;
    let filename = if cfg!(windows) {
        "epicenter-cli.exe"
    } else {
        "epicenter-cli"
    };
    Ok(Program {
        program: directory.join(filename),
        prefix: Vec::new(),
    })
}

/// A development run uses the CLI's source under the `bun` on `PATH`, as the
/// development host does, so a change needs no rebuild.
#[cfg(debug_assertions)]
pub(crate) fn bundled_program() -> Result<Program, String> {
    let entry =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/cli/src/bin.ts");
    Ok(Program {
        program: PathBuf::from("bun"),
        prefix: vec!["--no-install".into(), entry.into_os_string()],
    })
}

/// How a run ended. `code` is the CLI's exit code (ADR-0520): 0 done, 1 a
/// finding a person acts on, 2 input it cannot use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct CliExit {
    pub code: i32,
    /// The end of what the CLI wrote for people, at most 64 KiB.
    pub stderr: String,
}

/// Why a command did not run the CLI, or the CLI did not finish.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "name")]
pub enum CliError {
    /// This window holds no grant for the folder.
    NotGranted { grant: GrantError },
    /// The binary could not be started or read, stopped without an exit
    /// code, or the page stopped listening.
    Failed { message: String },
}

fn failed(message: impl Into<String>) -> CliError {
    CliError::Failed {
        message: message.into(),
    }
}

/// Run `program` with `args`, write `stdin` (or nothing) on its own task, and
/// hand each line of stdout to `on_line` as it arrives. A line is passed
/// without its line ending. When `on_line` refuses a line, the child is
/// killed and the run fails.
pub async fn run(
    program: &Program,
    args: &[OsString],
    stdin: Option<Vec<u8>>,
    on_line: impl FnMut(String) -> Result<(), String>,
) -> Result<CliExit, CliError> {
    run_with_env(program, args, &[], stdin, on_line).await
}

/// [`run`], with `env` set in the child's environment, such as the shell's
/// directories for `epicenter app` (`installed_apps.rs`).
pub async fn run_with_env(
    program: &Program,
    args: &[OsString],
    env: &[(OsString, OsString)],
    stdin: Option<Vec<u8>>,
    mut on_line: impl FnMut(String) -> Result<(), String>,
) -> Result<CliExit, CliError> {
    let mut command = Command::new(&program.program);
    command
        .args(&program.prefix)
        .args(args)
        .envs(env.iter().map(|(name, value)| (name, value)))
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|error| {
        failed(format!(
            "{} could not be started: {error}",
            program.program.display()
        ))
    })?;

    let writer = match (stdin, child.stdin.take()) {
        (Some(body), Some(mut pipe)) => Some(tokio::spawn(async move {
            // A child that exits without reading all of it closes the pipe;
            // its exit code says why, so a broken pipe is not the failure.
            let _ = pipe.write_all(&body).await;
            let _ = pipe.shutdown().await;
        })),
        _ => None,
    };
    let mut stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| failed("no stderr pipe"))?;
    let stderr = tokio::spawn(async move {
        let mut tail = Vec::new();
        let mut chunk = vec![0u8; 16 * 1024];
        loop {
            match stderr_pipe.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    tail.extend_from_slice(&chunk[..read]);
                    if tail.len() > STDERR_TAIL_BYTES * 2 {
                        tail.drain(..tail.len() - STDERR_TAIL_BYTES);
                    }
                }
            }
        }
        let start = tail.len().saturating_sub(STDERR_TAIL_BYTES);
        String::from_utf8_lossy(&tail[start..]).into_owned()
    });

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| failed("no stdout pipe"))?;
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::new();
    let mut refused = None;
    loop {
        line.clear();
        let read = reader
            .read_until(b'\n', &mut line)
            .await
            .map_err(|error| failed(format!("the CLI's output could not be read: {error}")))?;
        if read == 0 {
            break;
        }
        while matches!(line.last(), Some(b'\n' | b'\r')) {
            line.pop();
        }
        if line.is_empty() {
            continue;
        }
        let text = match String::from_utf8(std::mem::take(&mut line)) {
            Ok(text) => text,
            Err(_) => {
                refused = Some("the CLI printed a line that is not UTF-8".to_string());
                break;
            }
        };
        if let Err(message) = on_line(text) {
            refused = Some(message);
            break;
        }
    }
    if let Some(message) = refused {
        let _ = child.kill().await;
        return Err(failed(message));
    }

    let status = child
        .wait()
        .await
        .map_err(|error| failed(format!("the CLI could not be waited for: {error}")))?;
    if let Some(writer) = writer {
        let _ = writer.await;
    }
    let stderr = stderr.await.unwrap_or_default();
    match status.code() {
        Some(code) => Ok(CliExit { code, stderr }),
        None => Err(failed(format!(
            "the CLI stopped without an exit code ({status})"
        ))),
    }
}

/// The arguments for `epicenter check <root> --json`.
fn check_args(root: PathBuf) -> Vec<OsString> {
    vec!["check".into(), root.into_os_string(), "--json".into()]
}

/// `epicenter check <folder> --json` on a folder this window was granted
/// (ADR-0520), its one JSON line sent to `on_line`. Granted to the Folders
/// window alone.
#[tauri::command]
#[specta::specta]
pub async fn folder_check<R: Runtime>(
    webview: Webview<R>,
    scope: String,
    on_line: Channel<String>,
) -> Result<CliExit, CliError> {
    let root = webview
        .folders()
        .granted_root(&scope, webview.label())
        .map_err(|grant| CliError::NotGranted { grant })?;
    run(
        &bundled_program().map_err(failed)?,
        &check_args(root),
        None,
        |line| on_line.send(line).map_err(|error| error.to_string()),
    )
    .await
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::{json, Value};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
    use tauri::utils::acl::ExecutionContext;
    use tauri::webview::InvokeRequest;
    use tauri::WebviewWindowBuilder;
    use tauri_plugin_epicenter_folder::{Author, FolderConfig, ScopeConfig};

    use super::*;

    fn scratch(label: &str) -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "epicenter-cli-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(dir).unwrap()
    }

    /// A child that prints a megabyte and a 300 KB line before it reads any
    /// of a 4 MB stdin, then reports what it read, writes to stderr, and
    /// exits 1. A runner that wrote stdin before reading stdout would block
    /// on both full pipes; one that capped a line would cut the long one.
    /// The child is a script run with the `bun` on `PATH`, standing in for
    /// the compiled binary, which takes the same pipes.
    #[tokio::test]
    async fn streams_every_line_while_writing_stdin_and_keeps_the_exit_code() {
        let dir = scratch("pipes");
        let script = dir.join("child.ts");
        fs::write(
            &script,
            r#"
const out = Bun.stdout.writer();
for (let i = 0; i < 1000; i++) out.write(JSON.stringify({ i, pad: 'x'.repeat(1000) }) + '\n');
out.write(JSON.stringify({ long: 'y'.repeat(300_000) }) + '\n');
await out.flush();
const input = await Bun.stdin.bytes();
process.stderr.write('e'.repeat(200_000) + 'the end\n');
out.write(JSON.stringify({ read: input.length }) + '\n');
await out.flush();
process.exitCode = 1;
"#,
        )
        .unwrap();
        let program = Program {
            program: PathBuf::from("bun"),
            prefix: vec![script.into_os_string()],
        };
        let body = vec![b'z'; 4 * 1024 * 1024];
        let mut lines = Vec::new();
        let exit = run(&program, &[], Some(body), |line| {
            lines.push(line);
            Ok(())
        })
        .await
        .unwrap();

        assert_eq!(exit.code, 1);
        assert!(exit.stderr.ends_with("the end\n"));
        assert!(exit.stderr.len() <= STDERR_TAIL_BYTES);
        assert_eq!(lines.len(), 1002);
        for (index, line) in lines[..1000].iter().enumerate() {
            let value: Value = serde_json::from_str(line).unwrap();
            assert_eq!(value["i"], index);
        }
        let long: Value = serde_json::from_str(&lines[1000]).unwrap();
        assert_eq!(long["long"].as_str().unwrap().len(), 300_000);
        let last: Value = serde_json::from_str(&lines[1001]).unwrap();
        assert_eq!(last["read"], 4 * 1024 * 1024);
        let _ = fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_listener_that_stops_ends_the_run() {
        let program = Program {
            program: PathBuf::from("bun"),
            prefix: vec!["-e".into(), "for (;;) process.stdout.write('{}\\n')".into()],
        };
        let mut seen = 0;
        let ended = run(&program, &[], None, |_| {
            seen += 1;
            if seen == 3 {
                Err("the page went away".into())
            } else {
                Ok(())
            }
        })
        .await
        .unwrap_err();
        assert_eq!(
            ended,
            CliError::Failed {
                message: "the page went away".into()
            }
        );
    }

    #[tokio::test]
    async fn a_binary_that_cannot_start_fails() {
        let program = Program {
            program: PathBuf::from("/nonexistent/epicenter-cli"),
            prefix: Vec::new(),
        };
        let CliError::Failed { message } = run(&program, &[], None, |_| Ok(())).await.unwrap_err()
        else {
            panic!("not a failure");
        };
        assert!(message.contains("could not be started"), "{message}");
    }

    fn invoke(
        window: &tauri::WebviewWindow<MockRuntime>,
        command: &str,
        args: Value,
    ) -> Result<Value, Value> {
        tauri::test::get_ipc_response(
            window,
            InvokeRequest {
                cmd: command.to_string(),
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

    /// `folder_check` runs only on a folder this window was granted, and then
    /// runs `epicenter check <root> --json`: here the CLI's source under
    /// `bun`, which is what a development build runs.
    #[tokio::test]
    async fn folder_check_runs_check_on_the_granted_folder_only() {
        let root = scratch("check");
        fs::write(
            root.join("epicenter.json"),
            r#"{"kv":{"type":"object","properties":{}},"tables":{"notes":{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}}}"#,
        )
        .unwrap();
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("notes/a.md"), "---\ntitle: A\n---\n").unwrap();
        fs::write(root.join("notes/b.md"), "---\ntitle: 3\n---\n").unwrap();

        let mut context = mock_context(noop_assets());
        context.runtime_authority_mut().__allow_command(
            "plugin:epicenter-folder|grant_directory".into(),
            ExecutionContext::Local,
        );
        let app = mock_builder()
            .plugin(tauri_plugin_epicenter_folder::init())
            .build(context)
            .expect("mock app");
        app.folders()
            .register(ScopeConfig {
                scope: "data:notes".into(),
                folder: FolderConfig::data(
                    &root,
                    Author {
                        name: "Test".into(),
                        email: "test@localhost".into(),
                    },
                ),
                windows: vec!["folders".into()],
            })
            .unwrap();
        let folders = WebviewWindowBuilder::new(&app, "folders", Default::default())
            .build()
            .unwrap();
        let other = WebviewWindowBuilder::new(&app, "other", Default::default())
            .build()
            .unwrap();
        let webview = |window: &tauri::WebviewWindow<MockRuntime>| window.as_ref().clone();
        let lines = || {
            let (sender, receiver) = std::sync::mpsc::channel::<String>();
            let channel = Channel::new(move |body| {
                let tauri::ipc::InvokeResponseBody::Json(text) = body else {
                    panic!("a JSON message");
                };
                sender.send(serde_json::from_str(&text).unwrap()).unwrap();
                Ok(())
            });
            (channel, receiver)
        };

        let (channel, _) = lines();
        let refused = folder_check(webview(&folders), "data:notes".into(), channel)
            .await
            .unwrap_err();
        assert!(
            matches!(refused, CliError::NotGranted { .. }),
            "{refused:?}"
        );
        let (channel, _) = lines();
        let refused = folder_check(webview(&other), "data:notes".into(), channel)
            .await
            .unwrap_err();
        assert!(
            matches!(refused, CliError::NotGranted { .. }),
            "{refused:?}"
        );

        invoke(
            &folders,
            "plugin:epicenter-folder|grant_directory",
            json!({ "scope": "data:notes" }),
        )
        .unwrap();
        let (channel, received) = lines();
        let exit = folder_check(webview(&folders), "data:notes".into(), channel)
            .await
            .unwrap();
        assert_eq!(exit.code, 1, "{}", exit.stderr);
        let report: Value = serde_json::from_str(&received.recv().unwrap()).unwrap();
        assert_eq!(report["rows"], 1);
        assert_eq!(report["invalid"][0]["path"], "notes/b.md");
        assert!(received.try_recv().is_err(), "check prints one line");

        app.folders().shutdown();
        let _ = fs::remove_dir_all(root);
    }
}
