//! Reads a page makes in a folder it opens with its own engine.
//!
//! A read may name the root or anything beneath it, `.git` included: the
//! engine looks at its staging directory and Git's files. The path is
//! checked as a change's is (`page_files`), without the rule for what a
//! change may touch: it must be the root or under it with no `.`, `..`, or
//! empty name, and no existing component on the way to it may be a link.
//! The final component may be one: `read_dir` and `lstat` report it as a
//! link and never follow it, and `read_dir` and `read_file` refuse to read
//! through it. A link another program swaps in between the check and the
//! read is not defended against, as for a change.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use specta::Type;

use crate::page_files::{linked, relative_parts};

/// What one entry is, without following a link.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Directory,
    Link,
    /// Anything else, such as a socket or a device.
    Other,
}

impl EntryKind {
    fn of(kind: fs::FileType) -> Self {
        if kind.is_symlink() {
            Self::Link
        } else if kind.is_file() {
            Self::File
        } else if kind.is_dir() {
            Self::Directory
        } else {
            Self::Other
        }
    }
}

/// One name in a directory and what it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct DirectoryEntry {
    pub name: String,
    pub kind: EntryKind,
}

/// What a path is, without following a final link.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct PathInfo {
    pub kind: EntryKind,
    /// The size in bytes. Typed for the page as a plain `number`, which
    /// holds every size below 2^53 exactly; specta refuses a `u64` as such.
    #[specta(type = u32)]
    pub size: u64,
    /// The Unix mode, file type bits included, or `None` off Unix.
    pub mode: Option<u32>,
}

fn refused(path: &Path, why: &str) -> String {
    format!("'{}' is not one this page may read: {why}", path.display())
}

/// The names of `path` below `root`, none for the root itself, and its full
/// path, if a page may read it.
fn reading(root: &Path, path: &Path) -> Result<(Vec<String>, PathBuf), String> {
    let raw = path
        .to_str()
        .ok_or_else(|| refused(path, "its name is not text"))?;
    let base = root
        .to_str()
        .ok_or_else(|| refused(path, "the folder's path is not text"))?;
    let at_root = !raw.is_empty()
        && raw.trim_end_matches(['/', '\\']) == base.trim_end_matches(['/', '\\']);
    let parts = if at_root {
        Vec::new()
    } else {
        relative_parts(base, raw).ok_or_else(|| {
            refused(path, "it is outside the folder, or names `.`, `..`, or an empty name")
        })?
    };
    let full = parts.iter().fold(root.to_path_buf(), |full, part| full.join(part));
    Ok((parts, full))
}

/// The entries of the directory at `path`, each without following a link.
/// A name that is not text is left out, as an entry that cannot be read is.
pub fn read_dir(root: &Path, path: &Path) -> Result<Vec<DirectoryEntry>, String> {
    let (parts, full) = reading(root, path)?;
    if linked(root, &parts)? {
        return Err(refused(path, "a link is on its way"));
    }
    let entries = fs::read_dir(&full)
        .map_err(|cause| format!("'{}' could not be listed: {cause}", full.display()))?;
    Ok(entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().into_string().ok()?;
            let kind = entry.file_type().map_or(EntryKind::Other, EntryKind::of);
            Some(DirectoryEntry { name, kind })
        })
        .collect())
}

/// What `path` is, without following it if it is a link, or `None` when
/// nothing is there.
pub fn lstat(root: &Path, path: &Path) -> Result<Option<PathInfo>, String> {
    let (parts, full) = reading(root, path)?;
    if linked(root, parts.split_last().map_or(&[][..], |(_, above)| above))? {
        return Err(refused(path, "a link is on its way"));
    }
    let metadata = match fs::symlink_metadata(&full) {
        Ok(metadata) => metadata,
        Err(missing) if missing.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(cause) => {
            return Err(format!("'{}' could not be inspected: {cause}", full.display()))
        }
    };
    #[cfg(unix)]
    let mode = Some(std::os::unix::fs::MetadataExt::mode(&metadata));
    #[cfg(not(unix))]
    let mode = None;
    Ok(Some(PathInfo {
        kind: EntryKind::of(metadata.file_type()),
        size: metadata.len(),
        mode,
    }))
}

/// The bytes of the file at `path`.
pub fn read_file(root: &Path, path: &Path) -> Result<Vec<u8>, String> {
    let (parts, full) = reading(root, path)?;
    if linked(root, &parts)? {
        return Err(refused(path, "a link is on its way"));
    }
    fs::read(&full).map_err(|cause| format!("'{}' could not be read: {cause}", full.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(entries: Vec<DirectoryEntry>) -> Vec<(String, EntryKind)> {
        let mut kinds: Vec<_> = entries
            .into_iter()
            .map(|entry| (entry.name, entry.kind))
            .collect();
        kinds.sort_by(|a, b| a.0.cmp(&b.0));
        kinds
    }

    #[test]
    fn a_page_reads_anything_under_its_root_git_state_included() {
        let temp = crate::testing::TempDir::new("page-reads");
        let root = temp.folder("notes");
        fs::create_dir_all(root.join(".git/epicenter/scratch")).unwrap();
        fs::create_dir_all(root.join("todos")).unwrap();
        fs::write(root.join("todos/a.md"), b"first\n").unwrap();
        fs::write(root.join(".git/HEAD"), b"ref: refs/heads/main\n").unwrap();

        assert_eq!(
            kinds(read_dir(&root, &root).unwrap()),
            [(".git".to_string(), EntryKind::Directory), ("todos".to_string(), EntryKind::Directory)]
        );
        assert_eq!(
            kinds(read_dir(&root, &root.join("todos")).unwrap()),
            [("a.md".to_string(), EntryKind::File)]
        );
        assert_eq!(read_file(&root, &root.join("todos/a.md")).unwrap(), b"first\n");
        assert_eq!(
            read_file(&root, &root.join(".git/HEAD")).unwrap(),
            b"ref: refs/heads/main\n"
        );
        let info = lstat(&root, &root.join("todos/a.md")).unwrap().unwrap();
        assert_eq!(info.kind, EntryKind::File);
        assert_eq!(info.size, 6);
        #[cfg(unix)]
        assert_eq!(info.mode.unwrap() & 0o170000, 0o100000);
        assert_eq!(
            lstat(&root, &root).unwrap().unwrap().kind,
            EntryKind::Directory
        );
        // The root written with a trailing separator, and either separator
        // below it.
        assert!(read_dir(&root, Path::new(&format!("{}/", root.display()))).is_ok());
        assert!(lstat(&root, Path::new(&format!("{}\\todos", root.display())))
            .unwrap()
            .is_some());
    }

    #[test]
    fn a_missing_path_is_none_to_lstat_and_an_error_to_a_read() {
        let temp = crate::testing::TempDir::new("page-reads-missing");
        let root = temp.folder("notes");
        assert_eq!(lstat(&root, &root.join("todos/a.md")).unwrap(), None);
        assert_eq!(lstat(&root, &root.join("a.md")).unwrap(), None);
        assert!(read_file(&root, &root.join("a.md")).is_err());
        assert!(read_dir(&root, &root.join("todos")).is_err());
    }

    #[test]
    fn a_path_outside_the_root_is_refused() {
        let temp = crate::testing::TempDir::new("page-reads-outside");
        let root = temp.folder("notes");
        let sibling = temp.folder("notes2");
        fs::write(temp.path().join("outside.md"), b"x").unwrap();
        fs::write(sibling.join("a.md"), b"x").unwrap();
        for outside in [
            temp.path().join("outside.md"),
            temp.path().to_path_buf(),
            sibling.join("a.md"),
            PathBuf::from(format!("{}/todos/../../outside.md", root.display())),
            PathBuf::from(format!("{}/./a.md", root.display())),
            PathBuf::from(format!("{}//a.md", root.display())),
            PathBuf::from(""),
        ] {
            assert!(read_file(&root, &outside).is_err(), "{}", outside.display());
            assert!(lstat(&root, &outside).is_err(), "{}", outside.display());
            assert!(read_dir(&root, &outside).is_err(), "{}", outside.display());
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_link_on_the_way_is_refused_and_a_final_link_is_reported_not_followed() {
        let temp = crate::testing::TempDir::new("page-reads-link");
        let root = temp.folder("notes");
        let elsewhere = temp.folder("elsewhere");
        fs::write(elsewhere.join("secret.md"), b"theirs").unwrap();
        std::os::unix::fs::symlink(&elsewhere, root.join("todos")).unwrap();
        std::os::unix::fs::symlink(elsewhere.join("secret.md"), root.join("a.md")).unwrap();

        // Through a link on the way: refused.
        let through = root.join("todos/secret.md");
        assert!(read_file(&root, &through).unwrap_err().contains("link"));
        assert!(lstat(&root, &through).unwrap_err().contains("link"));
        assert!(read_dir(&root, &root.join("todos/")).is_err());

        // The link itself: listed and described as a link.
        assert_eq!(
            kinds(read_dir(&root, &root).unwrap()),
            [("a.md".to_string(), EntryKind::Link), ("todos".to_string(), EntryKind::Link)]
        );
        for link in ["todos", "a.md"] {
            assert_eq!(
                lstat(&root, &root.join(link)).unwrap().unwrap().kind,
                EntryKind::Link,
                "{link}"
            );
        }
        // Reading through the final link is refused.
        assert!(read_file(&root, &root.join("a.md")).is_err());
        assert!(read_dir(&root, &root.join("todos")).is_err());

        // A dangling link is a link, not a missing path.
        std::os::unix::fs::symlink(temp.path().join("gone"), root.join("gone")).unwrap();
        assert_eq!(
            lstat(&root, &root.join("gone")).unwrap().unwrap().kind,
            EntryKind::Link
        );
    }
}
