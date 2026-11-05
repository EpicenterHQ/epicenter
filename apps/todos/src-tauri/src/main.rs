//! Todos' desktop app (`epicenter-standalone`, decisions 88 to 97): one
//! window whose page opens Todos' data folder by name, `~/Epicenter/todos`,
//! which its bundle identifier names (`openFolder` from `@epicenter/folder`,
//! whose `tauri` leaf opens the Data root). It asks Epicenter to sync the
//! folder (`syncWithEpicenter`) and never signs in.

// Keeps a console window from opening beside the app in a Windows release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use epicenter_standalone::StandaloneApp;

/// Wide enough for the list beside the open todo.
const TODOS: StandaloneApp = StandaloneApp {
    page: "todos",
    title: "Todos",
    size: (960.0, 720.0),
};

fn main() {
    epicenter_standalone::builder(TODOS)
        .run(tauri::generate_context!())
        .expect("Todos could not start");
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;

    /// The bundle is `so.epicenter.todos`, which names its folder,
    /// `~/Epicenter/todos`. The development configuration states its
    /// environment, so its folder is `~/Epicenter Dev/todos`, and its
    /// identifier is the production one with `.dev`.
    #[test]
    fn todos_is_its_own_app_with_a_folder_named_for_it() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], "so.epicenter.todos");
        assert_eq!(config["productName"], TODOS.title);
        let dev: Value = serde_json::from_str(include_str!("../tauri.dev.conf.json")).unwrap();
        assert_eq!(dev["identifier"], "so.epicenter.todos.dev");
        // The environment is stated, never read from the identifier.
        assert_eq!(
            dev["plugins"]["epicenter-standalone"]["environment"],
            "development"
        );
        assert!(config["plugins"]["epicenter-standalone"].is_null());
    }

    /// The window reaches its roots, and Epicenter's sync request and status,
    /// through the folder plugin, by name, and hears the folder's changes as
    /// the shell's events; nothing else. No capability names
    /// a folder. Each configuration lists its capabilities, so nothing in
    /// `capabilities/` is enabled implicitly.
    #[test]
    fn the_capability_grants_plugins_and_names_no_folder() {
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/todos.json")).unwrap();
        assert_eq!(capability["windows"], json!(["todos:*"]));
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
                json!(["todos"])
            );
        }
        assert_eq!(dev["productName"], "Todos Dev");
    }
}
