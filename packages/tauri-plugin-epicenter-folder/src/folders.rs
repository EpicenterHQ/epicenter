//! Live window-to-directory bindings. Each command keeps its admitted directory.

use std::collections::HashMap;
use std::fmt;
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
}

struct Binding {
    directory: Directory,
    identity: Arc<()>,
    retiring: bool,
    watch: Option<FolderWatch>,
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
        state.bindings.insert(
            label.to_string(),
            Binding {
                directory,
                identity: Arc::new(()),
                retiring: false,
                watch: None,
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
        let watch = {
            let mut state = self.state();
            let Some(binding) = state.bindings.get_mut(label) else {
                return;
            };
            if binding.retiring {
                return;
            }
            binding.retiring = true;
            binding.watch.take()
        };
        // Keep the retiring label reserved until no old callback can emit to
        // it. Other windows remain available while this callback fence waits.
        drop(watch);
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

    /// Start at most one watch for the still-bound directory. Opening again
    /// reuses it; pages do not control its root or its window lifetime.
    pub(crate) fn watch(
        &self,
        label: &str,
        directory: &Directory,
        report: impl Fn(FolderChanged) + Send + 'static,
    ) -> Result<(), WindowError> {
        let identity = {
            let state = self.state();
            if state.stopped {
                return Err(WindowError::ShuttingDown);
            }
            let binding = state.bindings.get(label).ok_or(WindowError::NotBound)?;
            if binding.retiring || binding.directory != *directory {
                return Err(WindowError::NotBound);
            }
            if binding.watch.is_some() {
                return Ok(());
            }
            binding.identity.clone()
        };
        // Native recursive setup can walk a large tree. It must never hold the
        // global bindings lock, and remains inactive until installed below.
        let mut candidate = Some(FolderWatch::start(directory.root(), report).map_err(
            |error| WindowError::Unavailable {
                message: error.to_string(),
            },
        )?);
        let result = {
            let mut state = self.state();
            if state.stopped {
                Err(WindowError::ShuttingDown)
            } else {
                match state.bindings.get_mut(label) {
                    Some(binding)
                        if !binding.retiring && Arc::ptr_eq(&binding.identity, &identity) =>
                    {
                        if binding.watch.is_none() {
                            let watch = candidate.take().expect("the uninstalled watch");
                            watch.activate();
                            binding.watch = Some(watch);
                        }
                        Ok(())
                    }
                    _ => Err(WindowError::NotBound),
                }
            }
        };
        // Discard duplicate starts only after releasing the global lock.
        drop(candidate);
        result
    }

    /// Refuse new bindings and commands without waiting for admitted work (ADR-0542).
    pub fn shutdown(&self) {
        let watches = {
            let mut state = self.state();
            state.stopped = true;
            state
                .bindings
                .values_mut()
                .filter_map(|binding| binding.watch.take())
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
            folders.watch("main", &directory, move |_| {
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
            .watch("main", &old, move |_| {
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
        stopping.recv_timeout(Duration::from_secs(5)).unwrap();
        thread.join().unwrap();

        folders.bind("main", new.clone()).unwrap();
        let (send, receive) = mpsc::channel();
        folders
            .watch("main", &new, move |event| {
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
                    folders
                        .watch("main", &directory, move |_| {
                            let _ = send.send(id);
                        })
                        .unwrap();
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        std::fs::write(root.path().join("one.md"), b"one").unwrap();
        let installed = receive.recv_timeout(Duration::from_secs(5)).unwrap();
        std::fs::write(root.path().join("two.md"), b"two").unwrap();
        assert_eq!(
            receive.recv_timeout(Duration::from_secs(5)).unwrap(),
            installed
        );
        folders.shutdown();
        assert!(receive.try_iter().all(|id| id == installed));
    }
}
