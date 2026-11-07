//! The Folders window's Git (ADR-0826, ADR-0828): what `importGit` in
//! `@epicenter/folder/platform` needs of this computer, its `GitHost`,
//! which a page cannot do itself. The page runs the import; these commands
//! only run the system `git`, keep a scratch directory for its mirror, read
//! a Git LFS object, and hand a repository over to the Epicenter folder,
//! plus the folder picker that chooses the repository. None of them touches
//! a folder Epicenter syncs.

use std::collections::BTreeSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;
use tauri_plugin_dialog::DialogExt;

/// What one run of `git` answered: its exit code, its stdout as base64,
/// and its stderr.
#[derive(Debug, Serialize, specta::Type)]
pub struct GitRun {
    code: i32,
    stdout: String,
    stderr: String,
}

/// The scratch directories `git_scratch` made, the only ones
/// `git_scratch_remove` removes.
static SCRATCH: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());

/// The `PATH` `git` runs with: the app's, and where Homebrew installs
/// `git` and Git LFS, which an app opened from the Dock does not inherit.
fn search_path() -> String {
    let inherited = std::env::var("PATH").unwrap_or_default();
    let mut paths = vec!["/opt/homebrew/bin", "/usr/local/bin"]
        .into_iter()
        .filter(|path| cfg!(target_os = "macos") && !inherited.split(':').any(|p| p == *path))
        .map(str::to_string)
        .collect::<Vec<_>>();
    if !inherited.is_empty() {
        paths.push(inherited);
    }
    paths.join(":")
}

/// Run `git` with `args` in `cwd`, writing `input` (base64) to its stdin,
/// with no terminal prompt.
#[tauri::command]
#[specta::specta]
pub async fn git_run(
    args: Vec<String>,
    cwd: Option<String>,
    input: Option<String>,
) -> Result<GitRun, String> {
    let input = input
        .map(|encoded| STANDARD.decode(encoded).map_err(|error| error.to_string()))
        .transpose()?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new("git");
        command
            .args(&args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("PATH", search_path())
            .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("git could not start: {error}"))?;
        if let (Some(bytes), Some(mut stdin)) = (input, child.stdin.take()) {
            // Written on its own thread, so a large stdout never blocks it.
            std::thread::spawn(move || stdin.write_all(&bytes));
        }
        let output = child.wait_with_output().map_err(|error| error.to_string())?;
        Ok(GitRun {
            code: output.status.code().unwrap_or(-1),
            stdout: STANDARD.encode(output.stdout),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// A new, empty directory for an import's mirror.
#[tauri::command]
#[specta::specta]
pub fn git_scratch() -> Result<String, String> {
    let dir = tempfile::Builder::new()
        .prefix("epicenter-import-")
        .tempdir()
        .map_err(|error| error.to_string())?
        .keep();
    let path = dir.to_string_lossy().into_owned();
    SCRATCH.lock().map_err(|error| error.to_string())?.insert(dir);
    Ok(path)
}

/// Remove a directory `git_scratch` made, with all it holds; any other
/// path is refused.
#[tauri::command]
#[specta::specta]
pub async fn git_scratch_remove(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !SCRATCH
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&path)
    {
        return Err(format!("{} is no scratch directory", path.display()));
    }
    tauri::async_runtime::spawn_blocking(move || std::fs::remove_dir_all(&path))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

/// Whether `oid` is a SHA-256 in lowercase hex, as a Git LFS object is named.
fn is_oid(oid: &str) -> bool {
    oid.len() == 64 && oid.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// Where Git LFS keeps `oid` below `dir`: `lfs/objects/<aa>/<bb>/<oid>`.
fn lfs_object_path(dir: &Path, oid: &str) -> PathBuf {
    dir.join("lfs")
        .join("objects")
        .join(&oid[..2])
        .join(&oid[2..4])
        .join(oid)
}

/// The bytes (base64) of the Git LFS object `oid` in the store below `dir`,
/// or none when it is not there.
#[tauri::command]
#[specta::specta]
pub async fn git_lfs_object(dir: String, oid: String) -> Result<Option<String>, String> {
    if !is_oid(&oid) {
        return Err(format!("{oid} is no Git LFS object"));
    }
    let path = lfs_object_path(Path::new(&dir), &oid);
    tauri::async_runtime::spawn_blocking(move || match std::fs::read(&path) {
        Ok(bytes) => Ok(Some(STANDARD.encode(bytes))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{}: {error}", path.display())),
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Move the Git repository at `from` to `to`, refused when anything is at
/// `to` or `from` holds no `.git`, and leave a link at `from` to `target`.
#[tauri::command]
#[specta::specta]
pub fn git_hand_over(from: String, to: String, target: String) -> Result<(), String> {
    hand_over(Path::new(&from), Path::new(&to), Path::new(&target))
}

fn hand_over(from: &Path, to: &Path, target: &Path) -> Result<(), String> {
    if from.join(".git").symlink_metadata().is_err() {
        return Err(format!("{} is not a Git repository", from.display()));
    }
    if to.symlink_metadata().is_ok() {
        return Err(format!(
            "{} is there already; move it, then hand over again",
            to.display()
        ));
    }
    std::fs::rename(from, to).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(target, from);
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_dir(target, from);
    linked.map_err(|error| error.to_string())
}

/// Ask the person to choose a Git repository on this computer: its path, or
/// none when they cancel.
#[tauri::command]
#[specta::specta]
pub async fn choose_repository(app: crate::DesktopAppHandle) -> Result<Option<String>, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Import from Git")
        .pick_folder(move |picked| {
            let _ = send.send(picked);
        });
    let Some(picked) = receive.await.map_err(|error| error.to_string())? else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|error| error.to_string())?;
    if path.join(".git").symlink_metadata().is_err() && path.join("HEAD").symlink_metadata().is_err()
    {
        return Err(format!("{} is not a Git repository", path.display()));
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_lfs_object_is_named_by_a_sha256_alone() {
        assert!(is_oid(&"a".repeat(64)));
        assert!(!is_oid("../../etc/passwd"));
        assert!(!is_oid(&"A".repeat(64)));
        assert_eq!(
            lfs_object_path(Path::new("/r/.git"), &"ab".repeat(32)),
            Path::new("/r/.git/lfs/objects/ab/ab").join("ab".repeat(32))
        );
    }

    #[test]
    fn only_a_scratch_directory_it_made_is_removed() {
        let elsewhere = tempfile::tempdir().unwrap();
        let refused = tauri::async_runtime::block_on(git_scratch_remove(
            elsewhere.path().to_string_lossy().into_owned(),
        ));
        assert!(refused.is_err());
        assert!(elsewhere.path().exists());
        let made = git_scratch().unwrap();
        assert!(Path::new(&made).is_dir());
        tauri::async_runtime::block_on(git_scratch_remove(made.clone())).unwrap();
        assert!(!Path::new(&made).exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_hand_over_moves_the_repository_aside_and_leaves_a_link() {
        let root = tempfile::tempdir().unwrap();
        let from = root.path().join("Notes");
        let to = root.path().join("Notes (before Epicenter)");
        let target = root.path().join("Epicenter/Notes");
        std::fs::create_dir_all(from.join(".git")).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        hand_over(&from, &to, &target).unwrap();
        assert!(to.join(".git").is_dir());
        assert_eq!(std::fs::read_link(&from).unwrap(), target);
        // Not a repository, or something already aside: refused.
        let plain = root.path().join("plain");
        std::fs::create_dir(&plain).unwrap();
        assert!(hand_over(&plain, &root.path().join("x"), &target).is_err());
        std::fs::create_dir_all(root.path().join("again/.git")).unwrap();
        assert!(hand_over(&root.path().join("again"), &to, &target).is_err());
    }
}
