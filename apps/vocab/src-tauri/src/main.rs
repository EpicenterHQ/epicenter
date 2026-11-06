//! Vocab's desktop app (`epicenter-standalone`, decisions 88 to 97): one
//! window whose page opens Vocab's two roots by name: its AppData root and
//! its data folder, `~/Epicenter/vocab`, which its bundle identifier names
//! (`openFolder` from `@epicenter/folder`, whose `tauri` leaf opens the Data
//! root). The AppData root holds `connections.md`, the endpoints the learner
//! connected (`customEndpoints` from `@epicenter/ai`), whose keys are in
//! the shell's `credentials.json` beside it, which the page never reads; the
//! page's requests to them are sent from here, with the key, through
//! `epicenter-account`'s `connection_fetch`. It signs in only for
//! Epicenter's hosted tutor models and dictation, through
//! `epicenter-account`, whose token the page never holds; who is signed in
//! is `account.json` in the AppData root, which only the shell writes. Only
//! Epicenter syncs the folder (ADR-0822); the app never does.

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
    audiences: AccountApp::API,
};

fn main() {
    let context = tauri::generate_context!();
    let builder = epicenter_standalone::builder(VOCAB);
    epicenter_account::manage(builder, ACCOUNT)
        .invoke_handler(tauri::generate_handler![
            epicenter_account::account::account_sign_in,
            epicenter_account::account::account_sign_out,
            epicenter_account::account::account_fetch,
            epicenter_account::account::account_fetch_cancel,
            epicenter_account::connection::connection_key_set,
            epicenter_account::connection::connection_key_move,
            epicenter_account::connection::connection_fetch,
            epicenter_account::connection::connection_fetch_cancel,
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

    /// The build script declares every account and connection command, and
    /// nothing else.
    #[test]
    fn the_declared_commands_are_the_accounts_and_connections() {
        assert_eq!(
            COMMANDS,
            [
                epicenter_account::COMMANDS,
                epicenter_account::CONNECTION_COMMANDS
            ]
            .concat()
        );
    }

    /// The bundle is `so.epicenter.vocab`, which names its folder,
    /// `~/Epicenter/vocab`, and it loads the one build the web serves
    /// (ADR-0781). The development configuration states its environment, so its
    /// folder is `~/Epicenter Dev/vocab`, and its identifier is the
    /// production one with `.dev`, so it has its own AppData.
    #[test]
    fn vocab_is_its_own_app_with_a_folder_named_for_it() {
        let config = read(include_str!("../tauri.conf.json"));
        assert_eq!(config["identifier"], "so.epicenter.vocab");
        assert_eq!(config["productName"], VOCAB.title);
        assert_eq!(config["build"]["frontendDist"], "../build");
        let dev = read(include_str!("../tauri.dev.conf.json"));
        assert_eq!(dev["identifier"], "so.epicenter.vocab.dev");
        // The environment is stated, never read from the identifier.
        assert_eq!(
            dev["plugins"]["epicenter-standalone"]["environment"],
            "development"
        );
        assert!(config["plugins"]["epicenter-standalone"].is_null());
        assert_eq!(dev["productName"], "Vocab Dev");
        for configuration in [&config, &dev] {
            assert_eq!(
                configuration["app"]["security"]["capabilities"],
                json!(["vocab"])
            );
        }
    }

    /// The window reaches its roots and the record Epicenter keeps for its
    /// folder through the folder plugin, by name, hears its roots' changes,
    /// and calls exactly the commands the build script declares. No
    /// capability names a folder.
    #[test]
    fn the_capability_grants_plugins_and_the_declared_commands_and_no_folder() {
        let capability = read(include_str!("../capabilities/vocab.json"));
        assert_eq!(capability["windows"], json!(["vocab:*"]));
        assert_eq!(capability["local"], true);
        let mut expected: Vec<String> = [
            "epicenter-folder:default",
            "core:event:allow-listen",
            "core:event:allow-unlisten",
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
