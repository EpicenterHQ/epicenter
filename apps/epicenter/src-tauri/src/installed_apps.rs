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
//! build against its commit at every open; when it answers that the build
//! changed on disk, with a fresh copy beside it, the copy is swapped in only
//! while no window runs that commit (`restore_build`).

use std::ffi::OsString;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use tauri::ipc::Channel;
use tauri::{Manager, Webview};

use crate::app_data::DesktopPaths;
use crate::cli::{window_invocation, CliError, CliExit};
use crate::data_folders;
use crate::InstalledWindowCommits;

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
    /// The approved commit, whose build directory changed on disk:
    /// `repaired` names a fresh copy beside it in `builds/<id>/`.
    Damaged { commit: String, repaired: String },
}

fn answer(reply: Option<&str>) -> Option<Answer> {
    let value = serde_json::from_str::<serde_json::Value>(reply?).ok()?;
    let app = value.get("app")?;
    let commit = app.get("commit")?.as_str()?.to_string();
    match app.pointer("/state/kind")?.as_str()? {
        "ready" => Some(Answer::Ready(commit)),
        "damaged" => Some(Answer::Damaged {
            commit,
            repaired: app.pointer("/state/repaired")?.as_str()?.to_string(),
        }),
        _ => None,
    }
}

/// Swap the fresh copy `repaired` into installed app `id`'s build of
/// `commit` when no window runs that commit (ADR-0597), and otherwise leave
/// both directories and refuse, so the windows on that commit are closed
/// before their files are replaced.
fn restore_build(
    windows: &InstalledWindowCommits,
    builds: &Path,
    id: &str,
    commit: &str,
    repaired: &str,
    title: &str,
) -> Result<(), String> {
    windows
        .when_unused(id, commit, || replace_build(builds, id, commit, repaired))
        .unwrap_or_else(|| {
            Err(format!(
                "{title}'s files for this version changed on disk. Close its windows, then open it again to restore them."
            ))
        })
}

/// Move `<builds>/<id>/<commit>/` aside, rename the fresh copy `repaired`,
/// `.<commit>-<hex>` beside it, into its place, and remove the old one.
fn replace_build(builds: &Path, id: &str, commit: &str, repaired: &str) -> Result<(), String> {
    let fresh_copy = repaired
        .strip_prefix(&format!(".{commit}-"))
        .is_some_and(|suffix| {
            !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
        });
    if !is_app_id(id) || !is_commit(commit) || !fresh_copy {
        return Err(format!(
            "'{repaired}' is not a fresh copy of the build of {commit}."
        ));
    }
    let app = builds.join(id);
    let build = app.join(commit);
    let fresh = app.join(repaired);
    if !fs::symlink_metadata(&fresh).is_ok_and(|stats| stats.is_dir()) {
        return Err(format!(
            "The fresh copy of the build of {commit} is missing. Open it again."
        ));
    }
    let aside = app.join(format!("{repaired}-damaged"));
    let moved = match fs::rename(&build, &aside) {
        Ok(()) => true,
        Err(error) if error.kind() == ErrorKind::NotFound => false,
        Err(error) => {
            return Err(format!(
                "The changed build could not be moved aside: {error}"
            ))
        }
    };
    if let Err(error) = fs::rename(&fresh, &build) {
        if moved {
            let _ = fs::rename(&aside, &build);
        }
        return Err(format!(
            "The fresh copy of the build could not be moved into place: {error}"
        ));
    }
    if moved {
        // Best effort: the CLI removes what is left at its next build.
        if let Err(error) = fs::remove_dir_all(&aside) {
            log::warn!(
                "the changed build {} was not removed: {error}",
                aside.display()
            );
        }
    }
    Ok(())
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
    stream(&webview, update_args(&id, Some(&commit), true), on_line).await
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
    stream(&webview, update_args(&id, None, false), on_line).await
}

/// Open app `id` at `commit`, the commit the Folders window listed, in its own
/// window titled `title`, served at `/apps/<id>/<commit>/`. The CLI is asked
/// first, every time, and answers only for the approved commit, building it
/// when it is not built and checking its build when it is. A build that
/// changed on disk is replaced by the CLI's fresh copy when no window runs
/// that commit, and otherwise the open is refused. A window already open on
/// the folder is revealed when it runs that build, and refused when it runs
/// another. With
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
    let repaired = match exit.code {
        0 => match answer(exit.reply.as_deref()) {
            Some(Answer::Ready(built)) if built == commit => None,
            Some(Answer::Damaged {
                commit: built,
                repaired,
            }) if built == commit => Some(repaired),
            _ => return Err(format!("{title} was not built at {commit}.")),
        },
        1 => {
            return Err(format!(
                "{title} is waiting for approval. Review and approve it first."
            ))
        }
        _ => return Err(exit.failure("app update")),
    };
    // The app may read `so.epicenter` through a definition its declaration
    // must contain, so it waits for this launch to publish it.
    if let Some(declared) = app.try_state::<crate::cli::EpicenterFolderDeclared>() {
        declared.finished().await;
    }
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(repaired) = repaired {
            restore_build(
                &app.state::<InstalledWindowCommits>(),
                &app.state::<DesktopPaths>().builds_dir(),
                &id,
                &commit,
                &repaired,
                &title,
            )?;
        }
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

    /// A window opens only on the build the CLI answered ready or restored,
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
            answer(Some(&reply(r#"{"kind":"damaged","repaired":".aaa-01"}"#))),
            Some(Answer::Damaged {
                commit: commit.clone(),
                repaired: ".aaa-01".into()
            })
        );
        for state in [
            r#"{"kind":"unbuilt"}"#,
            r#"{"kind":"needsApproval"}"#,
            r#"{"kind":"broken","problem":"x"}"#,
            r#"{"kind":"damaged"}"#,
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

    /// A build that changed on disk, with the CLI's fresh copy beside it.
    fn damaged_build(commit: &str) -> (tempfile::TempDir, std::path::PathBuf, String) {
        let temporary = tempfile::tempdir().unwrap();
        let builds = temporary.path().join("builds");
        let app = builds.join("com.example.board");
        let repaired = format!(".{commit}-0123abcd");
        fs::create_dir_all(app.join(commit)).unwrap();
        fs::write(app.join(commit).join("index.html"), "edited").unwrap();
        fs::create_dir_all(app.join(&repaired)).unwrap();
        fs::write(app.join(&repaired).join("index.html"), "approved").unwrap();
        (temporary, builds, repaired)
    }

    /// The fresh copy replaces a damaged build only while no window runs that
    /// commit; a window on it keeps its files and the open is refused.
    #[test]
    fn a_damaged_build_is_replaced_only_when_no_window_runs_it() {
        let commit = "b".repeat(40);
        let (_temporary, builds, repaired) = damaged_build(&commit);
        let app = builds.join("com.example.board");
        let windows = InstalledWindowCommits::default();
        windows.record("app:com_example_board:61", &commit);
        // Another app's window, or this app's window on another commit, does
        // not hold it.
        windows.record("app:com_example_boards:61", &commit);
        windows.record("app:com_example_board:62", &"c".repeat(40));

        let refused = restore_build(
            &windows,
            &builds,
            "com.example.board",
            &commit,
            &repaired,
            "Board",
        )
        .unwrap_err();
        assert_eq!(
            refused,
            "Board's files for this version changed on disk. Close its windows, then open it again to restore them."
        );
        assert_eq!(
            fs::read_to_string(app.join(&commit).join("index.html")).unwrap(),
            "edited"
        );
        assert!(app.join(&repaired).is_dir());

        windows.forget("app:com_example_board:61");
        restore_build(
            &windows,
            &builds,
            "com.example.board",
            &commit,
            &repaired,
            "Board",
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(app.join(&commit).join("index.html")).unwrap(),
            "approved"
        );
        let mut left: Vec<_> = fs::read_dir(&app)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(left, [commit.clone()]);
    }

    /// Only a fresh copy of that commit's build, beside it, is swapped in.
    #[test]
    fn only_a_fresh_copy_beside_the_build_is_swapped_in() {
        let commit = "d".repeat(40);
        let (_temporary, builds, _repaired) = damaged_build(&commit);
        for repaired in [
            "../x".to_string(),
            format!(".{commit}-"),
            format!(".{commit}-0123/../../x"),
            format!(".{}-0123abcd", "e".repeat(40)),
            format!("{commit}-0123abcd"),
            format!(".{commit}-0123abce"),
        ] {
            assert!(
                replace_build(&builds, "com.example.board", &commit, &repaired).is_err(),
                "{repaired}"
            );
        }
        assert_eq!(
            fs::read_to_string(
                builds
                    .join("com.example.board")
                    .join(&commit)
                    .join("index.html")
            )
            .unwrap(),
            "edited"
        );
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
