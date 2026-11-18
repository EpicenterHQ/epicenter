//! The plain-name path rule, and where a path that passes it is in a folder.
//!
//! A path is relative to the folder and `/`-separated. Every segment is one
//! or more of `A-Z a-z 0-9 - _`, and only the last may carry one extension:
//! a `.` and one or more of `A-Z a-z 0-9`. So `recordings/k3x9a2f8.md`,
//! `recordings/2026-10-30T22-41-05-123Z-k3x9a2f8.webm`, and `settings.md`
//! pass, and `..`, `/abs`, `.hidden`, `a.b.c`, `a\b`, `a//b`, an empty path,
//! and a directory with an extension do not. A directory's path is the same
//! without an extension, and the empty directory path is the folder itself.
//!
//! The rule leaves out every hidden name, so the temporary file a write
//! keeps beside its target (`.<name>.tmp`, `beside.rs`) is never a path.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use crate::error::{FilesError, Result};

/// Whether `byte` may be in a name.
fn name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'
}

/// Whether `segment` is a name with no extension: one or more of
/// `A-Z a-z 0-9 - _`.
pub fn is_bare_name(segment: &str) -> bool {
    !segment.is_empty() && segment.bytes().all(name_byte)
}

/// Whether `segment` is a file's name: a bare name, with at most one
/// extension of one or more letters or digits.
pub fn is_file_name(segment: &str) -> bool {
    match segment.split_once('.') {
        None => is_bare_name(segment),
        Some((base, extension)) => {
            is_bare_name(base)
                && !extension.is_empty()
                && extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
        }
    }
}

/// Why the folder-relative file path `relative` fails the rule, or `None`.
pub fn file_problem(relative: &str) -> Option<String> {
    if relative.is_empty() {
        return Some("the path is empty".into());
    }
    let mut segments = relative.split('/').peekable();
    while let Some(segment) = segments.next() {
        let last = segments.peek().is_none();
        let passes = if last {
            is_file_name(segment)
        } else {
            is_bare_name(segment)
        };
        if !passes {
            return Some(format!("{relative:?} is not a plain name"));
        }
    }
    None
}

/// Why the folder-relative directory path `relative` fails the rule, or
/// `None`. The empty path is the folder.
pub fn dir_problem(relative: &str) -> Option<String> {
    if relative.is_empty() || relative.split('/').all(is_bare_name) {
        None
    } else {
        Some(format!("{relative:?} is not a plain directory name"))
    }
}

/// Refuse a folder that is not an absolute path.
pub fn check_folder(folder: &Path) -> Result<()> {
    if folder.is_absolute() {
        Ok(())
    } else {
        Err(FilesError::refused(format!(
            "{} is not an absolute path",
            folder.display()
        )))
    }
}

/// The file `relative` in `folder`: rule-checked, and no part of it that
/// exists is a symbolic link.
pub fn resolve(folder: &Path, relative: &str) -> Result<PathBuf> {
    check_folder(folder)?;
    if let Some(problem) = file_problem(relative) {
        return Err(FilesError::refused(problem));
    }
    no_link_on_the_way(folder, relative)
}

/// The directory `relative` in `folder` (the folder itself for `""`):
/// rule-checked, and no part of it that exists is a symbolic link.
pub fn resolve_dir(folder: &Path, relative: &str) -> Result<PathBuf> {
    check_folder(folder)?;
    if let Some(problem) = dir_problem(relative) {
        return Err(FilesError::refused(problem));
    }
    if relative.is_empty() {
        return Ok(folder.to_path_buf());
    }
    no_link_on_the_way(folder, relative)
}

fn no_link_on_the_way(folder: &Path, relative: &str) -> Result<PathBuf> {
    let mut current = folder.to_path_buf();
    for segment in relative.split('/') {
        current.push(segment);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(FilesError::refused(format!(
                    "{relative:?}: a link is on its way"
                )))
            }
            Ok(_) => {}
            Err(error)
                if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) =>
            {
                break
            }
            Err(error) => return Err(FilesError::from_io(current.display(), &error)),
        }
    }
    Ok(folder.join(relative))
}

/// Make the directories on the way to the file `relative` in `folder`, each
/// checked: one that appears as a link refuses.
pub fn make_parents(folder: &Path, relative: &str) -> Result<()> {
    let Some((parent, _)) = relative.rsplit_once('/') else {
        return Ok(());
    };
    let mut current = folder.to_path_buf();
    for segment in parent.split('/') {
        current.push(segment);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_dir() => continue,
            Ok(_) => {
                return Err(FilesError::refused(format!(
                    "{} is not a directory",
                    current.display()
                )))
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(FilesError::from_io(current.display(), &error)),
        }
        match fs::create_dir(&current) {
            Ok(()) => {}
            // Made by someone else meanwhile: checked again on the next pass.
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                let metadata = fs::symlink_metadata(&current)
                    .map_err(|error| FilesError::from_io(current.display(), &error))?;
                if !metadata.is_dir() {
                    return Err(FilesError::refused(format!(
                        "{} is not a directory",
                        current.display()
                    )));
                }
            }
            Err(error) => return Err(FilesError::from_io(current.display(), &error)),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_names_pass_and_nothing_else_does() {
        for passes in [
            "recordings/k3x9a2f8.md",
            "recordings/2026-10-30T22-41-05-123Z-k3x9a2f8.webm",
            "transcriptions/x.md",
            "settings.md",
            "recordings/k3x9",
            "a/b/c/D-e_f.TXT",
        ] {
            assert_eq!(file_problem(passes), None, "{passes:?}");
        }
        for refused in [
            "",
            "..",
            ".",
            "a/../b",
            "/abs",
            ".hidden",
            "recordings/.a.md.k3x9q0w1.tmp",
            "a.b.c",
            "a\\b",
            "a//b",
            "a/",
            "a.b/c.md",
            "a.",
            ".md",
            "a b.md",
            "naïve.md",
            "a/b.m-d",
            "a\nb",
        ] {
            assert!(file_problem(refused).is_some(), "{refused:?}");
        }
        for passes in ["", "recordings", "a/b-c/d_e"] {
            assert_eq!(dir_problem(passes), None, "{passes:?}");
        }
        for refused in ["a.b", "/a", "a/", "..", ".git", "a//b"] {
            assert!(dir_problem(refused).is_some(), "{refused:?}");
        }
    }

    #[test]
    fn a_folder_must_be_absolute() {
        assert!(matches!(
            resolve(Path::new("relative"), "a.md"),
            Err(FilesError::Refused { .. })
        ));
        assert!(matches!(
            resolve_dir(Path::new("relative"), ""),
            Err(FilesError::Refused { .. })
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_link_on_the_way_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), temp.path().join("recordings")).unwrap();
        std::fs::write(outside.path().join("x.md"), b"x").unwrap();
        std::os::unix::fs::symlink(outside.path().join("x.md"), temp.path().join("settings.md"))
            .unwrap();
        for refused in ["recordings/a.webm", "settings.md"] {
            assert!(
                matches!(
                    resolve(temp.path(), refused),
                    Err(FilesError::Refused { .. })
                ),
                "{refused}"
            );
        }
        assert!(resolve_dir(temp.path(), "recordings").is_err());
        assert!(make_parents(temp.path(), "recordings/2026/a.webm").is_err());
        assert_eq!(
            resolve(temp.path(), "other/a.webm").unwrap(),
            temp.path().join("other/a.webm")
        );
    }

    #[test]
    fn make_parents_makes_each_directory_on_the_way() {
        let temp = tempfile::tempdir().unwrap();
        make_parents(temp.path(), "a/b/c.md").unwrap();
        assert!(temp.path().join("a/b").is_dir());
        assert!(!temp.path().join("a/b/c.md").exists());
        make_parents(temp.path(), "a/b/c.md").unwrap();
        std::fs::write(temp.path().join("f"), b"").unwrap();
        assert!(matches!(
            make_parents(temp.path(), "f/x.md"),
            Err(FilesError::Refused { .. })
        ));
    }
}
