//! Standalone Todos chooses a directory before constructing its only window.
//! The old whole-AppData Folder remains readable until its work is deliberately
//! relocated; startup never merges two populated directories.

use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq, Eq)]
pub enum Launch {
    Default(PathBuf),
    Choose {
        legacy: PathBuf,
        target: PathBuf,
        target_status: TargetStatus,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub enum TargetStatus {
    Empty,
    HasWork,
    Unavailable(String),
}

pub fn root(
    identifier: &str,
    home: &Path,
    override_value: Option<&OsStr>,
) -> Result<PathBuf, String> {
    let base = match override_value {
        Some(value) if !value.is_empty() => {
            let path = Path::new(value);
            if !path.is_absolute() {
                return Err(format!(
                    "EPICENTER_FOLDER_DIR must be an absolute path, not {value:?}."
                ));
            }
            path.to_path_buf()
        }
        _ => {
            let name = match identifier {
                "so.epicenter.todos" => "Epicenter",
                "so.epicenter.todos.dev" => "Epicenter Dev",
                _ => {
                    return Err(format!(
                        "No authored root for {identifier}; set EPICENTER_FOLDER_DIR explicitly"
                    ))
                }
            };
            home.join(name)
        }
    };
    Ok(base.join("Todos"))
}

pub fn decide(legacy: &Path, target: &Path) -> io::Result<Launch> {
    let legacy_has_work = has_work(legacy, true)?;
    if !legacy_has_work {
        return Ok(Launch::Default(target.to_path_buf()));
    }
    let target_status = match has_work(target, false) {
        Ok(true) => TargetStatus::HasWork,
        Ok(false) => TargetStatus::Empty,
        Err(error) => TargetStatus::Unavailable(error.to_string()),
    };
    Ok(Launch::Choose {
        legacy: legacy.to_path_buf(),
        target: target.to_path_buf(),
        target_status,
    })
}

/// Inspect without following links. A file or link counts even if it cannot
/// be parsed as a todo; deleting it because the schema does not know it would
/// lose work. The old app's initialized but empty Git repository does not by
/// itself require a transition.
fn has_work(root: &Path, legacy: bool) -> io::Result<bool> {
    match fs::symlink_metadata(root) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
        Ok(meta) if !meta.is_dir() || meta.file_type().is_symlink() => {
            return Err(io::Error::other(format!(
                "{} is not a real directory",
                root.display()
            )))
        }
        Ok(_) => {}
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        if name == ".DS_Store" || (legacy && name == "EBWebView") {
            continue;
        }
        if name == ".git" {
            if git_has_work(&entry.path())? {
                return Ok(true);
            }
            continue;
        }
        if entry.file_type()?.is_dir() {
            if contains_file(&entry.path())? {
                return Ok(true);
            }
        } else {
            return Ok(true);
        }
    }
    Ok(false)
}

fn git_has_work(git: &Path) -> io::Result<bool> {
    if !fs::symlink_metadata(git)?.is_dir() {
        return Ok(true);
    }
    for name in ["objects", "refs"] {
        let path = git.join(name);
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
            Ok(meta) if !meta.is_dir() => return Ok(true),
            Ok(_) if contains_file(&path)? => return Ok(true),
            Ok(_) => {}
        }
    }
    for name in ["index", "packed-refs", "shallow", "commondir"] {
        match fs::symlink_metadata(git.join(name)) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
            Ok(_) => return Ok(true),
        }
    }
    Ok(false)
}

fn contains_file(directory: &Path) -> io::Result<bool> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            if contains_file(&entry.path())? {
                return Ok(true);
            }
        } else {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roots_match_host_storage_environments_and_require_absolute_overrides() {
        let home = Path::new("/home/person");
        assert_eq!(
            root("so.epicenter.todos", home, None).unwrap(),
            home.join("Epicenter/Todos")
        );
        assert_eq!(
            root("so.epicenter.todos.dev", home, None).unwrap(),
            home.join("Epicenter Dev/Todos")
        );
        assert_eq!(
            root("so.epicenter.todos", home, Some(OsStr::new("/other"))).unwrap(),
            Path::new("/other/Todos")
        );
        assert!(root("so.epicenter.todos", home, Some(OsStr::new("relative"))).is_err());
        assert_eq!(
            root("unrecognized", home, Some(OsStr::new("/other"))).unwrap(),
            Path::new("/other/Todos")
        );
    }

    #[test]
    fn fresh_launch_uses_root_and_runtime_files_do_not_trigger_transition() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("old");
        let target = temp.path().join("Epicenter/Todos");
        assert_eq!(
            decide(&legacy, &target).unwrap(),
            Launch::Default(target.clone())
        );
        fs::create_dir_all(legacy.join(".git/objects")).unwrap();
        fs::write(legacy.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        fs::write(legacy.join(".DS_Store"), "metadata").unwrap();
        assert_eq!(decide(&legacy, &target).unwrap(), Launch::Default(target));
    }

    #[test]
    fn legacy_or_two_populated_locations_require_a_deliberate_choice() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("old");
        let target = temp.path().join("Epicenter/Todos");
        fs::create_dir_all(legacy.join("todos")).unwrap();
        fs::write(legacy.join("todos/milk.md"), "milk").unwrap();
        assert_eq!(
            decide(&legacy, &target).unwrap(),
            Launch::Choose {
                legacy: legacy.clone(),
                target: target.clone(),
                target_status: TargetStatus::Empty
            }
        );
        fs::create_dir_all(target.join("todos")).unwrap();
        fs::write(target.join("todos/bread.md"), "bread").unwrap();
        assert_eq!(
            decide(&legacy, &target).unwrap(),
            Launch::Choose {
                legacy,
                target,
                target_status: TargetStatus::HasWork
            }
        );
    }

    #[test]
    fn unavailable_new_default_does_not_block_valid_legacy_work() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("old");
        let target = temp.path().join("Epicenter/Todos");
        fs::create_dir_all(legacy.join("todos")).unwrap();
        fs::write(legacy.join("todos/milk.md"), "milk").unwrap();
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, "not a directory").unwrap();
        assert!(matches!(
            decide(&legacy, &target).unwrap(),
            Launch::Choose {
                target_status: TargetStatus::Unavailable(_),
                ..
            }
        ));
        assert_eq!(fs::read(&target).unwrap(), b"not a directory");
        assert_eq!(fs::read(legacy.join("todos/milk.md")).unwrap(), b"milk");
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            fs::remove_file(&target).unwrap();
            symlink(&legacy, &target).unwrap();
            assert!(matches!(
                decide(&legacy, &target).unwrap(),
                Launch::Choose {
                    target_status: TargetStatus::Unavailable(_),
                    ..
                }
            ));
        }
    }

    #[test]
    fn git_history_and_unknown_files_count_as_work() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("old");
        let target = temp.path().join("target");
        fs::create_dir_all(legacy.join(".git/refs/heads")).unwrap();
        fs::write(legacy.join(".git/refs/heads/main"), "hash").unwrap();
        assert!(matches!(
            decide(&legacy, &target).unwrap(),
            Launch::Choose { .. }
        ));
        fs::remove_dir_all(legacy.join(".git")).unwrap();
        fs::write(legacy.join("unrecognized.txt"), "keep").unwrap();
        assert!(matches!(
            decide(&legacy, &target).unwrap(),
            Launch::Choose { .. }
        ));
    }

    #[test]
    fn unreadable_shape_refuses_launch_without_creating_a_target() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("old");
        let target = temp.path().join("Epicenter/Todos");
        fs::write(&legacy, "not a folder").unwrap();
        assert!(decide(&legacy, &target).is_err());
        assert!(!target.exists());
    }
}
