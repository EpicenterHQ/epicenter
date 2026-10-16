//! The desktop shell's microphone recorder, which writes each recording into
//! the folder the recording window was granted from the moment it starts
//! (ADR-0543).
//!
//! A shell installs it beside `tauri-plugin-epicenter-folder`:
//!
//! ```ignore
//! tauri::Builder::default()
//!     .plugin(tauri_plugin_epicenter_folder::init())
//!     .plugin(tauri_plugin_epicenter_recorder::init())
//! ```
//!
//! A page lists the microphones with `inputs` and names one by the id it
//! answers; `open_meter` reads a microphone's level without recording, until
//! `close_meter` or until the page is gone. The page opens no microphone of
//! its own. `open_meter` and `start` ask macOS for microphone access first
//! (`permission.rs`), for every caller.
//!
//! To record, a page names a folder scope its window was granted and a
//! folder-relative path. `start` creates `<path>.wav` there and appends mono
//! PCM16 to it as the microphone captures; `stop` finalizes its header; `cancel` deletes it.
//! When the page that started a recording reloads, or its window is destroyed,
//! the recording is finalized for it, never deleted. `recover` rewrites the
//! header of any WAV a quit or crash cut off, which a page calls when it opens
//! its folder.
//!
//! There is one recorder per host and at most one recording at a time; a
//! second `start` from any window is refused `Busy`.

use std::sync::{Arc, Mutex, MutexGuard};

use log::warn;
use tauri::plugin::TauriPlugin;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, RunEvent, Runtime, WindowEvent};

mod command_names;
mod commands;
pub mod ended;
pub mod error;
mod meter;
pub mod permission;
mod rate;
pub mod recorder;
pub mod wav;

pub use command_names::COMMANDS;
pub use ended::{EndedReason, RecordingSignal};
pub use error::RecorderError;

const PLUGIN_NAME: &str = "epicenter-recorder";

/// Told whether a microphone is open, by a recording or a meter, whenever that
/// may have changed, on the main thread. A shell draws its indicator from it.
pub type OnCapturing<R> = Arc<dyn Fn(&AppHandle<R>, bool) + Send + Sync>;

/// The host's one recorder, and how the shell hears that capture changed.
pub(crate) struct Recorders<R: Runtime> {
    recorder: Mutex<recorder::Recorder>,
    on_capturing: Option<OnCapturing<R>>,
    /// Asked before any microphone opens: [`permission::ensure_access`],
    /// which tests replace.
    pub(crate) access: fn() -> recorder::Result<()>,
}

impl<R: Runtime> Recorders<R> {
    pub(crate) fn lock(&self) -> MutexGuard<'_, recorder::Recorder> {
        self.recorder
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Configures the plugin. `init` is `Builder::new().build()`.
pub struct Builder<R: Runtime> {
    on_capturing: Option<OnCapturing<R>>,
    access: fn() -> recorder::Result<()>,
}

impl<R: Runtime> Default for Builder<R> {
    fn default() -> Self {
        Self {
            on_capturing: None,
            access: permission::ensure_access,
        }
    }
}

impl<R: Runtime> Builder<R> {
    pub fn new() -> Self {
        Self::default()
    }

    /// Hear whether a microphone is open after every start, stop, cancel,
    /// finalized departure, capture that ended on its own, and meter that
    /// opened or closed.
    pub fn on_capturing(
        mut self,
        listener: impl Fn(&AppHandle<R>, bool) + Send + Sync + 'static,
    ) -> Self {
        self.on_capturing = Some(Arc::new(listener));
        self
    }

    /// Answer microphone access with `access` instead of asking the system,
    /// so a test opens no prompt.
    #[cfg(test)]
    pub(crate) fn access(mut self, access: fn() -> recorder::Result<()>) -> Self {
        self.access = access;
        self
    }

    pub fn build(self) -> TauriPlugin<R> {
        let handler = specta_builder::<R>().invoke_handler();
        let on_capturing = self.on_capturing;
        let access = self.access;
        tauri::plugin::Builder::new(PLUGIN_NAME)
            .invoke_handler(handler)
            .setup(move |app, _api| {
                app.manage(Recorders {
                    recorder: Mutex::new(recorder::Recorder::new()),
                    on_capturing,
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
                // Finalized, so the file is whole without waiting for the
                // next `recover`.
                RunEvent::Exit => {
                    if let Some(recorders) = app.try_state::<Recorders<R>>() {
                        recorders.lock().finish_held();
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
            commands::cancel::<tauri::Wry>,
            commands::recover::<tauri::Wry>,
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::DataError)
}

/// The page `window` showed is gone: a new one started loading, or the window
/// was destroyed. Whatever it was recording is finalized, since it can no
/// longer be stopped, and a `start` that page sent and that has not yet run
/// is refused.
///
/// This runs on the main thread and joins the capture worker, which is safe for
/// two reasons worth stating, because both could quietly stop being true. The
/// wait is bounded: the worker checks its command channel every loop and
/// otherwise blocks for at most 20 ms on samples, so a stop is noticed within
/// roughly that. And the worker's only main-thread interaction is sending the
/// mic level over the page's channel, which posts a script to the event loop
/// without waiting for it. That second point holds only while Tauri's
/// `tracing` feature is off: with it on, `eval_script` switches to a variant
/// that blocks on a reply from the main thread (`tauri-runtime-wry`), and a
/// worker sending while the main thread joins it would deadlock. Nothing in
/// the shells' dependency graphs enables that feature; if something ever does,
/// move this call off the main thread.
fn page_ended<R: Runtime>(app: &AppHandle<R>, window: &str) {
    let Some(recorders) = app.try_state::<Recorders<R>>() else {
        return;
    };
    let (finished, meters_closed) = recorders.lock().page_ended(window);
    if finished.is_some() || meters_closed {
        refresh_capturing(app);
    }
}

/// Bring the shell's recording indicator up to date with the recorder.
///
/// Posted to the main thread, and it reads the recorder there rather than
/// carrying a flag from here. Both halves are load-bearing.
///
/// Reading at apply time is what keeps the indicator honest. Two commands
/// finishing at once used to hand the tray two booleans that could land in
/// either order, so a stop's stale `false` could overwrite a start's `true` and
/// leave the tray asserting something that had stopped being true. A closure
/// carrying no value cannot be stale.
///
/// Posting is what keeps it from deadlocking. A tray's `set_icon` blocks until
/// the main thread runs it (`run_item_main_thread!` in tauri 2.11), and the main
/// thread takes the recorder mutex whenever a page ends, so calling the tray
/// from a thread holding that mutex hangs the pair. Here the closure takes the
/// mutex on the main thread instead, where tauri runs both the task and
/// `set_icon` inline (`send_user_message` short-circuits when it is already on
/// the main thread), so a page-ended handler refreshing the tray does not wait
/// on itself.
///
/// **The caller must have released the recorder lock.** The closure takes it,
/// and a caller still holding it would stall the main thread until it let go.
pub(crate) fn refresh_capturing<R: Runtime>(app: &AppHandle<R>) {
    let has_listener = app
        .try_state::<Recorders<R>>()
        .is_some_and(|recorders| recorders.on_capturing.is_some());
    if !has_listener {
        return;
    }
    let app = app.clone();
    let posted = app.clone().run_on_main_thread(move || {
        let Some(recorders) = app.try_state::<Recorders<R>>() else {
            return;
        };
        let capturing = recorders.lock().is_capturing();
        if let Some(listener) = &recorders.on_capturing {
            listener(&app, capturing);
        }
    });
    if let Err(error) = posted {
        warn!("Could not refresh the recording indicator: {error}");
    }
}

#[cfg(test)]
mod tests;
