//! The paths a writer in the shell may change, checked on disk.
//!
//! `classify` decides each one. The path must be under the root with no `.`
//! or `..` component, every component from the root down that exists must be
//! what it says, never a link, and it must be a data path: one the shared
//! path rule accepts (`paths::path_problem`, the same rule as the folder
//! engine's `pathProblem`). It names no `.git` or `HEAD` in any case and only
//! names that mean only themselves on every disk, so no nested repository
//! can be assembled and no name reaches `.git` by another spelling.
//!
//! Nothing in `.git` is made or changed here, whether or not `.git` exists:
//! a page's save stages its bytes beside the root
//! (`storage::scratch_directory`), not in it. A link another program swaps
//! in between the check and the change is not defended against.
//!
//! `storage` builds a page's changes on these; a writer beside the page,
//! such as the recorder appending to its audio in place, names its data
//! path through `data_path`.

use std::fs;
use std::path::{Path, PathBuf};

use crate::paths;

fn refused(path: &Path, why: &str) -> String {
    format!("'{}' is not one the shell may change: {why}", path.display())
}

/// Whether `name` is a name at all, and one that means only itself on every
/// disk (`paths::names_only_itself`).
fn names_only_itself(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.chars().any(|c| c.is_control() || matches!(c, '\\' | '/'))
        && paths::names_only_itself(name)
}

/// Whether `parts` name a data path.
fn is_data(parts: &[String]) -> bool {
    !parts.is_empty()
        && parts.iter().all(|part| names_only_itself(part))
        && paths::path_problem(&parts.join("/")).is_none()
}

/// The names of `raw` below `base`, as the page wrote them, or `None`
/// when it is not below it or names `.`, `..`, or an empty name. A root
/// written with a trailing separator (`/`, `C:\`, a share root) ends where
/// the separator begins; one separator must follow it, so a sibling such as
/// `root2` is never inside `root`.
fn relative_parts(base: &str, raw: &str) -> Option<Vec<String>> {
    let base = base.trim_end_matches(['/', '\\']);
    let rest = raw.strip_prefix(base)?.strip_prefix(['/', '\\'])?;
    let parts: Vec<String> = rest.split(['/', '\\']).map(str::to_string).collect();
    parts
        .iter()
        .all(|part| !part.is_empty() && part != "." && part != "..")
        .then_some(parts)
}

/// The full path of `path`, if it is a data path a page may change.
fn classify(root: &Path, path: &Path) -> Result<PathBuf, String> {
    // The path as the page wrote it, split on every separator: `components`
    // would quietly drop a `.` or a doubled separator, and each name the page
    // supplied must be checked as written.
    let raw = path
        .to_str()
        .ok_or_else(|| refused(path, "its name is not text"))?;
    let base = root
        .to_str()
        .ok_or_else(|| refused(path, "the folder's path is not text"))?;
    let parts = relative_parts(base, raw)
        .ok_or_else(|| refused(path, "it is outside the folder, or names `.`, `..`, or an empty name"))?;
    if !is_data(&parts) {
        return Err(refused(
            path,
            "it is Git's own state or a name some disk reads as another",
        ));
    }
    // Every existing component, the last included, is itself, not a link.
    if linked(root, &parts)? {
        return Err(refused(path, "a link is on its way"));
    }
    Ok(root.join(parts.iter().collect::<PathBuf>()))
}

/// Whether one of `parts`, walked from `root`, is a link. The walk stops at
/// the first that does not exist, since nothing below it does either.
fn linked(root: &Path, parts: &[String]) -> Result<bool, String> {
    let mut current = root.to_path_buf();
    for part in parts {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => return Ok(true),
            Ok(_) => {}
            Err(missing) if missing.kind() == std::io::ErrorKind::NotFound => break,
            Err(cause) => {
                return Err(format!(
                    "'{}' could not be inspected: {cause}",
                    current.display()
                ))
            }
        }
    }
    Ok(false)
}

/// The full path of the data path `relative` in `root`, checked as a change
/// is: the shared path rule, and no link on the way. For a writer beside the
/// engine that names a data file itself, such as a recorder appending to its
/// audio in place.
pub fn data_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    classify(root, &root.join(relative))
}

/// Make the data directory at `path` and any missing ancestors, each one
/// checked as a data directory. Nothing in `.git` is made, whether or not
/// `.git` exists.
pub fn mkdir(root: &Path, path: &Path) -> Result<(), String> {
    let target = classify(root, path)?;
    let relative = target.strip_prefix(root).expect("checked under the root");
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        if fs::symlink_metadata(&current).is_ok() {
            continue;
        }
        classify(root, &current)?;
        fs::create_dir(&current)
            .or_else(|cause| if current.is_dir() { Ok(()) } else { Err(cause) })
            .map_err(|cause| format!("'{}' could not be made: {cause}", current.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn may(root: &Path, relative: &str) -> bool {
        classify(root, &root.join(relative)).is_ok()
    }

    #[test]
    fn the_shell_changes_data_paths_only() {
        let temp = crate::testing::TempDir::new("page-files");
        let root = temp.folder("notes");
        fs::create_dir_all(root.join(".git/objects")).unwrap();
        for allowed in [
            "todos",
            "todos/a.md",
            "todos/Buy milk.md",
            "todos/café.md",
            "epicenter.json",
            "kv.json",
            ".gitignore",
            ".obsidian/workspace.json",
            ".DS_Store",
            "todos/.hidden.md",
            "todos/.md",
            "todos/notes.txt",
            "todos/sub/a.md",
            "todos/config",
            "todos/objects/x",
            "other.md",
            "attachments/manual.txt",
        ] {
            assert!(may(&root, allowed), "{allowed}");
        }
        for refused in [
            ".git",
            ".git/config",
            ".git/config.worktree",
            ".git/HEAD",
            ".git/index",
            ".git/index.tmp-1",
            ".git/hooks/post-commit",
            ".GIT/Hooks/post-commit",
            ".git/objects/ab/cdef",
            ".git/objects/ab",
            ".GIT/OBJECTS/ab/cdef",
            ".git/objects/info/alternates",
            ".git/refs/heads/main",
            ".git/epicenter",
            ".git/epicenter/scratch",
            ".GIT/EPICENTER/SCRATCH",
            ".git/epicenter/no-hooks/post-commit",
            ".git/epicenter/scratch/staged",
            ".git/epicenter/scratch/nested/x",
            "todos/../.git/config",
            "todos/.git/config",
            "todos/HEAD",
            "todos/head",
            "GIT~1/hooks/post-commit",
            "todos/NOTES~1.md",
            "HEAD",
            // Names Windows or HFS+ resolve to another entry.
            "todos/a.md.",
            "todos/a.md ",
            "todos/a.md:stream",
            "todos/NUL",
            "todos/nul.md",
            "todos/COM1.md",
            "todos/a?.md",
            "todos/\u{200C}.git",
            "\u{200C}.git/config",
            "todos/a\u{FEFF}.md",
            // Segments `components` would drop.
            "todos/./a.md",
            "todos//a.md",
            "todos/a.md/",
            "./todos/a.md",
        ] {
            assert!(!may(&root, refused), "{refused}");
        }
        assert!(classify(&root, &temp.path().join("outside.md")).is_err());
    }

    #[test]
    fn a_root_written_with_a_trailing_separator_still_holds_its_files() {
        let temp = crate::testing::TempDir::new("page-files-roots");
        let root = temp.folder("notes");
        let slashed = PathBuf::from(format!("{}/", root.display()));
        assert!(classify(&slashed, &root.join("todos/a.md")).is_ok());
        assert!(classify(&slashed, &root.join("todos/.git/config")).is_err());
        // A sibling whose name extends the root's is outside it.
        let sibling = PathBuf::from(format!("{}2/todos/a.md", root.display()));
        assert!(classify(&root, &sibling).is_err());
        assert!(classify(&slashed, &sibling).is_err());
        // Drive and filesystem roots, as their names are written.
        let parts = |names: &[&str]| Some(names.iter().map(|name| name.to_string()).collect::<Vec<_>>());
        assert_eq!(relative_parts("C:\\", "C:\\todos\\a.md"), parts(&["todos", "a.md"]));
        assert_eq!(relative_parts("/", "/todos/a.md"), parts(&["todos", "a.md"]));
        assert_eq!(relative_parts("\\\\server\\share\\", "\\\\server\\share\\todos\\a.md"), parts(&["todos", "a.md"]));
        assert_eq!(relative_parts("/x/root", "/x/root2/a.md"), None);
        assert_eq!(relative_parts("/x/root", "/x/root/a//b"), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_on_the_way_refuses_a_directory() {
        let temp = crate::testing::TempDir::new("page-files-link");
        let elsewhere = temp.folder("elsewhere");
        for (linked, made) in [("todos", "todos/sub"), ("todos/sub", "todos/sub/deeper")] {
            let root = temp.folder(&format!("notes-{}", linked.len()));
            let link = root.join(linked);
            fs::create_dir_all(link.parent().unwrap()).unwrap();
            std::os::unix::fs::symlink(&elsewhere, &link).unwrap();
            assert!(mkdir(&root, &root.join(made)).is_err(), "{linked}");
        }
        assert!(fs::read_dir(&elsewhere).unwrap().next().is_none());
    }

    /// A save stages beside the root, so nothing in `.git` is ever made: not
    /// `.git` itself in a folder with no repository, and nothing inside one
    /// that exists.
    #[test]
    fn nothing_in_git_is_made_with_or_without_a_repository() {
        let temp = crate::testing::TempDir::new("page-files-no-repository");
        let root = temp.folder("notes");
        for refused in [
            ".git",
            ".git/hooks",
            ".git/epicenter",
            ".git/epicenter/scratch",
        ] {
            assert!(mkdir(&root, &root.join(refused)).is_err(), "{refused}");
        }
        assert!(!root.join(".git").exists());
        fs::create_dir(root.join(".git")).unwrap();
        for refused in [".git/epicenter", ".git/epicenter/scratch"] {
            assert!(mkdir(&root, &root.join(refused)).is_err(), "{refused}");
        }
        assert!(fs::read_dir(root.join(".git")).unwrap().next().is_none());
        mkdir(&root, &root.join("todos/sub")).unwrap();
        assert!(root.join("todos/sub").is_dir());
    }

    /// A writer beside the engine names a data path and gets it checked as a
    /// change is, before it creates anything there.
    #[test]
    fn a_data_path_is_checked_as_a_change_is() {
        let temp = crate::testing::TempDir::new("page-files-data-path");
        let root = temp.folder("notes");
        assert_eq!(
            data_path(&root, "recordings/a.wav").unwrap(),
            root.join("recordings/a.wav")
        );
        for refused in [
            ".git/epicenter/scratch/x",
            ".git/config",
            "../outside.wav",
            "recordings/HEAD",
            "recordings/a.wav.",
            "",
        ] {
            assert!(data_path(&root, refused).is_err(), "{refused:?}");
        }
        #[cfg(unix)]
        {
            let outside = temp.folder("outside");
            std::os::unix::fs::symlink(&outside, root.join("linked")).unwrap();
            assert!(data_path(&root, "linked/a.wav").is_err());
        }
    }
}
