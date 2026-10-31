//! Whispering's desktop app: its own folder, chosen by the person on first
//! run (`epicenter-standalone`), recorded into from the first sample
//! (`tauri-plugin-epicenter-recorder`), transcribed on this computer
//! (`tauri-plugin-epicenter-transcription`) or by a configured endpoint, and
//! synced only by Epicenter when the person asks it to.

// Keeps a console window from opening beside the app in a Windows release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod account;
mod http;
mod secrets;
mod shortcut;

use epicenter_standalone::StandaloneApp;

include!("command_names.rs");

fn main() {
    let app = epicenter_standalone::builder(StandaloneApp {
        page: "whispering",
        title: "Whispering",
        size: (1100.0, 760.0),
    })
    .plugin(tauri_plugin_epicenter_recorder::init())
    .plugin(tauri_plugin_epicenter_transcription::init())
    .plugin(shortcut::listener())
    .plugin(shortcut::register())
    .manage(account::Accounts::new(account::api_origin()))
    .manage(http::Sender::default())
    .invoke_handler(tauri::generate_handler![
        account::account_state,
        account::account_sign_in,
        account::account_sign_out,
        account::account_token,
        secrets::secret_get,
        secrets::secret_set,
        http::send_request,
        epicenter_standalone::commands::choose_folder,
        epicenter_standalone::commands::folder_path,
    ])
    .plugin(secrets::plugin())
    .build(tauri::generate_context!())
    .expect("Whispering could not start");
    tauri_plugin_epicenter_transcription::run(app, |_, _| {});
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_capability_grants_the_folder_window_what_it_calls_and_no_more() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/whispering.json")).unwrap();
        assert_eq!(capability["windows"], serde_json::json!(["whispering:*"]));
        assert_eq!(capability["local"], true);
        let granted: Vec<&str> = capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|permission| permission.as_str().unwrap())
            .collect();
        for command in COMMANDS {
            let permission = format!("allow-{}", command.replace('_', "-"));
            assert!(granted.contains(&permission.as_str()), "{permission}");
        }
    }
}
