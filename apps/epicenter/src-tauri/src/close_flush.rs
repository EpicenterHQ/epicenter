//! Letting saves in flight land before Epicenter exits.
//!
//! Quitting never asks. Capture and Todos keep their drafts in their pages,
//! and a draft's latest snapshot can still be waiting behind a running write
//! when the process is asked to leave. So before a quit, or a restart for an
//! account change, the host sends each open Capture and Todos window one
//! `flush-on-close` event and waits for its `flush_done`, or for
//! [`FLUSH_WAIT`], whichever comes first. The page sends what it holds and
//! waits for its running saves inside that bound. Then the process exits, and
//! the Folder plugin drains the writes it accepted. A draft whose save failed
//! is not held: its page already said so.
//!
//! ```text
//! Rust -> page   emit_to(label, "flush-on-close", ())   no payload
//! page -> Rust   flush_done()                           once its flush ends
//! Rust -> page   emit_to(label, "host-stopped", ())     the Bun host stopped
//! ```
//!
//! A quit that reaches the run loop as `ExitRequested` is held for the flush:
//! the tray's Quit, the app menu's Quit (an item of our own, since the
//! predefined one calls AppKit's `terminate:`), and any `app.exit`. A quit
//! AppKit delivers itself (the Dock, logout, shutdown) ends the run loop
//! without `ExitRequested`, while the main thread cannot carry a page's IPC,
//! so it drains only the writes the Folder plugin already accepted.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager, WebviewWindow};

use crate::DesktopAppHandle;

/// The one signal a page hears before the process leaves.
pub const FLUSH_EVENT: &str = "flush-on-close";
/// Sent to a page whose Bun host stopped; the page keeps its drafts.
pub const HOST_STOPPED_EVENT: &str = "host-stopped";
/// How long the host waits for the pages. Each page bounds its own flush below this.
pub const FLUSH_WAIT: Duration = Duration::from_secs(1);
/// The windows whose pages hold file-backed drafts.
pub const PAGES: [&str; 2] = ["capture", "todos"];

#[derive(Default)]
pub struct CloseFlush {
    /// A quit's flush finished: the next exit request leaves.
    flushed: AtomicBool,
    /// A quit's flush is running: a repeated quit starts no second one.
    flushing: AtomicBool,
    /// Where `flush_done` reports, one sender per flush waiting.
    acks: Mutex<Vec<mpsc::Sender<String>>>,
    /// The restart Bun was answered for, as (generation, request id).
    restart: Mutex<Option<(u64, String)>>,
}

/// A page finished flushing. The window is the one Tauri delivered the call
/// from, never a label the page names.
#[tauri::command]
pub fn flush_done(window: WebviewWindow) {
    let label = window.label().to_string();
    window
        .app_handle()
        .state::<CloseFlush>()
        .acks
        .lock()
        .expect("close flush lock poisoned")
        .retain(|ack| ack.send(label.clone()).is_ok());
}

/// Wait until every label in `waiting` has answered or `deadline` passes.
/// Returns the labels that did not answer.
fn wait_for_acks(
    acks: &mpsc::Receiver<String>,
    mut waiting: HashSet<String>,
    deadline: Instant,
) -> HashSet<String> {
    while !waiting.is_empty() {
        let left = deadline.saturating_duration_since(Instant::now());
        match acks.recv_timeout(left) {
            Ok(label) => {
                waiting.remove(&label);
            }
            Err(_) => break,
        }
    }
    waiting
}

fn open_pages(app: &DesktopAppHandle) -> HashSet<String> {
    PAGES
        .into_iter()
        .filter(|label| app.get_webview_window(label).is_some())
        .map(str::to_string)
        .collect()
}

/// Ask every open page to flush and wait for them, at most [`FLUSH_WAIT`].
/// Blocks; never call it on the main thread, which carries the pages' IPC.
pub fn flush_pages(app: &DesktopAppHandle) {
    let waiting = open_pages(app);
    if waiting.is_empty() {
        return;
    }
    let (sender, acks) = mpsc::channel();
    app.state::<CloseFlush>()
        .acks
        .lock()
        .expect("close flush lock poisoned")
        .push(sender);
    for label in &waiting {
        let _ = app.emit_to(label.as_str(), FLUSH_EVENT, ());
    }
    let silent = wait_for_acks(&acks, waiting, Instant::now() + FLUSH_WAIT);
    if !silent.is_empty() {
        let mut silent: Vec<_> = silent.into_iter().collect();
        silent.sort();
        crate::append_parent_log(
            app,
            &format!("left without a flush from {}", silent.join(", ")),
        );
    }
}

/// Whether to hold this exit request for a flush. Runs on the main thread.
///
/// A restart passes: Tauri ignores `prevent_exit` for one, and `relaunch`
/// flushed before requesting it. Every other request is held once, while a
/// background thread flushes and then exits with the same code.
pub fn holds_exit(app: &DesktopAppHandle, code: Option<i32>) -> bool {
    if code == Some(tauri::RESTART_EXIT_CODE) {
        return false;
    }
    let state = app.state::<CloseFlush>();
    if state.flushed.load(Ordering::Acquire) || open_pages(app).is_empty() {
        return false;
    }
    if state.flushing.swap(true, Ordering::AcqRel) {
        return true;
    }
    let app = app.clone();
    thread::spawn(move || {
        flush_pages(&app);
        app.state::<CloseFlush>()
            .flushed
            .store(true, Ordering::Release);
        app.exit(code.unwrap_or(0));
    });
    true
}

/// Bun asks to restart for an account change. Nothing is asked: the restart
/// is granted to this generation at once, and the pages flush when Bun
/// finishes it with `relaunch`.
pub fn prepare_restart(app: &DesktopAppHandle, generation: u64, request_id: String) {
    *app.state::<CloseFlush>()
        .restart
        .lock()
        .expect("close flush lock poisoned") = Some((generation, request_id.clone()));
    crate::reply_relaunch_preparation(app, generation, &request_id, Ok(()));
}

/// Grant a restart to `generation` without replying to it, for the isolated
/// runtime evidence harness, whose relaunch is not asked for by Bun.
#[cfg(feature = "runtime-evidence")]
pub(crate) fn grant_without_reply(app: &DesktopAppHandle, generation: u64, request_id: String) {
    *app.state::<CloseFlush>()
        .restart
        .lock()
        .expect("close flush lock poisoned") = Some((generation, request_id));
}

/// Bun gave a grant back, or withdrew a preparation. Only that grant ends.
pub fn release_restart(app: &DesktopAppHandle, generation: u64, request_id: &str) {
    let state = app.state::<CloseFlush>();
    let mut restart = state.restart.lock().expect("close flush lock poisoned");
    if restart
        .as_ref()
        .is_some_and(|(owner, id)| *owner == generation && id == request_id)
    {
        *restart = None;
    }
}

/// A Bun generation stopped: a grant it held ends with it.
pub fn retire_sidecar(app: &DesktopAppHandle, generation: u64) {
    let state = app.state::<CloseFlush>();
    let mut restart = state.restart.lock().expect("close flush lock poisoned");
    if restart
        .as_ref()
        .is_some_and(|(owner, _)| *owner == generation)
    {
        *restart = None;
    }
}

/// Bun finishes its grant: flush the pages, then restart. A request that holds
/// no grant changes nothing.
pub fn relaunch(app: &DesktopAppHandle, generation: u64, request_id: String) {
    let granted = {
        let state = app.state::<CloseFlush>();
        let mut restart = state.restart.lock().expect("close flush lock poisoned");
        let granted = restart
            .as_ref()
            .is_some_and(|(owner, id)| *owner == generation && *id == request_id);
        if granted {
            *restart = None;
        }
        granted
    };
    if !granted {
        crate::append_parent_log(
            app,
            &format!("ignored a relaunch for {request_id}, which holds no grant"),
        );
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        flush_pages(&app);
        app.request_restart();
    });
}

/// Bun stopped, on the main thread. The page keeps its drafts and its native
/// folder; it is told, and shown, so a person can recover its text.
pub fn host_stopped(app: &DesktopAppHandle, window: &WebviewWindow) {
    let _ = app.emit_to(window.label(), HOST_STOPPED_EVENT, ());
    let _ = window.show();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(names: &[&str]) -> HashSet<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn every_ack_ends_the_wait_before_the_deadline() {
        let (sender, acks) = mpsc::channel();
        sender.send("capture".to_string()).unwrap();
        sender.send("todos".to_string()).unwrap();
        let started = Instant::now();
        let silent = wait_for_acks(
            &acks,
            labels(&["capture", "todos"]),
            started + Duration::from_secs(5),
        );
        assert!(silent.is_empty());
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn a_silent_page_is_waited_for_until_the_deadline_only() {
        let (sender, acks) = mpsc::channel();
        sender.send("capture".to_string()).unwrap();
        let started = Instant::now();
        let silent = wait_for_acks(
            &acks,
            labels(&["capture", "todos"]),
            started + Duration::from_millis(50),
        );
        assert_eq!(silent, labels(&["todos"]));
        assert!(started.elapsed() >= Duration::from_millis(50));
        assert!(started.elapsed() < Duration::from_secs(1));
        drop(sender);
    }

    #[test]
    fn an_ack_from_another_window_does_not_count() {
        let (sender, acks) = mpsc::channel();
        sender.send("home".to_string()).unwrap();
        let silent = wait_for_acks(
            &acks,
            labels(&["todos"]),
            Instant::now() + Duration::from_millis(20),
        );
        assert_eq!(silent, labels(&["todos"]));
    }
}
