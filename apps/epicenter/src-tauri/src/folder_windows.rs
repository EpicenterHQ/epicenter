//! Epicenter's page, title and tab policy for app-and-directory windows.
//! The folder plugin owns identity, reuse, binding, construction and cleanup.

use tauri::{AppHandle, Runtime, WebviewUrl, WebviewWindow};
use tauri_plugin_epicenter_folder::{Directory, FolderExt};

pub(crate) const EDITOR_PATH: &str = "/folders/editor/";
pub(crate) const EDITOR_PREFIX: &str = "files";

pub(crate) fn open_editor<R: Runtime>(
    app: &AppHandle<R>,
    directory: Directory,
) -> anyhow::Result<WebviewWindow<R>> {
    let title = format!("Epicenter: {}", directory_name(&directory));
    open(app, EDITOR_PREFIX, directory, title, EDITOR_PATH)
}

pub(crate) fn directory_name(directory: &Directory) -> String {
    directory
        .root()
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| directory.root().display().to_string())
}

pub(crate) fn open<R: Runtime>(
    app: &AppHandle<R>,
    application: &str,
    directory: Directory,
    title: String,
    path: &str,
) -> anyhow::Result<WebviewWindow<R>> {
    let url = WebviewUrl::CustomProtocol(crate::scheme::url(path)?);
    let handle = app.clone();
    let prefix = path.to_owned();
    Ok(
        app.open_folder_window(application, directory, url, move |builder| {
            let builder = crate::configure_app_window(builder, &handle, &title, prefix);
            #[cfg(target_os = "macos")]
            let builder = crate::macos_tabs::configure(builder);
            Ok(builder)
        })?,
    )
}
