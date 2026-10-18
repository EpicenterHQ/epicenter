//! How Epicenter ends: Quit, and the restart an account change asks for.
//!
//! Both close every window, and the app exits or relaunches once the last one
//! is gone. Closing a window runs its page's close handler first: Capture and
//! Todos await their owner's `close()`, which lets the saves in flight land,
//! and then Tauri destroys the window. Nothing here waits on a page, counts
//! answers, or sets a timer. The run loop raises `ExitRequested { code: None }`
//! when the last window is destroyed, and [`holds_exit`] decides it: with no
//! quit or restart under way the exit is prevented, so closing the last
//! window leaves Epicenter in the tray.
//!
//! Built-in windows are closed, so their pages' handlers run. An installed
//! app's window is destroyed, as it was before: no installed app is granted
//! `core:window:allow-destroy`, so a close handler of its own could only
//! hold the quit open.
//!
//! A page whose handler never returns keeps its window, and so the app, open.
//! Its "Close anyway" lets the window go. A quit AppKit delivers itself (the
//! Dock, logout, shutdown) ends the run loop without closing windows, so it
//! drains only the writes the Folder plugin already accepted.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Mutex;

use tauri::Manager;

use crate::{DesktopAppHandle, APP_WINDOW_PREFIX};

/// What the app is doing about ending. A quit outranks a restart.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u8)]
pub enum Leaving {
    /// Running; closing the last window keeps the app in the tray.
    Stay = 0,
    /// Relaunching once every window is gone.
    Restart = 1,
    /// Exiting once every window is gone.
    Quit = 2,
}

impl Leaving {
    fn from_u8(value: u8) -> Self {
        match value {
            2 => Self::Quit,
            1 => Self::Restart,
            _ => Self::Stay,
        }
    }
}

/// What an exit request raised by the last window closing does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AfterLastWindow {
    /// Prevent it: the app stays in the tray.
    Stay,
    /// Let it exit.
    Exit,
    /// Prevent it and relaunch.
    Restart,
}

/// How a window is ended when the app leaves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ending {
    /// Ask it to close, which runs its page's close handler first.
    Close,
    /// Destroy it at once.
    Destroy,
}

/// The ending's state, managed by the app.
#[derive(Default)]
pub struct Departure {
    leaving: AtomicU8,
    /// The restart Bun was answered for, as (generation, request id).
    restart: Mutex<Option<(u64, String)>>,
}

impl Departure {
    /// Begin ending as `kind`. A quit replaces a restart; a restart never
    /// replaces a quit. Answers what the app is doing now.
    pub fn begin(&self, kind: Leaving) -> Leaving {
        let was = self.leaving.fetch_max(kind as u8, Ordering::AcqRel);
        Leaving::from_u8(was.max(kind as u8))
    }

    pub fn leaving(&self) -> Leaving {
        Leaving::from_u8(self.leaving.load(Ordering::Acquire))
    }

    fn restart(&self) -> std::sync::MutexGuard<'_, Option<(u64, String)>> {
        self.restart.lock().expect("departure lock poisoned")
    }
}

/// What the last window's exit request does while the app is `leaving`.
pub fn after_last_window(leaving: Leaving) -> AfterLastWindow {
    match leaving {
        Leaving::Stay => AfterLastWindow::Stay,
        Leaving::Quit => AfterLastWindow::Exit,
        Leaving::Restart => AfterLastWindow::Restart,
    }
}

/// How the window labeled `label` is ended.
pub fn ending(label: &str) -> Ending {
    if label.starts_with(APP_WINDOW_PREFIX) {
        Ending::Destroy
    } else {
        Ending::Close
    }
}

/// End every window in `windows` the way [`ending`] says. Answers whether
/// there was any; with none, nothing will raise the last window's exit
/// request, so the caller finishes at once.
pub fn end_windows<W>(
    windows: impl IntoIterator<Item = (String, W)>,
    mut end: impl FnMut(&W, Ending),
) -> bool {
    let mut any = false;
    for (label, window) in windows {
        any = true;
        end(&window, ending(&label));
    }
    any
}

/// Whether the app is ending, so a window that hides on close closes instead.
pub fn is_leaving(app: &DesktopAppHandle) -> bool {
    app.state::<Departure>().leaving() != Leaving::Stay
}

/// Begin `kind` and end every window. With no window open, finish now.
fn leave(app: &DesktopAppHandle, kind: Leaving) {
    let now = app.state::<Departure>().begin(kind);
    let any = end_windows(app.webview_windows(), |window, ending| {
        let ended = match ending {
            Ending::Close => window.close(),
            Ending::Destroy => window.destroy(),
        };
        if let Err(error) = ended {
            crate::append_parent_log(app, &format!("end {} window: {error}", window.label()));
        }
    });
    if !any {
        finish(app, now);
    }
}

fn finish(app: &DesktopAppHandle, leaving: Leaving) {
    match after_last_window(leaving) {
        AfterLastWindow::Stay => {}
        AfterLastWindow::Exit => app.exit(0),
        AfterLastWindow::Restart => app.request_restart(),
    }
}

/// Quit Epicenter: the menu's Quit and the tray's.
pub fn quit(app: &DesktopAppHandle) {
    leave(app, Leaving::Quit);
}

/// Whether to prevent this exit request. Runs on the main thread.
///
/// An exit with a code (`app.exit`, `request_restart`) goes ahead. The one the
/// last window raises (`code: None`) is decided by what the app is doing:
/// staying keeps it in the tray, a quit exits, and a restart relaunches.
pub fn holds_exit(app: &DesktopAppHandle, code: Option<i32>) -> bool {
    if code.is_some() {
        return false;
    }
    match after_last_window(app.state::<Departure>().leaving()) {
        AfterLastWindow::Stay => true,
        AfterLastWindow::Exit => false,
        AfterLastWindow::Restart => {
            app.request_restart();
            true
        }
    }
}

/// Bun asks to restart for an account change. Nothing is asked: the restart
/// is granted to this generation at once, and the windows close when Bun
/// finishes it with `relaunch`.
pub fn prepare_restart(app: &DesktopAppHandle, generation: u64, request_id: String) {
    *app.state::<Departure>().restart() = Some((generation, request_id.clone()));
    crate::reply_relaunch_preparation(app, generation, &request_id, Ok(()));
}

/// Grant a restart to `generation` without replying to it, for the isolated
/// runtime evidence harness, whose relaunch is not asked for by Bun.
#[cfg(feature = "runtime-evidence")]
pub(crate) fn grant_without_reply(app: &DesktopAppHandle, generation: u64, request_id: String) {
    *app.state::<Departure>().restart() = Some((generation, request_id));
}

/// Bun gave a grant back, or withdrew a preparation. Only that grant ends.
pub fn release_restart(app: &DesktopAppHandle, generation: u64, request_id: &str) {
    let departure = app.state::<Departure>();
    let mut restart = departure.restart();
    if restart
        .as_ref()
        .is_some_and(|(owner, id)| *owner == generation && id == request_id)
    {
        *restart = None;
    }
}

/// A Bun generation stopped: a grant it held ends with it.
pub fn retire_sidecar(app: &DesktopAppHandle, generation: u64) {
    let departure = app.state::<Departure>();
    let mut restart = departure.restart();
    if restart
        .as_ref()
        .is_some_and(|(owner, _)| *owner == generation)
    {
        *restart = None;
    }
}

/// Bun finishes its grant: close every window, and relaunch once the last is
/// gone. A request that holds no grant changes nothing.
pub fn relaunch(app: &DesktopAppHandle, generation: u64, request_id: String) {
    let granted = {
        let departure = app.state::<Departure>();
        let mut restart = departure.restart();
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
    leave(app, Leaving::Restart);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_last_window_closing_keeps_the_tray_unless_the_app_is_leaving() {
        let departure = Departure::default();
        assert_eq!(departure.leaving(), Leaving::Stay);
        assert_eq!(
            after_last_window(departure.leaving()),
            AfterLastWindow::Stay
        );

        assert_eq!(departure.begin(Leaving::Quit), Leaving::Quit);
        assert_eq!(
            after_last_window(departure.leaving()),
            AfterLastWindow::Exit
        );
    }

    #[test]
    fn a_restart_relaunches_once_the_last_window_is_gone() {
        let departure = Departure::default();
        assert_eq!(departure.begin(Leaving::Restart), Leaving::Restart);
        assert_eq!(
            after_last_window(departure.leaving()),
            AfterLastWindow::Restart
        );
    }

    #[test]
    fn a_quit_outranks_a_restart_either_way_round() {
        let restarting = Departure::default();
        restarting.begin(Leaving::Restart);
        assert_eq!(restarting.begin(Leaving::Quit), Leaving::Quit);
        assert_eq!(
            after_last_window(restarting.leaving()),
            AfterLastWindow::Exit
        );

        let quitting = Departure::default();
        quitting.begin(Leaving::Quit);
        assert_eq!(quitting.begin(Leaving::Restart), Leaving::Quit);
        assert_eq!(after_last_window(quitting.leaving()), AfterLastWindow::Exit);
    }

    #[test]
    fn leaving_closes_built_in_windows_and_destroys_installed_ones() {
        let windows = [
            "home",
            "todos",
            "capture",
            "recording-overlay",
            "app-com_example_notes",
        ]
        .map(|label| (label.to_string(), label));
        let mut ended = Vec::new();
        let any = end_windows(windows, |label, ending| ended.push((*label, ending)));
        assert!(any);
        assert_eq!(
            ended,
            [
                ("home", Ending::Close),
                ("todos", Ending::Close),
                ("capture", Ending::Close),
                ("recording-overlay", Ending::Close),
                ("app-com_example_notes", Ending::Destroy),
            ]
        );
    }

    #[test]
    fn with_no_window_open_leaving_finishes_at_once() {
        let mut ended = 0;
        let any = end_windows(Vec::<(String, ())>::new(), |_, _| ended += 1);
        assert!(!any);
        assert_eq!(ended, 0);
    }
}
