//! Flush on close: closing never asks, but a save already in flight gets a
//! bounded moment to land.
//!
//! The window's close request, the run loop's exit request, and the macOS Quit
//! menu item all come here. The first one is held: the page is sent
//! [`FLUSH_ON_CLOSE`] once, and a background thread waits for the page's one
//! `flush_done` or [`FLUSH_BOUND`], whichever comes first, then exits. A close
//! that arrives while that wait runs is held too; one that arrives after it
//! goes ahead. Nothing here asks the page whether it may close, and nothing
//! waits on a person.
//!
//! The page acknowledges when its held autosave snapshot and running saves
//! have landed, or when its own shorter budget runs out. A page that is
//! loading, failed to open, or stopped answering never acknowledges, so the
//! close waits out the bound and goes ahead.
//!
//! A quit from the system (the Dock, a logout, an Apple Event) never reaches
//! this: AppKit's `terminate:` ends in Tao's `applicationWillTerminate:`, so
//! the run loop sees only [`tauri::RunEvent::Exit`]. The page cannot be asked
//! then, and only writes the folder plugin already accepted are drained.

use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::commands::WINDOW;

/// The event the page receives when a close is held for its flush.
pub const FLUSH_ON_CLOSE: &str = "flush-on-close";

/// How long a close waits for the page. The page's own budget is shorter, so
/// its acknowledgement normally arrives first.
pub const FLUSH_BOUND: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    /// No close has been asked for.
    Open,
    /// The page was sent the event; the close waits for its acknowledgement.
    Flushing,
    /// The wait is over. Every close and exit goes ahead.
    Flushed,
}

/// What a close request does now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Begin {
    /// Hold it, send the page the event, and wait. Answered once.
    Start,
    /// Hold it; a wait already runs and exits when it ends.
    Hold,
    /// Let it go.
    Proceed,
}

/// The close flush's state, managed by the app.
pub struct CloseFlush {
    stage: Mutex<Stage>,
    ack: Sender<()>,
    acks: Mutex<Receiver<()>>,
}

impl CloseFlush {
    pub fn new() -> Self {
        let (ack, acks) = channel();
        Self {
            stage: Mutex::new(Stage::Open),
            ack,
            acks: Mutex::new(acks),
        }
    }

    fn stage(&self) -> std::sync::MutexGuard<'_, Stage> {
        self.stage
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Note a close request and say what it does now.
    pub fn begin(&self) -> Begin {
        let mut stage = self.stage();
        match *stage {
            Stage::Open => {
                *stage = Stage::Flushing;
                Begin::Start
            }
            Stage::Flushing => Begin::Hold,
            Stage::Flushed => Begin::Proceed,
        }
    }

    /// The page's flush is done. Counted only while a close waits for it, so
    /// an acknowledgement sent at any other time cannot end a later wait early.
    pub fn acknowledge(&self) {
        if *self.stage() == Stage::Flushing {
            let _ = self.ack.send(());
        }
    }

    /// Wait for the page's acknowledgement, at most `bound`, then let every
    /// close go ahead. Whether the page acknowledged.
    pub fn wait(&self, bound: Duration) -> bool {
        let acknowledged = self
            .acks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .recv_timeout(bound)
            .is_ok();
        *self.stage() = Stage::Flushed;
        acknowledged
    }
}

/// Whether a close or exit must be held now. The first one sends the page
/// [`FLUSH_ON_CLOSE`] and starts the bounded wait, which exits the app when
/// it ends.
pub fn hold<R: Runtime>(app: &AppHandle<R>) -> bool {
    hold_then(app, FLUSH_BOUND, |app| app.exit(0))
}

/// `hold`, with what happens when the wait ends. The tests replace the exit,
/// which the mock runtime does not implement.
pub(crate) fn hold_then<R: Runtime>(
    app: &AppHandle<R>,
    bound: Duration,
    then: impl FnOnce(&AppHandle<R>) + Send + 'static,
) -> bool {
    // No state means setup never finished: there is no page to wait for.
    let Some(flush) = app.try_state::<CloseFlush>() else {
        return false;
    };
    match flush.begin() {
        Begin::Proceed => false,
        Begin::Hold => true,
        Begin::Start => {
            // A page that cannot be reached never acknowledges; the bound ends the wait.
            let _ = app.emit_to(WINDOW, FLUSH_ON_CLOSE, ());
            let app = app.clone();
            std::thread::spawn(move || {
                app.state::<CloseFlush>().wait(bound);
                then(&app);
            });
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn an_acknowledgement_ends_the_wait_at_once() {
        let flush = CloseFlush::new();
        assert_eq!(flush.begin(), Begin::Start);
        flush.acknowledge();
        let started = Instant::now();
        assert!(flush.wait(Duration::from_secs(5)));
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(flush.begin(), Begin::Proceed);
    }

    #[test]
    fn with_no_acknowledgement_the_wait_ends_at_the_bound() {
        let flush = CloseFlush::new();
        assert_eq!(flush.begin(), Begin::Start);
        let started = Instant::now();
        assert!(!flush.wait(Duration::from_millis(50)));
        assert!(started.elapsed() >= Duration::from_millis(50));
        assert_eq!(flush.begin(), Begin::Proceed);
    }

    #[test]
    fn a_close_during_the_wait_is_held_and_starts_nothing() {
        let flush = CloseFlush::new();
        assert_eq!(flush.begin(), Begin::Start);
        assert_eq!(flush.begin(), Begin::Hold);
    }

    #[test]
    fn an_acknowledgement_before_any_close_does_not_end_a_later_wait() {
        let flush = CloseFlush::new();
        flush.acknowledge();
        assert_eq!(flush.begin(), Begin::Start);
        assert!(!flush.wait(Duration::from_millis(20)));
    }
}
