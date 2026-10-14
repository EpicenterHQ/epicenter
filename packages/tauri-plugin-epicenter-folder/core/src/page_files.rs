//! Changes a page makes to the files of a folder it opens with its own
//! engine.
//!
//! A page reads a granted folder through Tauri's fs plugin, whose scope
//! resolves every existing path, links included, before matching it. Its
//! changes come here instead, because a scope matches a path that does not
//! exist yet as text: under a link that already points elsewhere, a new
//! file's path looks like the folder's and lands outside it.
//!
//! `classify` decides every change. The path must be under the root with no
//! `.` or `..` component, and every component from the root down that exists
//! must be what it says, never a link. Then it must be one of:
//!
//! - a data path: any file or directory whose path the shared path rule
//!   accepts (`paths::path_problem`, the same rule as the folder engine's
//!   `pathProblem`). It names no `.git` or `HEAD` in any case and only names
//!   that mean only themselves on every disk, so no nested repository can be
//!   assembled and no name reaches `.git` by another spelling. Which data
//!   paths a folder has is the page's business: the shell keeps no list;
//! - inside `.git`, the folder engine's staging directory
//!   `.git/epicenter/scratch` and its files, and the private index copies
//!   `.git/index.tmp-*` that `git write-tree` reads.
//!
//! Every name is compared component by component, `.git` and its parts
//! case-insensitively, so on a disk that ignores case `.GIT/Hooks/x` is
//! refused as `.git/hooks/x` would be. Git objects are never written here: the
//! engine stores them with `git hash-object -w` (`page_git`), which names and
//! checks them itself. A data file is never written in place: the engine
//! writes a new staged file and renames it over the path, so an existing
//! hard link is replaced, never written through. A link
//! another program swaps in between the check and the change is not
//! defended against; a page cannot make one.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::paths;

/// What a path is to a page that changes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// A file or directory of the folder's data.
    Data,
    /// `.git/epicenter/scratch`, the engine's staging directory.
    Scratch,
    /// A staged file in it.
    Staged,
    /// `.git/index.tmp-*`, a private index copy.
    IndexCopy,
    /// `.git/epicenter`, made only as a directory on the way to scratch.
    Epicenter,
}

fn refused(path: &Path, why: &str) -> String {
    format!("'{}' is not one this page may change: {why}", path.display())
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

/// A name the engine itself gives a staged file or an index copy.
fn is_plain(name: &str) -> bool {
    names_only_itself(name)
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn classify_parts(parts: &[String]) -> Option<Kind> {
    if parts.is_empty() || !parts.iter().all(|part| names_only_itself(part)) {
        return None;
    }
    let lower: Vec<String> = parts.iter().map(|part| part.to_ascii_lowercase()).collect();
    let lower: Vec<&str> = lower.iter().map(String::as_str).collect();
    match lower.as_slice() {
        [".git", "epicenter"] => return Some(Kind::Epicenter),
        [".git", "epicenter", "scratch"] => return Some(Kind::Scratch),
        [".git", "epicenter", "scratch", name] => {
            return is_plain(name).then_some(Kind::Staged);
        }
        [".git", name] if name.starts_with("index.tmp-") => {
            return is_plain(name).then_some(Kind::IndexCopy);
        }
        _ => {}
    }
    paths::path_problem(&parts.join("/"))
        .is_none()
        .then_some(Kind::Data)
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

/// What `path` is, if a page may change it, and its full path.
fn classify(root: &Path, path: &Path) -> Result<(Kind, PathBuf), String> {
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
    let relative: PathBuf = parts.iter().collect();
    let kind = classify_parts(&parts).ok_or_else(|| {
        refused(path, "it is Git's own state or a name some disk reads as another")
    })?;
    // Every existing component, the last included, is itself, not a link.
    let mut current = root.to_path_buf();
    for part in &parts {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(refused(path, "a link is on its way"));
            }
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
    Ok((kind, root.join(relative)))
}

fn expect(kind: Kind, allowed: &[Kind], path: &Path) -> Result<(), String> {
    if allowed.contains(&kind) {
        Ok(())
    } else {
        Err(refused(path, "that change is not one the engine makes there"))
    }
}

/// Write `bytes` to a new file the engine stages in `.git`: a staged file
/// under `.git/epicenter/scratch` or a private index copy. A path that
/// exists is refused (`create_new`), so nothing already there, a hard link
/// another program planted included, is written through. A data file is
/// never written here: the engine stages its bytes and renames the staged
/// copy over it (`rename`).
pub fn write_file(
    root: &Path,
    path: &Path,
    bytes: &[u8],
    create_new: bool,
) -> Result<(), String> {
    let (kind, target) = classify(root, path)?;
    expect(kind, &[Kind::Staged, Kind::IndexCopy], path)?;
    if !create_new {
        return Err(refused(
            path,
            "a staged file or index copy is only ever written new",
        ));
    }
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .and_then(|mut file| file.write_all(bytes))
        .map_err(|cause| format!("'{}' could not be written: {cause}", target.display()))
}

/// Whether `index_file` names a private index copy directly in the root's
/// `.git` (`.git/index.tmp-*`), compared name by name so either separator
/// counts: the page joins `/` onto a root Windows writes with `\`.
pub(crate) fn is_index_copy(root: &Path, index_file: &str) -> bool {
    let Some(base) = root.to_str() else {
        return false;
    };
    relative_parts(base, index_file).is_some_and(|parts| {
        parts.first().map(String::as_str) == Some(".git")
            && classify_parts(&parts) == Some(Kind::IndexCopy)
    })
}

/// Rename `from` over `to`: a staged file into a data path, or one data path
/// to another.
pub fn rename(root: &Path, from: &Path, to: &Path) -> Result<(), String> {
    let (source_kind, source) = classify(root, from)?;
    let (target_kind, target) = classify(root, to)?;
    expect(source_kind, &[Kind::Data, Kind::Staged], from)?;
    expect(target_kind, &[Kind::Data, Kind::Staged], to)?;
    if source_kind == Kind::Data && target_kind == Kind::Staged {
        return Err(refused(to, "a data file is not moved into staging"));
    }
    fs::rename(&source, &target).map_err(|cause| {
        format!(
            "'{}' could not be moved to '{}': {cause}",
            source.display(),
            target.display()
        )
    })
}

/// Remove a data file, an empty data directory, a staged file, or a private
/// index copy. A directory's contents are never removed with it.
pub fn remove(root: &Path, path: &Path, recursive: bool) -> Result<(), String> {
    let (kind, target) = classify(root, path)?;
    expect(
        kind,
        &[Kind::Data, Kind::Staged, Kind::IndexCopy],
        path,
    )?;
    if recursive {
        return Err(refused(path, "a tree is never removed whole"));
    }
    let metadata = fs::symlink_metadata(&target)
        .map_err(|cause| format!("'{}' could not be removed: {cause}", target.display()))?;
    let removed = if metadata.is_dir() {
        fs::remove_dir(&target)
    } else {
        fs::remove_file(&target)
    };
    removed.map_err(|cause| format!("'{}' could not be removed: {cause}", target.display()))
}

/// Make the directory at `path` and any missing ancestors, each one a data
/// directory or the engine's staging directory on its way.
pub fn mkdir(root: &Path, path: &Path) -> Result<(), String> {
    let (kind, target) = classify(root, path)?;
    expect(kind, &[Kind::Data, Kind::Scratch], path)?;
    let relative = target.strip_prefix(root).expect("checked under the root");
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        if fs::symlink_metadata(&current).is_ok() {
            continue;
        }
        let (kind, _) = classify(root, &current)?;
        expect(
            kind,
            &[Kind::Data, Kind::Scratch, Kind::Epicenter],
            &current,
        )?;
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
    fn a_page_changes_its_data_and_the_engines_own_git_files_only() {
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
            ".git/epicenter/scratch",
            ".git/epicenter/scratch/staged",
            ".git/index.tmp-1",
            ".GIT/EPICENTER/SCRATCH/x",
        ] {
            assert!(may(&root, allowed), "{allowed}");
        }
        for refused in [
            ".git",
            ".git/config",
            ".git/config.worktree",
            ".git/HEAD",
            ".git/index",
            ".git/hooks/post-commit",
            ".GIT/Hooks/post-commit",
            ".git/objects/ab/cdef",
            ".git/objects/ab",
            ".GIT/OBJECTS/ab/cdef",
            ".git/objects/info/alternates",
            ".git/refs/heads/main",
            ".git/epicenter/no-hooks/post-commit",
            ".git/epicenter/scratch/nested/x",
            "todos/../.git/config",
            "todos/.git/config",
            "todos/HEAD",
            "todos/head",
            "GIT~1/hooks/post-commit",
            "todos/NOTES~1.md",
            "HEAD",
            // Names Windows or HFS+ resolve to another entry.
            ".git/epicenter/scratch/.. ",
            ".git/epicenter/scratch/..",
            ".git/epicenter/scratch/a b",
            ".git/epicenter/scratch/x.",
            ".git/index.tmp-a b",
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

    /// Every path the folder engine changed in its real-Git tests
    /// (`packages/folder/src/directory-folder.test.ts`, which keeps the
    /// fixture current) is one a page may change.
    #[test]
    fn every_change_the_folder_engine_makes_is_allowed() {
        let changes: Vec<String> =
            serde_json::from_str(include_str!("../../fixtures/page-file-changes.json"))
                .expect("the recorded changes");
        assert!(changes.len() >= 5, "the fixture records the engine's changes");
        let temp = crate::testing::TempDir::new("page-files-fixture");
        let root = temp.folder("notes");
        for change in changes {
            let concrete = change
                .replace("<staged>", "staged-1")
                .replace("<n>", "1")
                .replace("<stem>", "milk");
            assert!(may(&root, &concrete), "{change}");
        }
    }

    /// A new staged file holding `bytes`, as the engine writes one.
    fn staged(root: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = root.join(".git/epicenter/scratch").join(name);
        mkdir(root, path.parent().unwrap()).unwrap();
        write_file(root, &path, bytes, true).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn a_link_on_the_way_refuses_the_change() {
        let temp = crate::testing::TempDir::new("page-files-link");
        let root = temp.folder("notes");
        fs::create_dir_all(root.join(".git")).unwrap();
        let elsewhere = temp.folder("elsewhere");
        std::os::unix::fs::symlink(root.join(".git"), root.join("todos")).unwrap();
        let copy = staged(&root, "a", b"x");
        assert!(rename(&root, &copy, &root.join("todos/config.md")).is_err());
        assert!(!root.join(".git/config.md").exists());
        let other = temp.folder("other");
        fs::create_dir_all(other.join(".git")).unwrap();
        std::os::unix::fs::symlink(&elsewhere, other.join("todos")).unwrap();
        let copy = staged(&other, "a", b"x");
        assert!(rename(&other, &copy, &other.join("todos/a.md")).is_err());
        assert!(fs::read_dir(&elsewhere).unwrap().next().is_none());
        assert!(mkdir(&other, &other.join("todos")).is_err());
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
    fn a_linked_staging_directory_refuses_the_write() {
        let temp = crate::testing::TempDir::new("page-files-scratch-link");
        let elsewhere = temp.folder("elsewhere");
        for linked in [".git/epicenter", ".git/epicenter/scratch"] {
            let root = temp.folder(&format!("notes-{}", linked.len()));
            let link = root.join(linked);
            fs::create_dir_all(link.parent().unwrap()).unwrap();
            std::os::unix::fs::symlink(&elsewhere, &link).unwrap();
            let copy = root.join(".git/epicenter/scratch/a");
            assert!(write_file(&root, &copy, b"x", true).is_err(), "{linked}");
            assert!(mkdir(&root, &root.join(".git/epicenter/scratch")).is_err(), "{linked}");
        }
        assert!(fs::read_dir(&elsewhere).unwrap().next().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_hard_link_is_replaced_not_written_through() {
        let temp = crate::testing::TempDir::new("page-files-hardlink");
        let root = temp.folder("notes");
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("todos")).unwrap();
        let outside = temp.path().join("outside.md");
        fs::write(&outside, b"theirs").unwrap();
        // A data file is replaced by the staged copy renamed over it.
        fs::hard_link(&outside, root.join("todos/a.md")).unwrap();
        let copy = staged(&root, "a", b"mine");
        rename(&root, &copy, &root.join("todos/a.md")).unwrap();
        assert_eq!(fs::read(&outside).unwrap(), b"theirs");
        assert_eq!(fs::read(root.join("todos/a.md")).unwrap(), b"mine");
        // A private file is only ever written new, so one planted in its
        // place is refused, not written through.
        fs::hard_link(&outside, root.join(".git/index.tmp-1")).unwrap();
        assert!(write_file(&root, &root.join(".git/index.tmp-1"), b"mine", true).is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"theirs");
    }

    #[test]
    fn writes_renames_removals_and_directories_land_in_the_folder() {
        let temp = crate::testing::TempDir::new("page-files-ops");
        let root = temp.folder("notes");
        fs::create_dir_all(root.join(".git")).unwrap();
        mkdir(&root, &root.join(".git/epicenter/scratch")).unwrap();
        assert!(write_file(&root, &root.join(".git/epicenter"), b"x", false).is_err());
        assert!(mkdir(&root, &root.join(".git/epicenter/no-hooks")).is_err());
        mkdir(&root, &root.join("todos")).unwrap();
        // A data path is never written; only new private files are.
        for create_new in [true, false] {
            assert!(write_file(&root, &root.join("todos/a.md"), b"a", create_new).is_err());
        }
        assert!(!root.join("todos/a.md").exists());
        let staged = root.join(".git/epicenter/scratch/s");
        assert!(write_file(&root, &staged, b"b", false).is_err());
        write_file(&root, &staged, b"b", true).unwrap();
        assert!(write_file(&root, &staged, b"c", true).is_err());
        rename(&root, &staged, &root.join("todos/a.md")).unwrap();
        assert_eq!(fs::read(root.join("todos/a.md")).unwrap(), b"b");
        let index = root.join(".git/index.tmp-1");
        write_file(&root, &index, b"i", true).unwrap();
        remove(&root, &index, false).unwrap();
        assert!(rename(
            &root,
            &root.join("todos/a.md"),
            &root.join(".git/epicenter/scratch/t")
        )
        .is_err());
        assert!(remove(&root, &root.join("todos"), true).is_err());
        remove(&root, &root.join("todos/a.md"), false).unwrap();
        remove(&root, &root.join("todos"), false).unwrap();
        assert!(!root.join("todos").exists());
    }
}
