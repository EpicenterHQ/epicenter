//! Sign-in with Epicenter and the credentials file for Epicenter's
//! standalone desktop apps (`epicenter-standalone`), shared so each app names
//! only who it is. The page's side of the sign-in is `createTauriAuth` from
//! `@epicenter/account/tauri`; the page's side of the provider keys is
//! `@epicenter/ai/tauri`.
//!
//! - `account`: the native sign-in (RFC 8252 loopback with PKCE in the system
//!   browser), the refresh token in the credentials file, `account.json`,
//!   which says who is signed in, and `account_fetch`, which sends the page's
//!   requests to Epicenter's API with a token the page never holds.
//! - `credentials`: the app's one place for secrets, `credentials.json` at
//!   the top of its AppData directory (mode `0600`, ADR-0740), holding the
//!   refresh token and the provider keys a page saves. The shell reads it
//!   when a request needs a secret; no page reads it.
//! - `connection`: the provider keys' write-only commands
//!   (`connection_key_set`, `connection_key_move`), and `connection_fetch`,
//!   the shell's one fetch for the page: it sends a request to an endpoint
//!   the person connected, with the key the credentials file keeps for it,
//!   to that key's endpoint only, or with no key to a server on this
//!   computer. An app that reaches endpoints other than Epicenter's registers
//!   `CONNECTION_COMMANDS`.
//!
//! ```ignore
//! const ACCOUNT: AccountApp = AccountApp {
//!     client_id: "so.epicenter.vocab.native",
//!     name: "Vocab",
//!     scope: AccountApp::HOSTED_MODELS,
//!     audiences: AccountApp::API,
//! };
//!
//! epicenter_account::manage(builder, ACCOUNT)
//!     .invoke_handler(tauri::generate_handler![
//!         epicenter_account::account::account_sign_in,
//!         // … every name in `COMMANDS`
//!     ])
//! ```
//!
//! The app's `build.rs` declares `COMMANDS` (`AppManifest::commands`) and its
//! capability grants `allow-<command>` for each.

pub mod account;
pub mod connection;
pub mod credentials;
mod relay;

use std::sync::Arc;

use tauri::plugin::TauriPlugin;
use tauri::{Manager, RunEvent, Runtime};

pub use account::{deployment_origin, Account, AccountApp, Audience, Identity, IDENTITY_FILE};
pub use connection::Connections;
pub use credentials::{Credentials, CREDENTIALS_FILE};

/// Every command this crate gives a window, as its `build.rs` declares them.
pub const COMMANDS: &[&str] = &[
    "account_sign_in",
    "account_sign_out",
    "account_fetch",
    "account_fetch_cancel",
];

/// The commands an app that reaches endpoints other than Epicenter's adds to
/// `COMMANDS`: saving the provider keys, and the fetch that sends with them.
pub const CONNECTION_COMMANDS: &[&str] = &[
    "connection_key_set",
    "connection_key_move",
    "connection_fetch",
    "connection_fetch_cancel",
];

/// Manage `app`'s account, against Epicenter's deployment
/// (`deployment_origin`), with its credentials and `account.json` in the
/// app's AppData directory, and its connections' requests. Both files are
/// placed once the app runs.
pub fn manage<R: Runtime>(builder: tauri::Builder<R>, app: AccountApp) -> tauri::Builder<R> {
    manage_at(builder, app, deployment_origin())
}

/// `manage` against the deployment at `origin`, for a shell that names its
/// own (the Epicenter app, which a self-hosted build compiles for its server).
pub fn manage_at<R: Runtime>(
    builder: tauri::Builder<R>,
    app: AccountApp,
    origin: String,
) -> tauri::Builder<R> {
    let credentials = Arc::new(Credentials::default());
    let account = Arc::new(Account::new(app, origin, credentials.clone()));
    builder
        .manage(Arc::new(Connections::new(credentials.clone())))
        .manage(account.clone())
        .plugin(place(credentials, account))
}

/// Place the credentials file and `account.json` at the top of the app's
/// AppData directory, then write who the credentials say is signed in.
fn place<R: Runtime>(credentials: Arc<Credentials>, account: Arc<Account>) -> TauriPlugin<R> {
    let exiting = account.clone();
    tauri::plugin::Builder::new("epicenter-account")
        // A refresh the server already rotated must reach the credentials
        // file before the process ends, or the stored refresh token is spent
        // and the next start asks for a sign-in. Plugin Exit hooks run before
        // an app's own exit (`tauri_plugin_epicenter_transcription::run`).
        .on_event(move |_app, event| {
            if let RunEvent::Exit = event {
                exiting.finish_refreshing(account::EXIT_WAIT);
            }
        })
        .setup(move |app, _api| {
            // A startup that cannot name AppData says so itself
            // (`epicenter-standalone`); until then a secret reads as an error.
            let app_data = match app.path().app_data_dir() {
                Ok(app_data) => app_data,
                Err(error) => {
                    log::warn!("The account has no AppData directory: {error}");
                    return Ok(());
                }
            };
            credentials.resolve(credentials::path_in(&app_data));
            account.identify_at(app_data.join(IDENTITY_FILE));
            tauri::async_runtime::spawn(async move {
                if let Err(message) = account.publish_loaded().await {
                    log::warn!("Who is signed in could not be written: {message}");
                }
            });
            Ok(())
        })
        .build()
}
