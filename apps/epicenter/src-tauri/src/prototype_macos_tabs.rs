//! PROTOTYPE, THROWAWAY. Delete this module and its call sites once the
//! question below is answered; nothing in the product depends on it.
//!
//! # The question
//!
//! Can macOS native window tabs make Home, Whispering, and admitted-app
//! `WebviewWindow`s look like one tabbed window while each keeps its own label,
//! capability file, recorder ownership, and the ability to be torn off and used
//! side by side?
//!
//! # What this measures
//!
//! Three modes, chosen by `EPICENTER_PROTOTYPE_TABS`, so one build can A/B the
//! same session:
//!
//! - unset or `off`: today's behavior, untouched.
//! - `auto`: the stable Tauri surface only. Every Home-launchable window is
//!   built with one shared `tabbing_identifier`, and the app-global automatic
//!   tabbing flag is re-enabled first (see below). Nothing else. This is the
//!   variant worth shipping if it works.
//! - `force`: `auto`, plus an explicit AppKit `addTabbedWindow:ordered:` when a
//!   window is revealed while another window of the group is already on screen.
//!   This is the variant that reveals whether AppKit intervention is what
//!   actually produces the tabs.
//!
//! # Two facts this module exists to expose
//!
//! `allowsAutomaticWindowTabbing` is a *class* property, not a per-window one,
//! and `tauri-runtime-wry` sets it to `false` for the whole application the
//! first time any window is built without a tabbing identifier, or transparent,
//! or undecorated. The recording overlay is transparent and undecorated and is
//! created before every surface, so by the time Home exists the application has
//! already opted out of tabbing. `allow_automatic_tabbing` undoes that.
//!
//! `tabbingMode` defaults to automatic, which means AppKit consults the *user's*
//! System Settings tabbing preference. `describe` logs that preference so the
//! observation is never confused with a bug.

use objc2::MainThreadMarker;
use objc2_app_kit::{NSWindow, NSWindowOrderingMode, NSWindowUserTabbingPreference};
use tauri::{Manager, WebviewWindow, Wry};

use crate::{DesktopAppHandle, APP_WINDOW_PREFIX};

/// One identifier for every window Home can put in front of a person. The
/// recording overlay is deliberately not in the group: it is a non-activating
/// panel, not a place a user navigates to.
const TABBING_IDENTIFIER: &str = "so.epicenter.prototype.tabs";

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Off,
    /// Shared tabbing identifier only.
    Auto,
    /// Shared identifier plus explicit `addTabbedWindow:ordered:` on reveal.
    Force,
}

pub fn mode() -> Mode {
    match std::env::var("EPICENTER_PROTOTYPE_TABS").as_deref() {
        Ok("auto") => Mode::Auto,
        Ok("force") => Mode::Force,
        _ => Mode::Off,
    }
}

/// The identifier a Home-launchable window should be built with, or `None` when
/// the prototype is off and the build must behave exactly as it does today.
pub fn identifier() -> Option<&'static str> {
    match mode() {
        Mode::Off => None,
        Mode::Auto | Mode::Force => Some(TABBING_IDENTIFIER),
    }
}

/// Re-enable application-wide automatic tabbing before building a window that
/// wants to be a tab.
///
/// The recording overlay turned it off for the whole application, and the flag
/// is read when a window is ordered in, not when it is created, so this has to
/// run on the path that builds tabbed windows rather than once at startup.
pub fn allow_automatic_tabbing() {
    if mode() == Mode::Off {
        return;
    }
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    NSWindow::setAllowsAutomaticWindowTabbing(true, mtm);
}

/// In `force` mode, put `window` into the tab group of another already-visible
/// window that shares the identifier.
///
/// Called immediately before the window is revealed, because
/// `addTabbedWindow:ordered:` both joins the group and orders the window in.
/// A window with no visible sibling is left alone: it becomes the group's first
/// window by being the only one.
pub fn adopt_into_group(app: &DesktopAppHandle, window: &WebviewWindow<Wry>) {
    if mode() != Mode::Force {
        return;
    }
    let Some(anchor) = visible_sibling(app, window.label()) else {
        return;
    };
    let (Ok(anchor), Ok(joining)) = (ns_window(&anchor), ns_window(window)) else {
        return;
    };
    unsafe {
        (*anchor).addTabbedWindow_ordered(&*joining, NSWindowOrderingMode::Above);
    }
}

/// Another window of the group that is on screen right now, preferring the
/// focused one so a tab joins where the user is looking.
fn visible_sibling(app: &DesktopAppHandle, label: &str) -> Option<WebviewWindow<Wry>> {
    let candidates: Vec<WebviewWindow<Wry>> = app
        .webview_windows()
        .into_iter()
        .filter(|(other, _)| other != label && in_group(other))
        .map(|(_, window)| window)
        .filter(|window| window.is_visible().unwrap_or(false))
        .collect();
    candidates
        .iter()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| candidates.first())
        .cloned()
}

/// The window labels the prototype groups: the compiled surfaces plus every
/// admitted-app window. Not the recording overlay.
fn in_group(label: &str) -> bool {
    label.starts_with(APP_WINDOW_PREFIX) || crate::Surface::from_id(label).is_some()
}

fn ns_window(window: &WebviewWindow<Wry>) -> Result<*mut NSWindow, ()> {
    window
        .ns_window()
        .map(|pointer| pointer.cast::<NSWindow>())
        .map_err(|_| ())
}

/// Write what macOS actually did to the host log, so a run is readable without
/// guessing: the user's tabbing preference, whether the application still
/// allows automatic tabbing, and how many windows each group window sees in its
/// own tab bar.
pub fn describe(app: &DesktopAppHandle, moment: &str) {
    if mode() == Mode::Off {
        return;
    }
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let preference = match NSWindow::userTabbingPreference(mtm) {
        NSWindowUserTabbingPreference::Manual => "manual",
        NSWindowUserTabbingPreference::Always => "always",
        NSWindowUserTabbingPreference::InFullScreen => "in-full-screen",
        _ => "unknown",
    };
    let allows = NSWindow::allowsAutomaticWindowTabbing(mtm);

    let mut windows: Vec<String> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| in_group(label))
        .map(|(label, window)| {
            let visible = window.is_visible().unwrap_or(false);
            let tabbed = match ns_window(&window) {
                Ok(pointer) => unsafe {
                    (*pointer)
                        .tabbedWindows()
                        .map_or("no-tab-bar".to_string(), |group| group.len().to_string())
                },
                Err(()) => "unavailable".to_string(),
            };
            format!("{label}(visible={visible},tabbed={tabbed})")
        })
        .collect();
    windows.sort();

    crate::append_parent_log(
        app,
        &format!(
            "[prototype-tabs] {moment}: preference={preference} allowsAutomaticTabbing={allows} {}",
            windows.join(" ")
        ),
    );
}
