//! Live window-to-directory bindings. Each command keeps its admitted directory.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use specta::Type;

use crate::Directory;

/// The shell's live window bindings. Reached with `app.folders()`.
#[derive(Default)]
pub struct Folders {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    bindings: HashMap<String, Directory>,
    stopped: bool,
}

impl Folders {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Bind once for the window's lifetime, before its WebView exists.
    pub(crate) fn bind(&self, label: &str, directory: Directory) -> Result<(), BindError> {
        let mut state = self.state();
        if state.stopped {
            return Err(BindError::ShuttingDown);
        }
        if state.bindings.contains_key(label) {
            return Err(BindError::Bound {
                label: label.to_string(),
            });
        }
        state.bindings.insert(label.to_string(), directory);
        Ok(())
    }

    /// Bind before building the window; release the binding if construction fails.
    pub fn bind_while_building<T, E: From<BindError>>(
        &self,
        label: &str,
        directory: Directory,
        build: impl FnOnce() -> Result<T, E>,
    ) -> Result<T, E> {
        self.bind(label, directory)?;
        build().inspect_err(|_| self.unbind(label))
    }

    /// Remove a destroyed or failed window's binding.
    pub(crate) fn unbind(&self, label: &str) {
        self.state().bindings.remove(label);
    }

    /// Clone the calling window's directory once per admitted operation.
    /// Work already admitted keeps it after the window closes or shutdown begins.
    pub fn bound(&self, label: &str) -> Result<Directory, WindowError> {
        let state = self.state();
        if state.stopped {
            return Err(WindowError::ShuttingDown);
        }
        state
            .bindings
            .get(label)
            .cloned()
            .ok_or(WindowError::NotBound)
    }

    /// Refuse new bindings and commands without waiting for admitted work (ADR-0542).
    pub fn shutdown(&self) {
        self.state().stopped = true;
    }
}

/// Why a window was not bound.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindError {
    /// The label is bound already; a live window's folder never changes.
    Bound { label: String },
    /// The shell is shutting its folders down.
    ShuttingDown,
}

impl fmt::Display for BindError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Bound { label } => {
                write!(formatter, "The window '{label}' already has a folder.")
            }
            Self::ShuttingDown => formatter.write_str("The folders are shutting down."),
        }
    }
}

impl std::error::Error for BindError {}

/// Why the calling window's folder could not be used: what the page is told.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "name")]
pub enum WindowError {
    /// The shell bound no folder to this window.
    NotBound,
    /// The bound directory is gone; it is never created again for the window.
    Missing,
    /// The bound directory could not be reached.
    Unavailable { message: String },
    /// The shell is shutting its folders down.
    ShuttingDown,
}

impl fmt::Display for WindowError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotBound => formatter.write_str("This window has no folder."),
            Self::Missing => formatter.write_str("This window's folder is not there anymore."),
            Self::Unavailable { message } => formatter.write_str(message),
            Self::ShuttingDown => formatter.write_str("The folders are shutting down."),
        }
    }
}
