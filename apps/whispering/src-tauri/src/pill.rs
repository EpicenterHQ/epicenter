//! The floating pill's window: 240 by 40, transparent, over every app and
//! every Space, at the bottom centre of the screen with the pointer. It
//! opens hidden at startup on the page `/pill`; that page shows or hides it
//! through `pill_show` as the pill has something to say.
//!
//! On a Mac it is a non-activating `NSPanel`. A plain always-on-top window
//! still activates Whispering when clicked, which would pull the main window
//! over the app the person is dictating into each time they press Stop.
//! The panel takes clicks without activating anything. Elsewhere it is a
//! plain always-on-top window without a frame.

use tauri::{AppHandle, Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindow};

/// The window's label, which `capabilities/pill.json` selects and the page's events name.
pub const LABEL: &str = "pill";
/// Matches the pill's widest state (`Pill.svelte`, `max-w-60`).
const WIDTH: f64 = 240.0;
const HEIGHT: f64 = 40.0;
/// How far above the bottom of the screen's usable area the pill sits, clear of the Dock.
const ABOVE_BOTTOM: f64 = 72.0;

fn page() -> WebviewUrl {
    WebviewUrl::App("pill".into())
}

#[cfg(target_os = "macos")]
tauri_nspanel::tauri_panel! {
    panel!(PillPanel {
        config: {
            can_become_key_window: false,
            is_floating_panel: true
        }
    })
}

/// Open the pill's window, hidden.
#[cfg(target_os = "macos")]
pub fn open(app: &AppHandle) -> tauri::Result<()> {
    use tauri_nspanel::{CollectionBehavior, PanelBuilder, PanelLevel, StyleMask};

    let panel = PanelBuilder::<_, PillPanel>::new(app, LABEL)
        .url(page())
        .title("Whispering pill")
        .size(tauri::Size::Logical(tauri::LogicalSize { width: WIDTH, height: HEIGHT }))
        .level(PanelLevel::Status)
        // This style bit is what keeps a click from activating Whispering;
        // `no_activate` covers only opening the panel.
        .style_mask(StyleMask::empty().nonactivating_panel())
        .has_shadow(false)
        .transparent(true)
        .no_activate(true)
        // A click lands on Stop even though the panel is never the active window.
        .with_window(|window| window.decorations(false).transparent(true).accept_first_mouse(true))
        .collection_behavior(CollectionBehavior::new().can_join_all_spaces().full_screen_auxiliary())
        .build()?;
    panel.hide();
    Ok(())
}

/// Open the pill's window, hidden.
#[cfg(not(target_os = "macos"))]
pub fn open(app: &AppHandle) -> tauri::Result<()> {
    tauri::WebviewWindowBuilder::new(app, LABEL, page())
        .title("Whispering pill")
        .inner_size(WIDTH, HEIGHT)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build()?;
    Ok(())
}

/// Show the pill's window at the bottom centre of the screen with the
/// pointer, or hide it. It never takes focus from the app in front.
#[tauri::command]
pub fn pill_show(app: AppHandle, shown: bool) -> Result<(), String> {
    let window = app
        .get_webview_window(LABEL)
        .ok_or("The pill's window is not open.")?;
    if shown {
        place(&app, &window)?;
    }
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;
        let panel = app
            .get_webview_panel(LABEL)
            .map_err(|_| "The pill's window is not open.".to_string())?;
        if shown {
            panel.show();
        } else {
            panel.hide();
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let done = if shown { window.show() } else { window.hide() };
        done.map_err(|error| format!("The pill could not be shown: {error}"))
    }
}

/// Move the window to the bottom centre of the usable area of the screen
/// the pointer is on, or of the main screen when that cannot be told.
fn place<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) -> Result<(), String> {
    let pointer = app.cursor_position().ok();
    let screen = pointer
        .and_then(|at| app.monitor_from_point(at.x, at.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or("No screen to show the pill on.")?;
    let scale = screen.scale_factor();
    let area = screen.work_area();
    let width = (WIDTH * scale) as i32;
    let height = (HEIGHT * scale) as i32;
    let x = area.position.x + (area.size.width as i32 - width) / 2;
    let y = area.position.y + area.size.height as i32 - height - (ABOVE_BOTTOM * scale) as i32;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| format!("The pill could not be placed: {error}"))
}
