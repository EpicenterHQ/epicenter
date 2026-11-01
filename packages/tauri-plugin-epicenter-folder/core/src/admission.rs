//! Which directories may be a folder: any directory, except one inside a
//! `.git` or `.epicenter` directory, which belong to Git and to Epicenter;
//! never one overlapping Epicenter's machine-local application data; and
//! never the library root (`~/Epicenter`), which holds every app's folder, or
//! a directory holding it. Containment compares canonical paths and
//! directory identity, so a linked parent or another spelling of a protected
//! directory is no route around it.

use std::path::{Component, Path, PathBuf};

use crate::state;

/// The directory names no folder is ever inside: Git's, and Epicenter's
/// unfinished writes (`state::DIRECTORY`).
const RESERVED: [&str; 2] = [".git", state::DIRECTORY];

/// Whether Epicenter may set `path` up for sync: never inside a `.git` or
/// `.epicenter` directory (`is_reserved_directory`), never inside, equal to,
/// or holding `data_dir`, Epicenter's application data, and never
/// `library_root` or a directory holding it, so the folders in it never
/// become one repository.
pub fn check_sync_directory(
    data_dir: &Path,
    library_root: &Path,
    path: &Path,
) -> Result<(), String> {
    let candidate = resolved(path);
    if is_reserved_directory(&candidate) {
        return Err(format!(
            "This folder is inside a .git or {} folder, which belong to Git and to Epicenter, so it cannot be opened.",
            state::DIRECTORY
        ));
    }
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

/// Whether some segment of `root`, a canonical path (`resolved`), is `.git`
/// or `.epicenter`, in any case: a folder there would be Git's state or
/// another folder's unfinished writes, which that folder recovers and
/// removes. Any other hidden directory, `~/.notes` among them, may be a
/// folder. Case is ignored because a canonical path keeps a name as it was
/// made, and on a disk that ignores case Git and Epicenter take a directory
/// made as `.GIT` or `.Epicenter` for their own. The hub's sync admission and
/// an app window's roots (`scope::Refusals` in the plugin) both ask it.
pub fn is_reserved_directory(root: &Path) -> bool {
    root.components().any(|component| {
        let name = component.as_os_str().to_string_lossy();
        RESERVED
            .iter()
            .any(|reserved| name.eq_ignore_ascii_case(reserved))
    })
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
    fn application_data_the_library_root_git_and_unfinished_writes_are_refused() {
        let temp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(temp.path()).unwrap();
        let data = base.join("machine");
        let library = base.join("Epicenter");
        fs::create_dir_all(data.join("logs")).unwrap();
        let notes = library.join("Notes");
        let saves = state::saves(&notes);
        fs::create_dir_all(&saves).unwrap();
        fs::create_dir_all(notes.join(".git/objects")).unwrap();
        for refused in [
            data.clone(),
            data.join("logs"),
            library.clone(),
            base.clone(),
            saves,
            state::directory(&notes),
            base.join("x").join(state::DIRECTORY).join("recordings/y"),
            notes.join(".git"),
            base.join("x/.git/y"),
            // The existing `.git` spelled in another case, which a disk that
            // ignores case resolves to it.
            notes.join(".GIT/objects"),
            // A directory spelled in another case, which Git and Epicenter on
            // such a disk would take for their own.
            base.join("x/.Git/y"),
            base.join("x/.EPICENTER/saves"),
        ] {
            assert!(
                check_sync_directory(&data, &library, &refused).is_err(),
                "{refused:?}"
            );
        }
        // Any other hidden directory may be a folder, and so may a
        // directory whose name only starts with a reserved one.
        let home = base.join("home");
        for accepted in [
            notes,
            home.join(".notes"),
            home.join(".notes/inbox"),
            home.join(".config/notes"),
            base.join("x/.github/y"),
            base.join("x/.gitignore.d"),
            base.join("x/.epicenter-old/y"),
            base.join("x/git/epicenter"),
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
    fn a_link_into_git_or_application_data_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(temp.path()).unwrap();
        let data = base.join("machine");
        fs::create_dir_all(&data).unwrap();
        std::os::unix::fs::symlink(&data, base.join("alias")).unwrap();
        fs::create_dir_all(base.join("repository/.git/objects")).unwrap();
        std::os::unix::fs::symlink(base.join("repository/.git"), base.join("objects")).unwrap();
        let library = base.join("Epicenter");
        assert!(check_sync_directory(&data, &library, &base.join("alias")).is_err());
        assert!(check_sync_directory(&data, &library, &base.join("objects")).is_err());
    }
}
