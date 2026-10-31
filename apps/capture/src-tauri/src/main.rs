//! Capture's desktop app: one window over the folder Capture keeps its files
//! in, asked for on first run (`~/Epicenter/Capture` recommended) and bound
//! before the page loads (`epicenter-standalone`). The page opens it as
//! Capture's contract client (`openDevice` from `@epicenter/folder/tauri`)
//! and never signs in: it asks Epicenter to sync the folder
//! (`syncWithEpicenter({ path, contract })`, the path from `folder_path`),
//! and can move it (`choose_folder`). The choice is `folder` in Capture's
//! `settings.md`, in its configuration directory (decision 82).

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
            epicenter_standalone::commands::choose_folder,
            epicenter_standalone::commands::folder_path,
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

    /// The window reaches its folder, Epicenter's sync request and status
    /// through the folder plugin, its folder's path, and may ask to move the
    /// folder; nothing else.
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
                "allow-choose-folder",
                "allow-folder-path"
            ])
        );
    }
}
