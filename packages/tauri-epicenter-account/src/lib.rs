//! Sign-in with Epicenter and the OS keychain for Epicenter's standalone
//! desktop apps (`epicenter-standalone`), shared so each app names only who
//! it is. The page's side of the sign-in is `createTauriAuth` from
//! `@epicenter/account/tauri`, an `AuthClient` over these commands; the
//! page's side of the provider keys is `@epicenter/ai/tauri`.
//!
//! - `account`: the native sign-in (RFC 8252 loopback with PKCE in the system
//!   browser), the refresh token in the keychain, and `account_fetch`, which
//!   sends the page's requests to Epicenter's API with a token the page never
//!   holds.
//! - `keychain`: the one way an app reaches the keychain, for the refresh
//!   token and for the provider keys a page saves (`keychain_get`,
//!   `keychain_set`).
//! - `connection`: `connection_fetch`, the shell's one fetch for the page:
//!   it sends a request to an endpoint the person connected, with the key
//!   the keychain keeps for it, to that key's endpoint only, or with no key
//!   to a server on this computer. An app that reaches endpoints other than
//!   Epicenter's registers `CONNECTION_COMMANDS`, the provider keys' commands.
//!
//! ```ignore
//! const ACCOUNT: AccountApp = AccountApp {
//!     client_id: "so.epicenter.vocab.native",
//!     name: "Vocab",
//!     scope: AccountApp::HOSTED_MODELS,
//! };
//!
//! let context = tauri::generate_context!();
//! epicenter_account::manage(builder, ACCOUNT, &context.config().identifier)
//!     .invoke_handler(tauri::generate_handler![
//!         epicenter_account::account::account_state,
//!         // … every name in `COMMANDS`
//!     ])
//! ```
//!
//! The app's `build.rs` declares `COMMANDS` (`AppManifest::commands`) and its
//! capability grants `allow-<command>` for each.

pub mod account;
pub mod connection;
pub mod keychain;
mod relay;

use std::sync::Arc;

pub use account::{deployment_origin, Account, AccountApp};
pub use connection::Connections;

/// Every command this crate gives a window, as its `build.rs` declares them.
pub const COMMANDS: &[&str] = &[
    "account_state",
    "account_sign_in",
    "account_sign_out",
    "account_fetch",
    "account_fetch_cancel",
];

/// The commands an app that reaches endpoints other than Epicenter's adds to
/// `COMMANDS`: the provider keys in the keychain, and the fetch that sends
/// with them.
pub const CONNECTION_COMMANDS: &[&str] = &[
    "keychain_get",
    "keychain_set",
    "connection_fetch",
    "connection_fetch_cancel",
];

/// Manage `app`'s account, against Epicenter's deployment
/// (`deployment_origin`), its keychain under the bundle `identifier`, and
/// its connections' requests.
pub fn manage<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
    app: AccountApp,
    identifier: &str,
) -> tauri::Builder<R> {
    let secrets = keychain::for_app(identifier);
    builder
        .manage(keychain::AppSecrets(secrets.clone()))
        .manage(Arc::new(Connections::new(secrets.clone())))
        .manage(Arc::new(Account::new(app, deployment_origin(), secrets)))
}
