//! Whispering's desktop app (`epicenter-standalone`, decisions 88 to 97): one
//! window that starts on Whispering's AppData root and opens its data folder,
//! `~/Epicenter/Whispering` unless `settings.md` names another, by path
//! (`openDataFolder` from `@epicenter/folder/tauri`), when Tauri's
//! file-system scope allows it. It records into that folder from the first
//! sample (`tauri-plugin-epicenter-recorder`), transcribes on this computer
//! (`tauri-plugin-epicenter-transcription`), through the signed-in Epicenter
//! account (`epicenter-account`, whose token the page never holds), or at a
//! custom endpoint (`send_request`), and starts and stops a recording from a
//! global shortcut, the one the page resolves from `shortcuts.md` and asks
//! for (`set_shortcut`). It asks Epicenter to sync the folder and never
//! syncs it itself.

// Keeps a console window from opening beside the app in a Windows release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod http;
mod shortcut;

use epicenter_account::AccountApp;
use epicenter_standalone::StandaloneApp;

include!("command_names.rs");

/// Wide: the recordings and the open one side by side.
const WHISPERING: StandaloneApp = StandaloneApp {
    page: "whispering",
    title: "Whispering",
    size: (1100.0, 760.0),
};

/// Signs in only for Epicenter's hosted transcription and AI.
const ACCOUNT: AccountApp = AccountApp {
    client_id: "so.epicenter.whispering.native",
    name: "Whispering",
    scope: AccountApp::HOSTED_MODELS,
};

fn main() {
    let context = tauri::generate_context!();
    let builder = epicenter_standalone::builder(WHISPERING)
        .plugin(tauri_plugin_epicenter_recorder::init())
        .plugin(tauri_plugin_epicenter_transcription::init())
        .plugin(shortcut::listener())
        .manage(http::Sender::default());
    let app = epicenter_account::manage(builder, ACCOUNT, &context.config().identifier)
        .invoke_handler(tauri::generate_handler![
            epicenter_account::account::account_state,
            epicenter_account::account::account_sign_in,
            epicenter_account::account::account_sign_out,
            epicenter_account::account::account_fetch,
            epicenter_account::account::account_fetch_cancel,
            epicenter_account::keychain::keychain_get,
            epicenter_account::keychain::keychain_set,
            http::send_request,
            shortcut::set_shortcut,
        ])
        .build(context)
        .expect("Whispering could not start");
    // Exits without C++ static finalizers on macOS, which can race a
    // resident model (the transcription plugin's README).
    tauri_plugin_epicenter_transcription::run(app, |_, _| {});
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;

    fn read(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    /// Whispering is its own native client, `so.epicenter.<app>.native`
    /// (decision 84), the id `apps/api/worker/oauth-registrations.ts`
    /// registers, and asks only for hosted models.
    #[test]
    fn whispering_signs_in_as_its_own_native_client() {
        assert_eq!(ACCOUNT.client_id, "so.epicenter.whispering.native");
        assert_eq!(ACCOUNT.name, "Whispering");
        assert_eq!(ACCOUNT.scope, AccountApp::HOSTED_MODELS);
    }

    /// The build script declares every account command, `send_request` and
    /// `set_shortcut`, and nothing else.
    #[test]
    fn the_declared_commands_are_the_accounts_send_request_and_set_shortcut() {
        let mut expected = epicenter_account::COMMANDS.to_vec();
        expected.extend(["send_request", "set_shortcut"]);
        assert_eq!(COMMANDS, expected.as_slice());
    }

    /// The bundle is `so.epicenter.whispering`, its folder is named for the
    /// app (`~/Epicenter/Whispering`), and it loads the desktop page, never
    /// the web build. The development configuration has its own name, so its
    /// own folder (`~/Epicenter/Whispering Dev`) and AppData.
    #[test]
    fn whispering_is_its_own_app_with_a_folder_named_for_it() {
        let config = read(include_str!("../tauri.conf.json"));
        assert_eq!(config["identifier"], "so.epicenter.whispering");
        assert_eq!(config["productName"], WHISPERING.title);
        assert_eq!(config["build"]["frontendDist"], "../build-desktop");
        assert_eq!(config["plugins"]["fs"]["scopeDroppedPaths"], false);
        let dev = read(include_str!("../tauri.dev.conf.json"));
        assert_eq!(dev["identifier"], "so.epicenter.whispering.dev");
        assert_eq!(dev["productName"], "Whispering Dev");
        for configuration in [&config, &dev] {
            assert_eq!(
                configuration["app"]["security"]["capabilities"],
                json!(["whispering"])
            );
        }
    }

    /// The window reaches its roots and Epicenter's sync request through
    /// the folder plugin, finds them with Tauri's path API and the app's
    /// name, may pick a folder with the native dialog, records, transcribes
    /// and administers local models, hears the global shortcut, and calls
    /// exactly the commands the build script declares. No capability names
    /// a folder: startup allows the default.
    #[test]
    fn the_capability_grants_plugins_and_the_declared_commands_and_no_folder() {
        let capability = read(include_str!("../capabilities/whispering.json"));
        assert_eq!(capability["windows"], json!(["whispering:*"]));
        assert_eq!(capability["local"], true);
        let mut expected: Vec<String> = [
            "epicenter-folder:default",
            "dialog:allow-open",
            "core:app:allow-name",
            "core:path:allow-resolve-directory",
            "core:path:allow-join",
            "core:event:allow-listen",
            "core:event:allow-unlisten",
            "epicenter-recorder:default",
            "epicenter-transcription:allow-list-inference-models",
            "epicenter-transcription:allow-transcribe-file",
            "epicenter-transcription:allow-list-models",
            "epicenter-transcription:allow-download-model",
            "epicenter-transcription:allow-reveal-model",
            "epicenter-transcription:allow-get-active-model",
            "epicenter-transcription:allow-set-active-model",
            "epicenter-transcription:allow-get-unload-policy",
            "epicenter-transcription:allow-set-unload-policy",
        ]
        .map(String::from)
        .to_vec();
        expected.extend(
            COMMANDS
                .iter()
                .map(|command| format!("allow-{}", command.replace('_', "-"))),
        );
        assert_eq!(capability["permissions"], json!(expected));
    }
}
