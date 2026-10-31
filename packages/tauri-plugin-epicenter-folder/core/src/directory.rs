//! An existing, canonical directory.
//!
//! The shell prepares a fixed default or resolves a chosen directory before
//! binding it to a window. An admitted operation retains its own clone, so
//! later window destruction or label reuse cannot redirect its work.

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::root::{prepare_directory, resolve_root, PrepareError};

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

    fn open(path: &Path, create: bool) -> Result<Self, DirectoryError> {
        prepare_directory(path, create).map_err(|error| match error {
            PrepareError::Missing => DirectoryError::Missing {
                path: path.to_path_buf(),
            },
            PrepareError::Failed(message) => DirectoryError::Unavailable { message },
        })?;
        let root = resolve_root(path).map_err(|message| DirectoryError::Unavailable { message })?;
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
