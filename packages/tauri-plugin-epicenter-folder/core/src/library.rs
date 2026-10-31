//! The fixed native defaults: permanent reverse-DNS children of one library
//! root (ADR-0672). Epicenter's records are the one default a shell opens;
//! the apps on `epicenter-standalone` keep their data at
//! `~/Epicenter/<productName>` instead, outside this table.
//!
//! The root is `~/Epicenter` in release and `~/Epicenter Dev` in
//! development unless `EPICENTER_FOLDER_DIR` names another one at startup.
//! An ordinary launch computes `<root>/<id>`, admits it, then creates it when
//! missing or reuses it as it is. Nothing is saved: no selection, ownership
//! claim, or configuration file is read or written, and a default that was
//! moved or deleted is made again at the same path on the next launch.
//! Display titles never name storage.

use std::path::{Component, Path, PathBuf};

use crate::directory::Directory;

/// One native app's default directory name under the library root, and the
/// title the interface shows for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LibraryDefault {
    /// The permanent directory name, a reverse-DNS identifier.
    pub id: &'static str,
    /// The readable name shown for this default; never a path.
    pub title: &'static str,
}

/// Epicenter's own records folder, where Settings once kept AI connections.
/// No window binds it now; it stays refused to apps and folder editors so
/// nothing claims the files a person may still have there.
pub const RECORDS: LibraryDefault = LibraryDefault {
    id: "so.epicenter",
    title: "Epicenter",
};

impl LibraryDefault {
    /// `<library_root>/<id>`, computed without touching the disk.
    pub fn path(self, library_root: &Path) -> PathBuf {
        library_root.join(self.id)
    }
}

/// Admit `<library_root>/<id>`, then create it when missing or reuse the
/// directory already there with its files. A file or a link at the path is
/// refused and kept. A root override that would put the default in
/// application data or in a folder's `.epicenter` is refused before anything
/// is made.
pub fn open_default(
    data_dir: &Path,
    library_root: &Path,
    definition: LibraryDefault,
) -> Result<Directory, String> {
    let path = definition.path(library_root);
    if definition == RECORDS {
        check_editable_directory(data_dir, &path)?;
    } else {
        check_app_directory(data_dir, library_root, &path)?;
    }
    Directory::create(&path).map_err(|error| {
        format!(
            "The {} folder could not be opened: {error}",
            definition.title
        )
    })
}

/// Whether Epicenter's records may open at `path`: never a folder's
/// `.epicenter` or anything in one, and never overlapping application data.
/// Epicenter's records may be edited.
pub fn check_editable_directory(data_dir: &Path, path: &Path) -> Result<(), String> {
    let candidate = resolved(path);
    check_namespace(&candidate)?;
    if overlaps(&candidate, &resolved(data_dir)) {
        return Err(
            "This folder holds Epicenter's machine-local application data, so it cannot be opened."
                .into(),
        );
    }
    Ok(())
}

/// Whether an app or a folder editor window may open `path`:
/// everything `check_editable_directory` refuses, and also Epicenter's records
/// at `<library_root>/so.epicenter`, anything in them (its `.epicenter`
/// included), or a directory holding them, such as the library root.
pub fn check_app_directory(
    data_dir: &Path,
    library_root: &Path,
    path: &Path,
) -> Result<(), String> {
    check_editable_directory(data_dir, path)?;
    if overlaps(&resolved(path), &resolved(&RECORDS.path(library_root))) {
        return Err(
            "This folder holds Epicenter's own records, so it cannot be opened in an app.".into(),
        );
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

/// Compare containment including alternative OS spellings of one directory.
fn overlaps(candidate: &Path, protected: &Path) -> bool {
    candidate.starts_with(protected)
        || protected.starts_with(candidate)
        || candidate
            .ancestors()
            .any(|path| same_file::is_same_file(path, protected).unwrap_or(false))
        || protected
            .ancestors()
            .any(|path| same_file::is_same_file(path, candidate).unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::fs;

    use serde::Deserialize;

    /// An ordinary app's default, as a shell would declare one: admitted as
    /// an app, so never over Epicenter's records.
    const APP: LibraryDefault = LibraryDefault {
        id: "so.epicenter.example",
        title: "Example",
    };

    struct Library {
        _temp: tempfile::TempDir,
        base: PathBuf,
        data: PathBuf,
        root: PathBuf,
    }

    fn library() -> Library {
        let temp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(temp.path()).unwrap();
        Library {
            data: base.join("machine"),
            root: base.join("Epicenter"),
            base,
            _temp: temp,
        }
    }

    fn entries(path: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(path)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// A missing root and default are made; nothing is written to AppData,
    /// which is not even created.
    #[test]
    fn a_missing_default_is_created_under_a_new_root_without_writing_configuration() {
        let library = library();
        let root = library.base.join("new/root");
        for default in [RECORDS, APP] {
            let directory = open_default(&library.data, &root, default).unwrap();
            assert_eq!(directory.root(), root.join(default.id));
            assert!(entries(directory.root()).is_empty());
        }
        assert_eq!(entries(&root), [RECORDS.id, APP.id]);
        assert!(!library.data.exists());
    }

    #[test]
    fn an_existing_default_is_reused_with_its_files_and_a_removed_one_is_made_again() {
        let library = library();
        let app = APP.path(&library.root);
        fs::create_dir_all(app.join("notes")).unwrap();
        fs::write(app.join("notes/milk.md"), "keep").unwrap();
        fs::write(app.join("unrelated.txt"), "keep").unwrap();
        let opened = open_default(&library.data, &library.root, APP).unwrap();
        assert_eq!(opened.root(), app);
        assert_eq!(entries(&app), ["notes", "unrelated.txt"]);
        assert_eq!(
            fs::read_to_string(app.join("notes/milk.md")).unwrap(),
            "keep"
        );

        fs::remove_dir_all(&app).unwrap();
        assert_eq!(
            open_default(&library.data, &library.root, APP).unwrap(),
            opened
        );
        assert!(entries(&app).is_empty());
    }

    #[test]
    fn a_file_at_the_default_is_refused_and_kept() {
        let library = library();
        fs::create_dir_all(&library.root).unwrap();
        let occupied = APP.path(&library.root);
        fs::write(&occupied, "keep").unwrap();
        assert!(open_default(&library.data, &library.root, APP).is_err());
        assert_eq!(fs::read_to_string(&occupied).unwrap(), "keep");
        assert_eq!(entries(&library.root), [APP.id]);
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_default_is_refused_and_a_linked_root_opens_its_real_child() {
        use std::os::unix::fs::symlink;
        let library = library();
        let elsewhere = library.base.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::create_dir_all(&library.root).unwrap();
        symlink(&elsewhere, APP.path(&library.root)).unwrap();
        assert!(open_default(&library.data, &library.root, APP).is_err());
        assert!(entries(&elsewhere).is_empty());

        let real = library.base.join("real");
        fs::create_dir(&real).unwrap();
        let alias = library.base.join("alias");
        symlink(&real, &alias).unwrap();
        let opened = open_default(&library.data, &alias, APP).unwrap();
        assert_eq!(opened.root(), real.join(APP.id));
    }

    #[test]
    fn concurrent_launches_open_one_directory() {
        let library = library();
        let gate = std::sync::Arc::new(std::sync::Barrier::new(4));
        let threads: Vec<_> = (0..4)
            .map(|_| {
                let (data, root, gate) = (library.data.clone(), library.root.clone(), gate.clone());
                std::thread::spawn(move || {
                    gate.wait();
                    open_default(&data, &root, APP).unwrap()
                })
            })
            .collect();
        let opened: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert!(opened.windows(2).all(|pair| pair[0] == pair[1]));
        assert_eq!(entries(&library.root), [APP.id]);
    }

    /// A root override that reaches application data or a folder's
    /// `.epicenter` is refused before the root or the default is made.
    #[test]
    fn root_overrides_into_application_data_or_state_are_refused_before_creation() {
        let library = library();
        fs::create_dir_all(&library.data).unwrap();
        for root in [
            library.data.join("library"),
            library.data.clone(),
            library.base.join("Notes/.epicenter/scratch/library"),
            library.base.join("Notes/.EPICENTER"),
        ] {
            for default in [RECORDS, APP] {
                assert!(
                    open_default(&library.data, &root, default).is_err(),
                    "{root:?}"
                );
            }
            assert!(!root.join(APP.id).exists(), "{root:?}");
        }
        assert!(!library.data.join("library").exists());
        assert!(!library.base.join("Notes").exists());
    }

    #[test]
    fn ordinary_apps_refuse_records_its_staging_and_holders_while_editors_may_edit_records() {
        let library = library();
        let records = open_default(&library.data, &library.root, RECORDS).unwrap();
        let staging = crate::storage::scratch_directory(records.root());
        fs::create_dir_all(records.root().join("connections")).unwrap();
        fs::create_dir_all(&staging).unwrap();
        fs::create_dir_all(&library.data).unwrap();
        for refused in [
            records.root().to_path_buf(),
            records.root().join("connections"),
            library.root.clone(),
            library.base.clone(),
            library.data.clone(),
        ] {
            assert!(
                check_app_directory(&library.data, &library.root, &refused).is_err(),
                "{refused:?}"
            );
        }
        assert!(check_app_directory(&library.data, &library.root, &staging).is_err());
        assert!(check_editable_directory(&library.data, records.root()).is_ok());
        assert!(
            check_editable_directory(&library.data, &records.root().join("connections")).is_ok()
        );
        for refused in [&staging, &library.data, &library.base] {
            assert!(
                check_editable_directory(&library.data, refused).is_err(),
                "{refused:?}"
            );
        }
        let app = open_default(&library.data, &library.root, APP).unwrap();
        assert!(check_app_directory(&library.data, &library.root, app.root()).is_ok());
        // A similar sibling name is not the records folder.
        let similar = library.root.join("so.epicenter-other");
        fs::create_dir(&similar).unwrap();
        assert!(check_app_directory(&library.data, &library.root, &similar).is_ok());
    }

    /// The case-insensitive spelling of records is records on such a disk.
    #[test]
    fn records_protection_follows_the_disks_case_sensitivity() {
        let library = library();
        open_default(&library.data, &library.root, RECORDS).unwrap();
        let other_case = library.root.join("SO.EPICENTER");
        if other_case.exists() {
            assert!(check_app_directory(&library.data, &library.root, &other_case).is_err());
        }
    }

    /// Where Epicenter's records are admitted and refused, case by case.
    #[cfg(unix)]
    #[test]
    fn records_default_matches_its_cases() {
        #[derive(Deserialize)]
        struct Case {
            name: String,
            data: Option<String>,
            root: String,
            #[serde(default)]
            directories: Vec<String>,
            #[serde(default)]
            files: Vec<String>,
            #[serde(default)]
            links: BTreeMap<String, String>,
            allowed: bool,
        }
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/records-default.json")).unwrap();
        let cases: Vec<Case> = serde_json::from_value(fixture["cases"].clone()).unwrap();
        for case in cases {
            let temp = tempfile::tempdir().unwrap();
            let base = dunce::canonicalize(temp.path()).unwrap();
            let data = base.join(case.data.as_deref().unwrap_or("machine"));
            let root = base.join(&case.root);
            for directory in &case.directories {
                fs::create_dir_all(base.join(directory)).unwrap();
            }
            for file in &case.files {
                let path = base.join(file);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, "keep").unwrap();
            }
            for (alias, target) in &case.links {
                let path = base.join(alias);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::os::unix::fs::symlink(base.join(target), path).unwrap();
            }
            fs::create_dir_all(&data).unwrap();
            let candidate = RECORDS.path(&root);
            let existed = fs::symlink_metadata(&candidate).is_ok();
            let opened = open_default(&data, &root, RECORDS);
            assert_eq!(opened.is_ok(), case.allowed, "{}: {opened:?}", case.name);
            if case.allowed {
                assert_eq!(
                    opened.unwrap().root(),
                    dunce::canonicalize(&candidate).unwrap(),
                    "{}",
                    case.name
                );
            } else {
                assert_eq!(
                    fs::symlink_metadata(&candidate).is_ok(),
                    existed,
                    "{}",
                    case.name
                );
            }
            assert!(entries(&data).is_empty(), "{}", case.name);
            for path in &case.files {
                assert_eq!(
                    fs::read_to_string(base.join(path)).unwrap(),
                    "keep",
                    "{}",
                    case.name
                );
            }
        }
    }
}
