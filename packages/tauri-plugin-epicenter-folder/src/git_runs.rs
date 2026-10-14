//! The `git` runs a page has started, so `cancel_git`, a reload, or a closed
//! window can stop them.
//!
//! A page names each run with an ID it makes up, a random UUID, and the
//! plugin keys the run by that ID and the label of the window that asked.
//! Random IDs keep two pages apart without the plugin knowing which page is
//! which: a window recreated under an old label, or a reloaded page, never
//! picks the ID of a run the page before it left running.
//!
//! When a page starts loading in a window, or the window is destroyed, every
//! run registered for that label is the old page's, since the new page has
//! started none yet: each is cancelled and forgotten.
//!
//! `run_git` and `cancel_git` are separate requests that Tauri may handle in
//! either order, so a cancel that arrives before its run is remembered, and
//! the run it names is cancelled as it starts. Those remembered IDs are
//! dropped when the window's page changes, and are capped
//! (`REMEMBERED_CANCELS`), since a page may cancel a run that already ended.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

/// How many early cancels a window's page may leave unclaimed before the
/// oldest are forgotten.
const REMEMBERED_CANCELS: usize = 1024;

/// The longest ID a page may give a run.
const MAX_ID_LENGTH: usize = 128;

type Key = (String, String);

#[derive(Default)]
struct State {
    /// Cancel flags of the runs still running.
    running: HashMap<Key, Arc<AtomicBool>>,
    /// Cancels that arrived before their run.
    cancelled: HashSet<Key>,
}

#[derive(Default)]
pub(crate) struct GitRuns {
    state: Mutex<State>,
}

fn key(window: &str, id: &str) -> Key {
    (window.to_string(), id.to_string())
}

impl GitRuns {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Register run `id` of `window` and return its cancel flag, already set
    /// when a cancel for it came first. Refused when the ID is empty, too
    /// long, or names a run of this window that is still running.
    pub fn start(&self, window: &str, id: &str) -> Result<Arc<AtomicBool>, String> {
        if id.is_empty() || id.len() > MAX_ID_LENGTH {
            return Err(format!(
                "a Git command's ID must be 1 to {MAX_ID_LENGTH} bytes long"
            ));
        }
        let key = key(window, id);
        let mut state = self.state();
        if state.running.contains_key(&key) {
            return Err(format!("a Git command with the ID '{id}' is already running"));
        }
        let cancelled = state.cancelled.remove(&key);
        let cancel = Arc::new(AtomicBool::new(cancelled));
        state.running.insert(key, Arc::clone(&cancel));
        Ok(cancel)
    }

    /// Run `id` of `window` ended. A page change may already have forgotten
    /// it; then nothing is removed.
    pub fn finish(&self, window: &str, id: &str, cancel: &Arc<AtomicBool>) {
        let key = key(window, id);
        let mut state = self.state();
        if state
            .running
            .get(&key)
            .is_some_and(|current| Arc::ptr_eq(current, cancel))
        {
            state.running.remove(&key);
        }
    }

    /// Stop run `id` of `window`, or, when it has not started, stop it as it
    /// starts.
    pub fn cancel(&self, window: &str, id: &str) {
        if id.is_empty() || id.len() > MAX_ID_LENGTH {
            return;
        }
        let key = key(window, id);
        let mut state = self.state();
        if let Some(cancel) = state.running.get(&key) {
            cancel.store(true, Ordering::SeqCst);
            return;
        }
        let remembered = state
            .cancelled
            .iter()
            .filter(|(owner, _)| owner == window)
            .count();
        if remembered >= REMEMBERED_CANCELS {
            state.cancelled.retain(|(owner, _)| owner != window);
        }
        state.cancelled.insert(key);
    }

    /// The page in `window` is over: it reloaded, navigated, or the window
    /// was destroyed. Cancel and forget every run it started, and every
    /// cancel it left waiting.
    pub fn page_ended(&self, window: &str) {
        let mut state = self.state();
        state.running.retain(|(owner, _), cancel| {
            if owner != window {
                return true;
            }
            cancel.store(true, Ordering::SeqCst);
            false
        });
        state.cancelled.retain(|(owner, _)| owner != window);
    }
}
