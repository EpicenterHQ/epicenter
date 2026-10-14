//! AppKit's `terminate:` routed through the departure round.
//!
//! Tao's application delegate (`TaoAppDelegateParent`, Tao 0.35) answers
//! `applicationWillTerminate:` but not `applicationShouldTerminate:`, so AppKit
//! terminates at once for every `terminate:` caller: the app menu's Quit and
//! Cmd-Q, the Dock's Quit, logout, restart, shutdown, and a `quit` Apple
//! event. `applicationWillTerminate:` then ends Tao's loop and Tauri delivers
//! `RunEvent::Exit` without `ExitRequested`, so no round asks the pages and a
//! draft not yet submitted is lost.
//!
//! This adds that one method to Tao's delegate class, once, during setup on
//! the main thread. It replaces no delegate and touches no ivar. It answers
//! from the round:
//!
//! - no participant window exists: terminate now, as before;
//! - otherwise, while idle, collecting, or granted: cancel, and request an
//!   ordinary exit, which raises `ExitRequested` and runs the round, or asks
//!   it again, or is refused as busy;
//! - while leaving: cancel and request nothing. Tauri's own exit stops the
//!   loop with `stop:` and never calls `terminate:`.
//!
//! A cancelled logout stays cancelled: macOS tells loginwindow the app
//! refused, and the person logs out again once the round has finished.
//!
//! The hook runs inside an AppKit callback and must not unwind: nothing in it
//! unwraps, and an exit request only posts to the event loop.
//!
//! # Where terminating now is safe
//!
//! Answering now makes AppKit call `applicationWillTerminate:` before
//! `terminate:` returns. Tao handles that with `AppState::exit`, which takes
//! Tao's event-handler mutex (`tao/src/platform_impl/macos/app_state.rs`,
//! `Handler::handle_nonuser_event`). Tao holds that same mutex while it runs
//! Tauri's callbacks, `run_on_main_thread` tasks included, and the mutex is
//! not reentrant. So `terminate:` answered now from inside a Tauri callback
//! blocks the main thread forever: no Exit, no Folder drain. AppKit's own
//! quits (menu actions, the Dock, logout, a `quit` Apple event) arrive from
//! the run loop outside Tao's callbacks, where Tao's exit path runs and the
//! Folder plugin drains on Exit. Nothing in this app calls `terminate:`, and
//! nothing may: code in a Tauri callback that wants to quit calls `app.exit`.
//! A modal session is the nesting identified so far through which AppKit
//! could deliver `terminate:` inside a callback, so while one runs the guard
//! never answers now: it cancels and requests the ordinary exit, which only
//! posts. Other nested run loops are not ruled out.

use std::ffi::{c_char, c_void, CStr};
use std::sync::OnceLock;

use objc2::msg_send;
use objc2::runtime::AnyObject;
use tauri::Manager;

use super::machine::TerminateReply;
use super::{Departure, NativeWindows};
use crate::DesktopAppHandle;

/// `NSApplicationTerminateReply` is an `NSUInteger`.
const TERMINATE_CANCEL: usize = 0;
const TERMINATE_NOW: usize = 1;
const _: () = assert!(
    std::mem::size_of::<usize>() == 8,
    "NSUInteger is 64-bit and encoded as Q"
);

const DELEGATE_CLASS: &CStr = c"TaoAppDelegateParent";
const SELECTOR: &CStr = c"applicationShouldTerminate:";
/// Returns `NSApplicationTerminateReply`; takes self, `_cmd`, the sender.
const TYPES: &CStr = c"Q@:@";

type ShouldTerminate = extern "C" fn(*mut c_void, *const c_void, *mut c_void) -> usize;

/// The application the hook answers for. Set once, before the method exists,
/// and kept for the life of the process.
static APP: OnceLock<DesktopAppHandle> = OnceLock::new();

#[link(name = "objc")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> *mut c_void;
    fn object_getClass(object: *mut c_void) -> *mut c_void;
    fn class_getName(class: *mut c_void) -> *const c_char;
    fn sel_registerName(name: *const c_char) -> *const c_void;
    fn class_getInstanceMethod(class: *mut c_void, selector: *const c_void) -> *mut c_void;
    /// `BOOL` is one byte on every Apple target; read it as a byte.
    fn class_addMethod(
        class: *mut c_void,
        selector: *const c_void,
        implementation: *const c_void,
        types: *const c_char,
    ) -> u8;
}

extern "C" fn should_terminate(
    _delegate: *mut c_void,
    _selector: *const c_void,
    _sender: *mut c_void,
) -> usize {
    let Some(app) = APP.get() else {
        return TERMINATE_NOW;
    };
    let reply = match reply(app) {
        TerminateReply::Now if modal_session() => TerminateReply::CancelAndQuit,
        reply => reply,
    };
    match reply {
        TerminateReply::Now => TERMINATE_NOW,
        TerminateReply::Cancel => TERMINATE_CANCEL,
        TerminateReply::CancelAndQuit => {
            // Posts `RequestExit` through the event-loop proxy and returns.
            app.exit(0);
            TERMINATE_CANCEL
        }
    }
}

fn reply(app: &DesktopAppHandle) -> TerminateReply {
    let Some(state) = app.try_state::<Departure>() else {
        return TerminateReply::Now;
    };
    // Transitions run on this thread and never call `terminate:`, so the
    // lock is free or briefly held by a read on another thread.
    let machine = state
        .machine
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    machine.terminate_reply(&NativeWindows(app))
}

/// Whether AppKit is running a modal session, inside which `terminate:` may
/// arrive nested in a Tauri callback.
fn modal_session() -> bool {
    // SAFETY: the hook runs on the main thread; `NSApp` is checked first.
    unsafe {
        let application = shared_application();
        if application.is_null() {
            return false;
        }
        let application: &AnyObject = &*application;
        let window: *mut AnyObject = msg_send![application, modalWindow];
        !window.is_null()
    }
}

/// `NSApp`, or null before AppKit has one.
unsafe fn shared_application() -> *mut AnyObject {
    let class = objc_getClass(c"NSApplication".as_ptr());
    if class.is_null() {
        return std::ptr::null_mut();
    }
    let class: &AnyObject = &*class.cast::<AnyObject>();
    msg_send![class, sharedApplication]
}

/// `NSApp.delegate`, or null.
unsafe fn application_delegate() -> *mut AnyObject {
    let application = shared_application();
    if application.is_null() {
        return std::ptr::null_mut();
    }
    let application: &AnyObject = &*application;
    msg_send![application, delegate]
}

unsafe fn class_name(class: *mut c_void) -> String {
    let name = class_getName(class);
    if name.is_null() {
        return "an unnamed class".into();
    }
    CStr::from_ptr(name).to_string_lossy().into_owned()
}

unsafe fn responds(delegate: *mut AnyObject) -> bool {
    let delegate: &AnyObject = &*delegate;
    msg_send![delegate, respondsToSelector: objc2::sel!(applicationShouldTerminate:)]
}

/// Add `applicationShouldTerminate:` to Tao's delegate class. Main thread,
/// once, during setup. Any surprise is an error, which fails startup: a guard
/// that is silently missing would let a quit lose drafts again.
pub fn install(app: &DesktopAppHandle) -> Result<(), String> {
    if objc2::MainThreadMarker::new().is_none() {
        return Err("The quit guard must be installed on the main thread.".into());
    }
    if APP.get().is_some() {
        return Err("The quit guard is already installed.".into());
    }
    // SAFETY: main thread; every pointer is checked before use; the class is
    // Tao's registered delegate class and only gains a method it lacks.
    unsafe {
        let delegate = application_delegate();
        if delegate.is_null() {
            return Err("AppKit has no application delegate to guard quitting.".into());
        }
        let expected = objc_getClass(DELEGATE_CLASS.as_ptr());
        if expected.is_null() {
            return Err("Tao's application delegate class is not registered.".into());
        }
        let actual = object_getClass(delegate.cast());
        if actual != expected {
            return Err(format!(
                "The application delegate is {}, not Tao's TaoAppDelegateParent, so quitting cannot be guarded.",
                class_name(actual)
            ));
        }
        let selector = sel_registerName(SELECTOR.as_ptr());
        if !class_getInstanceMethod(expected, selector).is_null() {
            return Err(
                "Tao's application delegate already answers applicationShouldTerminate:, so the quit guard must be revisited."
                    .into(),
            );
        }
        if APP.set(app.clone()).is_err() {
            return Err("The quit guard is already installed.".into());
        }
        let implementation = should_terminate as ShouldTerminate as *const c_void;
        if class_addMethod(expected, selector, implementation, TYPES.as_ptr()) == 0 {
            return Err("AppKit refused the quit guard method.".into());
        }
        if class_getInstanceMethod(expected, selector).is_null() || !responds(delegate) {
            return Err("The application delegate does not answer the quit guard.".into());
        }
    }
    Ok(())
}
