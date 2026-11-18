//! Whether the folder is inside a Git repository, and whether that
//! repository keeps `.webm` audio through Git LFS. Settings uses it to say
//! that audio would go into Git whole, and that audio deleted from the
//! folder stays in the repository's history. It reads; it never runs Git.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{FilesError, Result};
use crate::path::check_folder;

/// What [`folder_git`] found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderGit {
    /// A `.git` directory or file is in the folder or one of its ancestors.
    pub repository: bool,
    /// A `.gitattributes` from the repository's root down to the folder
    /// sends `.webm` files through Git LFS ([`lfs_webm_line`]).
    pub lfs_webm: bool,
}

/// Find the Git repository that holds `folder`, and whether it sends `.webm`
/// files through Git LFS. A folder in no repository answers both `false`.
pub fn folder_git(folder: &Path) -> Result<FolderGit> {
    check_folder(folder)?;
    let folder =
        fs::canonicalize(folder).map_err(|error| FilesError::from_io(folder.display(), &error))?;
    let Some(root) = folder
        .ancestors()
        .find(|directory| fs::symlink_metadata(directory.join(".git")).is_ok())
        .map(Path::to_path_buf)
    else {
        return Ok(FolderGit {
            repository: false,
            lfs_webm: false,
        });
    };
    // The root first, then each directory down to the folder: a deeper
    // file's line comes later, as Git reads them.
    let mut directories: Vec<PathBuf> = folder
        .ancestors()
        .take_while(|directory| directory.starts_with(&root))
        .map(Path::to_path_buf)
        .collect();
    directories.reverse();
    let mut lfs_webm = false;
    for directory in directories {
        let attributes = directory.join(".gitattributes");
        let text = match fs::read_to_string(&attributes) {
            Ok(text) => text,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => {
                log::warn!("{} could not be read: {error}", attributes.display());
                continue;
            }
        };
        for line in text.lines() {
            if let Some(lfs) = lfs_webm_line(line) {
                lfs_webm = lfs;
            }
        }
    }
    Ok(FolderGit {
        repository: true,
        lfs_webm,
    })
}

/// What one `.gitattributes` line says about `.webm` files and Git LFS:
/// `Some(true)` when it sends them through LFS, `Some(false)` when it takes
/// the LFS filter away, and `None` when it says nothing about them.
///
/// A line is about `.webm` files when its pattern's last segment is `*`,
/// or starts with `*` and ends with `.webm` (any case): `*.webm`,
/// `**/*.webm`, and `recordings/*.webm` all are. A pattern's directory part
/// is not matched against the folder, so `other/*.webm` counts too. The
/// line sends them through LFS with `filter=lfs` among its attributes, and
/// takes the filter away with `-filter`, `!filter`, or another `filter=`.
/// Blank lines, comments, quoted patterns, and macro lines (`[attr]`) say
/// nothing.
pub(crate) fn lfs_webm_line(line: &str) -> Option<bool> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') || line.starts_with('"') {
        return None;
    }
    let mut words = line.split_whitespace();
    let pattern = words.next()?;
    if pattern.starts_with("[attr]") {
        return None;
    }
    let last = pattern.rsplit('/').next().unwrap_or(pattern);
    let about_webm =
        last == "*" || (last.starts_with('*') && last.to_ascii_lowercase().ends_with(".webm"));
    if !about_webm {
        return None;
    }
    let mut said = None;
    for attribute in words {
        if attribute == "filter=lfs" {
            said = Some(true);
        } else if attribute == "-filter"
            || attribute == "!filter"
            || attribute.starts_with("filter=")
        {
            said = Some(false);
        }
    }
    said
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_sends_webm_through_lfs_only_with_the_filter() {
        for (line, said) in [
            ("*.webm filter=lfs diff=lfs merge=lfs -text", Some(true)),
            ("**/*.webm filter=lfs diff=lfs merge=lfs -text", Some(true)),
            ("recordings/*.webm filter=lfs -text", Some(true)),
            ("*.WEBM filter=lfs", Some(true)),
            ("* filter=lfs", Some(true)),
            ("*.webm -filter", Some(false)),
            ("*.webm !filter", Some(false)),
            ("*.webm filter=other", Some(false)),
            ("*.webm -text", None),
            ("*.md filter=lfs", None),
            ("a.webm filter=lfs", None),
            ("# *.webm filter=lfs", None),
            ("", None),
            ("[attr]audio filter=lfs", None),
        ] {
            assert_eq!(lfs_webm_line(line), said, "{line:?}");
        }
    }

    #[test]
    fn a_folder_outside_any_repository_says_so() {
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path().join("data");
        fs::create_dir(&folder).unwrap();
        // A temporary directory is outside any repository on a test machine;
        // a `.git` above it would make this say otherwise.
        if fs::canonicalize(temp.path())
            .unwrap()
            .ancestors()
            .any(|directory| directory.join(".git").exists())
        {
            return;
        }
        assert_eq!(
            folder_git(&folder).unwrap(),
            FolderGit {
                repository: false,
                lfs_webm: false
            }
        );
    }

    #[test]
    fn the_attributes_from_the_root_down_decide() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home");
        let folder = root.join("apps/whispering/data");
        fs::create_dir_all(&folder).unwrap();
        fs::create_dir(root.join(".git")).unwrap();
        assert_eq!(
            folder_git(&folder).unwrap(),
            FolderGit {
                repository: true,
                lfs_webm: false
            }
        );

        fs::write(
            root.join(".gitattributes"),
            "# audio\n*.webm filter=lfs diff=lfs merge=lfs -text\n",
        )
        .unwrap();
        assert!(folder_git(&folder).unwrap().lfs_webm);

        // A deeper file's line comes later and wins.
        fs::write(root.join("apps/.gitattributes"), "*.webm -filter\n").unwrap();
        assert!(!folder_git(&folder).unwrap().lfs_webm);
        fs::write(
            folder.join(".gitattributes"),
            "recordings/*.webm filter=lfs\n",
        )
        .unwrap();
        assert!(folder_git(&folder).unwrap().lfs_webm);

        // A `.git` file, as a worktree or a submodule has, is a repository too.
        let worktree = temp.path().join("worktree");
        fs::create_dir(&worktree).unwrap();
        fs::write(worktree.join(".git"), "gitdir: elsewhere\n").unwrap();
        assert!(folder_git(&worktree).unwrap().repository);

        assert!(matches!(
            folder_git(&temp.path().join("missing")),
            Err(FilesError::NotFound { .. })
        ));
    }
}
