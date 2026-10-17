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
//! open_installed_app     epicenter app update --commit=<commit> --json -- <id>, before every open
//! ```
//!
//! What stays here is what must be native: opening an app's window at the
//! commit the CLI answered ready, with its folder grant
//! (`open_installed_window`). An open window keeps the build it opened on
//! (ADR-0588), so a new build changes no open window.

use std::ffi::OsString;

use tauri::ipc::Channel;
use tauri::{Manager, Webview};

use crate::cli::{window_invocation, CliError, CliExit};
use crate::data_folders;

/// Whether `value` is a full commit id, SHA-1 or SHA-256, in the lowercase
/// hex Git prints, and so can name a directory under `builds/<id>/`.
pub(crate) fn is_commit(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// The commit `epicenter app update --json` answered as ready to open: its
/// last line, `{"app": {"commit": …, "state": {"kind": "ready"}}}`.
fn ready_commit(reply: Option<&str>) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(reply?).ok()?;
    let app = value.get("app")?;
    (app.pointer("/state/kind")?.as_str()? == "ready")
        .then(|| app.get("commit")?.as_str().map(str::to_string))
        .flatten()
}

/// Whether `id` can name a directory under `builds/`: the characters of a
/// reverse-domain app id, never `..`. The CLI checks the whole rule.
pub(crate) fn is_app_id(id: &str) -> bool {
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

/// Fetch app `id`'s upstream and bring it up to date. A commit not yet
/// approved waits for approval.
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
/// window titled `title`, served at `/apps/<id>/<commit>/`. The CLI is asked
/// first, every time, and answers only for an approved commit, building it
/// when it is not the current build. A window already open on the folder is
/// revealed when it runs that build, and refused when it runs another. With
/// `folder`, a scope the Folders window listed, the window is let into that
/// folder and handed it, which the page asks for with `window_folder`.
/// Without one, the app is handed its own folder, `<folder_dir>/<id>`, whose
/// scope is its id (ADR-0552).
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
    let exit = window_invocation(&webview)
        .map_err(|error| format!("{error:?}"))?
        .run(&update_args(&id, Some(&commit), false), None, |_| Ok(()))
        .await
        .map_err(|error| match error {
            CliError::Failed { message } => message,
            other => format!("{other:?}"),
        })?;
    let commit = match exit.code {
        0 => match ready_commit(exit.reply.as_deref()) {
            Some(built) if built == commit => built,
            _ => return Err(format!("{title} was not built at {commit}.")),
        },
        1 => {
            return Err(format!(
                "{title} is waiting for approval. Review and approve it first."
            ))
        }
        _ => return Err(exit.failure("app update")),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let folder = match folder {
            Some(folder) => folder,
            None => data_folders::own_folder(&app, &id)?,
        };
        crate::open_installed_window(&app, &id, &commit, &title, &folder)
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

    /// A window opens only on the build the CLI answered ready, never on a
    /// commit it is still waiting to approve or failed to build.
    #[test]
    fn a_window_opens_only_on_the_commit_the_cli_answered_ready() {
        let commit = "a".repeat(40);
        let reply = |kind: &str| {
            format!(
                r#"{{"app":{{"id":"com.example.board","commit":"{commit}","state":{{"kind":"{kind}"}}}}}}"#
            )
        };
        assert_eq!(ready_commit(Some(&reply("ready"))), Some(commit.clone()));
        for kind in ["unbuilt", "needsApproval", "broken"] {
            assert_eq!(ready_commit(Some(&reply(kind))), None, "{kind}");
        }
        for other in [
            None,
            Some(""),
            Some(r#"{"error":"Board did not build"}"#),
            Some(r#"{"progress":"x"}"#),
        ] {
            assert_eq!(ready_commit(other), None, "{other:?}");
        }
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
        assert!(is_commit(&"0123456789abcdef".repeat(4)));
        assert!(!is_commit("HEAD"));
        assert!(!is_commit(&"A".repeat(40)), "Git prints lowercase hex");
    }

    #[test]
    fn a_failure_reads_the_clis_error_line_first() {
        let exit = |reply: Option<&str>, code: i32, stderr: &str| CliExit {
            code,
            reply: reply.map(str::to_string),
            stderr: stderr.into(),
        };
        assert_eq!(
            exit(
                Some(r#"{"error":"Board did not build"}"#),
                2,
                "for people\n"
            )
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
