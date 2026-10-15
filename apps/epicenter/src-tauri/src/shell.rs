use std::collections::HashSet;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::image::Image;
use tauri::menu::MenuBuilder;
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Wry};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState as NativeShortcutState};
use tauri_specta::Event;

use crate::{request_window, BuiltInApp, DesktopAppHandle};

const TRAY_ID: &str = "epicenter-tray";
const WHISPERING_WINDOW: &str = "whispering";

#[derive(Clone, Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GlobalShortcutRegistration {
    pub command_id: String,
    pub accelerator: String,
}

#[derive(Clone, Copy, Debug, Serialize, specta::Type)]
pub enum GlobalShortcutState {
    Pressed,
    Released,
}

#[derive(Clone, Debug, Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct GlobalShortcutTriggered {
    pub command_id: String,
    pub state: GlobalShortcutState,
}

#[derive(Default)]
pub struct GlobalShortcutRegistry(Mutex<Vec<GlobalShortcutRegistration>>);

pub fn create_tray(app: &DesktopAppHandle) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text("show-folders", "Show Folders")
        .text("show-settings", "Show Settings")
        .text("show-whispering", "Show Whispering")
        .separator()
        .text("quit", "Quit Epicenter")
        .build()?;
    let icon = tray_icon(false)?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Epicenter")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show-folders" => request_window(app, BuiltInApp::Folders),
            "show-settings" => request_window(app, BuiltInApp::Home),
            "show-whispering" => request_window(app, BuiltInApp::Whispering),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

pub fn set_tray_recording_state(app: &AppHandle, recording: bool) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    match tray_icon(recording).and_then(|icon| tray.set_icon(Some(icon))) {
        Ok(()) => {}
        Err(error) => log::warn!("update Epicenter tray recording state: {error}"),
    }
}

fn tray_icon(recording: bool) -> tauri::Result<Image<'static>> {
    let bytes = if recording {
        include_bytes!("../recorder-state-icons/red_large_square.png").as_slice()
    } else {
        include_bytes!("../recorder-state-icons/studio_microphone.png").as_slice()
    };
    Image::from_bytes(bytes)
}

#[tauri::command]
#[specta::specta]
pub fn replace_global_shortcuts(
    app: AppHandle<Wry>,
    registry: tauri::State<'_, GlobalShortcutRegistry>,
    registrations: Vec<GlobalShortcutRegistration>,
) -> Result<(), String> {
    validate_registrations(&registrations)?;
    let mut current = registry
        .0
        .lock()
        .map_err(|_| "global shortcut registry lock poisoned".to_string())?;
    let previous = current.clone();

    app.global_shortcut()
        .unregister_all()
        .map_err(|error| error.to_string())?;
    if let Err(error) = register_all(&app, &registrations) {
        let _ = app.global_shortcut().unregister_all();
        if let Err(rollback_error) = register_all(&app, &previous) {
            log::error!(
                "restore Epicenter global shortcuts after failed replacement: {rollback_error}"
            );
        }
        return Err(error);
    }

    *current = registrations;
    Ok(())
}

fn validate_registrations(registrations: &[GlobalShortcutRegistration]) -> Result<(), String> {
    let mut command_ids = HashSet::new();
    let mut accelerators = HashSet::new();
    for registration in registrations {
        if registration.command_id.is_empty() || registration.accelerator.is_empty() {
            return Err("global shortcut command ids and accelerators must not be empty".into());
        }
        if !command_ids.insert(&registration.command_id) {
            return Err(format!(
                "duplicate global shortcut command id: {}",
                registration.command_id
            ));
        }
        if !accelerators.insert(&registration.accelerator) {
            return Err(format!(
                "duplicate global shortcut accelerator: {}",
                registration.accelerator
            ));
        }
    }
    Ok(())
}

fn register_all(
    app: &AppHandle<Wry>,
    registrations: &[GlobalShortcutRegistration],
) -> Result<(), String> {
    for registration in registrations {
        let command_id = registration.command_id.clone();
        app.global_shortcut()
            .on_shortcut(registration.accelerator.as_str(), move |app, _, event| {
                let state = match event.state() {
                    NativeShortcutState::Pressed => GlobalShortcutState::Pressed,
                    NativeShortcutState::Released => GlobalShortcutState::Released,
                };
                let _ = GlobalShortcutTriggered {
                    command_id: command_id.clone(),
                    state,
                }
                .emit_to(app, WHISPERING_WINDOW);
            })
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn is_autostart_enabled(app: AppHandle<Wry>) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn set_autostart_enabled(app: AppHandle<Wry>, enabled: bool) -> Result<(), String> {
    if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    }
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registration(command_id: &str, accelerator: &str) -> GlobalShortcutRegistration {
        GlobalShortcutRegistration {
            command_id: command_id.into(),
            accelerator: accelerator.into(),
        }
    }

    #[test]
    fn shortcut_replacement_rejects_duplicate_owners() {
        let duplicate_command = [
            registration("record", "Cmd+R"),
            registration("record", "Cmd+T"),
        ];
        assert!(validate_registrations(&duplicate_command).is_err());

        let duplicate_accelerator = [
            registration("record", "Cmd+R"),
            registration("cancel", "Cmd+R"),
        ];
        assert!(validate_registrations(&duplicate_accelerator).is_err());
    }
}
