//! Live window-to-directory bindings. Each command keeps its admitted directory.

use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use specta::Type;
use tauri::ipc::Channel;

use crate::watch::{FolderChanged, FolderWatch};
use crate::Directory;

/// The shell's live window bindings. Reached with `app.folders()`.
#[derive(Default)]
pub struct Folders {
    state: Mutex<State>,
    next_close: AtomicU32,
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
    report: Arc<Mutex<Option<Box<dyn Fn(FolderChanged) + Send>>>>,
    observation: u64,
    close: Option<CloseSubscription>,
}

struct CloseSubscription {
    token: u32,
    channel: Channel<()>,
    phase: ClosePhase,
}

enum ClosePhase {
    Idle,
    Sent,
    Answering,
    Prompting,
    Ready,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CloseAnswer {
    Ignore,
    Destroy,
    WaitForPrompt,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CloseRequest {
    Unhandled,
    Sent,
    Waiting,
    ConfirmNatively(u32),
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
                report: Arc::new(Mutex::new(None)),
                observation: 0,
                close: None,
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

    /// Reserve this page's observation before filesystem setup can block.
    pub(crate) fn reserve_observation(&self, label: &str) -> Result<(Directory, u64), WindowError> {
        let mut state = self.state();
        if state.stopped {
            return Err(WindowError::ShuttingDown);
        }
        let binding = state.bindings.get_mut(label).ok_or(WindowError::NotBound)?;
        if binding.retiring {
            return Err(WindowError::NotBound);
        }
        binding.observation = binding.observation.wrapping_add(1);
        Ok((binding.directory.clone(), binding.observation))
    }

    /// The page's close recipient is replaceable across reloads, like its watch recipient.
    pub(crate) fn subscribe_close(
        &self,
        label: &str,
        channel: Channel<()>,
    ) -> Result<u32, WindowError> {
        let token = self.next_close.fetch_add(1, Ordering::Relaxed);
        let previous = {
            let mut state = self.state();
            if state.stopped {
                return Err(WindowError::ShuttingDown);
            }
            let binding = state.bindings.get_mut(label).ok_or(WindowError::NotBound)?;
            if binding.retiring {
                return Err(WindowError::NotBound);
            }
            binding.close.replace(CloseSubscription {
                token,
                channel,
                phase: ClosePhase::Idle,
            })
        };
        drop(previous);
        Ok(token)
    }

    pub(crate) fn unsubscribe_close(&self, label: &str, token: u32) {
        let old = {
            let mut state = self.state();
            state.bindings.get_mut(label).and_then(|binding| {
                (binding
                    .close
                    .as_ref()
                    .is_some_and(|close| close.token == token))
                .then(|| binding.close.take())
                .flatten()
            })
        };
        drop(old);
    }

    pub(crate) fn page_started(&self, label: &str) {
        let old = {
            let mut state = self.state();
            let Some(binding) = state.bindings.get_mut(label) else {
                return;
            };
            binding.observation = binding.observation.wrapping_add(1);
            let report = binding
                .report
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            (binding.close.take(), report)
        };
        drop(old);
    }

    /// Deliver once. A second unanswered request gets a native escape hatch.
    pub(crate) fn request_close(&self, label: &str) -> CloseRequest {
        let (token, channel) = {
            let mut state = self.state();
            let Some(close) = state
                .bindings
                .get_mut(label)
                .filter(|binding| !binding.retiring)
                .and_then(|binding| binding.close.as_mut())
            else {
                return CloseRequest::Unhandled;
            };
            match close.phase {
                ClosePhase::Answering | ClosePhase::Prompting | ClosePhase::Ready => {
                    return CloseRequest::Waiting;
                }
                ClosePhase::Sent => {
                    close.phase = ClosePhase::Prompting;
                    return CloseRequest::ConfirmNatively(close.token);
                }
                ClosePhase::Idle => close.phase = ClosePhase::Sent,
            }
            (close.token, close.channel.clone())
        };
        if channel.send(()).is_ok() {
            CloseRequest::Sent
        } else {
            self.finish_close_request(label, token);
            CloseRequest::Unhandled
        }
    }

    pub(crate) fn begin_close_answer(&self, label: &str, token: u32) -> CloseAnswer {
        let mut state = self.state();
        let Some(close) = state
            .bindings
            .get_mut(label)
            .filter(|binding| !binding.retiring)
            .and_then(|binding| binding.close.as_mut())
        else {
            return CloseAnswer::Ignore;
        };
        if close.token != token {
            return CloseAnswer::Ignore;
        }
        match close.phase {
            ClosePhase::Idle => CloseAnswer::Ignore,
            ClosePhase::Sent => {
                close.phase = ClosePhase::Answering;
                CloseAnswer::Destroy
            }
            ClosePhase::Prompting => {
                close.phase = ClosePhase::Ready;
                CloseAnswer::WaitForPrompt
            }
            ClosePhase::Answering | ClosePhase::Ready => CloseAnswer::Ignore,
        }
    }

    /// A canceled question resumes waiting for the page's already-sent answer.
    pub(crate) fn finish_native_prompt(&self, label: &str, token: u32, confirmed: bool) -> bool {
        let mut state = self.state();
        let Some(close) = state
            .bindings
            .get_mut(label)
            .and_then(|binding| binding.close.as_mut())
            .filter(|close| close.token == token)
        else {
            return false;
        };
        if confirmed || matches!(close.phase, ClosePhase::Ready) {
            close.phase = ClosePhase::Answering;
            true
        } else {
            close.phase = ClosePhase::Sent;
            false
        }
    }

    pub(crate) fn finish_close_request(&self, label: &str, token: u32) {
        let mut state = self.state();
        if let Some(close) = state
            .bindings
            .get_mut(label)
            .and_then(|binding| binding.close.as_mut())
            .filter(|close| close.token == token)
        {
            close.phase = ClosePhase::Idle;
        }
    }

    pub(crate) fn owns_close(&self, label: &str, token: u32) -> bool {
        self.state().bindings.get(label).is_some_and(|binding| {
            !binding.retiring
                && binding
                    .close
                    .as_ref()
                    .is_some_and(|close| close.token == token)
        })
    }

    /// Start at most one watch for the still-bound directory. A new open
    /// replaces its recipient, since the window binding outlives a page reload.
    pub(crate) fn watch(
        &self,
        label: &str,
        directory: &Directory,
        observation: u64,
        report: impl Fn(FolderChanged) + Send + 'static,
    ) -> Result<(), WindowError> {
        let mut next_report: Option<Box<dyn Fn(FolderChanged) + Send>> = Some(Box::new(report));
        let (identity, recipient) = {
            let state = self.state();
            if state.stopped {
                return Err(WindowError::ShuttingDown);
            }
            let binding = state.bindings.get(label).ok_or(WindowError::NotBound)?;
            if binding.retiring
                || binding.directory != *directory
                || binding.observation != observation
            {
                return Err(WindowError::NotBound);
            }
            if binding.watch.is_some() {
                let previous = binding
                    .report
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .replace(next_report.take().expect("the new recipient"));
                drop(state);
                drop(previous);
                return Ok(());
            }
            (binding.identity.clone(), binding.report.clone())
        };
        // Native recursive setup can walk a large tree. It must never hold the
        // global bindings lock, and remains inactive until installed below.
        let mut candidate = Some(
            FolderWatch::start(directory.root(), move |change| {
                if let Some(report) = recipient
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
                    Some(binding)
                        if !binding.retiring
                            && binding.observation == observation
                            && Arc::ptr_eq(&binding.identity, &identity) =>
                    {
                        let previous = binding
                            .report
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .replace(next_report.take().expect("the new recipient"));
                        if binding.watch.is_none() {
                            let watch = candidate.take().expect("the uninstalled watch");
                            watch.activate();
                            binding.watch = Some(watch);
                        }
                        Ok(previous)
                    }
                    _ => Err(WindowError::NotBound),
                }
            }
        };
        // Discard duplicate starts only after releasing the global lock.
        drop(candidate);
        match result {
            Ok(previous) => {
                drop(previous);
                Ok(())
            }
            Err(error) => Err(error),
        }
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
    fn a_replaced_close_subscription_cannot_destroy_or_unsubscribe_its_successor() {
        use tauri::ipc::{Channel, InvokeResponseBody};

        let root = tempfile::tempdir().unwrap();
        let directory = Directory::existing(root.path()).unwrap();
        let folders = Folders::default();
        folders.bind("main", directory).unwrap();
        let old = folders
            .subscribe_close("main", Channel::new(|_: InvokeResponseBody| Ok(())))
            .unwrap();
        let next = folders
            .subscribe_close("main", Channel::new(|_: InvokeResponseBody| Ok(())))
            .unwrap();
        folders.unsubscribe_close("main", old);
        assert!(!folders.owns_close("main", old));
        assert!(folders.owns_close("main", next));
        assert_eq!(folders.request_close("main"), CloseRequest::Sent);
        folders.page_started("main");
        assert!(!folders.owns_close("main", next));
        assert_eq!(folders.request_close("main"), CloseRequest::Unhandled);
    }

    #[test]
    fn a_page_cannot_destroy_an_idle_window() {
        use tauri::ipc::{Channel, InvokeResponseBody};

        let root = tempfile::tempdir().unwrap();
        let folders = Folders::default();
        folders
            .bind("main", Directory::existing(root.path()).unwrap())
            .unwrap();
        let token = folders
            .subscribe_close("main", Channel::new(|_: InvokeResponseBody| Ok(())))
            .unwrap();

        assert_eq!(
            folders.begin_close_answer("main", token),
            CloseAnswer::Ignore
        );
        assert_eq!(folders.request_close("main"), CloseRequest::Sent);
        assert_eq!(
            folders.begin_close_answer("main", token),
            CloseAnswer::Destroy
        );
    }

    #[test]
    fn a_second_unanswered_close_needs_confirmation_but_a_page_answer_stays_single() {
        use tauri::ipc::{Channel, InvokeResponseBody};

        let root = tempfile::tempdir().unwrap();
        let directory = Directory::existing(root.path()).unwrap();
        let folders = Folders::default();
        folders.bind("main", directory).unwrap();
        let token = folders
            .subscribe_close("main", Channel::new(|_: InvokeResponseBody| Ok(())))
            .unwrap();
        assert_eq!(folders.request_close("main"), CloseRequest::Sent);
        assert_eq!(
            folders.request_close("main"),
            CloseRequest::ConfirmNatively(token)
        );
        assert_eq!(folders.request_close("main"), CloseRequest::Waiting);
        assert_eq!(folders.begin_close_answer("main", token), CloseAnswer::WaitForPrompt);
        assert!(folders.finish_native_prompt("main", token, false));
        folders.finish_close_request("main", token);
        assert_eq!(folders.request_close("main"), CloseRequest::Sent);
        assert_eq!(folders.begin_close_answer("main", token), CloseAnswer::Destroy);
        assert_eq!(folders.request_close("main"), CloseRequest::Waiting);
        folders.finish_close_request("main", token);
        assert_eq!(folders.request_close("main"), CloseRequest::Sent);
    }

    #[test]
    fn keep_waiting_preserves_the_page_answer() {
        use tauri::ipc::{Channel, InvokeResponseBody};

        let root = tempfile::tempdir().unwrap();
        let folders = Folders::default();
        folders
            .bind("main", Directory::existing(root.path()).unwrap())
            .unwrap();
        let token = folders
            .subscribe_close("main", Channel::new(|_: InvokeResponseBody| Ok(())))
            .unwrap();
        assert_eq!(folders.request_close("main"), CloseRequest::Sent);
        assert_eq!(folders.request_close("main"), CloseRequest::ConfirmNatively(token));
        assert!(!folders.finish_native_prompt("main", token, false));
        assert_eq!(folders.begin_close_answer("main", token), CloseAnswer::Destroy);
    }

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
        stopping.recv_timeout(Duration::from_secs(5)).unwrap();
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
