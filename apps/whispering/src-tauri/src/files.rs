//! Whispering's folder on the desktop: the app's local data directory. The
//! page lists, writes and removes its files through `tauri-plugin-fs`, and
//! reads them here (`files_read`), every path in one call: a person can have
//! 15,000 notes, and one call each would be 15,000 round trips. It also
//! says how much a directory holds (`files_size`) and shows the folder in
//! the system's file manager (`files_reveal`).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

/// The app's local data directory, which holds `settings.json` and `recordings/`.
pub fn data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path().app_local_data_dir().map_err(|error| {
        format!("The system did not say where Whispering keeps its files: {error}")
    })
}

/// The `recordings/` folder, where the recorder writes each take.
pub fn recordings_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    data_dir(app).map(|data| data.join("recordings"))
}

/// The text of each file of `paths` in the folder that is there, by path; a
/// missing one is left out.
#[tauri::command]
pub async fn files_read<R: Runtime>(
    app: AppHandle<R>,
    paths: Vec<String>,
) -> Result<BTreeMap<String, String>, String> {
    let dir = data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || read(&dir, &paths))
        .await
        .map_err(|error| error.to_string())?
}

/// How many bytes the files directly in `dir`, a directory in the folder,
/// hold. A directory that is not there holds none.
#[tauri::command]
pub async fn files_size<R: Runtime>(app: AppHandle<R>, dir: String) -> Result<u64, String> {
    if !is_plain(&dir) {
        return Err(format!(
            "{dir:?} is not a plain path in Whispering's folder"
        ));
    }
    let dir = data_dir(&app)?.join(dir);
    tauri::async_runtime::spawn_blocking(move || size(&dir))
        .await
        .map_err(|error| error.to_string())?
}

/// The bytes of the files directly in `dir`; a file that goes away while
/// they are counted is left out.
pub fn size(dir: &Path) -> Result<u64, String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(format!("{} could not be read: {error}", dir.display())),
    };
    Ok(entries
        .filter_map(|entry| entry.ok()?.metadata().ok())
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
        .sum())
}

/// Show Whispering's folder in the system's file manager.
#[tauri::command]
pub fn files_reveal<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = data_dir(&app)?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|error| format!("The folder could not be opened: {error}"))
}

/// Whether `path` is a plain path in the folder: `/`-separated parts of
/// letters, digits, `-`, `_` and `.`, none empty and none starting with a
/// dot, so `..`, a hidden file and an absolute path are refused. The page
/// checks more strictly (`checkPath` in `files/files.ts`); this keeps a read
/// inside the folder whatever it is asked.
fn is_plain(path: &str) -> bool {
    path.split('/').all(|part| {
        !part.is_empty()
            && !part.starts_with('.')
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    })
}

/// Read `paths` in `dir`. A file that is not UTF-8 is read with its bad
/// bytes replaced, so one damaged note does not hide the rest.
pub fn read(dir: &Path, paths: &[String]) -> Result<BTreeMap<String, String>, String> {
    let mut read = BTreeMap::new();
    for path in paths {
        if !is_plain(path) {
            return Err(format!(
                "{path:?} is not a plain path in Whispering's folder"
            ));
        }
        match std::fs::read(dir.join(path)) {
            Ok(bytes) => {
                read.insert(path.clone(), String::from_utf8_lossy(&bytes).into_owned());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("{path} could not be read: {error}")),
        }
    }
    Ok(read)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_each_file_there_and_leaves_out_one_that_is_not() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("recordings")).unwrap();
        std::fs::write(dir.path().join("recordings/a.md"), "hello").unwrap();
        std::fs::write(dir.path().join("settings.json"), [b'o', b'k', 0xff]).unwrap();
        let paths = ["recordings/a.md", "recordings/b.md", "settings.json"].map(String::from);
        let read = read(dir.path(), &paths).unwrap();
        assert_eq!(
            read.into_iter().collect::<Vec<_>>(),
            [
                ("recordings/a.md".to_string(), "hello".to_string()),
                ("settings.json".to_string(), "ok\u{fffd}".to_string()),
            ]
        );
    }

    #[test]
    fn a_directory_holds_the_bytes_of_its_files_and_a_missing_one_holds_none() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("inner")).unwrap();
        std::fs::write(dir.path().join("a.webm"), [0u8; 1000]).unwrap();
        std::fs::write(dir.path().join("a.md"), "hello").unwrap();
        std::fs::write(dir.path().join("inner/b.webm"), [0u8; 50]).unwrap();
        assert_eq!(size(dir.path()).unwrap(), 1005);
        assert_eq!(size(&dir.path().join("gone")).unwrap(), 0);
    }

    #[test]
    fn refuses_a_path_outside_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        for path in ["../secret", "/etc/passwd", ".hidden", "a//b", "", "a/../b"] {
            assert!(read(dir.path(), &[path.to_string()]).is_err(), "{path}");
        }
    }
}
