//! Native transcript delivery and synthetic keyboard commands for Whispering.

use enigo::{Direction, Enigo, Key, Keyboard, Settings};
#[cfg(target_os = "macos")]
use tauri::Manager;
use tauri_plugin_clipboard_manager::ClipboardExt;

/// Where `write_text` left the transcript.
#[derive(Clone, Copy, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum WriteTextOutcome {
    /// The synthetic paste landed at the cursor.
    Pasted,
    /// Delivery could not paste, so the transcript remains on the clipboard.
    LeftOnClipboard,
}

/// Gives the freshly built event tap a moment to start before posting paste.
const PRE_PASTE_SETTLE: std::time::Duration = std::time::Duration::from_millis(50);

/// Gives the target application time to consume paste before clipboard restore.
const PRE_RESTORE_SETTLE: std::time::Duration = std::time::Duration::from_millis(100);

/// Delivers text to the cursor, falling back to the clipboard when it cannot.
///
/// With `keep_on_clipboard`, the transcript is the intended final clipboard
/// state. Otherwise this command borrows the clipboard, pastes, then restores
/// the exact previous macOS pasteboard or the previous text on other platforms.
#[tauri::command]
#[specta::specta]
pub async fn write_text(
    app: tauri::AppHandle,
    text: String,
    keep_on_clipboard: bool,
) -> Result<WriteTextOutcome, String> {
    #[cfg(target_os = "macos")]
    let can_paste = {
        use crate::keyboard::{DictationCapability, TapController};
        app.state::<TapController>().capability() == DictationCapability::Active
    };
    #[cfg(not(target_os = "macos"))]
    let can_paste = true;

    if !can_paste {
        app.clipboard()
            .write_text(&text)
            .map_err(|error| format!("Failed to write to clipboard: {error}"))?;
        return Ok(WriteTextOutcome::LeftOnClipboard);
    }

    if keep_on_clipboard {
        app.clipboard()
            .write_text(&text)
            .map_err(|error| format!("Failed to write to clipboard: {error}"))?;

        tokio::time::sleep(PRE_PASTE_SETTLE).await;
        if simulate_paste().is_err() {
            return Ok(WriteTextOutcome::LeftOnClipboard);
        }
        return Ok(WriteTextOutcome::Pasted);
    }

    #[cfg(target_os = "macos")]
    let snapshot = crate::clipboard::snapshot();
    #[cfg(not(target_os = "macos"))]
    let snapshot = app.clipboard().read_text().ok();

    #[cfg(target_os = "macos")]
    if !crate::clipboard::write_concealed(&text) {
        return Err("Failed to write to clipboard".to_string());
    }
    #[cfg(not(target_os = "macos"))]
    app.clipboard()
        .write_text(&text)
        .map_err(|error| format!("Failed to write to clipboard: {error}"))?;

    tokio::time::sleep(PRE_PASTE_SETTLE).await;
    if simulate_paste().is_err() {
        return Ok(WriteTextOutcome::LeftOnClipboard);
    }

    tokio::time::sleep(PRE_RESTORE_SETTLE).await;

    #[cfg(target_os = "macos")]
    crate::clipboard::restore(&snapshot);
    #[cfg(not(target_os = "macos"))]
    if let Some(content) = snapshot {
        app.clipboard()
            .write_text(&content)
            .map_err(|error| format!("Failed to restore clipboard: {error}"))?;
    }

    Ok(WriteTextOutcome::Pasted)
}

/// Posts a synthetic paste with layout-independent key codes.
fn simulate_paste() -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    let (modifier, v_key) = (Key::Meta, Key::Other(9));
    #[cfg(target_os = "windows")]
    let (modifier, v_key) = (Key::Control, Key::Other(0x56));
    #[cfg(target_os = "linux")]
    let (modifier, v_key) = (Key::Control, Key::Unicode('v'));

    let press_modifier = enigo.key(modifier, Direction::Press);
    let press_v = enigo.key(v_key, Direction::Press);
    let release_v = enigo.key(v_key, Direction::Release);
    let release_modifier = enigo.key(modifier, Direction::Release);
    press_modifier
        .and(press_v)
        .and(release_v)
        .and(release_modifier)
        .map_err(|error| format!("Failed to simulate paste: {error}"))
}

/// Simulates pressing the Enter/Return key.
#[tauri::command]
#[specta::specta]
pub async fn simulate_enter_keystroke() -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|error| error.to_string())?;
    enigo
        .key(Key::Return, Direction::Click)
        .map_err(|error| format!("Failed to simulate Enter key: {error}"))?;
    Ok(())
}

/// Simulates the platform copy shortcut with layout-independent key codes.
#[tauri::command]
#[specta::specta]
pub async fn simulate_copy_keystroke() -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|error| error.to_string())?;

    #[cfg(target_os = "macos")]
    let (modifier, c_key) = (Key::Meta, Key::Other(8));
    #[cfg(target_os = "windows")]
    let (modifier, c_key) = (Key::Control, Key::Other(0x43));
    #[cfg(target_os = "linux")]
    let (modifier, c_key) = (Key::Control, Key::Unicode('c'));

    enigo
        .key(modifier, Direction::Press)
        .map_err(|error| format!("Failed to press modifier key: {error}"))?;
    enigo
        .key(c_key, Direction::Press)
        .map_err(|error| format!("Failed to press C key: {error}"))?;
    enigo
        .key(c_key, Direction::Release)
        .map_err(|error| format!("Failed to release C key: {error}"))?;
    enigo
        .key(modifier, Direction::Release)
        .map_err(|error| format!("Failed to release modifier key: {error}"))?;

    Ok(())
}
