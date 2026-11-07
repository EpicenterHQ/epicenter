//! An existing, canonical directory.
//!
//! The shell prepares a fixed default or resolves a chosen directory before
//! binding it to a window: a real directory, not a link to one, created
//! first only for a default, and resolved once. An admitted operation
//! retains its own clone, so later window destruction or label reuse cannot
//! redirect its work.
//!
//! What `.git` is, if anything, does not matter here, as it does not to the
//! Bun store (`device/node-store.ts` in `@epicenter/folder`): no `.git`, a
//! `.git` file or link (a linked worktree or submodule), and a repository
//! all open and save alike, since a save stages in the root's `.epicenter`
//! and the shell runs no Git. Epicenter never syncs a folder Git keeps
//! (ADR-0822); that is the platform's to say, not the store's.

use std::fmt;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// An existing directory, resolved once to its canonical root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Directory(Arc<PathBuf>);

impl Directory {
    /// Resolve a directory selected by the person. Nothing is created; a
    /// missing directory, a file, or a link is refused. Its parent may be a link.
    pub fn existing(path: &Path) -> Result<Self, DirectoryError> {
        Self::open(path, false)
    }

    /// Prepare a fixed default computed by the shell, creating it and its
    /// parents when missing. Existing files are left as they are.
    pub fn create(path: &Path) -> Result<Self, DirectoryError> {
        Self::open(path, true)
    }

    /// `path` as a real directory, created first with its parents when
    /// `create` is set. Its parent may be a link a person chose; `path`
    /// itself must be a directory, not a link to one, so the folder never
    /// resolves outside where the shell put it.
    ///
    /// On Windows the root is a plain drive or share path (`C:\notes`), not
    /// the `\\?\C:\notes` form `fs::canonicalize` gives: a page's paths,
    /// joined with `/`, are resolved under it, and under `\\?\` Windows reads
    /// `/` as part of a name, not a separator. `dunce` keeps the `\\?\` form
    /// only for a path that cannot be written without it.
    fn open(path: &Path, create: bool) -> Result<Self, DirectoryError> {
        let unavailable = |message: String| DirectoryError::Unavailable { message };
        if create {
            let made = path
                .parent()
                .map_or(Ok(()), fs::create_dir_all)
                .and_then(|()| match fs::create_dir(path) {
                    Err(cause) if cause.kind() == ErrorKind::AlreadyExists => Ok(()),
                    result => result,
                });
            made.map_err(|cause| {
                unavailable(format!(
                    "The folder directory '{}' could not be created: {cause}",
                    path.display()
                ))
            })?;
        }
        let kind = match fs::symlink_metadata(path) {
            Ok(stats) => stats.file_type(),
            Err(cause) if cause.kind() == ErrorKind::NotFound => {
                return Err(DirectoryError::Missing {
                    path: path.to_path_buf(),
                })
            }
            Err(cause) => {
                return Err(unavailable(format!(
                    "The folder directory '{}' could not be inspected: {cause}",
                    path.display()
                )))
            }
        };
        if kind.is_symlink() || !kind.is_dir() {
            return Err(unavailable(format!(
                "The folder directory '{}' is a link or not a directory, so it was not opened",
                path.display()
            )));
        }
        let root = dunce::canonicalize(path).map_err(|cause| {
            unavailable(format!(
                "The native folder root '{}' could not be resolved: {cause}",
                path.display()
            ))
        })?;
        Ok(Self(Arc::new(root)))
    }

    /// The canonical root, an absolute path.
    pub fn root(&self) -> &Path {
        self.0.as_path()
    }
}

/// Why a path could not become a `Directory`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DirectoryError {
    /// Nothing is there, and it was not to be created.
    Missing { path: PathBuf },
    /// It could not be created or inspected, it is a link, or it is not a directory.
    Unavailable { message: String },
}

impl fmt::Display for DirectoryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing { path } => {
                write!(formatter, "The folder '{}' is not there.", path.display())
            }
            Self::Unavailable { message } => formatter.write_str(message),
        }
    }
}

impl std::error::Error for DirectoryError {}
