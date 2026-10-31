//! Todos' desktop app (`epicenter-standalone`, decisions 88 to 97): one
//! window that starts on Todos' AppData root and opens its data folder,
//! `~/Epicenter/Todos` unless `settings.md` names another, by path
//! (`openDataFolder` from `@epicenter/folder/tauri`), when Tauri's
//! file-system scope allows it: startup allows the default, and the native
//! picker allows the folder a person chooses. It asks Epicenter to sync the
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

    /// The bundle is `so.epicenter.todos`, and its folder is named for the
    /// app: `~/Epicenter/Todos` when the person takes the recommendation.
    #[test]
    fn todos_is_its_own_app_with_a_folder_named_for_it() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], "so.epicenter.todos");
        assert_eq!(config["productName"], TODOS.title);
        let dev: Value = serde_json::from_str(include_str!("../tauri.dev.conf.json")).unwrap();
        assert_eq!(dev["identifier"], "so.epicenter.todos.dev");
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
            serde_json::from_str(include_str!("../capabilities/todos.json")).unwrap();
        assert_eq!(capability["windows"], json!(["todos:*"]));
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
                json!(["todos"])
            );
        }
        assert_eq!(dev["productName"], "Todos Dev");
    }
}
