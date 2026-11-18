//! Whispering's microphone recorder, which writes each take at its path in
//! the app's folder from the moment it starts and finishes it there at Stop
//! (ADR-0962).
//!
//! A shell installs it beside `tauri-plugin-fs`, whose scope says which
//! folders it may record into:
//!
//! ```ignore
//! tauri::Builder::default()
//!     .plugin(tauri_plugin_fs::init())
//!     .plugin(tauri_plugin_epicenter_recorder::init())
//! ```
//!
//! A page lists the microphones with `inputs` and names one by the id it
//! answers; `open_meter` reads a microphone's level without recording, until
//! `close_meter` or until the page is gone. The page opens no microphone of
//! its own. `open_meter` and `start` ask macOS for microphone access first
//! (`permission.rs`), for every caller.
//!
//! To record, a page names its folder, which the file system scope must
//! allow, and the recording's id. `start` creates the take at
//! `recordings/<id>.webm` in the folder, never over a file there, and
//! encodes the microphone into it as Opus as it captures, writing it a
//! second at a time (`opus`, `webm`); `stop` finishes it in place and
//! answers its id and length. Nothing deletes a recording's audio once
//! capture has begun, and nothing repairs a take a crash cut off: it plays
//! from its whole seconds as it is. When the page that started a recording
//! reloads, or its window is destroyed, or the app exits, the recording is
//! finished for it. A recording adds no Close or Quit warning.
//!
//! There is one recorder per host and at most one recording at a time; a
//! second `start` from any window is refused `Busy`.

use std::sync::{Mutex, MutexGuard};

use tauri::plugin::TauriPlugin;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, RunEvent, Runtime, WindowEvent};

#[cfg(test)]
mod command_names;
#[cfg(test)]
use command_names::COMMANDS;
mod commands;
mod ended;
mod error;
mod meter;
mod opus;
mod permission;
mod rate;
mod recorder;
mod webm;

#[cfg(test)]
use error::RecorderError;

const PLUGIN_NAME: &str = "epicenter-recorder";

/// The host's one recorder.
pub(crate) struct Recorders {
    recorder: Mutex<recorder::Recorder>,
    /// Asked before any microphone opens: [`permission::ensure_access`],
    /// which tests replace.
    pub(crate) access: fn() -> recorder::Result<()>,
}

impl Recorders {
    pub(crate) fn lock(&self) -> MutexGuard<'_, recorder::Recorder> {
        self.recorder
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Configures the plugin. `init` is `Builder::new().build()`.
pub struct Builder {
    access: fn() -> recorder::Result<()>,
}

impl Default for Builder {
    fn default() -> Self {
        Self {
            access: permission::ensure_access,
        }
    }
}

impl Builder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Answer microphone access with `access` instead of asking the system,
    /// so a test opens no prompt.
    #[cfg(test)]
    pub(crate) fn access(mut self, access: fn() -> recorder::Result<()>) -> Self {
        self.access = access;
        self
    }

    pub fn build<R: Runtime>(self) -> TauriPlugin<R> {
        let handler = specta_builder::<R>().invoke_handler();
        let access = self.access;
        tauri::plugin::Builder::new(PLUGIN_NAME)
            .invoke_handler(handler)
            .setup(move |app, _api| {
                app.manage(Recorders {
                    recorder: Mutex::new(recorder::Recorder::new()),
                    access,
                });
                Ok(())
            })
            .on_page_load(|webview, payload| {
                if payload.event() == PageLoadEvent::Started {
                    page_ended(webview.app_handle(), webview.label());
                }
            })
            .on_event(|app, event| match event {
                RunEvent::WindowEvent {
                    label,
                    event: WindowEvent::Destroyed,
                    ..
                } => page_ended(app, label),
                // Finished, so the take states its length.
                RunEvent::Exit => {
                    if let Some(recorders) = app.try_state::<Recorders>() {
                        recorders.lock().shutdown();
                    }
                }
                _ => {}
            })
            .build()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new().build()
}

/// The typed command contract. The TypeScript bindings in
/// `../recorder/src/native/bindings.gen.ts` are generated from this builder.
fn specta_builder<R: Runtime>() -> tauri_specta::Builder<R> {
    tauri_specta::Builder::<R>::new()
        .plugin_name(PLUGIN_NAME)
        .commands(tauri_specta::collect_commands![
            commands::inputs,
            commands::open_meter::<tauri::Wry>,
            commands::close_meter::<tauri::Wry>,
            commands::start::<tauri::Wry>,
            commands::stop::<tauri::Wry>,
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::DataError)
}

/// The page `window` showed is gone: a new one started loading, or the window
/// was destroyed. Whatever it was recording is finished in place, since it
/// can no longer be stopped, and a `start` that page sent and that has not
/// yet run is refused.
///
/// This runs on the main thread and joins the capture worker, which is safe for
/// two reasons worth stating, because both could quietly stop being true. The
/// wait is bounded: the worker checks its command channel every loop and
/// otherwise blocks for at most 20 ms on samples, so a stop is noticed within
/// roughly that. And the worker never waits on the main thread: it sends
/// nothing to the page (an ending is reported from a thread of its own).
fn page_ended<R: Runtime>(app: &AppHandle<R>, window: &str) {
    if let Some(recorders) = app.try_state::<Recorders>() {
        recorders.lock().page_ended(window);
    }
}

#[cfg(test)]
mod tests;
