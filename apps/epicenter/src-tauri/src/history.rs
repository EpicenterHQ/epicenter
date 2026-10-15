//! A page's folder history, run by the `epicenter` CLI (ADR-0559).
//!
//! The shell runs no `git`. Each history operation a page asks for is one
//! fixed command here, mapped to one fixed `epicenter` invocation over the
//! folder this window was granted:
//!
//! ```txt
//! status        epicenter status <root> --json
//! history       epicenter history <root> --depth <n> --json
//! save_version  epicenter save-version <root> [--message <text>] --json
//! sync          epicenter sync <root> [--remote <url>] [--allow-unrelated] --json
//! settle_sync   epicenter sync <root> --resolve - --json
//! ```
//!
//! A page names a scope and nothing else; the root, the fallback author, the
//! branch, and whether it is an application's folder come from the shell's
//! registration (`Folders::granted_folder`). A token the page holds for its
//! remote, and the choices that settle a sync, cross on the child's standard
//! input, never in its arguments. Each command answers the child's exit code
//! and its one reply line, which the page decodes (`history-wire.ts` in
//! `@epicenter/folder`).
//!
//! The shell ends a window's children when its page reloads or the window
//! closes (`CliChildren`): each child leads its own process group, and is
//! asked to stop, which ends every `git` it started, then killed with its
//! group if it has not.

use std::collections::HashMap;
use std::ffi::OsString;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{Manager, Runtime, Webview};
use tauri_plugin_epicenter_folder::{FolderExt, FolderKind};

use crate::cli::{self, failed, CliError, Program};

/// How long a child asked to stop has before its process group is killed.
const STOP_GRACE: Duration = Duration::from_secs(1);

/// The `epicenter` children each window's page started, by window label.
#[derive(Default)]
pub struct CliChildren {
    running: Mutex<HashMap<String, Vec<(u32, Arc<AtomicBool>)>>>,
}

impl CliChildren {
    fn state(&self) -> std::sync::MutexGuard<'_, HashMap<String, Vec<(u32, Arc<AtomicBool>)>>> {
        self.running
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn start(&self, window: &str, pid: u32) -> Arc<AtomicBool> {
        let live = Arc::new(AtomicBool::new(true));
        self.state()
            .entry(window.to_string())
            .or_default()
            .push((pid, Arc::clone(&live)));
        live
    }

    fn finish(&self, window: &str, live: &Arc<AtomicBool>) {
        live.store(false, Ordering::SeqCst);
        let mut state = self.state();
        if let Some(children) = state.get_mut(window) {
            children.retain(|(_, other)| !Arc::ptr_eq(other, live));
            if children.is_empty() {
                state.remove(window);
            }
        }
    }

    /// The page in `window` is over: it reloaded, navigated, or the window
    /// was destroyed. End every child it started, with the processes each
    /// started.
    pub fn page_ended(&self, window: &str) {
        let children = self.state().remove(window).unwrap_or_default();
        for (pid, live) in children {
            end_group(pid, live);
        }
    }

    /// How many children `window`'s page has running.
    #[cfg(test)]
    fn running(&self, window: &str) -> usize {
        self.state().get(window).map_or(0, Vec::len)
    }
}

/// Ask the child `pid` to stop, which ends the `git` it runs, then kill its
/// process group if it is still running after `STOP_GRACE`.
fn end_group(pid: u32, live: Arc<AtomicBool>) {
    #[cfg(unix)]
    {
        let Ok(group) = libc::pid_t::try_from(pid) else {
            return;
        };
        // SAFETY: `kill` takes no pointers. The group is the one the child
        // leads (`process_group(0)`); `live` says it has not been reaped.
        unsafe {
            libc::kill(-group, libc::SIGTERM);
        }
        std::thread::spawn(move || {
            std::thread::sleep(STOP_GRACE);
            if live.load(Ordering::SeqCst) {
                // SAFETY: as above.
                unsafe {
                    libc::kill(-group, libc::SIGKILL);
                }
            }
        });
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        if live.load(Ordering::SeqCst) {
            let _ = std::process::Command::new("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .status();
        }
    }
}

/// How a history child ended, and its one reply line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct HistoryOutput {
    /// The CLI's exit code: 0 done, 1 a result a person acts on, 2 a folder
    /// or a `git` it cannot use.
    pub code: i32,
    /// The last line the child printed: its reply, or `{"error": ...}`.
    pub reply: Option<String>,
    /// The end of what the child wrote for people, at most 64 KiB.
    pub stderr: String,
}

/// A credential the page holds for exactly one remote URL, which the child
/// sends only to that URL, and only when it is `https`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, specta::Type)]
pub struct GitCredential {
    pub url: String,
    pub username: String,
    pub password: String,
}

/// Run one history invocation for `webview`'s grant of `scope`: `command`,
/// the root, `options`, then `--json`, with `stdin`. The child is this
/// window's until it exits.
async fn run_history<R: Runtime>(
    program: &Program,
    webview: &Webview<R>,
    scope: &str,
    command: &str,
    options: Vec<OsString>,
    stdin: Option<Vec<u8>>,
) -> Result<HistoryOutput, CliError> {
    let folder = webview
        .folders()
        .granted_folder(scope, webview.label())
        .map_err(|grant| CliError::NotGranted { grant })?;
    let mut args: Vec<OsString> = vec![command.into(), folder.root.into_os_string()];
    args.extend(options);
    args.push("--json".into());
    args.push("--desktop".into());
    let env: Vec<(OsString, OsString)> = vec![
        ("EPICENTER_AUTHOR_NAME".into(), folder.author.name.into()),
        ("EPICENTER_AUTHOR_EMAIL".into(), folder.author.email.into()),
        ("EPICENTER_BRANCH".into(), folder.branch.into()),
        (
            "EPICENTER_FOLDER_KIND".into(),
            match folder.kind {
                FolderKind::Application => "application",
                FolderKind::Data => "data",
            }
            .into(),
        ),
    ];
    let children = webview.state::<CliChildren>();
    let window = webview.label().to_string();
    let mut live = None;
    let mut reply = None;
    let exit = cli::run_child(
        program,
        &args,
        &env,
        stdin,
        |line| {
            reply = Some(line);
            Ok(())
        },
        |pid| live = Some(children.start(&window, pid)),
    )
    .await;
    if let Some(live) = &live {
        children.finish(&window, live);
    }
    let exit = exit?;
    Ok(HistoryOutput {
        code: exit.code,
        reply,
        stderr: exit.stderr,
    })
}

/// One JSON object for the child's standard input.
fn stdin_json(value: serde_json::Value) -> Result<Vec<u8>, CliError> {
    serde_json::to_vec(&value).map_err(|error| failed(error.to_string()))
}

/// The folder's changed files, its head, and its remote, ahead and behind.
#[tauri::command]
#[specta::specta]
pub async fn status<R: Runtime>(
    webview: Webview<R>,
    scope: String,
) -> Result<HistoryOutput, CliError> {
    let program = cli::bundled_program().map_err(failed)?;
    run_history(&program, &webview, &scope, "status", Vec::new(), None).await
}

/// The folder's last `depth` versions.
#[tauri::command]
#[specta::specta]
pub async fn history<R: Runtime>(
    webview: Webview<R>,
    scope: String,
    depth: u32,
) -> Result<HistoryOutput, CliError> {
    let program = cli::bundled_program().map_err(failed)?;
    let options = vec!["--depth".into(), depth.max(1).to_string().into()];
    run_history(&program, &webview, &scope, "history", options, None).await
}

/// Record the folder's edits as a version, with `message` when a person gave one.
#[tauri::command]
#[specta::specta]
pub async fn save_version<R: Runtime>(
    webview: Webview<R>,
    scope: String,
    message: Option<String>,
) -> Result<HistoryOutput, CliError> {
    let program = cli::bundled_program().map_err(failed)?;
    let options = match message {
        Some(message) => vec!["--message".into(), message.into()],
        None => Vec::new(),
    };
    run_history(&program, &webview, &scope, "save-version", options, None).await
}

/// `sync`'s options and input: `remote` connects first, which the CLI
/// refuses unless it is a network URL.
fn sync_invocation(
    remote: Option<String>,
    allow_unrelated: bool,
    credential: Option<GitCredential>,
) -> Result<(Vec<OsString>, Option<Vec<u8>>), CliError> {
    let mut options: Vec<OsString> = Vec::new();
    if let Some(remote) = remote {
        options.push("--remote".into());
        options.push(remote.into());
    }
    if allow_unrelated {
        options.push("--allow-unrelated".into());
    }
    let stdin = match credential {
        Some(credential) => {
            options.push("--credential-stdin".into());
            Some(stdin_json(json!({ "credential": credential }))?)
        }
        None => None,
    };
    Ok((options, stdin))
}

/// Record the folder's edits, fetch, merge by each file's kind, and push. A
/// sync that needs choices records its attempt in the folder for
/// `settle_sync`.
#[tauri::command]
#[specta::specta]
pub async fn sync<R: Runtime>(
    webview: Webview<R>,
    scope: String,
    remote: Option<String>,
    allow_unrelated: bool,
    credential: Option<GitCredential>,
) -> Result<HistoryOutput, CliError> {
    let program = cli::bundled_program().map_err(failed)?;
    let (options, stdin) = sync_invocation(remote, allow_unrelated, credential)?;
    run_history(&program, &webview, &scope, "sync", options, stdin).await
}

/// `settle_sync`'s input: the attempt's ID, the choices as the page encoded
/// them, unparsed so nothing in them changes, and the credential.
fn settle_input(
    attempt: &str,
    choices: &str,
    credential: Option<&GitCredential>,
) -> Result<Vec<u8>, CliError> {
    serde_json::from_str::<serde::de::IgnoredAny>(choices).map_err(|error| CliError::Refused {
        message: format!("the choices are not JSON: {error}"),
    })?;
    let mut input = format!(
        "{{\"attempt\":{},\"choices\":{choices}",
        serde_json::to_string(attempt).map_err(|error| failed(error.to_string()))?
    );
    if let Some(credential) = credential {
        input.push_str(",\"credential\":");
        input.push_str(&serde_json::to_string(credential).map_err(|error| failed(error.to_string()))?);
    }
    input.push('}');
    Ok(input.into_bytes())
}

/// Settle the sync attempt this folder recorded, named by its ID, with one
/// choice per conflict, then push. The conflicts are read again from the
/// commits the attempt recorded; nothing of them crosses from the page.
#[tauri::command]
#[specta::specta]
pub async fn settle_sync<R: Runtime>(
    webview: Webview<R>,
    scope: String,
    attempt: String,
    choices: String,
    credential: Option<GitCredential>,
) -> Result<HistoryOutput, CliError> {
    let program = cli::bundled_program().map_err(failed)?;
    let mut options: Vec<OsString> = vec!["--resolve".into(), "-".into()];
    if credential.is_some() {
        options.push("--credential-stdin".into());
    }
    let input = settle_input(&attempt, &choices, credential.as_ref())?;
    run_history(&program, &webview, &scope, "sync", options, Some(input)).await
}

/// Start what gives this computer a `git`, after the CLI answered
/// `GitMissing` (ADR-0559): on macOS the Command Line Tools installer, a
/// one-time step; on Windows the Git for Windows download page. Elsewhere a
/// package manager installs it, which this cannot start.
#[tauri::command]
#[specta::specta]
pub async fn install_git<R: Runtime>(webview: Webview<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = webview;
        let status = tokio::process::Command::new("/usr/bin/xcode-select")
            .arg("--install")
            .status()
            .await
            .map_err(|error| format!("the Command Line Tools installer could not start: {error}"))?;
        // It exits 1 when the tools are already installed or the installer
        // is already open; either way there is nothing more to start.
        let _ = status;
        Ok(())
    }
    #[cfg(windows)]
    {
        use tauri_plugin_opener::OpenerExt;
        webview
            .app_handle()
            .opener()
            .open_url("https://gitforwindows.org/", None::<String>)
            .map_err(|error| error.to_string())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = webview;
        Err("Install git with your system's package manager, then try again.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use serde_json::Value;
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
    use tauri::utils::acl::ExecutionContext;
    use tauri::WebviewWindowBuilder;
    use tauri_plugin_epicenter_folder::{Author, FolderConfig, ScopeConfig};

    use super::*;

    fn scratch(label: &str) -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "epicenter-history-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(dir).unwrap()
    }

    /// The CLI's source under the `bun` on `PATH`, as a development build
    /// runs it, with Git's own configuration out of the way.
    fn cli() -> Program {
        let entry = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/cli/src/bin.ts");
        Program {
            program: PathBuf::from("bun"),
            prefix: vec!["--no-install".into(), entry.into_os_string()],
        }
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args(["-c", "user.name=Remote", "-c", "user.email=remote@example.test"])
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn app_with(folder: FolderConfig) -> tauri::App<MockRuntime> {
        let mut context = mock_context(noop_assets());
        context.runtime_authority_mut().__allow_command(
            "plugin:epicenter-folder|grant_directory".into(),
            ExecutionContext::Local,
        );
        let app = mock_builder()
            .plugin(tauri_plugin_epicenter_folder::init())
            .manage(CliChildren::default())
            .build(context)
            .expect("mock app");
        app.folders()
            .register(ScopeConfig {
                scope: "data:notes".into(),
                folder,
                windows: vec!["folders".into()],
            })
            .unwrap();
        app
    }

    fn reply(output: &HistoryOutput) -> Value {
        serde_json::from_str(output.reply.as_deref().expect("a reply line")).unwrap()
    }

    /// Each history command runs only for a folder this window was granted,
    /// as the one fixed invocation, with the shell's author and kind; save
    /// version and sync reach a local bare remote; and a sync that needs
    /// choices is settled by a second child from the attempt's ID alone.
    #[tokio::test]
    async fn the_history_commands_run_the_cli_on_the_granted_folder_only() {
        std::env::set_var("GIT_CONFIG_GLOBAL", "/dev/null");
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
        let project = scratch("commands");
        let bare = project.join("remote.git");
        git(&project, &["init", "--quiet", "--bare", "--initial-branch=main", bare.to_str().unwrap()]);
        let root = project.join("notes");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("a.txt"), "base\n").unwrap();
        git(&root, &["init", "--quiet", "--initial-branch=main"]);
        git(&root, &["config", "remote.origin.url", bare.to_str().unwrap()]);
        let app = app_with(
            FolderConfig::data(
                &root,
                Author {
                    name: "Shell Author".into(),
                    email: "shell@example.test".into(),
                },
            ),
        );
        let folders = WebviewWindowBuilder::new(&app, "folders", Default::default())
            .build()
            .unwrap();
        let other = WebviewWindowBuilder::new(&app, "other", Default::default())
            .build()
            .unwrap();
        let webview = |window: &tauri::WebviewWindow<MockRuntime>| window.as_ref().clone();
        let program = cli();

        // Before the grant, and for another window, nothing runs.
        let refused = run_history(&program, &webview(&folders), "data:notes", "status", Vec::new(), None)
            .await
            .unwrap_err();
        assert!(matches!(refused, CliError::NotGranted { .. }), "{refused:?}");
        tauri::test::get_ipc_response(
            &folders,
            tauri::webview::InvokeRequest {
                cmd: "plugin:epicenter-folder|grant_directory".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(json!({ "scope": "data:notes" })),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        )
        .unwrap();
        let refused = run_history(&program, &webview(&other), "data:notes", "status", Vec::new(), None)
            .await
            .unwrap_err();
        assert!(matches!(refused, CliError::NotGranted { .. }), "{refused:?}");

        let status = run_history(&program, &webview(&folders), "data:notes", "status", Vec::new(), None)
            .await
            .unwrap();
        assert_eq!(status.code, 0, "{}", status.stderr);
        assert_eq!(
            reply(&status)["result"]["data"]["changes"],
            json!([{ "path": "a.txt", "kind": "add" }])
        );

        let saved = run_history(
            &program,
            &webview(&folders),
            "data:notes",
            "save-version",
            vec!["--message".into(), "First".into()],
            None,
        )
        .await
        .unwrap();
        assert_eq!(saved.code, 0, "{}", saved.stderr);
        assert_eq!(git(&root, &["log", "-1", "--format=%an %s"]), "Shell Author First");

        let (options, stdin) = sync_invocation(None, false, None).unwrap();
        let synced = run_history(&program, &webview(&folders), "data:notes", "sync", options, stdin)
            .await
            .unwrap();
        assert_eq!(synced.code, 0, "{}", synced.stderr);
        assert_eq!(reply(&synced)["result"]["data"]["kind"], "synced");
        assert_eq!(
            git(&bare, &["rev-parse", "main"]),
            git(&root, &["rev-parse", "HEAD"])
        );

        // Another device changes the same line; this folder does too.
        let device = project.join("device");
        git(&project, &["clone", "--quiet", bare.to_str().unwrap(), device.to_str().unwrap()]);
        fs::write(device.join("a.txt"), "theirs\n").unwrap();
        git(&device, &["commit", "--quiet", "-am", "Theirs"]);
        git(&device, &["push", "--quiet", "origin", "main"]);
        fs::write(root.join("a.txt"), "mine\n").unwrap();
        let (options, stdin) = sync_invocation(None, false, None).unwrap();
        let held = run_history(&program, &webview(&folders), "data:notes", "sync", options, stdin)
            .await
            .unwrap();
        assert_eq!(held.code, 1, "{}", held.stderr);
        let held = reply(&held);
        let attempt = &held["result"]["error"]["attempt"];
        let conflict = attempt["conflicts"][0]["id"].as_str().unwrap();
        let choices = json!({ conflict: { "kind": "replace", "value": "both\n" } }).to_string();
        let input = settle_input(attempt["id"].as_str().unwrap(), &choices, None).unwrap();
        let settled = run_history(
            &program,
            &webview(&folders),
            "data:notes",
            "sync",
            vec!["--resolve".into(), "-".into()],
            Some(input),
        )
        .await
        .unwrap();
        assert_eq!(settled.code, 0, "{}", settled.stderr);
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "both\n");
        assert_eq!(
            git(&bare, &["rev-parse", "main"]),
            git(&root, &["rev-parse", "HEAD"])
        );
        assert_eq!(app.state::<CliChildren>().running("folders"), 0);
        app.folders().shutdown();
        let _ = fs::remove_dir_all(project);
    }

    /// A page that reloads ends its children and every process each started:
    /// the child stands in for the CLI with a grandchild that would outlive
    /// it.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_page_that_ends_ends_its_children_and_their_process_groups() {
        let dir = scratch("children");
        let marker = dir.join("grandchild.pid");
        let script = dir.join("child.sh");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\nsleep 30 &\necho $! > '{}'\nwait\n",
                marker.display()
            ),
        )
        .unwrap();
        let program = Program {
            program: PathBuf::from("/bin/sh"),
            prefix: vec![script.into_os_string()],
        };
        let children = Arc::new(CliChildren::default());
        let running = {
            let children = Arc::clone(&children);
            tokio::spawn(async move {
                let mut live = None;
                let exit = cli::run_child(&program, &[], &[], None, |_| Ok(()), |pid| {
                    live = Some(children.start("app:todos", pid))
                })
                .await;
                if let Some(live) = &live {
                    children.finish("app:todos", live);
                }
                exit
            })
        };
        for _ in 0..100 {
            if marker.exists() && children.running("app:todos") == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let grandchild: i32 = fs::read_to_string(&marker).unwrap().trim().parse().unwrap();
        // Another window's page ending touches nothing.
        children.page_ended("folders");
        assert_eq!(children.running("app:todos"), 1);

        children.page_ended("app:todos");
        let ended = tokio::time::timeout(Duration::from_secs(5), running)
            .await
            .expect("the child ended")
            .unwrap();
        assert!(matches!(ended, Err(CliError::Failed { .. })), "{ended:?}");
        let mut gone = false;
        for _ in 0..100 {
            // SAFETY: signal 0 only asks whether the process exists.
            if unsafe { libc::kill(grandchild, 0) } != 0 {
                gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(gone, "the grandchild outlived its page");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn settle_input_carries_the_choices_unparsed_and_refuses_what_is_not_json() {
        let choices = r#"{"[\"setting\",\"kv.json\",\"n\"]":{"kind":"replace","value":1.00000000000000000001}}"#;
        let input = settle_input("id-1", choices, None).unwrap();
        assert_eq!(
            String::from_utf8(input).unwrap(),
            format!(r#"{{"attempt":"id-1","choices":{choices}}}"#)
        );
        assert!(matches!(
            settle_input("id-1", "{", None),
            Err(CliError::Refused { .. })
        ));
    }
}
