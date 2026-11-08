//! Capture's desktop app (`epicenter-standalone`, decisions 88 to 90): one
//! window whose page opens Capture's data folder by name, `~/Epicenter/capture`,
//! which its bundle identifier names (`openFolder` from `@epicenter/folder`,
//! whose `tauri` leaf opens the Data root). Only Epicenter syncs the folder
//! (ADR-0822), and the app never signs in.

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
        .run(tauri::generate_context!())
        .expect("Capture could not start");
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;

    /// The bundle is `so.epicenter.capture`, which names its folder,
    /// `~/Epicenter/capture`. The development configuration states its
    /// environment, so its folder is `~/Epicenter Dev/capture`, and its
    /// identifier is the production one with `.dev`.
    #[test]
    fn capture_is_its_own_app_with_a_folder_named_for_it() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], "so.epicenter.capture");
        assert_eq!(config["productName"], CAPTURE.title);
        let dev: Value = serde_json::from_str(include_str!("../tauri.dev.conf.json")).unwrap();
        assert_eq!(dev["identifier"], "so.epicenter.capture.dev");
        // The environment is stated, never read from the identifier.
        assert_eq!(
            dev["plugins"]["epicenter-standalone"]["environment"],
            "development"
        );
        assert!(config["plugins"]["epicenter-standalone"].is_null());
    }

    /// The window reaches its roots, their identities, and the record
    /// Epicenter keeps for its folder through the folder plugin, by name, and
    /// hears the folder's changes as the shell's events; nothing else. No
    /// capability names a folder. Each configuration lists its capabilities,
    /// so nothing in `capabilities/` is enabled implicitly.
    #[test]
    fn the_capability_grants_plugins_and_names_no_folder() {
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/capture.json")).unwrap();
        assert_eq!(capability["windows"], json!(["capture:*"]));
        assert_eq!(capability["local"], true);
        assert_eq!(
            capability["permissions"],
            json!([
                "epicenter-folder:default",
                "core:event:allow-listen",
                "core:event:allow-unlisten"
            ])
        );
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let dev: Value = serde_json::from_str(include_str!("../tauri.dev.conf.json")).unwrap();
        for configuration in [&config, &dev] {
            assert_eq!(
                configuration["app"]["security"]["capabilities"],
                json!(["capture"])
            );
        }
        assert_eq!(dev["productName"], "Capture Dev");
    }
}
