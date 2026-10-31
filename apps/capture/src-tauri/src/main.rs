//! Capture's desktop app (`epicenter-standalone`, decisions 88 and 89): one
//! window that starts on Capture's AppData root and opens its data folder,
//! `~/Epicenter/Capture` unless `settings.md` names another, by path
//! (`openDevice` from `@epicenter/folder/tauri`). It asks Epicenter to sync
//! the folder (`syncWithEpicenter`) and never signs in.

// Keeps a console window from opening beside the app in a Windows release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use epicenter_standalone::StandaloneApp;

/// Narrow and tall: the timeline and one capture, a column at a time.
const CAPTURE: StandaloneApp = StandaloneApp {
    page: "capture",
    title: "Capture",
    size: (760.0, 720.0),
};

fn main() {
    epicenter_standalone::builder(CAPTURE)
        .invoke_handler(tauri::generate_handler![
            epicenter_standalone::commands::open_data_folder,
            epicenter_standalone::commands::choose_data_folder,
        ])
        .run(tauri::generate_context!())
        .expect("Capture could not start");
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;

    /// The bundle is `so.epicenter.capture`, and its folder is named for the
    /// app: `~/Epicenter/Capture` when the person takes the recommendation.
    #[test]
    fn capture_is_its_own_app_with_a_folder_named_for_it() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], "so.epicenter.capture");
        assert_eq!(config["productName"], CAPTURE.title);
        let dev: Value = serde_json::from_str(include_str!("../tauri.dev.conf.json")).unwrap();
        assert_eq!(dev["identifier"], "so.epicenter.capture.dev");
    }

    /// The window reaches its roots, and Epicenter's sync request and status,
    /// through the folder plugin, and may open its data folder and pick
    /// another; nothing else.
    #[test]
    fn the_capability_selects_the_one_window_and_grants_only_its_folder() {
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/capture.json")).unwrap();
        assert_eq!(capability["windows"], json!(["capture:*"]));
        assert_eq!(capability["local"], true);
        assert_eq!(
            capability["permissions"],
            json!([
                "epicenter-folder:default",
                "allow-open-data-folder",
                "allow-choose-data-folder"
            ])
        );
    }
}
