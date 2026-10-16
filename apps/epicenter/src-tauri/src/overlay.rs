//! macOS-only: the recording overlay as a non-activating `NSPanel`.
//!
//! A plain always-on-top `WebviewWindow` still activates the app when clicked:
//! `focusable: false` only blocks keyboard focus, not application activation.
//! That would yank the Whispering window forward every time the user clicks
//! stop/cancel on the overlay while dictating into another app. An `NSPanel`
//! with `can_become_key_window: false` never activates the app, so the
//! overlay's buttons work without stealing focus or raising the Whispering window.
//!
//! The panel is created hidden at startup and registered under the same
//! `recording-overlay` label the JS window manager looks up, so the frontend
//! drives show/hide/position/levels exactly as it does for the plain
//! `WebviewWindow` on other platforms (the manager already prefers an existing
//! window via `getByLabel` before creating one).

// `Manager` is needed in scope because the `tauri_panel!` macro expands to code
// that calls `.app_handle()` on the window.
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, WebviewUrl};
use tauri_nspanel::{tauri_panel, CollectionBehavior, PanelBuilder, PanelLevel, StyleMask};

// Must stay in sync with `RECORDING_OVERLAY_WINDOW_LABEL` and the pill's size in
// Whispering's `recording-overlay/window-manager.tauri.ts`.
pub const WINDOW_LABEL: &str = "recording-overlay";
const OVERLAY_WIDTH: f64 = 224.0;
const OVERLAY_HEIGHT: f64 = 40.0;

tauri_panel! {
    panel!(RecordingOverlayPanel {
        config: {
            can_become_key_window: false,
            is_floating_panel: true
        }
    })
}

/// Create the recording overlay panel, hidden. The frontend repositions and
/// shows it once recording starts, so the initial position here is unused.
pub fn create_recording_overlay(app: &AppHandle, url: tauri::Url) -> tauri::Result<()> {
    if app.get_webview_window(WINDOW_LABEL).is_some() {
        return Ok(());
    }

    let panel = PanelBuilder::<_, RecordingOverlayPanel>::new(app, WINDOW_LABEL)
        .url(WebviewUrl::CustomProtocol(url))
        .title("Recording")
        .position(tauri::Position::Logical(tauri::LogicalPosition {
            x: 0.0,
            y: 0.0,
        }))
        .size(tauri::Size::Logical(tauri::LogicalSize {
            width: OVERLAY_WIDTH,
            height: OVERLAY_HEIGHT,
        }))
        .level(PanelLevel::Status)
        // Borderless + non-activating: clicking the panel (e.g. the stop button)
        // must never activate Epicenter or raise its Whispering window while the
        // user is dictating into another app. `no_activate` only covers window
        // creation; this style bit is what makes clicks non-activating.
        .style_mask(StyleMask::empty().nonactivating_panel())
        .has_shadow(false)
        .transparent(true)
        .no_activate(true)
        // Round the panel itself to the pill shape (radius = half the height) so
        // there is no square window backing peeking past the CSS pill's rounded
        // corners.
        .corner_radius(OVERLAY_HEIGHT / 2.0)
        // accept_first_mouse so a click lands on the stop/cancel button even
        // when the panel is not the active window (it never activates).
        .with_window(move |w| {
            w.decorations(false)
                .transparent(true)
                .accept_first_mouse(true)
                .on_navigation(|url| crate::scheme::is_allowed_navigation(WINDOW_LABEL, url))
                .on_new_window(|_, _| NewWindowResponse::Deny)
        })
        .collection_behavior(
            CollectionBehavior::new()
                .can_join_all_spaces()
                .full_screen_auxiliary(),
        )
        .build()?;
    panel.hide();
    Ok(())
}
