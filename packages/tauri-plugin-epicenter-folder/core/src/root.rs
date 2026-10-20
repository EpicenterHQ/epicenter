//! Where a folder's directory is, and whether it can be opened.
//!
//! The shell names a folder's directory when it registers the scope. The
//! first grant makes sure it is a real directory, creating an application
//! folder's when it is missing (`prepare_directory`), and resolves it once
//! (`resolve_root`). What `.git` is, if anything, does not matter here, as
//! it does not to the Bun host (`localRoot` in `@epicenter/folder`'s
//! `native/directory.ts`): no `.git`, a `.git` file or link (a linked
//! worktree or submodule), and a repository all open and save alike, since
//! a save stages beside the root and the shell runs no Git. Git state that
//! would send history writes elsewhere is the `epicenter` CLI's to refuse,
//! before each history operation (`gitLayoutProblem` in `@epicenter/folder`),
//! as is whether a data folder may get a repository of its own
//! (`enclosingRepository`).

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
