//! Where a folder's directory is, and whether it can be opened.
//!
//! The shell names a folder's directory when it registers the scope. The
//! first grant makes sure it is a real directory, creating an application
//! folder's when it is missing (`prepare_directory`), resolves it once
//! (`resolve_root`), and refuses a layout whose Git state would send writes
//! elsewhere (`verify_layout`), which the `epicenter` CLI checks again
//! before each history operation (`gitLayoutProblem` in `@epicenter/folder`).
//! Whether a data folder may get a repository of its own is the CLI's
//! question, asked when it would commit (`enclosingRepository`).

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

/// Why a folder's directory could not be made ready.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrepareError {
    /// Nothing is there, and the directory was not to be created.
    Missing,
    /// It could not be created or inspected, or it is a link or not a
    /// directory.
    Failed(String),
}

/// Make sure `root` is a real directory, creating it first when `create` is
/// set. Its parent may be a link a person chose and is created along with
/// it; `root` itself must be a directory, not a link to one, so the folder
/// never resolves outside where the shell put it.
pub fn prepare_directory(root: &Path, create: bool) -> Result<(), PrepareError> {
    let failed = |cause: std::io::Error| {
        PrepareError::Failed(format!(
            "The folder directory '{}' could not be created: {cause}",
            root.display()
        ))
    };
    if create {
        if let Some(parent) = root.parent() {
            fs::create_dir_all(parent).map_err(failed)?;
        }
        match fs::create_dir(root) {
            Ok(()) => {}
            Err(cause) if cause.kind() == ErrorKind::AlreadyExists => {}
            Err(cause) => return Err(failed(cause)),
        }
    }
    let kind = match fs::symlink_metadata(root) {
        Ok(stats) => stats.file_type(),
        Err(cause) if cause.kind() == ErrorKind::NotFound => return Err(PrepareError::Missing),
        Err(cause) => {
            return Err(PrepareError::Failed(format!(
                "The folder directory '{}' could not be inspected: {cause}",
                root.display()
            )))
        }
    };
    if kind.is_symlink() || !kind.is_dir() {
        return Err(PrepareError::Failed(format!(
            "The folder directory '{}' is a link or not a directory, so it was not opened",
            root.display()
        )));
    }
    Ok(())
}

/// Resolve the folder root once, refusing a path that is not a directory.
///
/// On Windows the result is a plain drive or share path (`C:\notes`), not
/// the `\\?\C:\notes` form `fs::canonicalize` gives: the page joins `/` onto
/// the root it is granted, and under `\\?\` Windows reads `/` as part of a
/// name, not a separator. `dunce` keeps the `\\?\` form only for a path that
/// cannot be written without it.
pub fn resolve_root(root: &Path) -> Result<PathBuf, String> {
    let resolved = dunce::canonicalize(root).map_err(|cause| {
        format!(
            "The native folder root '{}' could not be resolved: {cause}",
            root.display()
        )
    })?;
    if !resolved.is_dir() {
        return Err(format!(
            "The native folder root '{}' is not a directory.",
            root.display()
        ));
    }
    Ok(resolved)
}

/// Refuse a root whose Git state would send writes somewhere else:
///
/// - `.git` as a symbolic link or a `gitdir:` file (a linked worktree or
///   submodule);
/// - a `.git/commondir` file, which moves the objects and refs to another
///   repository;
/// - `.git/objects`, `.git/refs`, or `.git/logs` as a link, or a link in
///   `objects` or anywhere in `refs` and `logs`, through which
///   `hash-object -w` and `update-ref` would write outside the folder;
/// - a linked `.git/epicenter` or scratch directory. Scratch files are
///   renamed into the folder, so they must live inside it.
///
/// The grant runs this, and the `epicenter` CLI runs the same check before
/// each history operation, since another program may change `.git` while the
/// folder is open. It does
/// not defend against a link swapped in between that check and the command.
pub fn verify_layout(root: &Path) -> Result<(), String> {
    let refuse = |label: &str, why: &str| {
        format!(
            "The native folder '{}' cannot be opened: {label} {why}.",
            root.display()
        )
    };
    let inspect = |path: &Path, label: &str| match fs::symlink_metadata(path) {
        Ok(stats) => Ok(Some(stats.file_type())),
        Err(cause) if cause.kind() == ErrorKind::NotFound => Ok(None),
        Err(cause) => Err(refuse(label, &format!("could not be inspected: {cause}"))),
    };
    let git = root.join(".git");
    match inspect(&git, ".git")? {
        // No repository yet; `git init` makes one.
        None => return Ok(()),
        Some(kind) if kind.is_symlink() => return Err(refuse(".git", "is a symbolic link")),
        Some(kind) if !kind.is_dir() => {
            return Err(refuse(".git", "is a file that points at another Git directory"))
        }
        Some(_) => {}
    }
    if inspect(&git.join("commondir"), ".git/commondir")?.is_some() {
        return Err(refuse(
            ".git/commondir",
            "exists, so the repository's objects and refs live in another Git directory",
        ));
    }
    // How deep each directory is searched for links: every loose object is
    // a file one level below `objects`, while refs and their logs nest.
    for (name, depth) in [("objects", 1), ("refs", usize::MAX), ("logs", usize::MAX)] {
        refuse_links(&git.join(name), &format!(".git/{name}"), depth, &refuse)?;
    }
    let mut current = git;
    for (name, label) in [
        ("epicenter", ".git/epicenter"),
        ("scratch", ".git/epicenter/scratch"),
    ] {
        current.push(name);
        match inspect(&current, label)? {
            // Nothing below an absent directory exists yet; opening creates it.
            None => return Ok(()),
            Some(kind) if kind.is_symlink() => return Err(refuse(label, "is a symbolic link")),
            Some(kind) if !kind.is_dir() => return Err(refuse(label, "is not a directory")),
            Some(_) => {}
        }
    }
    Ok(())
}

/// Refuse `path` if it is a link, or holds one within `depth` levels.
fn refuse_links(
    path: &Path,
    label: &str,
    depth: usize,
    refuse: &dyn Fn(&str, &str) -> String,
) -> Result<(), String> {
    let kind = match fs::symlink_metadata(path) {
        Ok(stats) => stats.file_type(),
        Err(cause) if cause.kind() == ErrorKind::NotFound => return Ok(()),
        Err(cause) => return Err(refuse(label, &format!("could not be inspected: {cause}"))),
    };
    if kind.is_symlink() {
        return Err(refuse(label, "is a symbolic link"));
    }
    if !kind.is_dir() || depth == 0 {
        return Ok(());
    }
    let entries =
        fs::read_dir(path).map_err(|cause| refuse(label, &format!("could not be read: {cause}")))?;
    for entry in entries {
        let entry = entry.map_err(|cause| refuse(label, &format!("could not be read: {cause}")))?;
        let name = entry.file_name();
        refuse_links(
            &entry.path(),
            &format!("{label}/{}", name.to_string_lossy()),
            depth - 1,
            refuse,
        )?;
    }
    Ok(())
}
