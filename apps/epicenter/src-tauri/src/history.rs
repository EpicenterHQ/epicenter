//! A page's folder history, run by the `epicenter` CLI (ADR-0559).
//!
//! The shell runs no `git`. Each history operation a page asks for is one
//! fixed command here, mapped to one fixed `epicenter` invocation over the
//! folder this window was granted:
//!
//! ```txt
//! status        epicenter status <root> --json --desktop
//! history       epicenter history <root> --depth <n> --json --desktop
//! save_version  epicenter save-version <root> [--message <text>] --json --desktop
//! sync          epicenter sync <root> [--to <url>] [--allow-unrelated] --json --desktop
//! ```
//!
//! A page names a scope and nothing else; the root comes from the shell's
//! grant (`Folders::granted_root`). The CLI decides the rest itself: who
//! commits, the branch, whether the folder is an application's own, and
//! the token for the deployment's Git. Each command answers the child's exit code and its one reply line, which the page
//! decodes (`history-wire.ts` in `@epicenter/folder`).
//!
//! Each runs through `cli::window_invocation`, with the shell's deployment
//! and directories, so the shell ends it when its page reloads or the window
//! closes (`cli::CliChildren`).

use std::ffi::OsString;

use tauri::{Runtime, Webview};
use tauri_plugin_epicenter_folder::FolderExt;

use crate::cli::{window_invocation, CliError, CliExit};

/// Run one history invocation for `webview`'s grant of `scope`: `command`,
/// the root, `options`, then `--json`, as the app's grant. The
/// child is this window's until it exits, and its reply is the last line it
/// printed.
async fn run_history<R: Runtime>(
    webview: &Webview<R>,
    scope: &str,
    command: &str,
    options: Vec<OsString>,
) -> Result<CliExit, CliError> {
    let root = webview
        .folders()
        .granted_root(scope, webview.label())
        .map_err(|grant| CliError::NotGranted { grant })?;
    let mut args: Vec<OsString> = vec![command.into(), root.into_os_string()];
    args.extend(options);
    args.push("--json".into());
    window_invocation(webview)?
        .desktop()
        .run(&args, None, |_| Ok(()))
        .await
}

/// The folder's changed files, its head, and its remote, ahead and behind.
#[tauri::command]
#[specta::specta]
pub async fn status<R: Runtime>(
    webview: Webview<R>,
    scope: String,
) -> Result<CliExit, CliError> {
    run_history(&webview, &scope, "status", Vec::new()).await
}

/// The folder's last `depth` versions.
#[tauri::command]
#[specta::specta]
pub async fn history<R: Runtime>(
    webview: Webview<R>,
    scope: String,
    depth: u32,
) -> Result<CliExit, CliError> {
    let options = vec!["--depth".into(), depth.max(1).to_string().into()];
    run_history(&webview, &scope, "history", options).await
}

/// Record the folder's edits as a version, with `message` when a person gave one.
#[tauri::command]
#[specta::specta]
pub async fn save_version<R: Runtime>(
    webview: Webview<R>,
    scope: String,
    message: Option<String>,
) -> Result<CliExit, CliError> {
    let options = match message {
        Some(message) => vec!["--message".into(), message.into()],
        None => Vec::new(),
    };
    run_history(&webview, &scope, "save-version", options).await
}

/// `sync`'s options: `remote` connects first, which the CLI refuses unless
/// it is a network URL.
fn sync_options(remote: Option<String>, allow_unrelated: bool) -> Vec<OsString> {
    let mut options: Vec<OsString> = Vec::new();
    if let Some(remote) = remote {
        options.push("--to".into());
        options.push(remote.into());
    }
    if allow_unrelated {
        options.push("--allow-unrelated".into());
    }
    options
}

/// Record the folder's edits, fetch, merge by each file's kind into one
/// merge commit, and push (ADR-0576). Sync asks the person nothing.
#[tauri::command]
#[specta::specta]
pub async fn sync<R: Runtime>(
    webview: Webview<R>,
    scope: String,
    remote: Option<String>,
    allow_unrelated: bool,
) -> Result<CliExit, CliError> {
    let options = sync_options(remote, allow_unrelated);
    run_history(&webview, &scope, "sync", options).await
}

/// Start the Command Line Tools installer, which gives this Mac a `git`,
/// after the CLI answered `GitMissing` (ADR-0559). It is a one-time step.
#[tauri::command]
#[specta::specta]
pub async fn install_git() -> Result<(), String> {
    // It exits 1 when the tools are already installed or the installer is
    // already open; either way there is nothing more to start.
    tokio::process::Command::new("/usr/bin/xcode-select")
        .arg("--install")
        .status()
        .await
        .map(|_| ())
        .map_err(|error| format!("the Command Line Tools installer could not start: {error}"))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::Ordering;

    use serde_json::Value;
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
    use tauri::utils::acl::ExecutionContext;
    use tauri::WebviewWindowBuilder;
    use serde_json::json;
    use tauri_plugin_epicenter_folder::{FolderConfig, ScopeConfig};

    use super::*;
    use crate::app_data::DesktopPaths;
    use crate::cli::CliChildren;
    use tauri::Manager;

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

    /// A mock shell with `folder` registered and the shell's directories
    /// `paths`. Its commands run the CLI `bundled_program` names: in a
    /// development build, the CLI's source under the `bun` on `PATH`.
    fn app_with(folder: FolderConfig, paths: DesktopPaths) -> tauri::App<MockRuntime> {
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
        app.manage(paths);
        app.folders()
            .register(ScopeConfig {
                scope: "data:notes".into(),
                folder,
                windows: vec!["folders".into()],
            })
            .unwrap();
        app
    }

    fn reply(output: &CliExit) -> Value {
        serde_json::from_str(output.reply.as_deref().expect("a reply line")).unwrap()
    }

    /// Each history command runs only for a folder this window was granted,
    /// as the one fixed invocation, with the CLI's own author; save version
    /// and sync reach a local bare remote; and edits that compete merge into
    /// one commit this folder's edit wins, with nothing to settle.
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
            FolderConfig::data(&root),
            DesktopPaths {
                data_dir: project.join("data"),
                folder_dir: project.join("Epicenter"),
                cache_dir: project.join("cache"),
            },
        );
        let folders = WebviewWindowBuilder::new(&app, "folders", Default::default())
            .build()
            .unwrap();
        let other = WebviewWindowBuilder::new(&app, "other", Default::default())
            .build()
            .unwrap();
        let webview = |window: &tauri::WebviewWindow<MockRuntime>| window.as_ref().clone();

        // Before the grant, and for another window, nothing runs.
        let refused = run_history(&webview(&folders), "data:notes", "status", Vec::new())
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
        let refused = run_history(&webview(&other), "data:notes", "status", Vec::new())
            .await
            .unwrap_err();
        assert!(matches!(refused, CliError::NotGranted { .. }), "{refused:?}");

        let status = run_history(&webview(&folders), "data:notes", "status", Vec::new())
            .await
            .unwrap();
        assert_eq!(status.code, 0, "{}", status.stderr);
        assert_eq!(
            reply(&status)["result"]["data"]["changes"],
            json!([{ "path": "a.txt", "kind": "add" }])
        );

        let saved = run_history(
            &webview(&folders),
            "data:notes",
            "save-version",
            vec!["--message".into(), "First".into()],
        )
        .await
        .unwrap();
        assert_eq!(saved.code, 0, "{}", saved.stderr);
        assert_eq!(git(&root, &["log", "-1", "--format=%an %s"]), "Epicenter First");

        let synced = run_history(&webview(&folders), "data:notes", "sync", sync_options(None, false))
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
        let held = run_history(&webview(&folders), "data:notes", "sync", sync_options(None, false))
            .await
            .unwrap();
        assert_eq!(held.code, 0, "{}", held.stderr);
        assert_eq!(reply(&held)["result"]["data"]["kind"], "synced");
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "mine
");
        assert_eq!(git(&root, &["rev-list", "--parents", "-n", "1", "HEAD"]).split(' ').count(), 3);
        assert_eq!(
            git(&bare, &["rev-parse", "main"]),
            git(&root, &["rev-parse", "HEAD"])
        );
        assert_eq!(app.state::<CliChildren>().running("folders"), 0);
        app.folders().shutdown();
        let _ = fs::remove_dir_all(project);
    }
}
