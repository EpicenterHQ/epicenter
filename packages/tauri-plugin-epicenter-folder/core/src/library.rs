//! The fixed native app defaults: permanent reverse-DNS children of one
//! library root (ADR-0672).
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

/// Epicenter's own records, such as AI connections. Only Settings and
/// folder editors open it; ordinary apps are refused.
pub const RECORDS: LibraryDefault = LibraryDefault {
    id: "so.epicenter",
    title: "Epicenter",
};
pub const TODOS: LibraryDefault = LibraryDefault {
    id: "so.epicenter.todos",
    title: "Todos",
};
pub const CAPTURE: LibraryDefault = LibraryDefault {
    id: "so.epicenter.capture",
    title: "Capture",
};
pub const HONEYCRISP: LibraryDefault = LibraryDefault {
    id: "so.epicenter.honeycrisp",
    title: "Honeycrisp",
};
pub const WHISPERING: LibraryDefault = LibraryDefault {
    id: "so.epicenter.whispering",
    title: "Whispering",
};
pub const MESSAGES: LibraryDefault = LibraryDefault {
    id: "so.epicenter.messages",
    title: "Messages",
};

/// Every fixed default, records first.
pub const ALL: [LibraryDefault; 6] = [RECORDS, TODOS, CAPTURE, HONEYCRISP, WHISPERING, MESSAGES];

impl LibraryDefault {
    /// `<library_root>/<id>`, computed without touching the disk.
    pub fn path(self, library_root: &Path) -> PathBuf {
        library_root.join(self.id)
    }
}

/// Admit `<library_root>/<id>`, then create it when missing or reuse the
/// directory already there with its files. A file or a link at the path is
/// refused and kept. A root override that would put the default in
/// application data or in save staging is refused before anything is made.
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

/// Whether a folder editor may open `path`: never a save staging directory
/// or anything in one, and never overlapping application data, through the
/// directory or its own staging sibling. Epicenter's records may be edited.
pub fn check_editable_directory(data_dir: &Path, path: &Path) -> Result<(), String> {
    let candidate = directory_paths(path)?;
    check_namespace(&candidate[0])?;
    let data = resolved(data_dir);
    if candidate.iter().any(|path| overlaps(path, &data)) {
        return Err(
            "This folder holds Epicenter's machine-local application data, so it cannot be opened."
                .into(),
        );
    }
    Ok(())
}

/// Whether an ordinary app, or a handoff from another app, may open `path`:
/// everything `check_editable_directory` refuses, and also Epicenter's records
/// at `<library_root>/so.epicenter` or its staging sibling, anything in them,
/// or a directory holding them, such as the library root.
pub fn check_app_directory(
    data_dir: &Path,
    library_root: &Path,
    path: &Path,
) -> Result<(), String> {
    check_editable_directory(data_dir, path)?;
    let candidate = directory_paths(path)?;
    let records = directory_paths(&RECORDS.path(library_root))?;
    if candidate
        .iter()
        .any(|candidate| records.iter().any(|path| overlaps(candidate, path)))
    {
        return Err(
            "This folder holds Epicenter's own records, so it cannot be opened in an app.".into(),
        );
    }
    Ok(())
}

/// Saving also writes to a sibling staging directory. Admit both locations.
fn directory_paths(path: &Path) -> Result<[PathBuf; 2], String> {
    let root = resolved(path);
    let scratch = resolved(&crate::storage::scratch_directory(&root)?);
    Ok([root, scratch])
}

fn check_namespace(root: &Path) -> Result<(), String> {
    if root.components().any(|component| {
        let name = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        name.starts_with('.') && name.ends_with(".epicenter-scratch")
    }) {
        return Err("Save staging directories cannot be opened as authored folders.".into());
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

    #[test]
    fn the_table_has_six_unique_permanent_reverse_dns_identifiers() {
        let ids: std::collections::BTreeSet<_> = ALL
            .iter()
            .map(|default| default.id.to_lowercase())
            .collect();
        assert_eq!(ids.len(), ALL.len());
        assert_eq!(ALL[0], RECORDS);
        assert_eq!(
            ALL.map(|default| default.id),
            [
                "so.epicenter",
                "so.epicenter.todos",
                "so.epicenter.capture",
                "so.epicenter.honeycrisp",
                "so.epicenter.whispering",
                "so.epicenter.messages",
            ]
        );
        for default in ALL {
            assert!(default.id == "so.epicenter" || default.id.starts_with("so.epicenter."));
            assert!(!default.id.ends_with(".dev"));
        }
    }

    /// A missing root and default are made; nothing is written to AppData,
    /// which is not even created.
    #[test]
    fn a_missing_default_is_created_under_a_new_root_without_writing_configuration() {
        let library = library();
        let root = library.base.join("new/root");
        for default in ALL {
            let directory = open_default(&library.data, &root, default).unwrap();
            assert_eq!(directory.root(), root.join(default.id));
            assert!(entries(directory.root()).is_empty());
        }
        assert_eq!(entries(&root).len(), ALL.len());
        assert!(!library.data.exists());
    }

    #[test]
    fn an_existing_default_is_reused_with_its_files_and_a_removed_one_is_made_again() {
        let library = library();
        let todos = TODOS.path(&library.root);
        fs::create_dir_all(todos.join("todos")).unwrap();
        fs::write(todos.join("todos/milk.md"), "keep").unwrap();
        fs::write(todos.join("unrelated.txt"), "keep").unwrap();
        let opened = open_default(&library.data, &library.root, TODOS).unwrap();
        assert_eq!(opened.root(), todos);
        assert_eq!(entries(&todos), ["todos", "unrelated.txt"]);
        assert_eq!(
            fs::read_to_string(todos.join("todos/milk.md")).unwrap(),
            "keep"
        );

        fs::remove_dir_all(&todos).unwrap();
        assert_eq!(
            open_default(&library.data, &library.root, TODOS).unwrap(),
            opened
        );
        assert!(entries(&todos).is_empty());
    }

    #[test]
    fn a_file_at_the_default_is_refused_and_kept() {
        let library = library();
        fs::create_dir_all(&library.root).unwrap();
        let occupied = TODOS.path(&library.root);
        fs::write(&occupied, "keep").unwrap();
        assert!(open_default(&library.data, &library.root, TODOS).is_err());
        assert_eq!(fs::read_to_string(&occupied).unwrap(), "keep");
        assert_eq!(entries(&library.root), ["so.epicenter.todos"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_default_is_refused_and_a_linked_root_opens_its_real_child() {
        use std::os::unix::fs::symlink;
        let library = library();
        let elsewhere = library.base.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::create_dir_all(&library.root).unwrap();
        symlink(&elsewhere, CAPTURE.path(&library.root)).unwrap();
        assert!(open_default(&library.data, &library.root, CAPTURE).is_err());
        assert!(entries(&elsewhere).is_empty());

        let real = library.base.join("real");
        fs::create_dir(&real).unwrap();
        let alias = library.base.join("alias");
        symlink(&real, &alias).unwrap();
        let opened = open_default(&library.data, &alias, HONEYCRISP).unwrap();
        assert_eq!(opened.root(), real.join(HONEYCRISP.id));
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
                    open_default(&data, &root, WHISPERING).unwrap()
                })
            })
            .collect();
        let opened: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert!(opened.windows(2).all(|pair| pair[0] == pair[1]));
        assert_eq!(entries(&library.root), [WHISPERING.id]);
    }

    /// A root override that reaches application data or staging is refused
    /// before the root or the default is made.
    #[test]
    fn root_overrides_into_application_data_or_staging_are_refused_before_creation() {
        let library = library();
        fs::create_dir_all(&library.data).unwrap();
        for root in [
            library.data.join("library"),
            library.data.clone(),
            library.base.join(".Notes.epicenter-scratch/library"),
            library.base.join(".NOTES.EPICENTER-SCRATCH"),
        ] {
            for default in ALL {
                assert!(
                    open_default(&library.data, &root, default).is_err(),
                    "{root:?}"
                );
            }
            assert!(!root.join(TODOS.id).exists(), "{root:?}");
        }
        assert!(!library.data.join("library").exists());
        assert!(!library.base.join(".Notes.epicenter-scratch").exists());
        // Application data inside the default's staging sibling.
        let staged = library
            .root
            .join(".so.epicenter.todos.epicenter-scratch/machine");
        fs::create_dir_all(&staged).unwrap();
        assert!(open_default(&staged, &library.root, TODOS).is_err());
        assert!(!TODOS.path(&library.root).exists());
    }

    #[test]
    fn ordinary_apps_refuse_records_its_staging_and_holders_while_editors_may_edit_records() {
        let library = library();
        let records = open_default(&library.data, &library.root, RECORDS).unwrap();
        let staging = crate::storage::scratch_directory(records.root()).unwrap();
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
        for default in &ALL[1..] {
            let directory = open_default(&library.data, &library.root, *default).unwrap();
            assert!(check_app_directory(&library.data, &library.root, directory.root()).is_ok());
        }
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

    /// The CLI runs these same cases for Epicenter's records
    /// (`records-default.test.ts`), so both agree on what is admitted.
    #[cfg(unix)]
    #[test]
    fn records_default_matches_the_shared_cli_cases() {
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
