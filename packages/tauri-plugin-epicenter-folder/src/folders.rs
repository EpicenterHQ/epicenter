//! One owner for live window bindings and their shared directory watches.
//!
//! Membership and watcher insertion/removal take the same lock. Reports,
//! directory resolution, and watcher destruction run outside that lock.

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter, Runtime};

use crate::watcher::{self, FolderChanged, Report, Watch, FOLDER_CHANGED_EVENT};
use crate::Directory;

/// The shell's live window bindings and file watches. Reached with `app.folders()`.
#[derive(Default)]
pub struct Folders {
    shared: Arc<Shared>,
}

#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    stopping: Condvar,
}

#[derive(Default)]
struct State {
    bindings: HashMap<String, Directory>,
    watches: BTreeMap<PathBuf, Watch>,
    stopped: bool,
    clock_started: bool,
}

impl State {
    fn has_root(&self, root: &Path) -> bool {
        self.bindings
            .values()
            .any(|directory| directory.root() == root)
    }
}

impl Shared {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Folders {
    /// Bind once for the window's lifetime, before its WebView exists.
    pub(crate) fn bind(&self, label: &str, directory: Directory) -> Result<(), BindError> {
        let mut state = self.shared.state();
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

    /// Bind before building the window. A failed build releases the binding
    /// and any watch its page already started, so the label can be tried again.
    pub fn bind_while_building<T, E: From<BindError>>(
        &self,
        label: &str,
        directory: Directory,
        build: impl FnOnce() -> Result<T, E>,
    ) -> Result<T, E> {
        self.bind(label, directory)?;
        build().inspect_err(|_| self.unbind(label))
    }

    /// Remove a destroyed or failed window and its root's last watch.
    /// Dropping a native watcher can wait for a worker; never drop it locked.
    pub(crate) fn unbind(&self, label: &str) {
        let released = {
            let mut state = self.shared.state();
            let Some(directory) = state.bindings.remove(label) else {
                return;
            };
            if state.has_root(directory.root()) {
                return;
            }
            state.watches.remove(directory.root())
        };
        drop(released);
    }

    /// Clone the calling window's directory once per admitted operation.
    /// Work already admitted keeps it after the window closes or shutdown begins.
    pub fn bound(&self, label: &str) -> Result<Directory, WindowError> {
        let state = self.shared.state();
        if state.stopped {
            return Err(WindowError::ShuttingDown);
        }
        state
            .bindings
            .get(label)
            .cloned()
            .ok_or(WindowError::NotBound)
    }

    /// Refuse new bindings and commands, stop watches, and wake the clock.
    /// Work already admitted is not waited for (ADR-0542).
    pub fn shutdown(&self) {
        let watches = {
            let mut state = self.shared.state();
            state.stopped = true;
            std::mem::take(&mut state.watches)
        };
        self.shared.stopping.notify_all();
        drop(watches);
    }

    /// Start one watch for an opened root while it has a bound window.
    /// A late open after the last window closes starts nothing. Failure to
    /// watch leaves the folder open, with the problem recorded in the log.
    pub(crate) fn watch<R: Runtime>(&self, app: &AppHandle<R>, root: &Path) {
        let mut state = self.shared.state();
        if state.stopped || state.watches.contains_key(root) || !state.has_root(root) {
            return;
        }
        let report = changed_reporter(app.clone(), root.to_path_buf());
        let watch = match watcher::start(root, Arc::clone(&report)) {
            Ok(watch) => watch,
            Err(message) => {
                log::warn!("the folder '{}' is not watched: {message}", root.display());
                return;
            }
        };
        state.watches.insert(root.to_path_buf(), watch);
        if !state.clock_started {
            state.clock_started = true;
            let shared = Arc::clone(&self.shared);
            // A failed clock thread does not prevent filesystem notifications.
            let _ = std::thread::Builder::new()
                .name("epicenter-folder-clock".to_string())
                .spawn(move || keep_time(&shared));
        }
        drop(state);
        report(None);
    }

    /// Snapshot recipients before emitting; event handlers must not run locked.
    fn labels_on(&self, root: &Path) -> Vec<String> {
        self.shared
            .state()
            .bindings
            .iter()
            .filter(|(_, directory)| directory.root() == root)
            .map(|(label, _)| label.clone())
            .collect()
    }
}

/// Window-scoped listeners filter these reports; global listeners also hear them.
fn changed_reporter<R: Runtime>(app: AppHandle<R>, root: PathBuf) -> Report {
    use crate::FolderExt;
    Arc::new(move |paths| {
        let change = FolderChanged { paths };
        for label in app.folders().labels_on(&root) {
            let _ = app.emit_to(label.as_str(), FOLDER_CHANGED_EVENT, &change);
        }
    })
}

const CLOCK_TICK: Duration = Duration::from_secs(5);
const SLEEP_GAP: Duration = Duration::from_secs(30);

/// A wake can leave native notifications incomplete. Report every watched
/// root after a large wall-clock jump, taking no state lock during callbacks.
fn keep_time(shared: &Shared) {
    let mut last = SystemTime::now();
    let mut state = shared.state();
    loop {
        if state.stopped {
            return;
        }
        state = shared
            .stopping
            .wait_timeout(state, CLOCK_TICK)
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .0;
        if state.stopped {
            return;
        }
        let now = SystemTime::now();
        let slept = woke(last, now);
        last = now;
        if slept {
            let reports: Vec<Report> = state
                .watches
                .values()
                .map(|watch| Arc::clone(&watch.report))
                .collect();
            drop(state);
            for report in reports {
                report(None);
            }
            state = shared.state();
        }
    }
}

fn woke(last: SystemTime, now: SystemTime) -> bool {
    match now.duration_since(last) {
        Ok(elapsed) => elapsed > CLOCK_TICK + SLEEP_GAP,
        Err(_) => true,
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_a_jump_of_the_wall_clock_counts_as_a_sleep() {
        let last = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        assert!(!woke(last, last + CLOCK_TICK));
        assert!(!woke(last, last + CLOCK_TICK + Duration::from_secs(1)));
        assert!(woke(
            last,
            last + CLOCK_TICK + SLEEP_GAP + Duration::from_secs(1)
        ));
        assert!(woke(last, last + Duration::from_secs(3_600)));
        assert!(woke(last, last - Duration::from_secs(60)));
    }
}
