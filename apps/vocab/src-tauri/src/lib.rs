//! Vocab's desktop program: the shared standalone startup
//! (`epicenter-standalone`: its folder, asked for on first run and kept in
//! `settings.md`, bound to its one window), plus Vocab's own two native
//! needs. Its connected endpoints' API keys go in the keychain
//! (`keychain`), and signing in with Epicenter, for hosted tutor models and
//! dictation only, runs through the system browser with its requests
//! relayed here (`account`).

pub mod account;
pub mod keychain;

use std::sync::Arc;

use epicenter_standalone::StandaloneApp;

pub const APP: StandaloneApp = StandaloneApp {
    page: "vocab",
    title: "Vocab",
    size: (1100.0, 760.0),
};

/// Every command the page may call, declared in `build.rs` and granted in
/// `capabilities/vocab.json`.
pub const COMMANDS: &[&str] = &[
    "folder_path",
    "choose_folder",
    "connection_keys",
    "set_connection_key",
    "account_state",
    "account_sign_in",
    "account_sign_out",
    "account_fetch",
    "account_fetch_cancel",
];

pub fn run() {
    let context = tauri::generate_context!();
    let secrets = keychain::for_app(&context.config().identifier);
    epicenter_standalone::builder(APP)
        .manage(keychain::AppSecrets(secrets.clone()))
        .manage(Arc::new(account::Account::new(
            account::deployment_origin(),
            secrets,
        )))
        .invoke_handler(tauri::generate_handler![
            epicenter_standalone::commands::folder_path,
            epicenter_standalone::commands::choose_folder,
            keychain::connection_keys,
            keychain::set_connection_key,
            account::account_state,
            account::account_sign_in,
            account::account_sign_out,
            account::account_fetch,
            account::account_fetch_cancel,
        ])
        .run(context)
        .expect("Vocab could not start");
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::COMMANDS;

    /// The one window gets the folder plugin (its folder, and asking
    /// Epicenter to sync it) and exactly Vocab's own commands.
    #[test]
    fn the_capability_grants_the_window_its_folder_and_vocabs_commands() {
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/vocab.json")).unwrap();
        assert_eq!(capability["windows"], json!(["vocab:*"]));
        assert_eq!(capability["local"], true);
        let mut expected = vec!["epicenter-folder:default".to_string()];
        expected.extend(
            COMMANDS
                .iter()
                .map(|command| format!("allow-{}", command.replace('_', "-"))),
        );
        assert_eq!(capability["permissions"], json!(expected));
    }

    #[test]
    fn the_build_script_declares_every_command() {
        let script = include_str!("../build.rs");
        for command in COMMANDS {
            assert!(script.contains(&format!("\"{command}\"")), "{command}");
        }
    }
}
