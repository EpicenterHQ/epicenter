//! Live window-to-directory bindings. Each command keeps its admitted directory.
//!
//! A binding has one primary directory, fixed for the window's life: its
//! identity, which a page reaches by its exact path like any other root. A
//! page may also open other roots by their exact paths (`open_folder`), each
//! one Tauri's file-system scope allows (`scope`); every root a page opened
//! has its own watch and is reached by its exact path until the window
//! closes. A page always names the root it means: no command falls back to
//! the primary directory.

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use specta::Type;

use crate::watch::{FolderChanged, FolderWatch};
use crate::Directory;

/// The shell's live window bindings. Reached with `app.folders()`.
#[derive(Default)]
pub struct Folders {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    bindings: HashMap<String, Binding>,
    stopped: bool,
    /// The last observation number handed out, by any binding: one number
    /// names one page of one binding, even a binding made again under its
    /// label.
    observations: u64,
}

struct Binding {
    directory: Directory,
    /// Every root a page opened, by its canonical path: the primary when it
    /// was opened, and each other root `open_folder` admitted.
    opened: HashMap<PathBuf, OpenedRoot>,
    retiring: bool,
    /// The current page's observation number (`State::observations`), or 0
    /// before a page reserved one.
    observation: u64,
}

/// A root a page opened: its directory, its one watch, and the page's
/// recipient, replaceable across reloads.
struct OpenedRoot {
    directory: Directory,
    /// Held for the root's life: dropping it stops the watch.
    _watch: FolderWatch,
    report: Report,
}

type Report = Arc<Mutex<Option<Box<dyn Fn(FolderChanged) + Send>>>>;

impl Folders {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Bind `directory` as the window's primary root, once for the window's
    /// lifetime, before its WebView exists.
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
        state.bindings.insert(
            label.to_string(),
            Binding {
                directory,
                opened: HashMap::new(),
                retiring: false,
                observation: 0,
            },
        );
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
        let opened = {
            let mut state = self.state();
            let Some(binding) = state.bindings.get_mut(label) else {
                return;
            };
            if binding.retiring {
                return;
            }
            binding.retiring = true;
            std::mem::take(&mut binding.opened)
        };
        // Keep the retiring label reserved until no old callback can emit to
        // it. Other windows remain available while this callback fence waits.
        drop(opened);
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
            .filter(|binding| !binding.retiring)
            .map(|binding| binding.directory.clone())
            .ok_or(WindowError::NotBound)
    }

    /// The root a page named, cloned for one admitted operation: the primary
    /// directory by its exact path, or a root the page opened by its exact
    /// canonical path. Any other path is `NotGranted`, whatever it contains:
    /// a page opens a root before it reads or writes there.
    pub fn bound_root(&self, label: &str, root: &Path) -> Result<Directory, WindowError> {
        let state = self.state();
        if state.stopped {
            return Err(WindowError::ShuttingDown);
        }
        let binding = state
            .bindings
            .get(label)
            .filter(|binding| !binding.retiring)
            .ok_or(WindowError::NotBound)?;
        if binding.directory.root() == root {
            return Ok(binding.directory.clone());
        }
        binding
            .opened
            .get(root)
            .map(|opened| opened.directory.clone())
            .ok_or_else(|| WindowError::NotGranted {
                root: root.to_string_lossy().into_owned(),
            })
    }

    /// Reserve this page's observation before filesystem setup can block:
    /// the window's primary directory and the observation's number.
    pub(crate) fn reserve_observation(&self, label: &str) -> Result<(Directory, u64), WindowError> {
        let mut state = self.state();
        if state.stopped {
            return Err(WindowError::ShuttingDown);
        }
        state.observations += 1;
        let observation = state.observations;
        let binding = state.bindings.get_mut(label).ok_or(WindowError::NotBound)?;
        if binding.retiring {
            return Err(WindowError::NotBound);
        }
        binding.observation = observation;
        Ok((binding.directory.clone(), observation))
    }

    /// A page started loading in the window: the previous page's recipients
    /// hear nothing more, and its unfinished opens install no watch.
    pub(crate) fn page_started(&self, label: &str) {
        let old: Vec<_> = {
            let mut state = self.state();
            state.observations += 1;
            let observation = state.observations;
            let Some(binding) = state.bindings.get_mut(label) else {
                return;
            };
            binding.observation = observation;
            binding
                .opened
                .values()
                .filter_map(|opened| {
                    opened
                        .report
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .take()
                })
                .collect()
        };
        drop(old);
    }

    /// Start at most one watch for `directory`, a root the page opened, and
    /// record it as opened. A new open of the same root replaces its
    /// recipient, since the window binding outlives a page reload.
    pub(crate) fn watch(
        &self,
        label: &str,
        directory: &Directory,
        observation: u64,
        report: impl Fn(FolderChanged) + Send + 'static,
    ) -> Result<(), WindowError> {
        let mut next_report: Option<Box<dyn Fn(FolderChanged) + Send>> = Some(Box::new(report));
        let root = directory.root().to_path_buf();
        let replace = |recipient: &Report, next: &mut Option<Box<dyn Fn(FolderChanged) + Send>>| {
            recipient
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .replace(next.take().expect("the new recipient"))
        };
        {
            let state = self.state();
            if state.stopped {
                return Err(WindowError::ShuttingDown);
            }
            let binding = state.bindings.get(label).ok_or(WindowError::NotBound)?;
            if binding.retiring || binding.observation != observation {
                return Err(WindowError::NotBound);
            }
            if let Some(opened) = binding.opened.get(&root) {
                let previous = replace(&opened.report, &mut next_report);
                drop(state);
                drop(previous);
                return Ok(());
            }
        }
        // Native recursive setup can walk a large tree. It must never hold the
        // global bindings lock, and remains inactive until installed below.
        let recipient: Report = Arc::new(Mutex::new(None));
        let delivered = recipient.clone();
        let mut candidate = Some(
            FolderWatch::start(directory.root(), move |change| {
                if let Some(report) = delivered
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .as_ref()
                {
                    report(change);
                }
            })
            .map_err(|error| WindowError::Unavailable {
                message: error.to_string(),
            })?,
        );
        let result = {
            let mut state = self.state();
            if state.stopped {
                Err(WindowError::ShuttingDown)
            } else {
                match state.bindings.get_mut(label) {
                    Some(binding) if !binding.retiring && binding.observation == observation => {
                        if let Some(opened) = binding.opened.get(&root) {
                            Ok(replace(&opened.report, &mut next_report))
                        } else {
                            replace(&recipient, &mut next_report);
                            let watch = candidate.take().expect("the uninstalled watch");
                            watch.activate();
                            binding.opened.insert(
                                root,
                                OpenedRoot {
                                    directory: directory.clone(),
                                    _watch: watch,
                                    report: recipient,
                                },
                            );
                            Ok(None)
                        }
                    }
                    _ => Err(WindowError::NotBound),
                }
            }
        };
        // Discard duplicate starts only after releasing the global lock.
        drop(candidate);
        result.map(drop)
    }

    /// Refuse new bindings and commands without waiting for admitted work (ADR-0542).
    pub fn shutdown(&self) {
        let watches = {
            let mut state = self.state();
            state.stopped = true;
            state
                .bindings
                .values_mut()
                .map(|binding| std::mem::take(&mut binding.opened))
                .collect::<Vec<_>>()
        };
        drop(watches);
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
    /// The page named a root Tauri's file-system scope does not allow, or
    /// one it has not opened.
    NotGranted { root: String },
    /// The root is never a folder: why, in one line (`scope::Refusals`).
    Refused { root: String, reason: String },
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
            Self::NotGranted { root } => write!(formatter, "This window may not open {root}."),
            Self::Refused { reason, .. } => formatter.write_str(reason),
        }
    }
}

#[cfg(test)]
impl Folders {
    pub(crate) fn watch_current(
        &self,
        label: &str,
        directory: &Directory,
        report: impl Fn(FolderChanged) + Send + 'static,
    ) -> Result<(), WindowError> {
        let (_, observation) = self.reserve_observation(label)?;
        self.watch(label, directory, observation, report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    };
    use std::time::{Duration, Instant};

    #[test]
    fn native_setup_failure_releases_its_callback_outside_the_global_lock() {
        struct CheckOnDrop(Arc<Folders>, mpsc::Sender<bool>);
        impl Drop for CheckOnDrop {
            fn drop(&mut self) {
                let _ = self.1.send(self.0.state.try_lock().is_ok());
            }
        }
        let root = tempfile::tempdir().unwrap();
        let directory = Directory::existing(root.path()).unwrap();
        let folders = Arc::new(Folders::default());
        folders.bind("main", directory.clone()).unwrap();
        std::fs::remove_dir(root.path()).unwrap();
        let (send, receive) = mpsc::channel();
        let probe = CheckOnDrop(folders.clone(), send);
        assert!(matches!(
            folders.watch_current("main", &directory, move |_| {
                let _ = &probe;
            }),
            Err(WindowError::Unavailable { .. })
        ));
        assert!(receive.recv_timeout(Duration::from_secs(2)).unwrap());
    }

    #[test]
    fn unbind_fences_inflight_emission_before_reusing_the_label_and_keeps_other_windows_available()
    {
        let roots = tempfile::tempdir().unwrap();
        let old = Directory::create(&roots.path().join("old")).unwrap();
        let new = Directory::create(&roots.path().join("new")).unwrap();
        let folders = Arc::new(Folders::default());
        folders.bind("main", old.clone()).unwrap();
        folders.bind("other", new.clone()).unwrap();
        let (entered, entering) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let first = AtomicBool::new(true);
        folders
            .watch_current("main", &old, move |_| {
                if first.swap(false, Ordering::SeqCst) {
                    entered.send(()).unwrap();
                    released.recv().unwrap();
                }
            })
            .unwrap();
        std::fs::write(old.root().join("old.md"), b"old").unwrap();
        entering.recv_timeout(Duration::from_secs(5)).unwrap();
        let (stopped, stopping) = mpsc::channel();
        let unbinding = folders.clone();
        let thread = std::thread::spawn(move || {
            unbinding.unbind("main");
            stopped.send(()).unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        while !folders
            .state()
            .bindings
            .get("main")
            .is_some_and(|binding| binding.retiring)
        {
            assert!(
                Instant::now() < deadline,
                "unbind must reach the callback fence"
            );
            std::thread::yield_now();
        }
        assert!(stopping.try_recv().is_err());
        assert_eq!(folders.bound("other").unwrap(), new);
        assert_eq!(folders.bound("main"), Err(WindowError::NotBound));
        assert!(matches!(
            folders.bind("main", new.clone()),
            Err(BindError::Bound { .. })
        ));
        release.send(()).unwrap();
        // Unbinding drops the watch, and notify's macOS destructor joins its
        // watcher thread: 1.4 to 6.5 s while the rest of this suite watches
        // too, well under a second alone.
        stopping.recv_timeout(Duration::from_secs(30)).unwrap();
        thread.join().unwrap();

        folders.bind("main", new.clone()).unwrap();
        let (send, receive) = mpsc::channel();
        folders
            .watch_current("main", &new, move |event| {
                let _ = send.send(event);
            })
            .unwrap();
        std::fs::write(old.root().join("stale-root.md"), b"stale").unwrap();
        std::fs::write(new.root().join("new.md"), b"new").unwrap();
        let event = receive.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(event
            .paths
            .is_none_or(|paths| paths.iter().all(|path| !path.contains("stale-root"))));
        folders.shutdown();
    }

    #[test]
    fn concurrent_opens_install_only_one_active_watch() {
        let root = tempfile::tempdir().unwrap();
        let directory = Directory::existing(root.path()).unwrap();
        let folders = Arc::new(Folders::default());
        folders.bind("main", directory.clone()).unwrap();
        let (_, observation) = folders.reserve_observation("main").unwrap();
        let start = Arc::new(std::sync::Barrier::new(8));
        let (send, receive) = mpsc::channel();
        let workers: Vec<_> = (0..8)
            .map(|id| {
                let (folders, directory, start, send) = (
                    folders.clone(),
                    directory.clone(),
                    start.clone(),
                    send.clone(),
                );
                std::thread::spawn(move || {
                    start.wait();
                    let opened = folders.watch("main", &directory, observation, move |_| {
                        let _ = send.send(id);
                    });
                    opened.unwrap();
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        std::fs::write(root.path().join("one.md"), b"one").unwrap();
        let installed = receive.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(installed < 8);
        std::fs::write(root.path().join("two.md"), b"two").unwrap();
        assert_eq!(
            receive.recv_timeout(Duration::from_secs(5)).unwrap(),
            installed
        );
        folders.shutdown();
        assert!(receive.try_iter().all(|id| id == installed));
    }

    #[test]
    fn a_previous_page_cannot_replace_the_new_pages_observation() {
        let root = tempfile::tempdir().unwrap();
        let directory = Directory::existing(root.path()).unwrap();
        let folders = Folders::default();
        folders.bind("main", directory.clone()).unwrap();
        let (_, old) = folders.reserve_observation("main").unwrap();
        folders.page_started("main");
        let (_, current) = folders.reserve_observation("main").unwrap();
        let (send, receive) = mpsc::channel();
        folders
            .watch("main", &directory, current, move |change| {
                let _ = send.send(change);
            })
            .unwrap();
        assert_eq!(
            folders.watch("main", &directory, old, |_| {}),
            Err(WindowError::NotBound)
        );
        std::fs::write(root.path().join("new.md"), b"new").unwrap();
        receive.recv_timeout(Duration::from_secs(5)).unwrap();
        folders.shutdown();
    }
}
