//! Where the notes are.
//!
//! The shell chooses the directory from `HONEYCRISP_ROOT` or the default
//! under the home directory. It creates only the root directory itself.
//! The page creates missing layout through its granted folder, under the
//! lock the folder plugin takes on the first grant.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use epicenter_folder_core::files::resolve_root;

/// The one folder scope, and the name of the default directory.
pub const SCOPE: &str = "so.epicenter.honeycrisp";

/// The directory to open: `explicit` when it names one, else the default
/// under `home`.
pub fn choose(
    explicit: Option<OsString>,
    home: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    let explicit = explicit
        .map(|root| match root.to_str() {
            Some(text) => PathBuf::from(text.trim()),
            None => PathBuf::from(root),
        })
        .filter(|root| !root.as_os_str().is_empty());
    match explicit {
        Some(root) => Ok(root),
        None => Ok(home()?.join("Epicenter").join("local").join(SCOPE)),
    }
}

/// Make the directory if it is missing and return its canonical path: the one
/// the folder plugin grants and the terminal starts in. Nothing is created
/// inside it.
pub fn locate(root: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(root).map_err(|cause| {
        format!(
            "The notes folder at {} could not be created: {cause}",
            root.display()
        )
    })?;
    resolve_root(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::temp;

    #[test]
    fn an_explicit_root_wins_and_a_blank_one_means_the_default() {
        let home = || Ok(PathBuf::from("/home/person"));
        assert_eq!(
            choose(Some(" /tmp/notes ".into()), home).unwrap(),
            PathBuf::from("/tmp/notes")
        );
        let default = PathBuf::from("/home/person/Epicenter/local/so.epicenter.honeycrisp");
        assert_eq!(choose(None, home).unwrap(), default);
        assert_eq!(choose(Some("  ".into()), home).unwrap(), default);
        assert_eq!(
            choose(None, || Err("no home directory".to_string())).unwrap_err(),
            "no home directory"
        );
    }

    #[test]
    fn a_missing_root_is_created_empty() {
        let directory = temp("root-fresh");
        let root = locate(&directory.path().join("deep").join("notes-root")).unwrap();
        assert!(root.is_dir());
        // No layout, no settings, no repository: those wait for the page.
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
    }

    #[test]
    fn an_existing_root_gains_nothing_and_keeps_its_modification_time() {
        let directory = temp("root-existing");
        let root = directory.path();
        std::fs::write(root.join("stray.txt"), "kept").unwrap();
        let before = root.metadata().unwrap().modified().unwrap();
        assert_eq!(locate(root).unwrap(), root);
        assert_eq!(locate(root).unwrap(), root);
        let names: Vec<_> = std::fs::read_dir(root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, ["stray.txt"]);
        assert_eq!(root.metadata().unwrap().modified().unwrap(), before);
    }

    #[test]
    fn a_root_that_is_a_file_is_refused() {
        let directory = temp("root-file");
        let root = directory.path().join("notes-root");
        std::fs::write(&root, "not a directory").unwrap();
        assert!(locate(&root).unwrap_err().contains("could not be created"));
        assert_eq!(std::fs::read_to_string(&root).unwrap(), "not a directory");
    }
}
