//! Leaving Epicenter with pages that hold unsaved text.
//!
//! Capture and Todos keep drafts in their pages. Before the process quits, or
//! restarts for an account change, the host asks both windows in one round and
//! leaves only once each has agreed or a person has discarded it in the native
//! dialog. Agreeing never closes, reloads, or discards a page: it stays loaded,
//! and a round that ends without leaving resumes every page it held.
//!
//! [`machine`] is the round as data. This module is its Tauri side: the page
//! commands, the nudge, the native dialog, and the replies to Bun.
//!
//! # One owner
//!
//! Every transition runs on the main thread, which also owns the windows, and
//! changes window visibility inside the transition through [`NativeWindows`].
//! Bun frames, timers, dialog answers, and page answers are carried there by
//! [`dispatch`]; page loads, window destruction, ExitRequested, and window
//! creation already run there. So no hide or show can land after the round it
//! belonged to, and a round's membership is read in the same step that starts
//! it, with no participant window created in between. Nothing under the lock
//! waits: the window calls are synchronous on the main thread and never call
//! back into this module. Dialogs, replies, and nudges run after it is released.
//!
//! # Every quit
//!
//! A quit reaches the round as `ExitRequested`: the tray's Quit and any
//! `app.exit` directly, and every AppKit `terminate:` (the app menu's Quit,
//! Cmd-Q, the Dock, logout) through the guard in `terminate`, which Tao's
//! delegate would otherwise let terminate without asking.
//!
//! # The page wire
//!
//! ```text
//! Rust -> page   emit_to(label, "departure-changed", ())    no payload
//! page -> Rust   departure_status() -> Status
//!                departure_answer({ generation, round, answer }) -> Status
//! Status = { version, generation, phase: idle | collecting | granted | leaving,
//!            round?, intent?: quit | restart, vote?: none | asking | ready | discarded }
//! ```
//!
//! The caller is the window Tauri delivered the call from, never a label the
//! page names. A stale generation or round changes nothing and returns the
//! current status. The page-side ordering rules are in the README.

mod machine;
#[cfg(target_os = "macos")]
mod terminate;

#[cfg(target_os = "macos")]
pub use terminate::install as install_terminate_guard;

use std::sync::{mpsc, Mutex, OnceLock};
use std::thread::{self, ThreadId};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

pub use machine::Participant;
use machine::{Answer, Effect, IntentName, Machine, PhaseName, Status, Vote, Windows};

use crate::DesktopAppHandle;

pub const CHANGED_EVENT: &str = "departure-changed";
/// The Bun host that served this page stopped. The page and its native folder
/// keep working; its HTTP session does not come back.
pub const HOST_STOPPED_EVENT: &str = "host-stopped";
/// How long a page has to say it is deciding before the person is asked.
const FALLBACK_DELAY: Duration = Duration::from_secs(3);
/// How long an IPC answer waits for the main thread before reporting it busy.
const MAIN_THREAD_WAIT: Duration = Duration::from_secs(10);

#[derive(Default)]
pub struct Departure {
    machine: Mutex<Machine>,
    main: OnceLock<ThreadId>,
}

/// Record the main thread. Setup calls this; it runs there.
pub fn bind_main_thread(app: &DesktopAppHandle) {
    let _ = app.state::<Departure>().main.set(thread::current().id());
}

fn on_main_thread(app: &DesktopAppHandle) -> bool {
    app.state::<Departure>().main.get() == Some(&thread::current().id())
}

/// Run `operation` on the main thread: at once when already there, otherwise
/// queued behind whatever the main thread is doing, in the order dispatched.
fn dispatch(app: &DesktopAppHandle, operation: impl FnOnce(&DesktopAppHandle) + Send + 'static) {
    if on_main_thread(app) {
        operation(app);
        return;
    }
    let target = app.clone();
    if let Err(error) = app.run_on_main_thread(move || operation(&target)) {
        crate::append_parent_log(app, &format!("schedule departure work: {error}"));
    }
}

/// [`dispatch`], waiting for the result. Called with no lock held.
fn dispatch_wait<T: Send + 'static>(
    app: &DesktopAppHandle,
    operation: impl FnOnce(&DesktopAppHandle) -> T + Send + 'static,
) -> Result<T, String> {
    if on_main_thread(app) {
        return Ok(operation(app));
    }
    let (sender, receiver) = mpsc::sync_channel(1);
    let target = app.clone();
    app.run_on_main_thread(move || {
        let _ = sender.send(operation(&target));
    })
    .map_err(|error| format!("Epicenter could not reach its main thread: {error}"))?;
    receiver
        .recv_timeout(MAIN_THREAD_WAIT)
        .map_err(|_| "Epicenter's main thread did not answer in time.".to_string())
}

/// One transition, on the main thread. The machine changes the windows it
/// must while it holds the lock; the remaining effects run after.
fn transition<T>(
    app: &DesktopAppHandle,
    operation: impl FnOnce(&mut Machine, &mut dyn Windows) -> (T, Vec<Effect>),
) -> T {
    let (value, effects) = {
        let state = app.state::<Departure>();
        let mut machine = state
            .machine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let windows: &mut dyn Windows = &mut NativeWindows(app);
        operation(&mut *machine, windows)
    };
    perform(app, effects);
    value
}

/// Read without changing anything. A transition holds the lock for its whole
/// step, so a read never sees half of one.
fn read<T>(app: &DesktopAppHandle, operation: impl FnOnce(&Machine) -> T) -> T {
    let state = app.state::<Departure>();
    let machine = state
        .machine
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    operation(&*machine)
}

/// The participant windows, from the main thread.
struct NativeWindows<'a>(&'a DesktopAppHandle);

impl Windows for NativeWindows<'_> {
    fn exists(&self, participant: Participant) -> bool {
        self.0.get_webview_window(participant.label()).is_some()
    }

    fn visible(&self, participant: Participant) -> Option<bool> {
        self.0
            .get_webview_window(participant.label())?
            .is_visible()
            .ok()
    }

    fn hide(&mut self, participant: Participant) -> bool {
        self.0
            .get_webview_window(participant.label())
            .is_some_and(|window| window.hide().is_ok())
    }

    fn show(&mut self, participant: Participant, focus: bool) {
        let Some(window) = self.0.get_webview_window(participant.label()) else {
            return;
        };
        if focus {
            crate::focus(window);
        } else {
            let _ = window.show();
        }
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StatusWire {
    pub version: u64,
    pub generation: u64,
    pub phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub round: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vote: Option<&'static str>,
}

impl From<Status> for StatusWire {
    fn from(status: Status) -> Self {
        Self {
            version: status.version,
            generation: status.generation,
            phase: match status.phase {
                PhaseName::Idle => "idle",
                PhaseName::Collecting => "collecting",
                PhaseName::Granted => "granted",
                PhaseName::Leaving => "leaving",
            },
            round: status.round,
            intent: status.intent.map(|intent| match intent {
                IntentName::Quit => "quit",
                IntentName::Restart => "restart",
            }),
            vote: status.vote.map(|vote| match vote {
                Vote::None => "none",
                Vote::Asking => "asking",
                Vote::Ready => "ready",
                Vote::Discarded => "discarded",
            }),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AnswerWire {
    Asking,
    Ready,
    Cancel,
}

impl From<AnswerWire> for Answer {
    fn from(answer: AnswerWire) -> Self {
        match answer {
            AnswerWire::Asking => Self::Asking,
            AnswerWire::Ready => Self::Ready,
            AnswerWire::Cancel => Self::Cancel,
        }
    }
}

fn participant_of(window: &WebviewWindow) -> Result<Participant, String> {
    Participant::from_label(window.label())
        .ok_or_else(|| "Only Capture and Todos take part in leaving Epicenter.".to_string())
}

/// The calling page's authoritative departure status.
#[tauri::command]
pub fn departure_status(window: WebviewWindow) -> Result<StatusWire, String> {
    let participant = participant_of(&window)?;
    Ok(read(window.app_handle(), |machine| machine.status(participant)).into())
}

/// Answer the round the page read, for the page generation it read. Runs off
/// the main thread and waits for the main thread's transition.
#[tauri::command(async)]
pub fn departure_answer(
    window: WebviewWindow,
    generation: u64,
    round: u64,
    answer: AnswerWire,
) -> Result<StatusWire, String> {
    let participant = participant_of(&window)?;
    let app = window.app_handle().clone();
    dispatch_wait(&app, move |app| {
        transition(app, |machine, windows| {
            let effects = machine.answer(participant, generation, round, answer.into(), windows);
            (StatusWire::from(machine.status(participant)), effects)
        })
    })
}

/// `ExitRequested` for anything but a restart, on the main thread. Returns
/// whether to prevent it.
pub fn request_quit(app: &DesktopAppHandle, code: i32) -> bool {
    dispatch_wait(app, move |app| {
        transition(app, |machine, windows| machine.request_quit(code, windows))
    })
    .unwrap_or_else(|error| {
        // Silence is not permission: without the round, the exit waits.
        crate::append_parent_log(app, &format!("ask before quitting: {error}"));
        true
    })
}

/// A page is starting in this window, or the window was destroyed.
pub fn page_replaced(app: &DesktopAppHandle, label: &str) {
    let Some(participant) = Participant::from_label(label) else {
        return;
    };
    dispatch(app, move |app| {
        transition(app, |machine, windows| {
            ((), machine.page_replaced(participant, windows))
        })
    });
}

/// Whether the window under `label` may be created, or shown if it exists.
/// Every native path that reveals or creates a participant window asks this,
/// on the main thread, in the same step that then creates or shows it.
pub fn admits(app: &DesktopAppHandle, label: &str) -> bool {
    let Some(participant) = Participant::from_label(label) else {
        return true;
    };
    let exists = app.get_webview_window(label).is_some();
    read(app, |machine| {
        if exists {
            machine.may_reveal(participant)
        } else {
            machine.may_create()
        }
    })
}

/// A participant window was just built. Its Window-menu entry is ours, not
/// AppKit's, so that the menu cannot show it past a departure round.
pub fn adopt_window(window: &WebviewWindow) {
    if Participant::from_label(window.label()).is_none() {
        return;
    }
    #[cfg(target_os = "macos")]
    set_excluded_from_windows_menu(window);
}

pub fn prepare_restart(app: &DesktopAppHandle, sidecar: u64, request_id: String) {
    dispatch(app, move |app| {
        transition(app, |machine, windows| {
            ((), machine.prepare_restart(sidecar, request_id, windows))
        })
    });
}

pub fn prepare_cancel(app: &DesktopAppHandle, sidecar: u64, request_id: String) {
    dispatch(app, move |app| {
        transition(app, |machine, windows| {
            ((), machine.prepare_cancel(sidecar, &request_id, windows))
        })
    });
}

pub fn relaunch_abort(app: &DesktopAppHandle, sidecar: u64, request_id: String) {
    dispatch(app, move |app| {
        transition(app, |machine, windows| {
            ((), machine.relaunch_abort(sidecar, &request_id, windows))
        })
    });
}

/// Finish a valid grant by restarting. Any other request changes nothing.
pub fn relaunch(app: &DesktopAppHandle, sidecar: u64, request_id: String) {
    dispatch(app, move |app| {
        let accepted = transition(app, |machine, _| {
            let effects = machine.relaunch(sidecar, &request_id);
            (!effects.is_empty(), effects)
        });
        if !accepted {
            crate::append_parent_log(
                app,
                &format!("ignored a relaunch for {request_id}, which holds no grant"),
            );
        }
    });
}

pub fn retire_sidecar(app: &DesktopAppHandle, sidecar: u64) {
    dispatch(app, move |app| {
        transition(app, |machine, windows| {
            ((), machine.retire_sidecar(sidecar, windows))
        })
    });
}

/// Bun stopped, on the main thread. The page keeps its drafts and its native
/// folder; it is told, and shown when no round is in progress, so a person
/// can recover its text. A round keeps the visibility it is tracking.
pub fn host_stopped(app: &DesktopAppHandle, participant: Participant, window: &WebviewWindow) {
    let _ = app.emit_to(participant.label(), HOST_STOPPED_EVENT, ());
    if read(app, Machine::may_create) {
        let _ = window.show();
    }
}

fn perform(app: &DesktopAppHandle, effects: Vec<Effect>) {
    for effect in effects {
        match effect {
            Effect::Nudge(participant) => {
                let _ = app.emit_to(participant.label(), CHANGED_EVENT, ());
            }
            Effect::ArmFallback { round, arm } => {
                let app = app.clone();
                thread::spawn(move || {
                    thread::sleep(FALLBACK_DELAY);
                    ask_person(&app, round, arm);
                });
            }
            Effect::Reply {
                sidecar,
                request_id,
                result,
            } => crate::reply_relaunch_preparation(app, sidecar, &request_id, result),
            Effect::Exit(code) => app.exit(code),
            Effect::Restart => app.request_restart(),
            Effect::Report(message) => {
                app.dialog()
                    .message(message)
                    .title("Epicenter stayed open")
                    .kind(MessageDialogKind::Error)
                    .buttons(MessageDialogButtons::Ok)
                    .show(|_| {});
            }
        }
    }
}

/// The grace period passed. Ask the person about pages that never answered.
/// Silence is not permission: only an explicit discard lets the round go on,
/// and the default button keeps Epicenter open.
fn ask_person(app: &DesktopAppHandle, round: u64, arm: u64) {
    let Ok((silent, intent)) = dispatch_wait(app, move |app| {
        transition(app, |machine, _| {
            (
                (machine.fallback_due(round, arm), machine.intent()),
                Vec::new(),
            )
        })
    }) else {
        return;
    };
    if silent.is_empty() {
        return;
    }
    let names = silent
        .iter()
        .map(|(participant, _)| participant.title())
        .collect::<Vec<_>>()
        .join(" and ");
    let (verb, discard) = match intent {
        Some(IntentName::Restart) => ("restart Epicenter", "Discard and restart"),
        _ => ("quit", "Discard and quit"),
    };
    let has = if silent.len() == 1 { "has" } else { "have" };
    let message = format!(
        "{names} could not confirm that unsaved text is saved. Keep Epicenter open to recover it, or discard it and {verb}. A window that shows no unsaved text loses nothing."
    );
    let replying = app.clone();
    app.dialog()
        .message(message)
        .title(format!("{names} {has} not answered"))
        .kind(MessageDialogKind::Warning)
        .buttons(fallback_buttons(discard))
        .show_with_result(move |result| {
            decide(&replying, round, silent, chose_discard(&result, discard))
        });
}

const KEEP_OPEN: &str = "Keep open";
const CLOSE_DIALOG: &str = "Cancel";

/// The fallback dialog's buttons. The first is the Return-key default, so it
/// is "Keep open"; discarding is the second, and never the default.
///
/// There is a third button, rather than two, because of how a dialog that
/// fails or is dismissed reports itself. On macOS rfd answers `Cancel` for a
/// failed alert, a cancel response, a lost reply, or any response it does not
/// match (`rfd/src/backend/macos/message_dialog/user_alert.rs`), and the
/// dialog plugin then reports `Cancel` as the label of the button in the
/// cancel slot (`tauri-plugin-dialog/src/desktop.rs`, `show_message_dialog`).
/// With two buttons that slot held the discard label, so any failure read as
/// a discard. Here it holds a label that keeps Epicenter open.
fn fallback_buttons(discard: &str) -> MessageDialogButtons {
    MessageDialogButtons::YesNoCancelCustom(KEEP_OPEN.into(), discard.into(), CLOSE_DIALOG.into())
}

/// Whether the dialog's result is the person choosing to discard. Only the
/// discard button counts: its exact label, or the `No` slot it occupies. Keep
/// open, Cancel, a failure, and anything unexpected keep Epicenter open.
fn chose_discard(result: &MessageDialogResult, discard: &str) -> bool {
    match result {
        MessageDialogResult::No => true,
        MessageDialogResult::Custom(label) => label == discard,
        _ => false,
    }
}

/// The person's answer to the native dialog, carried to the main thread and
/// checked there against the round and the generations they were shown.
fn decide(app: &DesktopAppHandle, round: u64, listed: Vec<(Participant, u64)>, discard: bool) {
    dispatch(app, move |app| {
        transition(app, |machine, windows| {
            let effects = if discard {
                machine.discard(round, &listed, windows)
            } else {
                machine.fallback_keep(round, windows)
            };
            ((), effects)
        })
    });
}

/// AppKit lists every window in the Window menu and raises the one chosen,
/// past any check here. Capture and Todos leave that list; the menu gets
/// items of its own for them, which go through `request_window`.
#[cfg(target_os = "macos")]
fn set_excluded_from_windows_menu(window: &WebviewWindow) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let Ok(pointer) = window.ns_window() else {
        return;
    };
    // SAFETY: `ns_window` is the live NSWindow of this webview window, and
    // this runs on the main thread, where window creation happens.
    unsafe {
        let ns_window: &AnyObject = &*pointer.cast::<AnyObject>();
        let _: () = msg_send![ns_window, setExcludedFromWindowsMenu: true];
    }
}

/// The Window-menu item for a participant, if `id` is one.
#[cfg(target_os = "macos")]
pub fn window_menu_participant(id: &str) -> Option<Participant> {
    Participant::ALL
        .into_iter()
        .find(|participant| window_menu_id(*participant) == id)
}

#[cfg(target_os = "macos")]
pub(crate) fn window_menu_id(participant: Participant) -> String {
    format!("epicenter-window-{}", participant.label())
}

/// The default menu, with Capture and Todos listed in the Window menu through
/// items that go through `request_window`, since AppKit no longer lists them
/// itself. Its predefined Quit and Cmd-Q call `terminate:`, which the quit
/// guard routes through the departure round like every other AppKit quit.
#[cfg(target_os = "macos")]
pub fn menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, WINDOW_SUBMENU_ID};

    let menu = Menu::default(app)?;
    let mut window_menu = menu
        .get(WINDOW_SUBMENU_ID)
        .and_then(|item| item.as_submenu().cloned());
    if window_menu.is_none() {
        for item in menu.items()? {
            if let Some(submenu) = item.as_submenu() {
                if submenu.text()? == "Window" {
                    window_menu = Some(submenu.clone());
                    break;
                }
            }
        }
    }
    let Some(window_menu) = window_menu else {
        return Err(anyhow::anyhow!(
            "The desktop menu has no Window menu to list Capture and Todos."
        )
        .into());
    };
    window_menu.append(&PredefinedMenuItem::separator(app)?)?;
    for participant in Participant::ALL {
        window_menu.append(&MenuItem::with_id(
            app,
            window_menu_id(participant),
            participant.title(),
            true,
            None::<&str>,
        )?)?;
    }
    Ok(menu)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NoWindows;

    impl Windows for NoWindows {
        fn exists(&self, _: Participant) -> bool {
            true
        }
        fn visible(&self, _: Participant) -> Option<bool> {
            Some(true)
        }
        fn hide(&mut self, _: Participant) -> bool {
            true
        }
        fn show(&mut self, _: Participant, _: bool) {}
    }

    /// The exact JSON a page reads, for every phase. The TypeScript reader in
    /// `src/departure-wire.ts` parses the same fixture.
    #[test]
    fn status_wire_matches_the_published_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../src/departure-wire.fixture.json")).unwrap();
        let mut machine = Machine::default();
        machine.page_replaced(Participant::Capture, &mut NoWindows);
        machine.page_replaced(Participant::Todos, &mut NoWindows);
        let idle = StatusWire::from(machine.status(Participant::Capture));
        machine.request_quit(0, &mut NoWindows);
        let collecting = StatusWire::from(machine.status(Participant::Capture));
        assert_eq!(serde_json::to_value(&idle).unwrap(), fixture["valid"][0]);
        assert_eq!(
            serde_json::to_value(&collecting).unwrap(),
            fixture["valid"][1]
        );
    }

    /// The fallback dialog's answer, as the dialog plugin delivers it. Every
    /// result rfd and the plugin can produce is checked, and only the discard
    /// button authorizes a discard.
    #[test]
    fn the_fallback_dialog_discards_only_on_its_discard_button() {
        for discard in ["Discard and quit", "Discard and restart"] {
            let MessageDialogButtons::YesNoCancelCustom(first, second, third) =
                fallback_buttons(discard)
            else {
                panic!("the fallback dialog has three buttons");
            };
            // Return chooses the first button: it must keep Epicenter open.
            assert_eq!(first, KEEP_OPEN);
            assert_eq!(second, discard);
            assert_eq!(third, CLOSE_DIALOG);
            assert!(!chose_discard(&MessageDialogResult::Custom(first), discard));
            assert!(!chose_discard(&MessageDialogResult::Custom(third), discard));

            for kept in [
                // rfd's macOS alert reports a failed display, a cancel
                // response, a lost reply, and any unmatched response as
                // `Cancel`, and the plugin turns that into the cancel slot's
                // label.
                MessageDialogResult::Custom(CLOSE_DIALOG.into()),
                // The same results, should the plugin pass them through.
                MessageDialogResult::Cancel,
                MessageDialogResult::Ok,
                MessageDialogResult::Yes,
                // The default button.
                MessageDialogResult::Custom(KEEP_OPEN.into()),
                // Labels that are not this dialog's discard button.
                MessageDialogResult::Custom(String::new()),
                MessageDialogResult::Custom(discard.to_lowercase()),
                MessageDialogResult::Custom(format!("{discard} ")),
                MessageDialogResult::Custom(
                    if discard.ends_with("quit") {
                        "Discard and restart"
                    } else {
                        "Discard and quit"
                    }
                    .into(),
                ),
            ]
            .into_iter()
            .enumerate()
            {
                assert!(
                    !chose_discard(&kept.1, discard),
                    "result {} must keep Epicenter open",
                    kept.0
                );
            }
            assert!(chose_discard(
                &MessageDialogResult::Custom(discard.into()),
                discard
            ));
            assert!(chose_discard(&MessageDialogResult::No, discard));
        }
    }

    #[test]
    fn answers_are_closed_lowercase_words() {
        for (encoded, answer) in [
            ("\"asking\"", AnswerWire::Asking),
            ("\"ready\"", AnswerWire::Ready),
            ("\"cancel\"", AnswerWire::Cancel),
        ] {
            assert_eq!(serde_json::from_str::<AnswerWire>(encoded).unwrap(), answer);
        }
        for invalid in ["\"proceed\"", "\"Ready\"", "\"discarded\"", "1", "null"] {
            assert!(
                serde_json::from_str::<AnswerWire>(invalid).is_err(),
                "{invalid}"
            );
        }
    }
}
