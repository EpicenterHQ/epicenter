//! Installed apps: the Folders window's commands for them, and the build an
//! app's window loads (ADR-0540, ADR-0552, ADR-0556, ADR-0597).
//!
//! Installing lives in the `epicenter` CLI (`packages/cli/src/installed-apps.ts`):
//! the bare clone under `<data_dir>/apps/<app-id>/`, whose detached `HEAD` is
//! the approved commit, `epicenter.app.json`, Git, `bun install`, and the
//! build into `<cache_dir>/builds/<app-id>/<commit>/`. Each command here is one fixed
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
//! (ADR-0588), so a new build changes no open window. The CLI checks a
//! build against its commit at every open. Only when it answers that the
//! build is damaged does the open reserve that commit (`BuildReservation`),
//! which fails while a window runs it, and ask the CLI to restore it in place
//! (`--restore`); otherwise the damaged build is left for the windows running
//! it (`checked_open`).

use std::ffi::OsString;

use tauri::ipc::Channel;
use tauri::{Manager, Webview};

use crate::cli::{window_invocation, CliError, CliExit};
use crate::data_folders;
use crate::BuildReservation;

/// Whether `value` is a full commit id, SHA-1 or SHA-256, in the lowercase
/// hex Git prints, and so can name a directory under `builds/<id>/`.
pub(crate) fn is_commit(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// What `epicenter app update --commit=<commit> --json` answered for an
/// open, from its last line, `{"app": {"commit": …, "state": {…}}}`.
#[derive(Debug, PartialEq)]
enum Answer {
    /// The approved commit, built, its build intact.
    Ready(String),
    /// The approved commit, whose build directory changed on disk and was
    /// left as it is, since a window may be running it.
    Damaged(String),
}

/// The CLI's answer for `commit`, or why it opens nothing: waiting for
/// approval, another commit, or a failure.
fn answer_for(exit: &CliExit, commit: &str, title: &str) -> Result<Answer, String> {
    match exit.code {
        0 => match answer(exit.reply.as_deref()) {
            Some(Answer::Ready(built) | Answer::Damaged(built)) if built != commit => {
                Err(format!("{title} was not built at {commit}."))
            }
            Some(answer) => Ok(answer),
            None => Err(format!("{title} was not built at {commit}.")),
        },
        1 => Err(format!(
            "{title} is waiting for approval. Review and approve it first."
        )),
        _ => Err(exit.failure("app update")),
    }
}

/// Settle how `commit` opens. The CLI is asked once without restoring, so
/// opens of an intact build never reserve it and never refuse each other.
/// Only when it answers that the build changed on disk is the build reserved
/// (`reserve`, which fails while a window runs that commit or another open
/// restores it) and the CLI asked again with `--restore`. Answers the
/// reservation the window is pinned under, when one was taken.
async fn checked_open<G, Ask, Asked>(
    commit: &str,
    title: &str,
    mut ask: Ask,
    reserve: impl FnOnce() -> Option<G>,
) -> Result<Option<G>, String>
where
    Ask: FnMut(bool) -> Asked,
    Asked: std::future::Future<Output = Result<CliExit, String>>,
{
    if let Answer::Ready(_) = answer_for(&ask(false).await?, commit, title)? {
        return Ok(None);
    }
    let Some(reservation) = reserve() else {
        return Err(format!(
            "{title}'s files for this version changed on disk. Close its windows, or wait for the other open to restore them, then open it again."
        ));
    };
    match answer_for(&ask(true).await?, commit, title)? {
        Answer::Ready(_) => Ok(Some(reservation)),
        Answer::Damaged(_) => Err(format!(
            "{title}'s files for this version changed on disk and were not restored."
        )),
    }
}

fn answer(reply: Option<&str>) -> Option<Answer> {
    let value = serde_json::from_str::<serde_json::Value>(reply?).ok()?;
    let app = value.get("app")?;
    let commit = app.get("commit")?.as_str()?.to_string();
    match app.pointer("/state/kind")?.as_str()? {
        "ready" => Some(Answer::Ready(commit)),
        "damaged" => Some(Answer::Damaged(commit)),
        _ => None,
    }
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
/// approves it first. `restore` asks an open to restore a damaged build in
/// place, which only an open that reserved that build may ask.
fn update_args(id: &str, commit: Option<&str>, approve: bool, restore: bool) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["app".into(), "update".into()];
    if let Some(commit) = commit {
        args.push(format!("--commit={commit}").into());
    }
    if approve {
        args.push("--approve".into());
    }
    if restore {
        args.push("--restore".into());
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

/// `epicenter app list --json`: every installed app, with whether it can
/// run and any fetched commit waiting for approval.
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

/// Clone the repository at `source` bare into app data, with the app at
/// `folder` within it, or at its root when `folder` is empty. Nothing is
/// approved yet: the CLI exits 1 with the fetched commit's review.
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
    stream(
        &webview,
        update_args(&id, Some(&commit), true, false),
        on_line,
    )
    .await
}

/// Fetch app `id`'s default branch, which never moves its approved commit. A
/// fetched commit waits for approval, reviewed in the result.
#[tauri::command]
#[specta::specta]
pub async fn update_app(
    webview: Webview,
    id: String,
    on_line: Channel<String>,
) -> Result<CliExit, CliError> {
    stream(&webview, update_args(&id, None, false, false), on_line).await
}

/// Open app `id` at `commit`, the commit the Folders window listed, in its own
/// window titled `title`, served at `/apps/<id>/<commit>/`. The CLI is asked
/// first, every time, and answers only for the approved commit, building it
/// when it is not built and checking its build when it is. A build that
/// changed on disk is restored only under a reservation, taken when no window
/// runs that commit (`checked_open`); otherwise the open is refused. A window
/// already open on the folder is revealed when it runs that build, and
/// refused when it runs another. With
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
    let ask = |restore: bool| {
        let args = update_args(&id, Some(&commit), false, restore);
        let webview = &webview;
        async move {
            window_invocation(webview)
                .map_err(|error| format!("{error:?}"))?
                .run(&args, None, |_| Ok(()))
                .await
                .map_err(|error| match error {
                    CliError::Failed { message } => message,
                    other => format!("{other:?}"),
                })
        }
    };
    // A reservation, when a restore took one, is held until this open's
    // window is pinned, so no other open replaces the build while it loads.
    let reservation = checked_open(&commit, &title, ask, || {
        BuildReservation::take(&app, &id, &commit)
    })
    .await?;
    tauri::async_runtime::spawn_blocking(move || {
        let folder = match folder {
            Some(folder) => folder,
            None => data_folders::own_folder(&app, &id)?,
        };
        let opened =
            crate::open_installed_window(&app, &id, &commit, &title, &folder, reservation.as_ref())
                .map_err(|error| format!("{error:#}"));
        drop(reservation);
        opened
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
            strings(update_args("com.example.board", None, false, false)),
            ["app", "update", "--json", "--", "com.example.board"]
        );
        assert_eq!(
            strings(update_args("com.example.board", Some("abc"), true, false)),
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
        assert_eq!(
            strings(update_args("com.example.board", Some("abc"), false, true)),
            [
                "app",
                "update",
                "--commit=abc",
                "--restore",
                "--json",
                "--",
                "com.example.board"
            ]
        );
    }

    /// A window opens only on the build the CLI answered ready,
    /// never on a commit it is still waiting to approve or failed to build.
    #[test]
    fn a_window_opens_only_on_the_commit_the_cli_answered_for() {
        let commit = "a".repeat(40);
        let reply = |state: &str| {
            format!(r#"{{"app":{{"id":"com.example.board","commit":"{commit}","state":{state}}}}}"#)
        };
        assert_eq!(
            answer(Some(&reply(r#"{"kind":"ready"}"#))),
            Some(Answer::Ready(commit.clone()))
        );
        assert_eq!(
            answer(Some(&reply(r#"{"kind":"damaged"}"#))),
            Some(Answer::Damaged(commit.clone()))
        );
        for state in [
            r#"{"kind":"unbuilt"}"#,
            r#"{"kind":"needsApproval"}"#,
            r#"{"kind":"broken","problem":"x"}"#,
        ] {
            assert_eq!(answer(Some(&reply(state))), None, "{state}");
        }
        for other in [
            None,
            Some(""),
            Some(r#"{"error":"Board did not build"}"#),
            Some(r#"{"progress":"x"}"#),
        ] {
            assert_eq!(answer(other), None, "{other:?}");
        }
    }

    /// Opens of an intact build ask once and take no reservation, so two of
    /// them never refuse each other; only a damaged build is reserved, and
    /// restored only under that reservation.
    #[test]
    fn only_a_damaged_build_is_reserved_and_restored() {
        let commit = "a".repeat(40);
        let reply = |kind: &str| CliExit {
            code: 0,
            reply: Some(format!(
                r#"{{"app":{{"commit":"{commit}","state":{{"kind":"{kind}"}}}}}}"#
            )),
            stderr: String::new(),
        };
        let open = |states: &[&'static str], reservable: bool| {
            let asked = std::cell::RefCell::new(Vec::new());
            let reserved = std::cell::Cell::new(false);
            let mut states = states.iter();
            let result = tauri::async_runtime::block_on(checked_open(
                &commit,
                "Board",
                |restore| {
                    asked.borrow_mut().push(restore);
                    std::future::ready(Ok(reply(states.next().unwrap())))
                },
                || {
                    reserved.set(true);
                    reservable.then_some("reservation")
                },
            ));
            (result, asked.into_inner(), reserved.get())
        };

        for _ in 0..2 {
            assert_eq!(open(&["ready"], false), (Ok(None), vec![false], false));
        }
        assert_eq!(
            open(&["damaged", "ready"], true),
            (Ok(Some("reservation")), vec![false, true], true)
        );
        let (refused, asked, _) = open(&["damaged"], false);
        assert!(refused.unwrap_err().contains("Close its windows"));
        assert_eq!(asked, [false], "no restore without the reservation");
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
