//! The shell's own commands: one thin call per service.
//!
//! Every command checks that the notes window is calling. The capability for
//! that window is what grants them; this check keeps the answer the same if a
//! capability is ever widened. No command accepts a root, and none accepts a
//! working directory: both are the shell's.
//!
//! The terminal, history, and reveal block on a child process, so they run on
//! the blocking pool, never on the thread that drives the window.

use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use tauri::{Runtime, State, Webview};

use crate::history::{self, FileRevision};
use crate::reveal;
use crate::terminal::{Terminal, TerminalReply};

/// The label of the one window, the only one the folder scope and these
/// commands serve.
pub const WINDOW: &str = "main";

/// What the shell holds for its window.
pub struct Shell {
    pub terminal: Arc<Terminal>,
}

fn notes_window<R: Runtime>(webview: &Webview<R>) -> Result<(), String> {
    if webview.label() == WINDOW {
        Ok(())
    } else {
        Err(format!(
            "the window '{}' is not the notes window",
            webview.label()
        ))
    }
}

/// Run blocking work off the window thread.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|cause| cause.to_string())
}

// ============================================================================
// Terminal, history, reveal
// ============================================================================

/// A path for the page to show. The shell keeps the exact path; a name that
/// is not UTF-8 is shown with replacement characters and still works.
fn shown(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[derive(Debug, Serialize)]
pub struct ShellInfo {
    /// The canonical notes directory.
    root: String,
    /// Where the next terminal command starts.
    cwd: String,
}

#[tauri::command]
pub fn shell_info<R: Runtime>(
    webview: Webview<R>,
    shell: State<'_, Shell>,
) -> Result<ShellInfo, String> {
    notes_window(&webview)?;
    Ok(ShellInfo {
        root: shown(shell.terminal.root()),
        cwd: shown(&shell.terminal.cwd()),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRun {
    stdout: String,
    stderr: String,
    exit_code: i32,
    /// The working directory after the command, absolute.
    cwd: String,
}

impl From<TerminalReply> for TerminalRun {
    fn from(reply: TerminalReply) -> Self {
        Self {
            stdout: reply.stdout,
            stderr: reply.stderr,
            exit_code: reply.exit_code,
            cwd: shown(&reply.cwd),
        }
    }
}

#[tauri::command]
pub async fn terminal_run<R: Runtime>(
    webview: Webview<R>,
    shell: State<'_, Shell>,
    command: String,
) -> Result<TerminalRun, String> {
    notes_window(&webview)?;
    let terminal = Arc::clone(&shell.terminal);
    blocking(move || terminal.run(&command).into()).await
}

#[tauri::command]
pub async fn file_log<R: Runtime>(
    webview: Webview<R>,
    shell: State<'_, Shell>,
    path: String,
    depth: u32,
) -> Result<Vec<FileRevision>, String> {
    notes_window(&webview)?;
    let root = shell.terminal.root().to_path_buf();
    blocking(move || history::file_log(&root, &path, depth))
        .await?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn file_show<R: Runtime>(
    webview: Webview<R>,
    shell: State<'_, Shell>,
    oid: String,
    path: String,
) -> Result<String, String> {
    notes_window(&webview)?;
    let root = shell.terminal.root().to_path_buf();
    blocking(move || history::show(&root, &oid, &path))
        .await?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn reveal_folder<R: Runtime>(
    webview: Webview<R>,
    shell: State<'_, Shell>,
) -> Result<(), String> {
    notes_window(&webview)?;
    let root = shell.terminal.root().to_path_buf();
    blocking(move || reveal::reveal(&root)).await?
}
