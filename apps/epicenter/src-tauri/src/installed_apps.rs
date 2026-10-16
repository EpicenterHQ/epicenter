//! Installed apps: the Folders window's commands for them, and the build an
//! app's window loads (ADR-0540, ADR-0552, ADR-0556).
//!
//! Installing lives in the `epicenter` CLI (`packages/cli/src/installed-apps.ts`):
//! the clone under `<folder_dir>/Apps/<app-id>/`, `epicenter.app.json`,
//! `approvals.json`, Git, `bun install`, and the build into
//! `<cache_dir>/builds/<app-id>/<commit>/`. Each command here is one fixed
//! `epicenter app …` invocation, run as every command runs the CLI
//! (`cli::window_invocation`: this shell's deployment and directories, and
//! ended with the Folders window's page), whose NDJSON lines go to the
//! page's `Channel` as the CLI prints them.
//!
//! ```txt
//! list_installed_apps    epicenter app list --json
//! list_repository_apps   epicenter app list --repository=<source> --json
//! install_app            epicenter app install [--folder=<folder>] --json -- <source>
//! update_app             epicenter app update --json -- <id>
//! approve_app            epicenter app update --commit=<commit> --approve --json -- <id>
//! open_installed_app     epicenter app update --commit=<commit> --json -- <id>, when that commit is not built
//! ```
//!
//! What stays here is what must be native: reading which build is current,
//! and opening an app's window with its folder grant (`open_installed_window`).

use std::ffi::OsString;
use std::fs;
use std::path::Path;

use tauri::ipc::Channel;
use tauri::{Manager, Webview};

use crate::app_data::DesktopPaths;
use crate::cli::{window_invocation, CliError, CliExit};
use crate::data_folders;

/// The file in an app's build directory naming the commit its window loads.
pub const CURRENT_BUILD: &str = "current";

/// The commit `builds/<id>/current` names, when its build is there.
pub fn current_build(builds: &Path) -> Option<String> {
    let commit = fs::read_to_string(builds.join(CURRENT_BUILD)).ok()?;
    let commit = commit.trim();
    (is_commit(commit) && builds.join(commit).join("index.html").is_file())
        .then(|| commit.to_string())
}

fn is_commit(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Whether `id` can name a directory under `builds/`: the characters of a
/// reverse-domain app id, never `..`. The CLI checks the whole rule.
fn is_app_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.starts_with(['.', '-'])
        && !id.contains("..")
        && id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'.' || byte == b'-'
        })
}

/// The arguments for `epicenter app list --json`, or with `source`, the apps
/// in that repository.
fn list_args(source: Option<&str>) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["app".into(), "list".into()];
    if let Some(source) = source {
        args.push(format!("--repository={}", source.trim()).into());
    }
    args.push("--json".into());
    args
}

/// The arguments for installing the app at `folder` (empty for the root) of
/// the repository at `source`. It builds nothing that waits for approval.
fn install_args(source: &str, folder: &str) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["app".into(), "install".into()];
    if !folder.trim().is_empty() {
        args.push(format!("--folder={}", folder.trim()).into());
    }
    args.extend(["--json".into(), "--".into(), source.trim().into()]);
    args
}

/// The arguments for updating app `id`. With `commit`, nothing is fetched
/// and only that commit, the one a person was shown, is built; `approve`
/// approves it first.
fn update_args(id: &str, commit: Option<&str>, approve: bool) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["app".into(), "update".into()];
    if let Some(commit) = commit {
        args.push(format!("--commit={commit}").into());
    }
    if approve {
        args.push("--approve".into());
    }
    args.extend(["--json".into(), "--".into(), id.into()]);
    args
}

/// Run `epicenter <args>` for `webview`'s page, every line it prints sent to
/// `on_line`.
async fn stream(
    webview: &Webview,
    args: Vec<OsString>,
    on_line: Channel<String>,
) -> Result<CliExit, CliError> {
    window_invocation(webview)?
        .run(&args, None, |line| {
            on_line.send(line).map_err(|error| error.to_string())
        })
        .await
}

// ---------------------------------------------------------------------------
// Commands, granted to the Folders window alone

/// `epicenter app list --json`: every app installed under `Apps/`, with
/// whether it can run.
#[tauri::command]
#[specta::specta]
pub async fn list_installed_apps(
    webview: Webview,
    on_line: Channel<String>,
) -> Result<CliExit, CliError> {
    stream(&webview, list_args(None), on_line).await
}

/// The apps in the repository at `source`, a Git URL or a local path, each
/// with the folder to install it from.
#[tauri::command]
#[specta::specta]
pub async fn list_repository_apps(
    webview: Webview,
    source: String,
    on_line: Channel<String>,
) -> Result<CliExit, CliError> {
    stream(&webview, list_args(Some(&source)), on_line).await
}

/// Clone the repository at `source` into `Apps/`, with the app at `folder`
/// within it, or at its root when `folder` is empty. A commit nobody approved
/// here waits for approval; the CLI exits 1 with its review.
#[tauri::command]
#[specta::specta]
pub async fn install_app(
    webview: Webview,
    source: String,
    folder: String,
    on_line: Channel<String>,
) -> Result<CliExit, CliError> {
    stream(&webview, install_args(&source, &folder), on_line).await
}

/// Approve `commit` of app `id`, the commit the person was shown, and build
/// it.
#[tauri::command]
#[specta::specta]
pub async fn approve_app(
    webview: Webview,
    id: String,
    commit: String,
    on_line: Channel<String>,
) -> Result<CliExit, CliError> {
    stream(&webview, update_args(&id, Some(&commit), true), on_line).await
}

/// Fetch app `id`'s upstream and bring it up to date. What arrives from
/// elsewhere waits for approval.
#[tauri::command]
#[specta::specta]
pub async fn update_app(
    webview: Webview,
    id: String,
    on_line: Channel<String>,
) -> Result<CliExit, CliError> {
    stream(&webview, update_args(&id, None, false), on_line).await
}

/// Open app `id` at `commit`, the commit the Folders window listed, in its own
/// window titled `title`. When that commit is not the build its window
/// loads, the CLI builds it first, which it does only for a commit that may
/// run (one made here, or approved). With `folder`, a scope the Folders
/// window listed, the window is let into that folder and the app is handed
/// it as `?folder=`. Without one, the app is handed its own folder,
/// `<folder_dir>/<id>`, whose scope is its id (ADR-0552).
#[tauri::command]
#[specta::specta]
pub async fn open_installed_app(
    webview: Webview,
    id: String,
    title: String,
    commit: String,
    folder: Option<String>,
) -> Result<(), String> {
    if !is_app_id(&id) || !is_commit(&commit) {
        return Err(format!(
            "'{id}' at '{commit}' is not an installed app's commit."
        ));
    }
    let app = webview.app_handle().clone();
    let builds = app.state::<DesktopPaths>().builds_dir().join(&id);
    if current_build(&builds).as_deref() != Some(commit.as_str()) {
        let exit = window_invocation(&webview)
            .map_err(|error| format!("{error:?}"))?
            .run(&update_args(&id, Some(&commit), false), None, |_| Ok(()))
            .await
            .map_err(|error| match error {
                CliError::Failed { message } => message,
                other => format!("{other:?}"),
            })?;
        match exit.code {
            0 => {}
            1 => {
                return Err(format!(
                    "{title} changed from elsewhere. Review and approve it first."
                ))
            }
            _ => return Err(exit.failure("app update")),
        }
    }
    // The app may read `so.epicenter` through a lens its declaration must
    // contain, so it waits for this launch to publish it.
    if let Some(declared) = app.try_state::<crate::cli::EpicenterFolderDeclared>() {
        declared.finished().await;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let folder = match folder {
            Some(folder) => folder,
            None => data_folders::own_folder(&app, &id)?,
        };
        crate::open_installed_window(&app, &id, &title, Some(&folder))
            .map_err(|error| format!("{error:#}"))
    })
    .await
    .map_err(|error| format!("the app window could not be opened: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: Vec<OsString>) -> Vec<String> {
        args.into_iter()
            .map(|arg| arg.into_string().unwrap())
            .collect()
    }

    /// Each command is one fixed invocation, and what a page typed lands
    /// after `--` or inside `--name=value`, so it is never read as an option.
    #[test]
    fn each_command_is_one_fixed_invocation() {
        assert_eq!(strings(list_args(None)), ["app", "list", "--json"]);
        assert_eq!(
            strings(list_args(Some(" --upload-pack=x "))),
            ["app", "list", "--repository=--upload-pack=x", "--json"]
        );
        assert_eq!(
            strings(install_args("https://example.com/r.git", "apps/todos")),
            [
                "app",
                "install",
                "--folder=apps/todos",
                "--json",
                "--",
                "https://example.com/r.git"
            ]
        );
        assert_eq!(
            strings(install_args("--evil", " ")),
            ["app", "install", "--json", "--", "--evil"]
        );
        assert_eq!(
            strings(update_args("com.example.board", None, false)),
            ["app", "update", "--json", "--", "com.example.board"]
        );
        assert_eq!(
            strings(update_args("com.example.board", Some("abc"), true)),
            [
                "app",
                "update",
                "--commit=abc",
                "--approve",
                "--json",
                "--",
                "com.example.board"
            ]
        );
    }

    #[test]
    fn only_a_current_build_with_its_page_is_served() {
        let builds =
            std::env::temp_dir().join(format!("epicenter-current-build-{}", std::process::id()));
        let _ = fs::remove_dir_all(&builds);
        fs::create_dir_all(&builds).unwrap();
        let commit = "a".repeat(40);
        assert_eq!(current_build(&builds), None);
        fs::write(builds.join(CURRENT_BUILD), format!("{commit}\n")).unwrap();
        assert_eq!(current_build(&builds), None, "no build is there yet");
        fs::create_dir_all(builds.join(&commit)).unwrap();
        fs::write(builds.join(&commit).join("index.html"), "<!doctype html>").unwrap();
        assert_eq!(current_build(&builds), Some(commit));
        fs::write(builds.join(CURRENT_BUILD), "../elsewhere\n").unwrap();
        assert_eq!(current_build(&builds), None);
        let _ = fs::remove_dir_all(&builds);
    }

    #[test]
    fn opening_takes_only_an_app_id_and_a_commit() {
        for id in ["so.epicenter.todos", "com.example.board"] {
            assert!(is_app_id(id), "{id}");
        }
        for id in ["", "..", "../x", "a/b", ".hidden", "-x", "A.b", "a..b"] {
            assert!(!is_app_id(id), "{id}");
        }
        assert!(is_commit(&"0".repeat(40)));
        assert!(!is_commit("HEAD"));
    }

    #[test]
    fn a_failure_reads_the_clis_error_line_first() {
        let exit = |reply: Option<&str>, code: i32, stderr: &str| CliExit {
            code,
            reply: reply.map(str::to_string),
            stderr: stderr.into(),
        };
        assert_eq!(
            exit(Some(r#"{"error":"Board did not build"}"#), 2, "for people\n")
                .failure("app update"),
            "Board did not build"
        );
        assert_eq!(
            exit(Some(r#"{"progress":"x"}"#), 2, "for people\n").failure("app update"),
            "for people"
        );
        assert_eq!(
            exit(None, 3, "").failure("app update"),
            "epicenter app update exited with 3"
        );
    }
}
