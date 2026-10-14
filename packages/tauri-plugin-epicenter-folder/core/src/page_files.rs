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
//! - a file the shell declared the page may write (`FolderConfig::page_files`,
//!   glob patterns relative to the root, such as `todos/*.md`), or a
//!   directory on the way to one. No component may start with a dot, be a
//!   Windows short name such as `GIT~1`, or be named `HEAD`, so no nested
//!   repository, bare or not, can be assembled even under a broad pattern;
//! - inside `.git`, the folder engine's staging directory
//!   `.git/epicenter/scratch` and its files, and the private index copies
//!   `.git/index.tmp-*` that `git write-tree` reads.
//!
//! Every name is compared component by component, `.git` and its parts
//! case-insensitively, so on a disk that ignores case `.GIT/Hooks/x` is
//! refused as `.git/hooks/x` would be. Git objects are never written here: the
//! engine stores them with `git hash-object -w` (`page_git`), which names and
//! checks them itself. A file is replaced by a staged copy renamed over it,
//! so an existing hard link is replaced, never written through. A link
//! another program swaps in between the check and the change is not
//! defended against; a page cannot make one.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// What a path is to a page that changes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// A file the shell declared the page may write.
    File,
    /// A directory on the way to a declared file.
    Directory,
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

/// A Windows short name such as `GIT~1`, which can name `.git` itself.
fn is_short_name(name: &str) -> bool {
    name.as_bytes()
        .windows(2)
        .any(|pair| pair[0] == b'~' && pair[1].is_ascii_digit())
}

/// A code point HFS+ ignores when it compares names, or that Unicode marks
/// default-ignorable: a name holding one can resolve to a name without it.
fn is_ignorable(c: char) -> bool {
    matches!(u32::from(c),
        0x00AD | 0x034F | 0x061C | 0x115F..=0x1160 | 0x17B4..=0x17B5
        | 0x180B..=0x180F | 0x200B..=0x200F | 0x202A..=0x202E
        | 0x2060..=0x206F | 0x3164 | 0xFE00..=0xFE0F | 0xFEFF | 0xFFA0
        | 0xFFF0..=0xFFF8 | 0x1BCA0..=0x1BCA3 | 0x1D173..=0x1D17A
        | 0xE0000..=0xE0FFF)
}

/// A name Windows reserves for a device, with or without an extension.
fn is_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && (stem.as_bytes()[3].is_ascii_digit()
                || ["¹", "²", "³"].iter().any(|digit| stem.ends_with(digit))))
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && ["¹", "²", "³"].iter().any(|digit| stem == format!("{}{digit}", &stem[..3])))
}

/// Whether `name` means only itself on every disk the folder can live on.
/// A name Windows rewrites (a trailing dot or space, a `:` stream, a device
/// name, a short name, a character it forbids) or that HFS+ compares without
/// an ignorable character could resolve to another entry, `.git` among them.
fn names_only_itself(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.ends_with(['.', ' '])
        && !name
            .chars()
            .any(|c| c.is_control() || matches!(c, ':' | '<' | '>' | '"' | '|' | '?' | '*' | '\\' | '/') || is_ignorable(c))
        && !is_device_name(name)
        && !is_short_name(name)
}

/// A name the engine itself gives a staged file or an index copy.
fn is_plain(name: &str) -> bool {
    names_only_itself(name)
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn glob_options() -> glob::MatchOptions {
    glob::MatchOptions {
        case_sensitive: true,
        require_literal_separator: true,
        require_literal_leading_dot: true,
    }
}

/// Directories on the way to the files `patterns` declare: each pattern's
/// leading components that hold no pattern syntax.
fn declared_directories(patterns: &[String]) -> Vec<Vec<String>> {
    let mut directories = Vec::new();
    for pattern in patterns {
        let parts: Vec<&str> = pattern.split('/').collect();
        let mut prefix = Vec::new();
        for part in &parts[..parts.len().saturating_sub(1)] {
            if part.contains(['*', '?', '[', ']']) {
                break;
            }
            prefix.push(part.to_string());
            directories.push(prefix.clone());
        }
    }
    directories
}

fn classify_parts(parts: &[String], patterns: &[String]) -> Option<Kind> {
    if !parts.iter().all(|part| names_only_itself(part)) {
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
    if parts.is_empty()
        || parts.iter().any(|part| {
            part.starts_with('.') || is_short_name(part) || part.eq_ignore_ascii_case("head")
        })
    {
        return None;
    }
    let relative = parts.join("/");
    if patterns.iter().any(|pattern| {
        glob::Pattern::new(pattern)
            .is_ok_and(|pattern| pattern.matches_with(&relative, glob_options()))
    }) {
        return Some(Kind::File);
    }
    if declared_directories(patterns)
        .iter()
        .any(|directory| directory == parts)
    {
        return Some(Kind::Directory);
    }
    None
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
fn classify(root: &Path, patterns: &[String], path: &Path) -> Result<(Kind, PathBuf), String> {
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
    let kind = classify_parts(&parts, patterns).ok_or_else(|| {
        refused(path, "the shell lets this page change only its declared files")
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

static STAGED: AtomicU64 = AtomicU64::new(0);

/// Write `bytes` to `path`; with `create_new`, refuse a path that exists. A
/// declared file's bytes are staged under `.git/epicenter/scratch` and
/// renamed (or, for a new file, linked) into place.
pub fn write_file(
    root: &Path,
    patterns: &[String],
    path: &Path,
    bytes: &[u8],
    create_new: bool,
) -> Result<(), String> {
    let (kind, target) = classify(root, patterns, path)?;
    expect(kind, &[Kind::File, Kind::Staged, Kind::IndexCopy], path)?;
    let failed =
        |cause: std::io::Error| format!("'{}' could not be written: {cause}", target.display());
    if kind != Kind::File {
        // The engine's own private files: plain writes in `.git`.
        let mut options = fs::OpenOptions::new();
        options.write(true);
        if create_new {
            options.create_new(true);
        } else {
            options.create(true).truncate(true);
        }
        return options
            .open(&target)
            .and_then(|mut file| file.write_all(bytes))
            .map_err(failed);
    }
    // The staging directory is checked like any page path: made only where
    // no link is on the way, and the staged file too.
    let scratch = root.join(".git").join("epicenter").join("scratch");
    mkdir(root, patterns, &scratch)?;
    let staged = scratch.join(format!(
        "rust-{}-{}",
        std::process::id(),
        STAGED.fetch_add(1, Ordering::SeqCst)
    ));
    let (staged_kind, staged) = classify(root, patterns, &staged)?;
    expect(staged_kind, &[Kind::Staged], &staged)?;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staged)
        .and_then(|mut file| file.write_all(bytes))
        .map_err(failed)?;
    let published = if create_new {
        fs::hard_link(&staged, &target).and_then(|()| fs::remove_file(&staged))
    } else {
        fs::rename(&staged, &target)
    };
    if published.is_err() {
        let _ = fs::remove_file(&staged);
    }
    published.map_err(failed)
}

/// Rename `from` over `to`: a staged file into a declared file, or within
/// the declared files.
pub fn rename(root: &Path, patterns: &[String], from: &Path, to: &Path) -> Result<(), String> {
    let (source_kind, source) = classify(root, patterns, from)?;
    let (target_kind, target) = classify(root, patterns, to)?;
    expect(source_kind, &[Kind::File, Kind::Staged], from)?;
    expect(target_kind, &[Kind::File, Kind::Staged], to)?;
    if source_kind == Kind::File && target_kind == Kind::Staged {
        return Err(refused(to, "a declared file is not moved into staging"));
    }
    fs::rename(&source, &target).map_err(|cause| {
        format!(
            "'{}' could not be moved to '{}': {cause}",
            source.display(),
            target.display()
        )
    })
}

/// Remove a declared file, an empty declared directory, a staged file, or a
/// private index copy. A directory's contents are never removed with it.
pub fn remove(root: &Path, patterns: &[String], path: &Path, recursive: bool) -> Result<(), String> {
    let (kind, target) = classify(root, patterns, path)?;
    expect(
        kind,
        &[Kind::File, Kind::Directory, Kind::Staged, Kind::IndexCopy],
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

/// Make the directory at `path` and any missing ancestors, each one a
/// declared directory or the engine's staging directory on its way.
pub fn mkdir(root: &Path, patterns: &[String], path: &Path) -> Result<(), String> {
    let (kind, target) = classify(root, patterns, path)?;
    expect(kind, &[Kind::Directory, Kind::Scratch], path)?;
    let relative = target.strip_prefix(root).expect("checked under the root");
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        if fs::symlink_metadata(&current).is_ok() {
            continue;
        }
        let (kind, _) = classify(root, patterns, &current)?;
        expect(
            kind,
            &[Kind::Directory, Kind::Scratch, Kind::Epicenter],
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

    fn todos() -> Vec<String> {
        vec![
            "epicenter.json".into(),
            "kv.json".into(),
            "todos/*.md".into(),
        ]
    }

    fn may(root: &Path, relative: &str) -> bool {
        classify(root, &todos(), &root.join(relative)).is_ok()
    }

    #[test]
    fn a_page_changes_its_declared_files_and_the_engines_own_git_files_only() {
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
            ".gitignore",
            ".DS_Store",
            "todos/../.git/config",
            "todos/.hidden.md",
            "todos/.git/config",
            "todos/HEAD",
            "todos/head",
            "todos/objects/x",
            "todos/config",
            "todos/notes.txt",
            "todos/sub/a.md",
            "GIT~1/hooks/post-commit",
            "todos/NOTES~1.md",
            "other.md",
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
        assert!(classify(&root, &todos(), &temp.path().join("outside.md")).is_err());
        // Even a pattern that reaches everything assembles no repository.
        let all = vec!["**".to_string()];
        for refused in ["todos/HEAD", "todos/.git/config", "x/Head"] {
            assert!(
                classify(&root, &all, &root.join(refused)).is_err(),
                "{refused}"
            );
        }
    }

    /// Every path the folder engine changed in its real-Git tests
    /// (`packages/folder/src/directory-folder.test.ts`, which keeps the
    /// fixture current) is one a page with Todos' declared files may change.
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

    #[cfg(unix)]
    #[test]
    fn a_link_on_the_way_refuses_the_change() {
        let temp = crate::testing::TempDir::new("page-files-link");
        let root = temp.folder("notes");
        fs::create_dir_all(root.join(".git")).unwrap();
        let elsewhere = temp.folder("elsewhere");
        std::os::unix::fs::symlink(root.join(".git"), root.join("todos")).unwrap();
        let patterns = todos();
        assert!(write_file(&root, &patterns, &root.join("todos/config.md"), b"x", false).is_err());
        assert!(!root.join(".git/config.md").exists());
        let other = temp.folder("other");
        fs::create_dir_all(other.join(".git")).unwrap();
        std::os::unix::fs::symlink(&elsewhere, other.join("todos")).unwrap();
        assert!(write_file(&other, &patterns, &other.join("todos/a.md"), b"x", false).is_err());
        assert!(fs::read_dir(&elsewhere).unwrap().next().is_none());
        assert!(mkdir(&other, &patterns, &other.join("todos")).is_err());
    }

    #[test]
    fn a_root_written_with_a_trailing_separator_still_holds_its_files() {
        let temp = crate::testing::TempDir::new("page-files-roots");
        let root = temp.folder("notes");
        let slashed = PathBuf::from(format!("{}/", root.display()));
        assert!(classify(&slashed, &todos(), &root.join("todos/a.md")).is_ok());
        assert!(classify(&slashed, &todos(), &root.join("todos/.git/config")).is_err());
        // A sibling whose name extends the root's is outside it.
        let sibling = PathBuf::from(format!("{}2/todos/a.md", root.display()));
        assert!(classify(&root, &todos(), &sibling).is_err());
        assert!(classify(&slashed, &todos(), &sibling).is_err());
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
            fs::create_dir_all(root.join("todos")).unwrap();
            assert!(
                write_file(&root, &todos(), &root.join("todos/a.md"), b"x", false).is_err(),
                "{linked}"
            );
            assert!(!root.join("todos/a.md").exists());
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
        fs::hard_link(&outside, root.join("todos/a.md")).unwrap();
        write_file(&root, &todos(), &root.join("todos/a.md"), b"mine", false).unwrap();
        assert_eq!(fs::read(&outside).unwrap(), b"theirs");
        assert_eq!(fs::read(root.join("todos/a.md")).unwrap(), b"mine");
    }

    #[test]
    fn writes_renames_removals_and_directories_land_in_the_folder() {
        let temp = crate::testing::TempDir::new("page-files-ops");
        let root = temp.folder("notes");
        let patterns = todos();
        fs::create_dir_all(root.join(".git")).unwrap();
        mkdir(&root, &patterns, &root.join(".git/epicenter/scratch")).unwrap();
        assert!(write_file(&root, &patterns, &root.join(".git/epicenter"), b"x", false).is_err());
        assert!(mkdir(&root, &patterns, &root.join(".git/epicenter/no-hooks")).is_err());
        mkdir(&root, &patterns, &root.join("todos")).unwrap();
        write_file(&root, &patterns, &root.join("todos/a.md"), b"a", true).unwrap();
        assert!(write_file(&root, &patterns, &root.join("todos/a.md"), b"b", true).is_err());
        let staged = root.join(".git/epicenter/scratch/s");
        write_file(&root, &patterns, &staged, b"b", true).unwrap();
        rename(&root, &patterns, &staged, &root.join("todos/a.md")).unwrap();
        assert_eq!(fs::read(root.join("todos/a.md")).unwrap(), b"b");
        assert!(rename(
            &root,
            &patterns,
            &root.join("todos/a.md"),
            &root.join(".git/epicenter/scratch/t")
        )
        .is_err());
        assert!(remove(&root, &patterns, &root.join("todos"), true).is_err());
        remove(&root, &patterns, &root.join("todos/a.md"), false).unwrap();
        remove(&root, &patterns, &root.join("todos"), false).unwrap();
        assert!(!root.join("todos").exists());
    }
}
