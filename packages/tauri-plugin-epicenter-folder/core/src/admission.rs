//! Which directories may be a folder: never a hidden directory or one inside
//! a hidden directory, never one overlapping Epicenter's machine-local
//! application data, and never the library root (`~/Epicenter`), which holds
//! every app's folder, or a directory holding it. Containment compares
//! canonical paths and directory identity, so a linked parent or another
//! spelling of a protected directory is no route around it.

use std::path::{Component, Path, PathBuf};

use crate::paths::is_hidden_path;

/// Whether Epicenter may set `path` up for sync: never a hidden directory or
/// one inside a hidden directory (`is_hidden_path`), never inside, equal to,
/// or holding `data_dir`, Epicenter's application data, and never
/// `library_root` or a directory holding it, so the folders in it never
/// become one repository.
pub fn check_sync_directory(
    data_dir: &Path,
    library_root: &Path,
    path: &Path,
) -> Result<(), String> {
    let candidate = resolved(path);
    check_visible(&candidate)?;
    let data = resolved(data_dir);
    if holds(&candidate, &data) || holds(&data, &candidate) {
        return Err(
            "This folder holds Epicenter's machine-local application data, so it cannot be opened."
                .into(),
        );
    }
    if holds(&candidate, &resolved(library_root)) {
        return Err("This folder holds every Epicenter folder, so it cannot be one.".into());
    }
    Ok(())
}

/// A hidden directory, or anything in one, is never a folder: what is
/// below a hidden path is no folder's data. That includes another folder's
/// `.epicenter`, whose unfinished writes that folder recovers and removes,
/// and its `.git`.
fn check_visible(root: &Path) -> Result<(), String> {
    if root
        .components()
        .any(|component| is_hidden_path(&component.as_os_str().to_string_lossy()))
    {
        return Err(
            "A hidden folder, or one inside a hidden folder, cannot be opened as a folder.".into(),
        );
    }
    Ok(())
}

/// Resolve existing ancestors and normalize missing components too.
pub fn resolved(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => {}
            _ => {
                result.push(component.as_os_str());
                if let Ok(canonical) = dunce::canonicalize(&result) {
                    result = canonical;
                }
            }
        }
    }
    result
}

/// Whether `holder` is `inner` or one of its ancestors, including
/// alternative OS spellings of one directory.
fn holds(holder: &Path, inner: &Path) -> bool {
    inner.starts_with(holder)
        || inner
            .ancestors()
            .any(|path| same_file::is_same_file(path, holder).unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A temporary directory whose name is not hidden, unlike `tempdir()`'s.
    fn visible_temp() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("admission")
            .tempdir()
            .unwrap()
    }

    #[test]
    fn application_data_the_library_root_and_hidden_directories_are_refused() {
        let temp = visible_temp();
        let base = dunce::canonicalize(temp.path()).unwrap();
        let data = base.join("machine");
        let library = base.join("Epicenter");
        fs::create_dir_all(data.join("logs")).unwrap();
        let notes = library.join("Notes");
        let saves = notes.join(".epicenter/saves");
        fs::create_dir_all(&saves).unwrap();
        for refused in [
            data.clone(),
            data.join("logs"),
            library.clone(),
            base.clone(),
            saves,
            notes.join(".epicenter"),
            notes.join(".git"),
            base.join(".notes/inbox"),
        ] {
            assert!(
                check_sync_directory(&data, &library, &refused).is_err(),
                "{refused:?}"
            );
        }
        for accepted in [
            notes,
            base.join("machine-other"),
            base.join("Epicenter-other"),
        ] {
            assert!(
                check_sync_directory(&data, &library, &accepted).is_ok(),
                "{accepted:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_link_to_application_data_is_refused() {
        let temp = visible_temp();
        let base = dunce::canonicalize(temp.path()).unwrap();
        let data = base.join("machine");
        fs::create_dir_all(&data).unwrap();
        std::os::unix::fs::symlink(&data, base.join("alias")).unwrap();
        let library = base.join("Epicenter");
        assert!(check_sync_directory(&data, &library, &base.join("alias")).is_err());
    }
}
