//! Vocab's desktop app (`epicenter-standalone`, decisions 88 to 97): one
//! window that starts on Vocab's AppData root and opens its data folder,
//! `~/Epicenter/Vocab` unless `settings.md` names another, by path
//! (`openDataFolder` from `@epicenter/folder/tauri`), when Tauri's
//! file-system scope allows it. The AppData root also holds `connections.md`,
//! the endpoints the learner connected, whose keys are in the keychain. It
//! signs in only for Epicenter's hosted tutor models and dictation, through
//! `epicenter-account`, whose token the page never holds. It asks Epicenter
//! to sync the folder and never syncs it itself.

// Keeps a console window from opening beside the app in a Windows release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use epicenter_account::AccountApp;
use epicenter_standalone::StandaloneApp;

include!("command_names.rs");

/// Wide: the chat history, the conversation, and its focus words side by side.
const VOCAB: StandaloneApp = StandaloneApp {
    page: "vocab",
    title: "Vocab",
    size: (1100.0, 760.0),
};

/// Signs in only for Epicenter's hosted tutor models and dictation.
const ACCOUNT: AccountApp = AccountApp {
    client_id: "so.epicenter.vocab.native",
    name: "Vocab",
    scope: AccountApp::HOSTED_MODELS,
};

fn main() {
    let context = tauri::generate_context!();
    let builder = epicenter_standalone::builder(VOCAB);
    epicenter_account::manage(builder, ACCOUNT, &context.config().identifier)
        .invoke_handler(tauri::generate_handler![
            epicenter_account::account::account_state,
            epicenter_account::account::account_sign_in,
            epicenter_account::account::account_sign_out,
            epicenter_account::account::account_fetch,
            epicenter_account::account::account_fetch_cancel,
            epicenter_account::keychain::keychain_get,
            epicenter_account::keychain::keychain_set,
        ])
        .run(context)
        .expect("Vocab could not start");
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;

    fn read(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    /// Vocab is its own native client, `so.epicenter.<app>.native`
    /// (decision 84), the id `apps/api/worker/oauth-registrations.ts`
    /// registers, and asks only for hosted models.
    #[test]
    fn vocab_signs_in_as_its_own_native_client() {
        assert_eq!(ACCOUNT.client_id, "so.epicenter.vocab.native");
        assert_eq!(ACCOUNT.name, "Vocab");
        assert_eq!(ACCOUNT.scope, AccountApp::HOSTED_MODELS);
    }

    /// The build script declares every account command, and nothing else.
    #[test]
    fn the_declared_commands_are_the_accounts() {
        assert_eq!(COMMANDS, epicenter_account::COMMANDS);
    }

    /// The bundle is `so.epicenter.vocab`, its folder is named for the app
    /// (`~/Epicenter/Vocab`), and it loads the desktop page, never the web
    /// build. The development configuration has its own name, so its own
    /// folder (`~/Epicenter/Vocab Dev`) and AppData.
    #[test]
    fn vocab_is_its_own_app_with_a_folder_named_for_it() {
        let config = read(include_str!("../tauri.conf.json"));
        assert_eq!(config["identifier"], "so.epicenter.vocab");
        assert_eq!(config["productName"], VOCAB.title);
        assert_eq!(config["build"]["frontendDist"], "../build-desktop");
        assert_eq!(config["plugins"]["fs"]["scopeDroppedPaths"], false);
        let dev = read(include_str!("../tauri.dev.conf.json"));
        assert_eq!(dev["identifier"], "so.epicenter.vocab.dev");
        assert_eq!(dev["productName"], "Vocab Dev");
        for configuration in [&config, &dev] {
            assert_eq!(
                configuration["app"]["security"]["capabilities"],
                json!(["vocab"])
            );
        }
    }

    /// The window reaches its roots and Epicenter's sync request through the
    /// folder plugin, finds them with Tauri's path API and the app's name,
    /// may pick a folder with the native dialog, and calls exactly the
    /// commands the build script declares. No capability names a folder:
    /// startup allows the default.
    #[test]
    fn the_capability_grants_plugins_and_the_declared_commands_and_no_folder() {
        let capability = read(include_str!("../capabilities/vocab.json"));
        assert_eq!(capability["windows"], json!(["vocab:*"]));
        assert_eq!(capability["local"], true);
        let mut expected: Vec<String> = [
            "epicenter-folder:default",
            "dialog:allow-open",
            "core:app:allow-name",
            "core:path:allow-resolve-directory",
            "core:path:allow-join",
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
