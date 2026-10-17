//! The narrow runner for the `epicenter` CLI (ADR-0556).
//!
//! A page calls a fixed command here, never a generic exec. Each command maps
//! to one fixed `epicenter` invocation with typed arguments, runs the binary
//! the app bundles, and streams what it prints on stdout, one JSON value per
//! line, to the page's `Channel`. Secrets and bodies cross on stdin, never in
//! arguments.
//!
//! Every command starts the CLI through one [`Invocation`]: the bundled
//! program, the deployment this shell is configured for in
//! `EPICENTER_API_URL`, and this shell's directories in `EPICENTER_DATA_DIR`,
//! `EPICENTER_FOLDER_DIR`, and `EPICENTER_CACHE_DIR`, so the CLI a command
//! runs names the same deployment and files as the shell, whichever command
//! it is. A command a page calls is that window's ([`CliChildren`]): its
//! child ends when the page reloads or the window closes.
//!
//! The runner writes stdin on its own task and drains stderr on another while
//! it reads stdout, so a child that prints before it finishes reading cannot
//! deadlock on a full pipe. Lines are read whole, however long, and the run
//! ends only when stdout closes and the child exits.
//!
//! A run that ends early, because its listener refused a line, its page
//! ended, or its future was dropped, asks the child to stop and kills it
//! only after [`STOP_GRACE`], so a refresh the child already sent reaches
//! the keychain (ADR-0565).

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime, Webview};
use tauri_plugin_epicenter_folder::GrantError;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Notify;

use crate::app_data::DesktopPaths;

/// How much of the child's stderr a result keeps: the end, where the reason is.
const STDERR_TAIL_BYTES: usize = 64 * 1024;

/// How long a child asked to stop has before it is killed with its process
/// group. The CLI waits at most two seconds for a refresh it sent to reach
/// the keychain before it exits (ADR-0565), so this is longer.
pub(crate) const STOP_GRACE: Duration = Duration::from_secs(3);

/// A child this run owns until it is waited for. Dropped before then, because
/// its listener refused a line, its page ended, or its future was dropped,
/// it is asked to stop and killed only after [`STOP_GRACE`]. This is the
/// shell's one way of ending a CLI child.
struct Running(Option<Child>);

impl Running {
    fn child(&mut self) -> &mut Child {
        self.0
            .as_mut()
            .expect("the child is owned until it is waited for")
    }

    async fn wait(mut self) -> std::io::Result<ExitStatus> {
        let status = self.child().wait().await;
        self.0 = None;
        status
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        let Some(child) = self.0.take() else {
            return;
        };
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn(stop(child));
            }
            Err(_) => {
                let mut child = child;
                let _ = child.start_kill();
            }
        }
    }
}

/// Ask `child` and its process group to stop, then kill them if they still
/// run after [`STOP_GRACE`].
async fn stop(mut child: Child) {
    #[cfg(unix)]
    {
        signal_group(&child, libc::SIGTERM);
        if tokio::time::timeout(STOP_GRACE, child.wait()).await.is_ok() {
            return;
        }
        signal_group(&child, libc::SIGKILL);
    }
    let _ = child.kill().await;
}

/// Signal the process group `child` leads (`process_group(0)`), while it is
/// not yet reaped, so the ID cannot name another process.
#[cfg(unix)]
fn signal_group(child: &Child, signal: libc::c_int) {
    let Some(group) = child.id().and_then(|pid| libc::pid_t::try_from(pid).ok()) else {
        return;
    };
    // SAFETY: `kill` takes no pointers; the group is the child's own.
    unsafe {
        libc::kill(-group, signal);
    }
}

/// The `epicenter` children each window's page started, by window label,
/// each as the signal that ends its run. Cloning shares the one record, so a
/// run can hold it across its awaits.
#[derive(Clone, Default)]
pub struct CliChildren {
    running: Arc<Mutex<HashMap<String, Vec<Arc<Notify>>>>>,
}

impl CliChildren {
    fn state(&self) -> std::sync::MutexGuard<'_, HashMap<String, Vec<Arc<Notify>>>> {
        self.running
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn start(&self, window: &str) -> Arc<Notify> {
        let end = Arc::new(Notify::new());
        self.state()
            .entry(window.to_string())
            .or_default()
            .push(Arc::clone(&end));
        end
    }

    fn finish(&self, window: &str, end: &Arc<Notify>) {
        let mut state = self.state();
        if let Some(children) = state.get_mut(window) {
            children.retain(|other| !Arc::ptr_eq(other, end));
            if children.is_empty() {
                state.remove(window);
            }
        }
    }

    /// The page in `window` is over: it reloaded, navigated, or the window
    /// was destroyed. Every run it started ends the way a run that ends
    /// early does ([`Running`]): its child and the processes the child
    /// started are asked to stop, and killed after [`STOP_GRACE`].
    pub fn page_ended(&self, window: &str) {
        for end in self.state().remove(window).unwrap_or_default() {
            // A run not yet waiting keeps the permit and ends when it waits.
            end.notify_one();
        }
    }

    /// How many children `window`'s page has running.
    #[cfg(test)]
    pub(crate) fn running(&self, window: &str) -> usize {
        self.state().get(window).map_or(0, Vec::len)
    }
}

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
    Ok(Program {
        program: directory.join("epicenter-cli"),
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
    /// The last line the CLI printed on stdout: a command's one answer, or
    /// `{"error": ...}`.
    pub reply: Option<String>,
    /// The end of what the CLI wrote for people, at most 64 KiB.
    pub stderr: String,
}

impl CliExit {
    /// The message of a reply `{"error": "<message>"}`, the CLI's refusal.
    fn refusal(&self) -> Option<String> {
        let value = serde_json::from_str::<Value>(self.reply.as_deref()?).ok()?;
        value.get("error")?.as_str().map(str::to_string)
    }

    /// Why `epicenter <what>` did not do what it was asked: its refusal, or
    /// the end of what it wrote for people, or its exit code.
    pub(crate) fn failure(&self, what: &str) -> String {
        self.refusal()
            .or_else(|| Some(self.stderr.trim().to_string()).filter(|text| !text.is_empty()))
            .unwrap_or_else(|| format!("epicenter {what} exited with {}", self.code))
    }

    /// The one JSON value a command that exited 0 answered. A refusal is
    /// [`CliError::Refused`]; anything else is a failure naming `what`.
    fn answer<T: serde::de::DeserializeOwned>(self, what: &str) -> Result<T, CliError> {
        let value = self
            .reply
            .as_deref()
            .and_then(|line| serde_json::from_str::<Value>(line).ok());
        match value {
            Some(value) if self.code == 0 => serde_json::from_value(value).map_err(|error| {
                failed(format!(
                    "epicenter {what} answered something that does not read: {error}"
                ))
            }),
            _ => match self.refusal() {
                Some(message) => Err(CliError::Refused { message }),
                None => Err(failed(format!(
                    "epicenter {what} exited {}: {}",
                    self.code,
                    self.stderr.trim()
                ))),
            },
        }
    }
}

/// Why a command did not run the CLI, or the CLI did not finish.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "name")]
pub enum CliError {
    /// This window holds no grant for the folder.
    NotGranted { grant: GrantError },
    /// The CLI refused the input with exit code 2 and said why on stdout:
    /// an id, an endpoint, or a keychain it cannot use.
    Refused { message: String },
    /// The binary could not be started or read, stopped without an exit
    /// code, or the page stopped listening.
    Failed { message: String },
}

pub(crate) fn failed(message: impl Into<String>) -> CliError {
    CliError::Failed {
        message: message.into(),
    }
}

/// How this shell starts the `epicenter` CLI: the program, the environment
/// every run gets, whether it selects the app's own grant (`--desktop`,
/// ADR-0558), and the window whose page the run belongs to.
#[derive(Clone)]
pub(crate) struct Invocation {
    program: Program,
    env: Vec<(OsString, OsString)>,
    desktop: bool,
    owner: Option<(CliChildren, String)>,
}

impl Invocation {
    /// `program` with the deployment at `origin` and this shell's `paths`,
    /// as the CLI reads them (`app-paths.ts`, `authContext`).
    pub(crate) fn new(program: Program, origin: &str, paths: &DesktopPaths) -> Self {
        Self {
            program,
            env: vec![
                ("EPICENTER_API_URL".into(), origin.into()),
                ("EPICENTER_DATA_DIR".into(), paths.data_dir.clone().into()),
                (
                    "EPICENTER_FOLDER_DIR".into(),
                    paths.folder_dir.clone().into(),
                ),
                ("EPICENTER_CACHE_DIR".into(), paths.cache_dir.clone().into()),
            ],
            desktop: false,
            owner: None,
        }
    }

    /// Run as the desktop app's grant: `--desktop` follows the arguments.
    pub(crate) fn desktop(mut self) -> Self {
        self.desktop = true;
        self
    }

    /// One more variable in the child's environment.
    #[cfg(test)]
    pub(crate) fn env(mut self, name: &str, value: impl Into<OsString>) -> Self {
        self.env.push((name.into(), value.into()));
        self
    }

    /// The run belongs to `window`'s page, and ends with it.
    pub(crate) fn owned_by(mut self, children: &CliChildren, window: &str) -> Self {
        self.owner = Some((children.clone(), window.to_string()));
        self
    }

    /// Run `epicenter <args>`, write `stdin` (or nothing) on its own task,
    /// and hand each line of stdout to `on_line` as it arrives. A line is
    /// passed without its line ending. When `on_line` refuses a line, the
    /// child is stopped, gracefully (`STOP_GRACE`), and the run fails.
    pub(crate) async fn run(
        &self,
        args: &[OsString],
        stdin: Option<Vec<u8>>,
        on_line: impl FnMut(String) -> Result<(), String>,
    ) -> Result<CliExit, CliError> {
        let mut args = args.to_vec();
        if self.desktop {
            args.push("--desktop".into());
        }
        let end = self
            .owner
            .as_ref()
            .map(|(children, window)| children.start(window));
        let exit = run_child(&self.program, &args, &self.env, stdin, on_line, end.clone()).await;
        if let (Some((children, window)), Some(end)) = (&self.owner, &end) {
            children.finish(window, end);
        }
        exit
    }

    /// Run `epicenter <args>` that answers one JSON value, and read it.
    async fn answer<T: serde::de::DeserializeOwned>(
        &self,
        args: &[&str],
        stdin: Option<Vec<u8>>,
    ) -> Result<T, CliError> {
        let args: Vec<OsString> = args.iter().map(OsString::from).collect();
        let what = args
            .iter()
            .map(|arg| arg.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        self.run(&args, stdin, |_| Ok(())).await?.answer(&what)
    }
}

/// How this shell starts the CLI, for work no page owns, such as the launch
/// call. Fails when the shell's directories or deployment are not known.
pub(crate) fn invocation<R: Runtime>(app: &AppHandle<R>) -> Result<Invocation, CliError> {
    let paths = app
        .try_state::<DesktopPaths>()
        .ok_or_else(|| failed("the shell's directories are not resolved yet"))?;
    Ok(Invocation::new(
        bundled_program().map_err(failed)?,
        &crate::deployment_origin().map_err(failed)?,
        &paths,
    ))
}

/// How this shell starts the CLI for a command `webview`'s page called: the
/// child is that window's, and ends when its page does.
pub(crate) fn window_invocation<R: Runtime>(webview: &Webview<R>) -> Result<Invocation, CliError> {
    let children = webview.state::<CliChildren>();
    Ok(invocation(webview.app_handle())?.owned_by(&children, webview.label()))
}

/// Run `program` with `args` and `env` until it exits, or until `end` is
/// signalled ([`CliChildren::page_ended`]). The child leads its own process
/// group, so stopping it ends every process it started.
async fn run_child(
    program: &Program,
    args: &[OsString],
    env: &[(OsString, OsString)],
    stdin: Option<Vec<u8>>,
    mut on_line: impl FnMut(String) -> Result<(), String>,
    end: Option<Arc<Notify>>,
) -> Result<CliExit, CliError> {
    let ended = async move {
        match end {
            Some(end) => end.notified().await,
            None => std::future::pending().await,
        }
    };
    tokio::pin!(ended);
    const PAGE_ENDED: &str = "the page that started the CLI ended";
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
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    let mut running = Running(Some(command.spawn().map_err(|error| {
        failed(format!(
            "{} could not be started: {error}",
            program.program.display()
        ))
    })?));
    let child = running.child();

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
    let mut reply = None;
    let mut refused = None;
    loop {
        line.clear();
        let read = tokio::select! {
            read = reader.read_until(b'\n', &mut line) => read
                .map_err(|error| failed(format!("the CLI's output could not be read: {error}")))?,
            // Dropping `running` stops the child.
            () = &mut ended => return Err(failed(PAGE_ENDED)),
        };
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
        reply = Some(text.clone());
        if let Err(message) = on_line(text) {
            refused = Some(message);
            break;
        }
    }
    if let Some(message) = refused {
        // Dropping `running` stops the child.
        return Err(failed(message));
    }

    let status = tokio::select! {
        status = running.wait() => status
            .map_err(|error| failed(format!("the CLI could not be waited for: {error}")))?,
        () = &mut ended => return Err(failed(PAGE_ENDED)),
    };
    if let Some(writer) = writer {
        let _ = writer.await;
    }
    let stderr = stderr.await.unwrap_or_default();
    match status.code() {
        Some(code) => Ok(CliExit {
            code,
            reply,
            stderr,
        }),
        None => Err(failed(format!(
            "the CLI stopped without an exit code ({status})"
        ))),
    }
}

/// The arguments for the launch call: point `~/.local/bin/epicenter`, the
/// path every Git configuration Epicenter writes runs (ADR-0566, ADR-0567),
/// at the binary this launch bundles. It never needs an administrator.
fn command_link_args() -> Vec<OsString> {
    vec!["install-command".into(), "--json".into()]
}

/// Run `epicenter install-command --json`. A run that does not
/// exit 0, such as one from an App Translocation copy, is an error naming
/// what the CLI printed.
pub(crate) async fn refresh_command_link(invocation: &Invocation) -> Result<(), String> {
    let mut printed = Vec::new();
    let exit = invocation
        .run(&command_link_args(), None, |line| {
            printed.push(line);
            Ok(())
        })
        .await
        .map_err(|error| format!("{error:?}"))?;
    if exit.code == 0 {
        return Ok(());
    }
    Err(format!(
        "exit {}: {} {}",
        exit.code,
        printed.join(" "),
        exit.stderr.trim()
    ))
}

/// The launch call, in the background so a launch never waits on it, with
/// this shell's `paths`, which the app does not manage yet. A development
/// build runs the CLI from source, which has no binary to link, so it
/// leaves the link to the release build.
pub(crate) fn spawn_command_link_refresh(paths: &DesktopPaths) {
    if cfg!(debug_assertions) {
        return;
    }
    let invocation = bundled_program().and_then(|program| {
        crate::deployment_origin().map(|origin| Invocation::new(program, &origin, paths))
    });
    tauri::async_runtime::spawn(async move {
        let result = match invocation {
            Ok(invocation) => refresh_command_link(&invocation).await,
            Err(message) => Err(message),
        };
        if let Err(message) = result {
            log::warn!("the epicenter command link was not refreshed: {message}");
        }
    });
}

/// Whether this launch's `epicenter declare-epicenter-folder` has finished,
/// one way or the other. An installed app may read `so.epicenter` through a
/// definition its declaration must contain (ADR-0538), so no installed app
/// opens before it, whichever window opened first.
#[derive(Clone)]
pub struct EpicenterFolderDeclared(tokio::sync::watch::Receiver<bool>);

impl EpicenterFolderDeclared {
    /// Resolves once the launch's declaration has finished.
    pub async fn finished(&self) {
        let mut receiver = self.0.clone();
        let _ = receiver.wait_for(|done| *done).await;
    }
}

/// The second launch call, in the background: publish `so.epicenter`'s
/// declaration through the CLI (`packages/cli/src/epicenter-folder.ts`),
/// with this shell's `paths`, in every build. A failure is logged; apps
/// that read the folder then refuse it as `ShapeMismatch`, which they say.
pub(crate) fn spawn_epicenter_folder_declaration(paths: &DesktopPaths) -> EpicenterFolderDeclared {
    let (sender, receiver) = tokio::sync::watch::channel(false);
    let invocation = bundled_program().and_then(|program| {
        crate::deployment_origin().map(|origin| Invocation::new(program, &origin, paths))
    });
    tauri::async_runtime::spawn(async move {
        let result = match invocation {
            Ok(invocation) => invocation
                .answer::<Value>(&["declare-epicenter-folder", "--json"], None)
                .await
                .map(|_| ())
                .map_err(|error| format!("{error:?}")),
            Err(message) => Err(message),
        };
        if let Err(message) = result {
            log::warn!("Epicenter's own folder was not declared: {message}");
        }
        let _ = sender.send(true);
    });
    EpicenterFolderDeclared(receiver)
}

// ---------------------------------------------------------------------------
// AI connections (ADR-0557): one request over a connection, and its key in
// the keychain. The CLI holds both; these commands only carry the page's
// typed input to one fixed invocation, so no page reads a saved key.
// ---------------------------------------------------------------------------

/// Where a request goes: a connection by its id, which is the stem of its row
/// in `so.epicenter/connections`. An `openai-compatible` target names the
/// endpoint the page prepared the request for; the CLI sends only while the
/// keychain entry still holds it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AiTarget {
    OpenaiCompatible {
        connection: String,
        endpoint: String,
    },
    Epicenter {
        connection: String,
    },
    Local {
        connection: String,
    },
}

impl AiTarget {
    fn connection(&self) -> &str {
        match self {
            Self::OpenaiCompatible { connection, .. }
            | Self::Epicenter { connection }
            | Self::Local { connection } => connection,
        }
    }
}

/// One request `epicenter send` carries, relative to its target: below an AI
/// connection's endpoint, or below the deployment's origin for an account
/// request.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, specta::Type)]
pub struct AiRequest {
    pub method: String,
    /// Below the target, such as `audio/transcriptions` or `api/repos`.
    pub path: String,
    pub headers: Vec<(String, String)>,
    /// The body in base64, decoded here and written to the CLI as raw bytes.
    pub body: Option<String>,
}

/// What this computer's keychain holds for a connection. Never the key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum AiKeyState {
    Missing,
    Saved {
        endpoint: String,
        #[serde(rename = "hasKey")]
        has_key: bool,
    },
}

/// A connection id, as `@epicenter/ai/send` reads one: it goes into the
/// CLI's arguments, so it may never look like an option.
fn connection_id(id: &str) -> Result<&str, CliError> {
    let valid = (1..=128).contains(&id.len())
        && id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if valid {
        Ok(id)
    } else {
        Err(CliError::Refused {
            message: format!("'{id}' is not a connection id"),
        })
    }
}

/// What `epicenter send` reads on stdin: one JSON line naming the target
/// and the request, then the body's raw bytes (`encodeSendInput` in
/// `@epicenter/ai/send`).
fn send_input(target: &impl Serialize, request: &AiRequest) -> Result<Vec<u8>, CliError> {
    let body = match &request.body {
        Some(encoded) => STANDARD
            .decode(encoded)
            .map_err(|error| CliError::Refused {
                message: format!("the request body is not base64: {error}"),
            })?,
        None => Vec::new(),
    };
    let mut input = serde_json::to_vec(&json!({
        "target": target,
        "request": {
            "method": request.method,
            "path": request.path,
            "headers": request.headers,
        },
    }))
    .map_err(|error| failed(error.to_string()))?;
    input.push(b'\n');
    input.extend_from_slice(&body);
    Ok(input)
}

/// `epicenter send --json` over `target` as the app's grant, each NDJSON
/// line handed to `on_line`. `--desktop` gives an Epicenter connection and
/// an account request the app's own grant (ADR-0558).
async fn run_send(
    invocation: &Invocation,
    target: &impl Serialize,
    request: &AiRequest,
    on_line: impl FnMut(String) -> Result<(), String>,
) -> Result<CliExit, CliError> {
    let input = send_input(target, request)?;
    invocation
        .clone()
        .desktop()
        .run(&["send".into(), "--json".into()], Some(input), on_line)
        .await
}

/// [`run_send`] over an AI connection, whose id is checked first.
async fn send_with(
    invocation: &Invocation,
    target: &AiTarget,
    request: &AiRequest,
    on_line: impl FnMut(String) -> Result<(), String>,
) -> Result<CliExit, CliError> {
    connection_id(target.connection())?;
    run_send(invocation, target, request, on_line).await
}

/// Send one line of a send's output to the page's channel.
fn to_channel(on_event: &Channel<String>) -> impl FnMut(String) -> Result<(), String> + '_ {
    |line| on_event.send(line).map_err(|error| error.to_string())
}

/// After a send's own lines, one more, `{"type":"exit","code","stderr"}`, so
/// a page that sees it knows no other line is coming, whenever the command's
/// own result arrives.
fn end_channel(on_event: &Channel<String>, exit: CliExit) -> Result<CliExit, CliError> {
    let last = json!({ "type": "exit", "code": exit.code, "stderr": exit.stderr });
    on_event
        .send(last.to_string())
        .map_err(|error| failed(error.to_string()))?;
    Ok(exit)
}

/// Run one `epicenter auth key <action> <connection> --json` and read its
/// answer.
async fn key_command<T: serde::de::DeserializeOwned>(
    invocation: &Invocation,
    action: &str,
    connection: &str,
    stdin: Option<Vec<u8>>,
) -> Result<T, CliError> {
    let connection = connection_id(connection)?;
    invocation
        .answer(&["auth", "key", action, connection, "--json"], stdin)
        .await
}

async fn key_set_with(
    invocation: &Invocation,
    connection: &str,
    endpoint: &str,
    key: &str,
) -> Result<AiKeyState, CliError> {
    let input = serde_json::to_vec(&json!({ "endpoint": endpoint, "key": key }))
        .map_err(|error| failed(error.to_string()))?;
    key_command(invocation, "set", connection, Some(input)).await
}

async fn key_state_with(invocation: &Invocation, connection: &str) -> Result<AiKeyState, CliError> {
    key_command(invocation, "state", connection, None).await
}

/// What `epicenter auth key remove` answers.
#[derive(Deserialize)]
struct KeyRemoved {
    removed: bool,
}

async fn key_remove_with(invocation: &Invocation, connection: &str) -> Result<bool, CliError> {
    let answer: KeyRemoved = key_command(invocation, "remove", connection, None).await?;
    Ok(answer.removed)
}

/// Send one request over an AI connection with the key saved on this
/// computer, through `epicenter send` (ADR-0557). Each line of its NDJSON
/// (the response's head, its body in base64 chunks, and `end`, or an
/// `error`) goes to `on_event`; the page reads them back into a `Response`.
/// One more line, `{"type":"exit","code","stderr"}`, follows the CLI's own
/// on the same channel (`end_channel`).
#[tauri::command]
#[specta::specta]
pub async fn ai_send(
    webview: Webview,
    connection: AiTarget,
    request: AiRequest,
    on_event: Channel<String>,
) -> Result<CliExit, CliError> {
    let exit = send_with(
        &window_invocation(&webview)?,
        &connection,
        &request,
        to_channel(&on_event),
    )
    .await?;
    end_channel(&on_event, exit)
}

/// Save `endpoint` and `key` for `connection` in this computer's keychain,
/// through `epicenter auth key set`, which reads both on stdin. An empty key
/// confirms a keyless endpoint.
#[tauri::command]
#[specta::specta]
pub async fn ai_key_set(
    webview: Webview,
    connection: String,
    endpoint: String,
    key: String,
) -> Result<AiKeyState, CliError> {
    key_set_with(&window_invocation(&webview)?, &connection, &endpoint, &key).await
}

/// Remove what this computer saved for `connection`; whether there was anything.
#[tauri::command]
#[specta::specta]
pub async fn ai_key_remove(webview: Webview, connection: String) -> Result<bool, CliError> {
    key_remove_with(&window_invocation(&webview)?, &connection).await
}

/// Whether a key is saved for `connection`, and for which endpoint. Never the key.
#[tauri::command]
#[specta::specta]
pub async fn ai_key_state(webview: Webview, connection: String) -> Result<AiKeyState, CliError> {
    key_state_with(&window_invocation(&webview)?, &connection).await
}

// ---------------------------------------------------------------------------
// Account requests (ADR-0549, ADR-0556): a page's call to one of the
// deployment's resources, which `epicenter send` makes with the app's grant.
// The page names the resource by role and never holds the token.
// ---------------------------------------------------------------------------

/// The deployment's resources an account request may carry a token for, by
/// role: `api` for the profile read, `git` for Git and the folder connect
/// call. A closed set, so a page cannot name an audience of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum AccountAudience {
    Api,
    Git,
}

/// The account target `epicenter send` reads: `{"kind":"account","audience"}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum AccountTarget {
    Account { audience: AccountAudience },
}

/// `epicenter send --json --desktop` with an account target. The CLI sends
/// only a path below the deployment's `/api/`.
async fn account_send_with(
    invocation: &Invocation,
    audience: AccountAudience,
    request: &AiRequest,
    on_line: impl FnMut(String) -> Result<(), String>,
) -> Result<CliExit, CliError> {
    run_send(
        invocation,
        &AccountTarget::Account { audience },
        request,
        on_line,
    )
    .await
}

/// Send one request to the deployment's `audience` resource with the app's
/// grant, through `epicenter send` (ADR-0549, ADR-0556). The lines are
/// `ai_send`'s: the response's head, its body in base64 chunks, and `end`,
/// or an `error` such as `NoAccountToken` when the app is not signed in,
/// then the shell's own `{"type":"exit","code","stderr"}`.
#[tauri::command]
#[specta::specta]
pub async fn account_send(
    webview: Webview,
    audience: AccountAudience,
    request: AiRequest,
    on_event: Channel<String>,
) -> Result<CliExit, CliError> {
    let exit = account_send_with(
        &window_invocation(&webview)?,
        audience,
        &request,
        to_channel(&on_event),
    )
    .await?;
    end_channel(&on_event, exit)
}

// ---------------------------------------------------------------------------
// The app's sign-in (ADR-0549, ADR-0558): the CLI's desktop grant, client
// `so.epicenter`, which only these commands and `send` select with
// `--desktop`. Rust holds no token; it opens the authorization page the CLI
// names and reports what the CLI says.
// ---------------------------------------------------------------------------

/// Who approved a grant, as the server's userinfo answered at sign-in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct AuthAccount {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
}

/// One of the CLI's grants: `device` (a terminal's `epicenter auth login`)
/// or `desktop` (this app's).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthGrant {
    pub grant: String,
    pub client: String,
    pub signed_in: bool,
    #[serde(default)]
    pub account: Option<AuthAccount>,
    #[serde(default)]
    pub signed_in_at: Option<String>,
}

/// `epicenter auth status --json`: the deployment and each grant on this
/// computer, read from the keychain alone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct AuthStatus {
    pub origin: String,
    pub grants: Vec<AuthGrant>,
}

/// What signing the app out did: whether it was signed in, and whether the
/// server heard the revocation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthSignOut {
    pub signed_out: bool,
    pub revoked: bool,
}

/// The page the CLI asks to open must be this deployment's authorization
/// endpoint, so a CLI that misbehaved could not send the person elsewhere.
fn authorization_page(url: &str, origin: &str) -> Result<(), String> {
    let parsed = tauri::Url::parse(url).map_err(|error| format!("{url}: {error}"))?;
    if parsed.origin().ascii_serialization() != origin
        || parsed.path() != "/auth/oauth2/authorize"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err(format!(
            "the CLI asked to open {url}, which is not {origin}/auth/oauth2/authorize"
        ));
    }
    Ok(())
}

/// `epicenter auth login --json --desktop`: hand `open` the
/// authorization page the CLI prints, and every line to `on_line`. The page
/// must be on `origin`, the deployment the invocation names.
async fn login_with(
    invocation: &Invocation,
    origin: &str,
    mut open: impl FnMut(&str) -> Result<(), String>,
    mut on_line: impl FnMut(String) -> Result<(), String>,
) -> Result<CliExit, CliError> {
    invocation
        .clone()
        .desktop()
        .run(
            &["auth".into(), "login".into(), "--json".into()],
            None,
            |line| {
                if let Ok(Value::Object(object)) = serde_json::from_str::<Value>(&line) {
                    if let Some(url) = object.get("open").and_then(Value::as_str) {
                        authorization_page(url, origin)?;
                        open(url)?;
                    }
                }
                on_line(line)
            },
        )
        .await
}

/// Sign the app in: the CLI's loopback sign-in as `so.epicenter`. The shell
/// opens the authorization page in the person's browser; each line the CLI
/// prints (`{"open"}`, then `{"signedIn"}` or `{"error"}`) goes to
/// `on_event`.
#[tauri::command]
#[specta::specta]
pub async fn auth_login<R: Runtime>(
    webview: Webview<R>,
    on_event: Channel<String>,
) -> Result<CliExit, CliError> {
    use tauri_plugin_opener::OpenerExt;
    let origin = crate::deployment_origin().map_err(failed)?;
    let app = webview.app_handle().clone();
    login_with(
        &window_invocation(&webview)?,
        &origin,
        |url| {
            app.opener()
                .open_url(url, None::<String>)
                .map_err(|error| format!("the browser could not be opened: {error}"))
        },
        |line| on_event.send(line).map_err(|error| error.to_string()),
    )
    .await
}

/// Who each of the CLI's grants on this computer belongs to.
#[tauri::command]
#[specta::specta]
pub async fn auth_status(webview: Webview) -> Result<AuthStatus, CliError> {
    window_invocation(&webview)?
        .desktop()
        .answer(&["auth", "status", "--json"], None)
        .await
}

/// Sign the app out: the CLI revokes its grant and deletes it from the
/// keychain. A terminal's `epicenter auth login` is left signed in.
#[tauri::command]
#[specta::specta]
pub async fn auth_logout(webview: Webview) -> Result<AuthSignOut, CliError> {
    window_invocation(&webview)?
        .desktop()
        .answer(&["auth", "logout", "--json"], None)
        .await
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::{json, Value};

    use super::*;

    /// This shell's directories, under `dir`.
    fn paths_in(dir: &std::path::Path) -> DesktopPaths {
        DesktopPaths {
            data_dir: dir.join("data"),
            folder_dir: dir.join("Epicenter"),
            cache_dir: dir.join("cache"),
        }
    }

    /// `program` as this shell starts the CLI, for a deployment nothing
    /// listens on and directories under `dir`.
    fn invocation_in(program: Program, dir: &std::path::Path) -> Invocation {
        Invocation::new(program, "http://127.0.0.1:9", &paths_in(dir))
    }

    /// `program` for a test that reads no directory.
    fn plain(program: Program) -> Invocation {
        invocation_in(program, &std::env::temp_dir().join("epicenter-cli-unused"))
    }

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

    /// The launch call runs one fixed invocation with the shell's
    /// directories, and a run that exits non-zero is reported with what the
    /// CLI printed. The child is a script standing in for the binary.
    #[tokio::test]
    async fn the_launch_call_is_one_fixed_invocation_with_the_shells_directories() {
        let dir = scratch("link");
        let seen = dir.join("seen");
        let script = dir.join("child.sh");
        fs::write(
            &script,
            format!(
                "printf '%s\\n' \"$*\" \"$EPICENTER_DATA_DIR\" > '{}'\n\
                 echo '{{\"commandLink\":{{\"action\":\"translocated\"}}}}'\n\
                 exit \"$CHILD_EXIT\"\n",
                seen.display()
            ),
        )
        .unwrap();
        let program = Program {
            program: PathBuf::from("sh"),
            prefix: vec![script.into_os_string()],
        };
        let paths = DesktopPaths {
            data_dir: PathBuf::from("/support/so.epicenter"),
            folder_dir: PathBuf::from("/home/Epicenter"),
            cache_dir: PathBuf::from("/caches/so.epicenter"),
        };
        let env = |code: &str| {
            Invocation::new(program.clone(), "https://api.example.test", &paths)
                .env("CHILD_EXIT", code)
        };

        assert_eq!(refresh_command_link(&env("0")).await, Ok(()));
        assert_eq!(
            fs::read_to_string(&seen).unwrap(),
            "install-command --json\n/support/so.epicenter\n"
        );
        let refused = refresh_command_link(&env("1")).await.unwrap_err();
        assert!(refused.starts_with("exit 1: "), "{refused}");
        assert!(refused.contains("translocated"), "{refused}");
    }

    /// A deep link opens a built-in window without the Folders window, so the
    /// launch, not a window, publishes `so.epicenter`'s declaration: with no
    /// window at all, the launch call runs the CLI (from source, as a
    /// development build does) and writes it under the shell's folder root.
    #[tokio::test]
    async fn the_launch_declares_epicenters_folder_with_no_window_open() {
        let dir = scratch("declare");
        let paths = paths_in(&dir);
        let declared = spawn_epicenter_folder_declaration(&paths);
        tokio::time::timeout(Duration::from_secs(60), declared.finished())
            .await
            .expect("the declaration finished");
        let declaration =
            fs::read_to_string(paths.folder_dir.join("so.epicenter").join("epicenter.json"))
                .expect("so.epicenter/epicenter.json was written");
        assert!(declaration.contains("\"connections\""), "{declaration}");
        let _ = fs::remove_dir_all(dir);
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
        let exit = plain(program).run(&[], Some(body), |line| {
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
        let ended = plain(program).run(&[], None, |_| {
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

    /// A run that ends early asks the child to stop and gives it
    /// `STOP_GRACE`: a child that finishes a write after the stop signal, as
    /// the CLI finishes a refresh it sent, still finishes it.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_run_that_ends_early_lets_the_child_finish_before_killing_it() {
        let dir = scratch("grace");
        let marker = dir.join("finished");
        let script = dir.join("child.sh");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\ntrap 'sleep 1; echo done > \"{}\"; exit 0' TERM\necho '{{}}'\nwhile :; do sleep 0.05; done\n",
                marker.display()
            ),
        )
        .unwrap();
        let program = Program {
            program: PathBuf::from("/bin/sh"),
            prefix: vec![script.into_os_string()],
        };
        let ended = plain(program)
            .run(&[], None, |_| Err("the page went away".into()))
            .await
            .unwrap_err();
        assert_eq!(
            ended,
            CliError::Failed {
                message: "the page went away".into()
            }
        );
        let mut finished = false;
        for _ in 0..100 {
            if marker.exists() {
                finished = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(finished, "the child was killed before it finished");
        let _ = fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_binary_that_cannot_start_fails() {
        let program = Program {
            program: PathBuf::from("/nonexistent/epicenter-cli"),
            prefix: Vec::new(),
        };
        let CliError::Failed { message } = plain(program).run(&[], None, |_| Ok(())).await.unwrap_err()
        else {
            panic!("not a failure");
        };
        assert!(message.contains("could not be started"), "{message}");
    }

    /// Every command a page calls starts the CLI the same way: with the
    /// shell's deployment and its three directories, and as that window's
    /// child, which ends with its page. The child stands in for a long
    /// `epicenter app install`: it reports its environment and waits.
    #[cfg(unix)]
    #[tokio::test]
    async fn every_invocation_names_the_shells_deployment_and_directories_and_ends_with_its_page() {
        let dir = scratch("invocation");
        let script = dir.join("child.sh");
        fs::write(
            &script,
            "#!/bin/sh\nprintf '%s|%s|%s|%s|%s\\n' \"$*\" \"$EPICENTER_API_URL\" \"$EPICENTER_DATA_DIR\" \"$EPICENTER_FOLDER_DIR\" \"$EPICENTER_CACHE_DIR\"\nsleep 30 &\nwait\n",
        )
        .unwrap();
        let program = Program {
            program: PathBuf::from("/bin/sh"),
            prefix: vec![script.into_os_string()],
        };
        let paths = paths_in(&dir);
        let children = CliChildren::default();
        let invocation = Invocation::new(program, "https://self.example.test", &paths)
            .desktop()
            .owned_by(&children, "folders");
        let (sender, received) = tokio::sync::oneshot::channel::<String>();
        let running = tokio::spawn(async move {
            let mut sender = Some(sender);
            invocation
                .run(&["app".into(), "install".into()], None, move |line| {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(line);
                    }
                    Ok(())
                })
                .await
        });
        let line = tokio::time::timeout(Duration::from_secs(5), received)
            .await
            .expect("the child reported")
            .unwrap();
        assert_eq!(
            line,
            format!(
                "app install --desktop|https://self.example.test|{}|{}|{}",
                paths.data_dir.display(),
                paths.folder_dir.display(),
                paths.cache_dir.display()
            )
        );
        assert_eq!(children.running("folders"), 1);
        children.page_ended("other");
        assert_eq!(children.running("folders"), 1);
        children.page_ended("folders");
        let ended = tokio::time::timeout(Duration::from_secs(5), running)
            .await
            .expect("the child ended with its page")
            .unwrap();
        assert!(ended.as_ref().map_or(true, |exit| exit.code != 0), "{ended:?}");
        assert_eq!(children.running("folders"), 0);
        let _ = fs::remove_dir_all(dir);
    }

    /// The CLI's source under the `bun` on `PATH`, as a development build
    /// runs it, with the keychain replaced by the in-memory store
    /// `EPICENTER_TEST_SECRETS` seeds, so no test touches the real keychain.
    fn cli_with_secrets(dir: &std::path::Path, secrets: Value) -> Program {
        let env = dir.join("secrets.env");
        fs::write(&env, format!("EPICENTER_TEST_SECRETS='{secrets}'\n")).unwrap();
        let entry = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/cli/src/bin.ts");
        Program {
            program: PathBuf::from("bun"),
            prefix: vec![
                format!("--env-file={}", env.display()).into(),
                "--no-install".into(),
                entry.into_os_string(),
            ],
        }
    }

    /// One HTTP exchange on a local port: answers `body` with status 200 and
    /// hands back the request it read, head and body.
    async fn fake_endpoint(body: Vec<u8>) -> (String, tokio::task::JoinHandle<Vec<u8>>) {
        use tokio::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let served = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = vec![0u8; 64 * 1024];
            loop {
                let read = socket.read(&mut chunk).await.unwrap();
                request.extend_from_slice(&chunk[..read]);
                let text = String::from_utf8_lossy(&request).to_lowercase();
                if let Some(end) = text.find("\r\n\r\n") {
                    let length = text[..end]
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .map(|value| value.trim().parse::<usize>().unwrap())
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
                if read == 0 {
                    break;
                }
            }
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/octet-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(head.as_bytes()).await.unwrap();
            socket.write_all(&body).await.unwrap();
            socket.shutdown().await.unwrap();
            request
        });
        (format!("http://127.0.0.1:{}/v1", address.port()), served)
    }

    fn openai(endpoint: &str) -> AiTarget {
        AiTarget::OpenaiCompatible {
            connection: "groq".into(),
            endpoint: endpoint.into(),
        }
    }

    /// `ai_send` runs exactly `epicenter send --json`, writes the target and
    /// request as one JSON line followed by the body's raw bytes, and passes
    /// each line the child prints on, unread. The child here reports what it
    /// was given.
    #[tokio::test]
    async fn ai_send_writes_one_fixed_invocation_with_the_raw_body() {
        let dir = scratch("send-input");
        let script = dir.join("child.ts");
        fs::write(
            &script,
            r#"
const input = await Bun.stdin.bytes();
const newline = input.indexOf(10);
const head = JSON.parse(new TextDecoder().decode(input.subarray(0, newline)));
const body = input.subarray(newline + 1);
console.log(JSON.stringify({ argv: Bun.argv.slice(2), head, body: [...body.subarray(0, 4)], length: body.length }));
"#,
        )
        .unwrap();
        let program = Program {
            program: PathBuf::from("bun"),
            prefix: vec![script.into_os_string()],
        };
        let mut body = vec![0u8, 10, 13, 255];
        body.extend(std::iter::repeat(7u8).take(2 * 1024 * 1024));
        let request = AiRequest {
            method: "POST".into(),
            path: "audio/transcriptions".into(),
            headers: vec![(
                "content-type".into(),
                "multipart/form-data; boundary=x".into(),
            )],
            body: Some(STANDARD.encode(&body)),
        };
        let mut lines = Vec::new();
        let exit = send_with(
            &plain(program.clone()),
            &openai("https://api.groq.com/openai/v1"),
            &request,
            |line| {
                lines.push(line);
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_eq!(exit.code, 0, "{}", exit.stderr);
        let seen: Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(seen["argv"], json!(["send", "--json", "--desktop"]));
        assert_eq!(
            seen["head"],
            json!({
                "target": { "kind": "openai-compatible", "connection": "groq", "endpoint": "https://api.groq.com/openai/v1" },
                "request": {
                    "method": "POST",
                    "path": "audio/transcriptions",
                    "headers": [["content-type", "multipart/form-data; boundary=x"]],
                },
            })
        );
        assert_eq!(seen["body"], json!([0, 10, 13, 255]));
        assert_eq!(seen["length"], body.len());

        let refused = send_with(
            &plain(program),
            &AiTarget::Epicenter {
                connection: "--json".into(),
            },
            &request,
            |_| Ok(()),
        )
        .await
        .unwrap_err();
        assert!(matches!(refused, CliError::Refused { .. }), "{refused:?}");
        let _ = fs::remove_dir_all(dir);
    }

    /// `account_send` runs exactly `epicenter send --json --desktop`, and
    /// stdin's head carries the account target, named by role, and the
    /// request. The child here reports what it was given.
    #[tokio::test]
    async fn account_send_writes_the_account_target_and_request() {
        let dir = scratch("account-send-input");
        let script = dir.join("child.ts");
        fs::write(
            &script,
            r#"
const input = await Bun.stdin.bytes();
const newline = input.indexOf(10);
const head = JSON.parse(new TextDecoder().decode(input.subarray(0, newline)));
console.log(JSON.stringify({ argv: Bun.argv.slice(2), head, body: new TextDecoder().decode(input.subarray(newline + 1)) }));
"#,
        )
        .unwrap();
        let program = Program {
            program: PathBuf::from("bun"),
            prefix: vec![script.into_os_string()],
        };
        let request = AiRequest {
            method: "POST".into(),
            path: "api/repos".into(),
            headers: vec![("content-type".into(), "application/json".into())],
            body: Some(STANDARD.encode(br#"{"folder":"so.epicenter.todos"}"#)),
        };
        let mut lines = Vec::new();
        let exit = account_send_with(&plain(program), AccountAudience::Git, &request, |line| {
            lines.push(line);
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(exit.code, 0, "{}", exit.stderr);
        let seen: Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(seen["argv"], json!(["send", "--json", "--desktop"]));
        assert_eq!(
            seen["head"],
            json!({
                "target": { "kind": "account", "audience": "git" },
                "request": {
                    "method": "POST",
                    "path": "api/repos",
                    "headers": [["content-type", "application/json"]],
                },
            })
        );
        assert_eq!(seen["body"], r#"{"folder":"so.epicenter.todos"}"#);
        let _ = fs::remove_dir_all(dir);
    }

    /// A page names a resource by role; an audience outside the closed set,
    /// such as a URL or another resource, never reaches the CLI.
    #[test]
    fn an_account_audience_outside_the_enum_does_not_deserialize() {
        assert_eq!(
            serde_json::from_value::<AccountAudience>(json!("api")).unwrap(),
            AccountAudience::Api
        );
        assert_eq!(
            serde_json::from_value::<AccountAudience>(json!("git")).unwrap(),
            AccountAudience::Git
        );
        for refused in [
            json!("mcp"),
            json!("Git"),
            json!("https://git.epicenter.so"),
            json!(""),
            json!(null),
            json!({ "kind": "account", "audience": "git" }),
        ] {
            assert!(
                serde_json::from_value::<AccountAudience>(refused.clone()).is_err(),
                "{refused} deserialized"
            );
        }
    }

    /// Through the real CLI, with a keychain that holds no grant: an account
    /// request below `/api/` is refused for want of the app's sign-in, and
    /// one outside it is refused before any token is asked for.
    #[tokio::test]
    async fn account_send_through_the_cli_needs_the_apps_grant_and_an_api_path() {
        let dir = scratch("account-send-cli");
        let invocation = invocation_in(cli_with_secrets(&dir, json!({})), &dir);
        let request = |path: &str| AiRequest {
            method: "GET".into(),
            path: path.into(),
            headers: Vec::new(),
            body: None,
        };
        let mut events = Vec::new();
        let exit = account_send_with(
            &invocation,
            AccountAudience::Api,
            &request("api/session"),
            |line| {
                events.push(serde_json::from_str::<Value>(&line).unwrap());
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_eq!(exit.code, 2);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["name"], "NoAccountToken");
        assert!(
            events[0]["message"]
                .as_str()
                .unwrap()
                .contains("Sign in from Epicenter's Settings"),
            "{}",
            events[0]
        );

        let mut events = Vec::new();
        account_send_with(
            &invocation,
            AccountAudience::Api,
            &request("auth/oauth2/revoke"),
            |line| {
                events.push(serde_json::from_str::<Value>(&line).unwrap());
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_eq!(events[0]["name"], "InvalidRequest");
        let _ = fs::remove_dir_all(dir);
    }

    /// Through the real CLI: the key state names the endpoint and never the
    /// key, a request reaches the endpoint with the keychain's key and comes
    /// back as head, chunks, and end, and a request prepared for another
    /// endpoint is refused without being sent.
    #[tokio::test]
    async fn ai_send_and_the_key_commands_run_the_cli() {
        let dir = scratch("send-cli");
        let reply: Vec<u8> = (0..200_000u32).map(|index| (index % 251) as u8).collect();
        let (endpoint, served) = fake_endpoint(reply.clone()).await;
        let program = invocation_in(
            cli_with_secrets(
                &dir,
                json!({ "groq": { "endpoint": endpoint, "key": "sk-rust" } }),
            ),
            &dir,
        );

        assert_eq!(
            key_state_with(&program, "groq").await.unwrap(),
            AiKeyState::Saved {
                endpoint: endpoint.clone(),
                has_key: true
            }
        );
        assert_eq!(
            key_state_with(&program, "other").await.unwrap(),
            AiKeyState::Missing
        );
        assert_eq!(
            key_set_with(&program, "other", "https://API.example.com/v1/", "")
                .await
                .unwrap(),
            AiKeyState::Saved {
                endpoint: "https://api.example.com/v1".into(),
                has_key: false
            }
        );
        let refused = key_set_with(&program, "other", "ftp://x", "k")
            .await
            .unwrap_err();
        assert!(matches!(refused, CliError::Refused { .. }), "{refused:?}");
        assert!(!key_remove_with(&program, "other").await.unwrap());

        let request = AiRequest {
            method: "POST".into(),
            path: "chat/completions".into(),
            headers: vec![("cookie".into(), "ambient=1".into())],
            body: Some(STANDARD.encode(b"{\"model\":\"m\"}")),
        };
        let mut events = Vec::new();
        let exit = send_with(&program, &openai(&endpoint), &request, |line| {
            events.push(serde_json::from_str::<Value>(&line).unwrap());
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(exit.code, 0, "{}", exit.stderr);
        assert_eq!(events[0]["type"], "head");
        assert_eq!(events[0]["status"], 200);
        assert_eq!(events.last().unwrap()["type"], "end");
        let mut body = Vec::new();
        for event in &events[1..events.len() - 1] {
            assert_eq!(event["type"], "chunk");
            body.extend(STANDARD.decode(event["data"].as_str().unwrap()).unwrap());
        }
        assert_eq!(body, reply);
        let sent = String::from_utf8(served.await.unwrap()).unwrap();
        assert!(sent.starts_with("POST /v1/chat/completions "), "{sent}");
        assert!(
            sent.to_lowercase()
                .contains("authorization: bearer sk-rust"),
            "{sent}"
        );
        assert!(!sent.to_lowercase().contains("cookie"), "{sent}");
        assert!(sent.ends_with("{\"model\":\"m\"}"), "{sent}");

        let mut events = Vec::new();
        let exit = send_with(
            &program,
            &openai("https://api.example.com/v1"),
            &request,
            |line| {
                events.push(serde_json::from_str::<Value>(&line).unwrap());
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_eq!(exit.code, 2);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["name"], "EndpointChanged");

        let mut events = Vec::new();
        send_with(
            &program,
            &AiTarget::Epicenter {
                connection: "account".into(),
            },
            &request,
            |line| {
                events.push(serde_json::from_str::<Value>(&line).unwrap());
                Ok(())
            },
        )
        .await
        .unwrap();
        // `--desktop` asks for the app's grant, and this keychain holds none.
        assert_eq!(events[0]["name"], "NoAccessToken");
        assert!(
            events[0]["message"]
                .as_str()
                .unwrap()
                .contains("Sign in from Epicenter's Settings"),
            "{}",
            events[0]
        );
        let _ = fs::remove_dir_all(dir);
    }

    /// Through the real CLI, with a keychain that holds nothing: status names
    /// the deployment the shell passed and both grants signed out, and
    /// signing out reports that there was nothing to sign out.
    #[tokio::test]
    async fn auth_status_and_logout_run_the_cli() {
        let dir = scratch("auth-cli");
        let desktop = invocation_in(cli_with_secrets(&dir, json!({})), &dir).desktop();
        let status: AuthStatus = desktop
            .answer(&["auth", "status", "--json"], None)
            .await
            .unwrap();
        assert_eq!(status.origin, "http://127.0.0.1:9");
        assert_eq!(
            status
                .grants
                .iter()
                .map(|grant| (grant.grant.as_str(), grant.client.as_str(), grant.signed_in))
                .collect::<Vec<_>>(),
            vec![
                ("device", "so.epicenter.cli", false),
                ("desktop", "so.epicenter", false)
            ]
        );
        let signed_out: AuthSignOut = desktop
            .answer(&["auth", "logout", "--json"], None)
            .await
            .unwrap();
        assert_eq!(
            signed_out,
            AuthSignOut {
                signed_out: false,
                revoked: false
            }
        );
        let refused = desktop
            .answer::<Value>(&["auth", "token", "--json"], None)
            .await
            .unwrap_err();
        assert!(matches!(refused, CliError::Refused { .. }), "{refused:?}");
        let _ = fs::remove_dir_all(dir);
    }

    /// `auth_login` runs exactly the desktop sign-in, `--desktop`, opens
    /// the page the CLI names only when it is the deployment's authorization
    /// endpoint, and passes every line on. A child stands in for the CLI.
    #[tokio::test]
    async fn auth_login_opens_only_the_deployments_authorization_page() {
        let dir = scratch("auth-login");
        let script = dir.join("child.ts");
        fs::write(
            &script,
            r#"
const url = process.env.OPEN_URL ?? '';
console.log(JSON.stringify({ argv: Bun.argv.slice(2), origin: process.env.EPICENTER_API_URL }));
console.log(JSON.stringify({ open: url }));
console.log(JSON.stringify({ signedIn: { grant: 'desktop' } }));
"#,
        )
        .unwrap();
        let child = |url: &str| {
            let env = dir.join(format!("{}.env", url.len()));
            fs::write(&env, format!("OPEN_URL={url}\n")).unwrap();
            Program {
                program: PathBuf::from("bun"),
                prefix: vec![
                    format!("--env-file={}", env.display()).into(),
                    script.clone().into_os_string(),
                ],
            }
        };
        let origin = "https://api.example.test";
        let good = format!("{origin}/auth/oauth2/authorize?client_id=so.epicenter");
        let mut opened = Vec::new();
        let mut lines = Vec::new();
        let exit = login_with(
            &Invocation::new(child(&good), origin, &paths_in(&dir)),
            origin,
            |url| {
                opened.push(url.to_string());
                Ok(())
            },
            |line| {
                lines.push(serde_json::from_str::<Value>(&line).unwrap());
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_eq!(exit.code, 0, "{}", exit.stderr);
        assert_eq!(
            lines[0],
            json!({
                "argv": ["auth", "login", "--json", "--desktop"],
                "origin": origin,
            })
        );
        assert_eq!(opened, vec![good.clone()]);
        assert_eq!(lines[2]["signedIn"]["grant"], "desktop");

        for elsewhere in [
            "https://evil.example/auth/oauth2/authorize",
            "https://api.example.test/sign-in",
            "file:///etc/passwd",
        ] {
            let mut opened = Vec::new();
            let refused = login_with(
                &Invocation::new(child(elsewhere), origin, &paths_in(&dir)),
                origin,
                |url| {
                    opened.push(url.to_string());
                    Ok(())
                },
                |_| Ok(()),
            )
            .await
            .unwrap_err();
            assert!(matches!(refused, CliError::Failed { .. }), "{refused:?}");
            assert!(opened.is_empty(), "{elsewhere} was opened");
        }
        let _ = fs::remove_dir_all(dir);
    }
}
