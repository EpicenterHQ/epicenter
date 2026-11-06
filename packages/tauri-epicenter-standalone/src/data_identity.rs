//! An app finds its folder by its identity (ADR-0822).
//!
//! The shell remembers its Data root's identity, its inode and birth time,
//! in its AppData root (`data-folder.json`, which no page reaches), each time
//! the page opens Data (`remember`). At start, before it names Data at its
//! derived path, it looks for the directory in the Epicenter folder that
//! identity proves (`find`): a folder the person renamed is opened by its
//! new name, and an empty folder an app made at the old name meanwhile is
//! not taken for it. A remembered identity without a real birth time proves
//! nothing, since a file system without birth times can give a new
//! directory a deleted one's inode.
//!
//! Any directory directly inside the Epicenter folder can be an app's
//! folder, so Open with names one (`opened_with`).

use std::fs;
use std::path::{Path, PathBuf};

use tauri_plugin_epicenter_folder::{folder_name_problem, proves, FolderIdentity, DATA_FOLDER_FILE};

/// The identity remembered in the AppData root `app_data`, or `None` when
/// none is, or it does not read.
pub fn remembered(app_data: &Path) -> Option<FolderIdentity> {
    let text = fs::read_to_string(app_data.join(DATA_FOLDER_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Remember `identity` in the AppData root `app_data`, made when missing,
/// unless it is already what is remembered. Written whole, by a rename, so a
/// crash leaves the old identity or the new one.
pub fn remember(app_data: &Path, identity: &FolderIdentity) -> std::io::Result<()> {
    if remembered(app_data).as_ref() == Some(identity) {
        return Ok(());
    }
    fs::create_dir_all(app_data)?;
    let staged = app_data.join(format!(".{DATA_FOLDER_FILE}.writing"));
    fs::write(&staged, serde_json::to_vec(identity)?)?;
    fs::rename(&staged, app_data.join(DATA_FOLDER_FILE))
}

/// The directory the remembered identity proves (`proves`), read by
/// `identity`: `derived`, the path the app's site names, when it is the one;
/// otherwise the first by name of the directories directly inside the
/// Epicenter folder `library`, links followed and hidden names skipped.
/// `None` when nothing is remembered or nothing matches, and the app names
/// `derived`.
pub fn find(
    library: &Path,
    derived: &Path,
    remembered: Option<&FolderIdentity>,
    identity: &dyn Fn(&Path) -> Option<FolderIdentity>,
) -> Option<PathBuf> {
    let remembered = remembered?;
    let proven = |path: &Path| {
        fs::metadata(path).is_ok_and(|metadata| metadata.is_dir())
            && identity(path).is_some_and(|found| proves(&found, remembered))
    };
    if proven(derived) {
        return Some(derived.to_path_buf());
    }
    let mut names: Vec<String> = fs::read_dir(library)
        .ok()?
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| !name.starts_with('.'))
        .collect();
    names.sort();
    names
        .into_iter()
        .map(|name| library.join(name))
        .find(|path| proven(path))
}

/// The directory directly inside the Epicenter folder `library` that a
/// launch argument names, by its name there or by an absolute path whose
/// parent is the Epicenter folder (a link there included), or why it
/// cannot be the app's folder.
pub fn opened_with(library: &Path, argument: &str) -> Result<PathBuf, String> {
    let named = Path::new(argument);
    let (parent, name) = if named.is_absolute() {
        let name = named
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| format!("{argument} names no folder."))?;
        (named.parent().unwrap_or(named), name)
    } else {
        (library, argument)
    };
    if let Some(problem) = folder_name_problem(name) {
        return Err(format!("{argument} is not a folder's name: {problem}."));
    }
    let inside = |path: &Path| dunce::canonicalize(path).ok();
    if parent != library && inside(parent).is_none_or(|parent| Some(parent) != inside(library)) {
        return Err(format!(
            "{argument} is not directly inside {}, so it cannot be this app's folder.",
            library.display()
        ));
    }
    let folder = library.join(name);
    if !fs::metadata(&folder).is_ok_and(|metadata| metadata.is_dir()) {
        return Err(format!("{} is not a folder.", folder.display()));
    }
    Ok(folder)
}

/// The value of `--folder` among the launch arguments `arguments`, given as
/// `--folder <folder>` or `--folder=<folder>`.
pub fn folder_argument(arguments: &[String]) -> Option<String> {
    let mut arguments = arguments.iter();
    while let Some(argument) = arguments.next() {
        if argument == "--folder" {
            return arguments.next().cloned();
        }
        if let Some(value) = argument.strip_prefix("--folder=") {
            return Some(value.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_epicenter_folder::identity_at;

    fn real(path: &Path) -> Option<FolderIdentity> {
        identity_at(path).ok().flatten()
    }

    fn library() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let library = dunce::canonicalize(temp.path()).unwrap().join("Epicenter");
        fs::create_dir_all(&library).unwrap();
        (temp, library)
    }

    #[test]
    fn an_identity_is_remembered_once_and_read_back() {
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().join("App Data");
        assert_eq!(remembered(&app_data), None);
        let identity = FolderIdentity {
            inode: "12".into(),
            birthtime: Some("34".into()),
        };
        remember(&app_data, &identity).unwrap();
        assert_eq!(remembered(&app_data), Some(identity.clone()));
        assert_eq!(
            fs::read_to_string(app_data.join("data-folder.json")).unwrap(),
            r#"{"inode":"12","birthtime":"34"}"#
        );
        assert_eq!(fs::read_dir(&app_data).unwrap().count(), 1);
        fs::write(app_data.join("data-folder.json"), "{").unwrap();
        assert_eq!(remembered(&app_data), None);
    }

    /// The remembered folder renamed is found by its new name, and an empty
    /// folder made at the old name meanwhile is not taken for it.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_renamed_folder_is_found_and_a_recreated_one_is_not() {
        let (_temp, library) = library();
        let derived = library.join("notes");
        fs::create_dir(&derived).unwrap();
        let identity = real(&derived).unwrap();
        assert!(identity.birthtime.is_some());
        assert_eq!(
            find(&library, &derived, Some(&identity), &real),
            Some(derived.clone())
        );
        fs::rename(&derived, library.join("My notes")).unwrap();
        fs::create_dir(&derived).unwrap();
        assert_eq!(
            find(&library, &derived, Some(&identity), &real),
            Some(library.join("My notes"))
        );
        assert_eq!(find(&library, &derived, None, &real), None);
        fs::remove_dir(library.join("My notes")).unwrap();
        assert_eq!(find(&library, &derived, Some(&identity), &real), None);
    }

    /// On a file system without birth times an inode can be a deleted
    /// directory's, reused: a remembered identity without a birth time, or
    /// a directory read without one, never matches.
    #[test]
    fn a_missing_birth_time_never_matches() {
        let (_temp, library) = library();
        let derived = library.join("notes");
        fs::create_dir(library.join("Reused")).unwrap();
        let unborn = |_: &Path| {
            Some(FolderIdentity {
                inode: "7".into(),
                birthtime: None,
            })
        };
        let remembered_unborn = FolderIdentity {
            inode: "7".into(),
            birthtime: None,
        };
        assert_eq!(find(&library, &derived, Some(&remembered_unborn), &unborn), None);
        let born = FolderIdentity {
            inode: "7".into(),
            birthtime: Some("1".into()),
        };
        assert_eq!(find(&library, &derived, Some(&born), &unborn), None);
        let same = |_: &Path| Some(born.clone());
        assert_eq!(
            find(&library, &derived, Some(&born), &same),
            Some(library.join("Reused"))
        );
    }

    /// Hidden names are skipped, and a link in the Epicenter folder is
    /// followed to the folder it names.
    #[cfg(unix)]
    #[test]
    fn hidden_names_are_skipped_and_links_followed() {
        let (temp, library) = library();
        let derived = library.join("notes");
        let elsewhere = dunce::canonicalize(temp.path()).unwrap().join("Drive/notes");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::create_dir(library.join(".hidden")).unwrap();
        let identity = |path: &Path| {
            let real = dunce::canonicalize(path).ok()?;
            Some(FolderIdentity {
                inode: real.display().to_string(),
                birthtime: Some("1".into()),
            })
        };
        let hidden = identity(&library.join(".hidden")).unwrap();
        assert_eq!(find(&library, &derived, Some(&hidden), &identity), None);
        std::os::unix::fs::symlink(&elsewhere, library.join("Linked")).unwrap();
        let linked = identity(&elsewhere).unwrap();
        assert_eq!(
            find(&library, &derived, Some(&linked), &identity),
            Some(library.join("Linked"))
        );
    }

    #[test]
    fn open_with_names_a_folder_directly_inside_the_epicenter_folder() {
        let (temp, library) = library();
        fs::create_dir(library.join("Recipes")).unwrap();
        fs::create_dir_all(library.join("bradenwong.com/zhongwen")).unwrap();
        assert_eq!(opened_with(&library, "Recipes"), Ok(library.join("Recipes")));
        assert_eq!(
            opened_with(&library, library.join("Recipes").to_str().unwrap()),
            Ok(library.join("Recipes"))
        );
        for refused in [
            "Missing".to_string(),
            ".hidden".to_string(),
            "bradenwong.com/zhongwen".to_string(),
            "../Epicenter".to_string(),
            library.join("bradenwong.com/zhongwen").display().to_string(),
            temp.path().display().to_string(),
            "/".to_string(),
        ] {
            assert!(opened_with(&library, &refused).is_err(), "{refused}");
        }
        #[cfg(unix)]
        {
            // The Epicenter folder spelled through a link is still it.
            let alias = dunce::canonicalize(temp.path()).unwrap().join("alias");
            std::os::unix::fs::symlink(&library, &alias).unwrap();
            assert_eq!(
                opened_with(&library, alias.join("Recipes").to_str().unwrap()),
                Ok(library.join("Recipes"))
            );
        }
    }

    #[test]
    fn the_folder_argument_is_read_in_either_spelling() {
        let arguments = |list: &[&str]| list.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        assert_eq!(
            folder_argument(&arguments(&["/app", "--folder", "Recipes"])),
            Some("Recipes".into())
        );
        assert_eq!(
            folder_argument(&arguments(&["/app", "--folder=/Users/me/Epicenter/Recipes"])),
            Some("/Users/me/Epicenter/Recipes".into())
        );
        assert_eq!(folder_argument(&arguments(&["/app"])), None);
        assert_eq!(folder_argument(&arguments(&["/app", "--folder"])), None);
    }
}
