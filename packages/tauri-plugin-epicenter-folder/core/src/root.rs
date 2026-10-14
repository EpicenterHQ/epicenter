//! Where a folder's directory is, and whether it can be opened.
//!
//! The shell names a folder's directory when it registers the scope. The
//! first grant makes it exist as a real directory (`prepare_directory`),
//! resolves it once (`resolve_root`), and refuses a layout whose private Git
//! state would send writes elsewhere (`verify_layout`).

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

/// Make `root` exist as a real directory. Its parent may be a link a person
/// chose and is created when missing; `root` itself must be a directory, not
/// a link to one, so the folder never resolves outside where the shell put it.
pub fn prepare_directory(root: &Path) -> Result<(), String> {
    let failed = |cause: std::io::Error| {
        format!("The folder directory '{}' could not be created: {cause}", root.display())
    };
    if let Some(parent) = root.parent() {
        fs::create_dir_all(parent).map_err(failed)?;
    }
    match fs::create_dir(root) {
        Ok(()) => {}
        Err(cause) if cause.kind() == ErrorKind::AlreadyExists => {}
        Err(cause) => return Err(failed(cause)),
    }
    let kind = fs::symlink_metadata(root).map_err(failed)?.file_type();
    if kind.is_symlink() || !kind.is_dir() {
        return Err(format!(
            "The folder directory '{}' is a link or not a directory, so it was not opened",
            root.display()
        ));
    }
    Ok(())
}

/// Resolve the folder root once, refusing a path that is not a directory.
pub fn resolve_root(root: &Path) -> Result<PathBuf, String> {
    let resolved = fs::canonicalize(root).map_err(|cause| {
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

/// Refuse a root whose private Git state would send writes somewhere else:
/// `.git` as a symbolic link or a `gitdir:` file (a linked worktree or
/// submodule), and a linked `.git/epicenter` or scratch directory. Scratch
/// files are renamed into the folder, so they must live inside it.
///
/// This inspects the layout once, when the folder opens. It does not defend
/// against a program that swaps a link in afterward.
pub fn verify_layout(root: &Path) -> Result<(), String> {
    let mut current = root.to_path_buf();
    for (name, label) in [
        (".git", ".git"),
        ("epicenter", ".git/epicenter"),
        ("scratch", ".git/epicenter/scratch"),
    ] {
        current.push(name);
        let stats = match fs::symlink_metadata(&current) {
            Ok(stats) => stats,
            // Nothing below an absent directory exists yet; opening creates it.
            Err(cause) if cause.kind() == ErrorKind::NotFound => return Ok(()),
            Err(cause) => {
                return Err(format!(
                "The native folder '{}' cannot be opened: {label} could not be inspected: {cause}",
                root.display()
            ))
            }
        };
        let kind = stats.file_type();
        if kind.is_symlink() {
            return Err(format!(
                "The native folder '{}' cannot be opened: {label} is a symbolic link.",
                root.display()
            ));
        }
        if !kind.is_dir() {
            return Err(if name == ".git" {
                format!(
                    "The native folder '{}' cannot be opened: .git is a file that points at another Git directory.",
                    root.display()
                )
            } else {
                format!(
                    "The native folder '{}' cannot be opened: {label} is not a directory.",
                    root.display()
                )
            });
        }
    }
    Ok(())
}
