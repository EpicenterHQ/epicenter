//! Honeycrisp's desktop app (`epicenter-standalone`, decisions 88 to 90): one
//! window that starts on Honeycrisp's AppData root and opens its data folder,
//! `~/Epicenter/Honeycrisp` unless `settings.md` names another, by path
//! (`openDevice` from `@epicenter/folder/tauri`), when Tauri's file-system
//! scope allows it: the capability allows the default, and the native
//! picker allows the folder a person chooses. It asks Epicenter to sync the
//! folder (`syncWithEpicenter`) and never signs in.

// Keeps a console window from opening beside the app in a Windows release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use epicenter_standalone::StandaloneApp;

/// Wide: the folders, the notes, and the open note side by side.
const HONEYCRISP: StandaloneApp = StandaloneApp {
    page: "honeycrisp",
    title: "Honeycrisp",
    size: (1100.0, 760.0),
};

fn main() {
    epicenter_standalone::builder(HONEYCRISP)
        .run(tauri::generate_context!())
        .expect("Honeycrisp could not start");
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;

    /// The bundle is `so.epicenter.honeycrisp`, its folder is named for the
    /// app (`~/Epicenter/Honeycrisp` when the person takes the
    /// recommendation), and it loads the desktop page, never the web build.
    #[test]
    fn honeycrisp_is_its_own_app_with_a_folder_named_for_it() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], "so.epicenter.honeycrisp");
        assert_eq!(config["productName"], HONEYCRISP.title);
        assert_eq!(config["build"]["frontendDist"], "../build-desktop");
        let dev: Value = serde_json::from_str(include_str!("../tauri.dev.conf.json")).unwrap();
        assert_eq!(dev["identifier"], "so.epicenter.honeycrisp.dev");
    }

    /// The window reaches its roots, and Epicenter's sync request and status,
    /// through the folder plugin, finds them with Tauri's path API and the
    /// app's name, and may pick a folder with the native dialog; nothing
    /// else. No capability names a folder: startup allows the default. Each
    /// configuration lists its capabilities, so nothing in `capabilities/` is
    /// enabled implicitly, and the development configuration has its own
    /// name, so its own default folder.
    #[test]
    fn the_capability_grants_plugins_and_names_no_folder() {
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/honeycrisp.json")).unwrap();
        assert_eq!(capability["windows"], json!(["honeycrisp:*"]));
        assert_eq!(capability["local"], true);
        assert_eq!(
            capability["permissions"],
            json!([
                "epicenter-folder:default",
                "dialog:allow-open",
                "core:app:allow-name",
                "core:path:allow-resolve-directory",
                "core:path:allow-join"
            ])
        );
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let dev: Value = serde_json::from_str(include_str!("../tauri.dev.conf.json")).unwrap();
        assert_eq!(config["plugins"]["fs"]["scopeDroppedPaths"], false);
        for configuration in [&config, &dev] {
            assert_eq!(
                configuration["app"]["security"]["capabilities"],
                json!(["honeycrisp"])
            );
        }
        assert_eq!(dev["productName"], "Honeycrisp Dev");
    }
}
