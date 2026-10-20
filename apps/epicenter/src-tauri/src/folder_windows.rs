//! One native window per app and folder, optionally grouped as macOS tabs.
//!
//! A bundled app's window, and each Folders editor, edits one existing
//! directory for its lifetime. The shell resolves the directory, binds it to
//! the window's label through the folder plugin before the WebView exists,
//! and names the window by the directory's canonical root, so opening the
//! same app on the same directory again reveals its window, and two
//! directories with one name in different places are two windows. A build
//! that fails leaves no binding behind. The plugin removes the binding when
//! the window is destroyed.

use std::path::Path;
use std::sync::mpsc;

use anyhow::Context;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use tauri_plugin_epicenter_folder::{Directory, FolderExt};

/// The generic file editor's route and capability-selected label prefix.
pub(crate) const EDITOR_PATH: &str = "/folders/editor/";
pub(crate) const EDITOR_PREFIX: &str = "files";

/// Tauri label for one application view on one canonical root. The digest
/// distinguishes equal basenames without putting paths in labels.
pub(crate) fn label(prefix: &str, root: &Path) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(root.as_os_str().as_encoded_bytes());
    let hex: String = digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("{prefix}:{hex}")
}

/// A window to show one directory in.
pub(crate) struct FolderWindow {
    pub label: String,
    pub title: String,
    pub directory: Directory,
}

impl FolderWindow {
    /// The window of `prefix`, such as `todos` or `files`, on `directory`:
    /// `<prefix>:<digest of the canonical root>` (`label`).
    pub fn new(prefix: &str, title: String, directory: Directory) -> Self {
        Self {
            label: label(prefix, directory.root()),
            title,
            directory,
        }
    }

    /// The generic editor, shared by listed folders and accepted handoffs.
    pub fn editor(directory: Directory) -> Self {
        let title = format!("Epicenter: {}", directory_name(&directory));
        Self::new(EDITOR_PREFIX, title, directory)
    }
}

/// Open the generic file editor after the caller's admission checks.
pub(crate) fn show_editor(
    app: &crate::DesktopAppHandle,
    directory: Directory,
) -> anyhow::Result<()> {
    show(app, FolderWindow::editor(directory), |app, label, title| {
        build(app, label, title, EDITOR_PATH)
    })
}

/// The same page and folder lifetime on every platform. macOS may present
/// compatible windows as tabs; other platforms show separate windows.
pub(crate) fn build(
    app: &crate::DesktopAppHandle,
    label: &str,
    title: &str,
    path: &str,
) -> anyhow::Result<WebviewWindow> {
    let builder = crate::app_window_builder(app, label, title, path)?;
    #[cfg(target_os = "macos")]
    let window = crate::macos_tabs::build(builder);
    #[cfg(not(target_os = "macos"))]
    let window = builder.build().map_err(anyhow::Error::from);
    window.with_context(|| format!("create the {title} WebView"))
}

/// The name a window's title gives its directory.
pub(crate) fn directory_name(directory: &Directory) -> String {
    directory
        .root()
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| directory.root().display().to_string())
}

/// Reveal `window` if it is open, or bind its directory and `build` it, on
/// the main thread, and wait for the outcome. `build` gets the label and
/// the title.
pub(crate) fn show<R: Runtime>(
    app: &AppHandle<R>,
    window: FolderWindow,
    build: impl FnOnce(&AppHandle<R>, &str, &str) -> anyhow::Result<WebviewWindow<R>> + Send + 'static,
) -> anyhow::Result<()> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let on_main = app.clone();
    app.run_on_main_thread(move || {
        let FolderWindow {
            label,
            title,
            directory,
        } = window;
        let result = match on_main.get_webview_window(&label) {
            Some(open) => {
                crate::focus(open);
                Ok(())
            }
            None => on_main
                .folders()
                .bind_while_building(&label, directory, || build(&on_main, &label, &title))
                .map(|built| {
                    crate::focus(built);
                }),
        };
        let _ = sender.send(result);
    })
    .context("schedule the folder window on the main thread")?;
    receiver
        .recv()
        .context("the main thread stopped before opening the window")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_label_identifies_the_app_and_canonical_root_without_naming_the_path() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home/Notes");
        let work = temp.path().join("work/Notes");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&work).unwrap();
        let notes = Directory::existing(&home).unwrap();
        let made = label("todos", notes.root());
        assert!(made.starts_with("todos:"));
        assert_eq!(made.len(), "todos:".len() + 32);
        assert!(made
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '/' | ':' | '_')));
        assert!(!made.contains("Notes"));
        let again = Directory::existing(&home.join("..").join("Notes")).unwrap();
        assert_eq!(label("todos", again.root()), made);
        assert_ne!(label("capture", notes.root()), made);
        assert_ne!(
            label("todos", Directory::existing(&work).unwrap().root()),
            made
        );
    }
}
