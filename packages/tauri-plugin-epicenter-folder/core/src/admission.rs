//! Which directories may be a folder: never a folder's `.epicenter` or
//! anything in one, never one overlapping Epicenter's machine-local
//! application data, and never the library root (`~/Epicenter`), which holds
//! every app's folder, or a directory holding it. Containment compares
//! canonical paths and directory identity, so a linked parent or another
//! spelling of a protected directory is no route around it.

use std::path::{Component, Path, PathBuf};

/// Whether Epicenter may set `path` up for sync: never a folder's
/// `.epicenter` or anything in one, never inside, equal to, or holding
/// `data_dir`, Epicenter's application data, and never `library_root` or a
/// directory holding it, so the folders in it never become one repository.
pub fn check_sync_directory(
    data_dir: &Path,
    library_root: &Path,
    path: &Path,
) -> Result<(), String> {
    let candidate = resolved(path);
    check_namespace(&candidate)?;
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

/// A folder's own `.epicenter` (its staged saves and unfinished files), or
/// anything in one, is never a folder of its own.
fn check_namespace(root: &Path) -> Result<(), String> {
    if root.components().any(|component| {
        component
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(crate::storage::STATE_DIRECTORY)
    }) {
        return Err("A folder's .epicenter directory cannot be opened as a folder.".into());
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

    #[test]
    fn application_data_the_library_root_and_any_epicenter_directory_are_refused() {
        let temp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(temp.path()).unwrap();
        let data = base.join("machine");
        let library = base.join("Epicenter");
        fs::create_dir_all(data.join("logs")).unwrap();
        let notes = library.join("Notes");
        let staging = crate::storage::scratch_directory(&notes);
        fs::create_dir_all(&staging).unwrap();
        for refused in [
            data.clone(),
            data.join("logs"),
            library.clone(),
            base.clone(),
            staging,
            notes.join(".EPICENTER"),
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
        let temp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(temp.path()).unwrap();
        let data = base.join("machine");
        fs::create_dir_all(&data).unwrap();
        std::os::unix::fs::symlink(&data, base.join("alias")).unwrap();
        let library = base.join("Epicenter");
        assert!(check_sync_directory(&data, &library, &base.join("alias")).is_err());
    }
}
