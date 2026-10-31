//! Epicenter's page, title and tab policy for app-and-directory windows.
//! The folder plugin owns identity, reuse, binding, construction and cleanup.

use epicenter_folder_core::library;
use tauri::{AppHandle, Runtime, WebviewUrl, WebviewWindow};
use tauri_plugin_epicenter_folder::defaults::DesktopPaths;
use tauri_plugin_epicenter_folder::{Directory, FolderExt};

pub(crate) const EDITOR_PATH: &str = "/folders/editor/";
pub(crate) const EDITOR_PREFIX: &str = "files";

/// Whether `directory` overlaps Epicenter's own files, so that no app or
/// editor window may bind it: Settings' folder, the fixed
/// `<folder_dir>/so.epicenter`, any folder's `.epicenter` (its staged saves
/// and unfinished files), or the app data, anything inside them, or a directory
/// holding them, such as the folder root. No configuration is read.
pub(crate) fn overlaps_epicenter_files(paths: &DesktopPaths, directory: &Directory) -> bool {
    library::check_app_directory(&paths.data_dir, &paths.folder_dir, directory.root()).is_err()
}

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

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn admission_protects_settings_staged_bytes_and_a_missing_parent_in_app_data() {
        let temp = tempfile::tempdir().unwrap();
        let folder_dir = dunce::canonicalize(temp.path()).unwrap();
        let scratch = folder_dir.join("elsewhere/.epicenter/scratch");
        fs::create_dir_all(&scratch).unwrap();
        let private = folder_dir.join("private");
        fs::create_dir(&private).unwrap();
        let paths = DesktopPaths {
            data_dir: folder_dir.join("absent/../private"),
            folder_dir: folder_dir.clone(),
        };
        let settings = paths.open_default(library::RECORDS).unwrap();
        assert!(overlaps_epicenter_files(&paths, &settings));

        // Any folder's own `.epicenter` is protected, records or not.
        fs::remove_dir_all(folder_dir.join(library::RECORDS.id)).unwrap();
        for protected in [&scratch, &private] {
            let directory = Directory::existing(protected).unwrap();
            assert!(
                overlaps_epicenter_files(&paths, &directory),
                "{protected:?}"
            );
        }
        let ordinary = folder_dir.join("ordinary");
        fs::create_dir(&ordinary).unwrap();
        assert!(!overlaps_epicenter_files(
            &paths,
            &Directory::existing(&ordinary).unwrap()
        ));
    }
}
