//! Changes a page makes to the files of a folder it opens with its own
//! engine.
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
//!   `.git/index.tmp-*` that `git write-tree` reads. `mkdir` makes `.git`
//!   itself only on the way to scratch, when it is absent: a folder has no
//!   repository until its first commit (ADR-0535), and its first save
//!   stages before that.
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
//!
//! A rename or a removal also carries what the page expects at the path it
//! changes (`Expectation`), and lands only if the path holds that. The caller
//! holds the root's publishing lock and save lock
//! (`registry::PageWork::publishing`) across the check and the change, so no
//! other window's change through the shell, and no save by the Bun host
//! (`@epicenter/folder/bun`, which takes the same save lock), lands between
//! them. Any other program takes no such lock.

use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;

use crate::paths;

/// What a page expects at a path when its rename or removal lands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Expectation {
    /// Nothing is there: a new file, or a move's destination.
    Absent,
    /// A regular file is there, whatever its bytes.
    Present,
    /// A regular file is there whose bytes hash to this SHA-256, in lowercase
    /// hexadecimal.
    Sha256(String),
    /// Whatever is there, or nothing: the page has already decided.
    Any,
}

/// Why a rename or a removal changed nothing. The first three are the path
/// failing the page's `Expectation`; the page reports each as its own
/// refusal rather than as a failure whose outcome is unknown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "name")]
pub enum ChangeError {
    /// The file there does not hash to the expected SHA-256. The hash it
    /// does have is given, or none when no file is there.
    Conflict {
        #[serde(rename = "actualSha256")]
        actual_sha256: Option<String>,
    },
    /// Something is there where nothing was expected.
    Exists,
    /// No file is there where one was expected.
    NotFound,
    /// The change was refused or failed for another reason.
    Failed { message: String },
}

impl From<String> for ChangeError {
    fn from(message: String) -> Self {
        Self::Failed { message }
    }
}

/// A SHA-256 digest in lowercase hexadecimal, as the page writes one.
fn hex(digest: &[u8]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The lowercase hexadecimal SHA-256 of `bytes`.
#[cfg(test)]
fn sha256(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// The lowercase hexadecimal SHA-256 of the file at `target`, streamed so a
/// large file is never held in memory under the publishing mutex.
fn file_sha256(target: &Path) -> std::io::Result<String> {
    let mut hasher = Sha256::new();
    std::io::copy(&mut fs::File::open(target)?, &mut hasher)?;
    Ok(hex(&hasher.finalize()))
}

/// Whether `target` holds what `expected` says. A final link never counts as
/// a file: `classify` has already refused one.
fn check(target: &Path, expected: &Expectation) -> Result<(), ChangeError> {
    if *expected == Expectation::Any {
        return Ok(());
    }
    let found = match fs::symlink_metadata(target) {
        Ok(metadata) => Some(metadata),
        Err(missing) if missing.kind() == ErrorKind::NotFound => None,
        Err(cause) => {
            return Err(format!("'{}' could not be inspected: {cause}", target.display()).into())
        }
    };
    let is_file = found.as_ref().is_some_and(|metadata| metadata.is_file());
    match expected {
        Expectation::Any => Ok(()),
        Expectation::Absent if found.is_none() => Ok(()),
        Expectation::Absent => Err(ChangeError::Exists),
        Expectation::Present if is_file => Ok(()),
        Expectation::Present if found.is_none() => Err(ChangeError::NotFound),
        Expectation::Present => {
            Err(format!("'{}' is not a file", target.display()).into())
        }
        Expectation::Sha256(_) if !is_file => Err(ChangeError::Conflict {
            actual_sha256: None,
        }),
        Expectation::Sha256(expected) => {
            let actual = file_sha256(target).map_err(|cause| {
                format!("'{}' could not be read: {cause}", target.display())
            })?;
            if actual == *expected {
                Ok(())
            } else {
                Err(ChangeError::Conflict {
                    actual_sha256: Some(actual),
                })
            }
        }
    }
}

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
pub(crate) fn relative_parts(base: &str, raw: &str) -> Option<Vec<String>> {
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
    if linked(root, &parts)? {
        return Err(refused(path, "a link is on its way"));
    }
    Ok((kind, root.join(relative)))
}

/// Whether one of `parts`, walked from `root`, is a link. The walk stops at
/// the first that does not exist, since nothing below it does either.
pub(crate) fn linked(root: &Path, parts: &[String]) -> Result<bool, String> {
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

#[cfg(test)]
thread_local! {
    /// How long a test's rename on this thread waits between checking its
    /// destination and renaming onto it, so a race test can show that the
    /// publishing mutex, not luck, keeps another save out of that gap.
    pub(crate) static PAUSE_AFTER_CHECK: std::cell::Cell<std::time::Duration> =
        const { std::cell::Cell::new(std::time::Duration::ZERO) };
}

/// Rename `from` over `to`, if `to` holds what `expected` says: a staged file
/// into a data path, or one data path to another. A refusal leaves both
/// paths as they were; removing a staged source is the page's business. The
/// caller holds the root's publishing lock.
pub fn rename(
    root: &Path,
    from: &Path,
    to: &Path,
    expected: &Expectation,
) -> Result<(), ChangeError> {
    let (source_kind, source) = classify(root, from)?;
    let (target_kind, target) = classify(root, to)?;
    expect(source_kind, &[Kind::Data, Kind::Staged], from)?;
    expect(target_kind, &[Kind::Data, Kind::Staged], to)?;
    if source_kind == Kind::Data && target_kind == Kind::Staged {
        return Err(refused(to, "a data file is not moved into staging").into());
    }
    check(&target, expected)?;
    #[cfg(test)]
    std::thread::sleep(PAUSE_AFTER_CHECK.with(std::cell::Cell::get));
    fs::rename(&source, &target).map_err(|cause| {
        format!(
            "'{}' could not be moved to '{}': {cause}",
            source.display(),
            target.display()
        )
        .into()
    })
}

/// Remove a data file, an empty data directory, a staged file, or a private
/// index copy, if the path holds what `expected` says. A directory's
/// contents are never removed with it. The caller holds the root's
/// publishing lock.
pub fn remove(
    root: &Path,
    path: &Path,
    recursive: bool,
    expected: &Expectation,
) -> Result<(), ChangeError> {
    let (kind, target) = classify(root, path)?;
    expect(
        kind,
        &[Kind::Data, Kind::Staged, Kind::IndexCopy],
        path,
    )?;
    if recursive {
        return Err(refused(path, "a tree is never removed whole").into());
    }
    check(&target, expected)?;
    let metadata = fs::symlink_metadata(&target).map_err(|cause| {
        if cause.kind() == ErrorKind::NotFound {
            return ChangeError::NotFound;
        }
        format!("'{}' could not be removed: {cause}", target.display()).into()
    })?;
    let removed = if metadata.is_dir() {
        fs::remove_dir(&target)
    } else {
        fs::remove_file(&target)
    };
    removed.map_err(|cause| format!("'{}' could not be removed: {cause}", target.display()).into())
}

/// The full path of the data path `relative` in `root`, checked as a change
/// is: the shared path rule, and no link on the way. For a writer beside the
/// engine that names a data file itself, such as a recorder appending to its
/// audio in place.
pub fn data_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let (kind, target) = classify(root, &root.join(relative))?;
    expect(kind, &[Kind::Data], Path::new(relative))?;
    Ok(target)
}

/// Make the directory at `path` and any missing ancestors, each one a data
/// directory or the engine's staging directory on its way.
///
/// Before a folder's first commit there is no repository (ADR-0535): Sync
/// or Save version runs `git init` later. A save stages its bytes first, so
/// on the way to `.git/epicenter/scratch` this makes `.git` itself when it
/// is absent, which is exactly when no repository exists. Nothing else in
/// `.git` is made here: a `.git` that exists, with or without `HEAD`, is
/// walked past, and `git init` fills it in.
pub fn mkdir(root: &Path, path: &Path) -> Result<(), String> {
    let (kind, target) = classify(root, path)?;
    expect(kind, &[Kind::Data, Kind::Scratch], path)?;
    let relative = target.strip_prefix(root).expect("checked under the root");
    let repository = root.join(".git");
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        if fs::symlink_metadata(&current).is_ok() {
            continue;
        }
        // Only the staging directory's path passes through `.git`, so this
        // is the scratch path's first step in a folder with no repository.
        if current != repository {
            let (kind, _) = classify(root, &current)?;
            expect(
                kind,
                &[Kind::Data, Kind::Scratch, Kind::Epicenter],
                &current,
            )?;
        }
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
        assert!(rename(&root, &copy, &root.join("todos/config.md"), &Expectation::Any).is_err());
        assert!(!root.join(".git/config.md").exists());
        let other = temp.folder("other");
        fs::create_dir_all(other.join(".git")).unwrap();
        std::os::unix::fs::symlink(&elsewhere, other.join("todos")).unwrap();
        let copy = staged(&other, "a", b"x");
        assert!(rename(&other, &copy, &other.join("todos/a.md"), &Expectation::Any).is_err());
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
        rename(&root, &copy, &root.join("todos/a.md"), &Expectation::Any).unwrap();
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
        rename(&root, &staged, &root.join("todos/a.md"), &Expectation::Any).unwrap();
        assert_eq!(fs::read(root.join("todos/a.md")).unwrap(), b"b");
        let index = root.join(".git/index.tmp-1");
        write_file(&root, &index, b"i", true).unwrap();
        remove(&root, &index, false, &Expectation::Any).unwrap();
        assert!(rename(
            &root,
            &root.join("todos/a.md"),
            &root.join(".git/epicenter/scratch/t"),
            &Expectation::Any
        )
        .is_err());
        assert!(remove(&root, &root.join("todos"), true, &Expectation::Any).is_err());
        remove(&root, &root.join("todos/a.md"), false, &Expectation::Any).unwrap();
        remove(&root, &root.join("todos"), false, &Expectation::Any).unwrap();
        assert!(!root.join("todos").exists());
    }

    /// Before the first commit makes a repository (ADR-0535), a save stages
    /// its bytes in `.git/epicenter/scratch`, so `.git` is made on the way;
    /// `git init` later fills in the same `.git`. Nothing else in `.git`
    /// becomes reachable.
    #[test]
    fn a_folder_with_no_repository_yet_stages_its_first_save() {
        let temp = crate::testing::TempDir::new("page-files-no-repository");
        let root = temp.folder("notes");
        // `.git` is made only on the way to scratch, never as a target.
        assert!(mkdir(&root, &root.join(".git")).is_err());
        assert!(mkdir(&root, &root.join(".git/hooks")).is_err());
        assert!(mkdir(&root, &root.join(".git/epicenter/no-hooks")).is_err());
        assert!(!root.join(".git").exists());

        let staged = staged(&root, "first", b"milk");
        rename(&root, &staged, &root.join("todos.md"), &Expectation::Absent).unwrap();
        assert_eq!(fs::read(root.join("todos.md")).unwrap(), b"milk");
        let mut made: Vec<String> = fs::read_dir(root.join(".git"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        made.sort();
        assert_eq!(made, ["epicenter"]);

        // A `.git` with no `HEAD` is still Git's own state everywhere else.
        for refused in [".git/HEAD", ".git/config", ".git/hooks/post-commit"] {
            assert!(
                write_file(&root, &root.join(refused), b"x", true).is_err(),
                "{refused}"
            );
        }
        assert!(mkdir(&root, &root.join(".git/hooks")).is_err());
        assert!(remove(&root, &root.join(".git"), false, &Expectation::Any).is_err());

        // The first commit's `git init` takes over the `.git` the save made.
        let init = std::process::Command::new("git")
            .args(["init", "--quiet", "--initial-branch=main"])
            .current_dir(&root)
            .status()
            .unwrap();
        assert!(init.success());
        assert!(root.join(".git/HEAD").is_file());
        assert!(root.join(".git/epicenter/scratch").is_dir());
    }

    fn folder_with(label: &str, files: &[(&str, &[u8])]) -> (crate::testing::TempDir, PathBuf) {
        let temp = crate::testing::TempDir::new(label);
        let root = temp.folder("notes");
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("todos")).unwrap();
        for (path, bytes) in files {
            fs::write(root.join(path), bytes).unwrap();
        }
        (temp, root)
    }

    #[test]
    fn the_hash_is_the_one_the_page_computes() {
        assert_eq!(
            sha256(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        // A file is hashed as it streams, to the same digest as its bytes.
        let bytes: Vec<u8> = (0..200_000u32).map(|n| (n % 251) as u8).collect();
        let (_temp, root) = folder_with("page-files-hash", &[("todos/big.bin", &bytes)]);
        assert_eq!(file_sha256(&root.join("todos/big.bin")).unwrap(), sha256(&bytes));
    }

    #[test]
    fn a_publishing_rename_lands_only_on_what_the_page_expected() {
        let old = sha256(b"old");
        let (_temp, root) = folder_with("page-files-expect", &[("todos/a.md", b"old")]);
        let a = root.join("todos/a.md");
        let b = root.join("todos/b.md");

        // A create over an existing file is `Exists`; the file is untouched
        // and the staged copy stays for the page to remove.
        let copy = staged(&root, "1", b"new");
        assert_eq!(rename(&root, &copy, &a, &Expectation::Absent), Err(ChangeError::Exists));
        assert_eq!(fs::read(&a).unwrap(), b"old");
        assert!(copy.exists());
        // A replacement of a missing file is `NotFound`, guarded or not.
        assert_eq!(rename(&root, &copy, &b, &Expectation::Present), Err(ChangeError::NotFound));
        assert_eq!(
            rename(&root, &copy, &b, &Expectation::Sha256(old.clone())),
            Err(ChangeError::Conflict { actual_sha256: None })
        );
        assert!(!b.exists());
        // Another hash is `Conflict` with the hash of what is there.
        assert_eq!(
            rename(&root, &copy, &a, &Expectation::Sha256(sha256(b"other"))),
            Err(ChangeError::Conflict { actual_sha256: Some(old.clone()) })
        );
        assert_eq!(fs::read(&a).unwrap(), b"old");
        assert!(copy.exists());
        // The expected hash lands, and so does a move to an absent path.
        rename(&root, &copy, &a, &Expectation::Sha256(old.clone())).unwrap();
        assert_eq!(fs::read(&a).unwrap(), b"new");
        rename(&root, &a, &b, &Expectation::Absent).unwrap();
        // `present` needs a file, and `any` takes whatever is there.
        let copy = staged(&root, "2", b"again");
        rename(&root, &copy, &b, &Expectation::Present).unwrap();
        let copy = staged(&root, "3", b"over");
        rename(&root, &copy, &b, &Expectation::Any).unwrap();
        assert_eq!(fs::read(&b).unwrap(), b"over");
        let copy = staged(&root, "4", b"dir");
        assert!(matches!(
            rename(&root, &copy, &root.join("todos"), &Expectation::Present),
            Err(ChangeError::Failed { .. })
        ));
    }

    #[test]
    fn a_guarded_removal_removes_only_the_expected_bytes() {
        let (_temp, root) = folder_with("page-files-remove", &[("todos/a.md", b"old")]);
        let a = root.join("todos/a.md");
        assert_eq!(
            remove(&root, &a, false, &Expectation::Sha256(sha256(b"other"))),
            Err(ChangeError::Conflict { actual_sha256: Some(sha256(b"old")) })
        );
        assert!(a.exists());
        remove(&root, &a, false, &Expectation::Sha256(sha256(b"old"))).unwrap();
        assert_eq!(remove(&root, &a, false, &Expectation::Present), Err(ChangeError::NotFound));
        assert_eq!(remove(&root, &a, false, &Expectation::Any), Err(ChangeError::NotFound));
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
