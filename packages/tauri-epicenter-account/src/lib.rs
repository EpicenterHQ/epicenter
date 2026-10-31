//! Sign-in with Epicenter and the OS keychain for Epicenter's standalone
//! desktop apps (`epicenter-standalone`), shared so each app names only who
//! it is. The page's side is `createTauriAuth` from `@epicenter/auth/tauri`,
//! an `AuthClient` over these commands.
//!
//! - `account`: the native sign-in (RFC 8252 loopback with PKCE in the system
//!   browser), the refresh token in the keychain, and `account_fetch`, which
//!   sends the page's requests to Epicenter's API with a token the page never
//!   holds.
//! - `keychain`: the one way an app reaches the keychain, for the refresh
//!   token and for the API keys a page saves (`keychain_get`, `keychain_set`).
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
pub mod keychain;

use std::sync::Arc;

pub use account::{deployment_origin, Account, AccountApp};

/// Every command this crate gives a window, as its `build.rs` declares them.
pub const COMMANDS: &[&str] = &[
    "account_state",
    "account_sign_in",
    "account_sign_out",
    "account_fetch",
    "account_fetch_cancel",
    "keychain_get",
    "keychain_set",
];

/// Manage `app`'s account, against Epicenter's deployment
/// (`deployment_origin`), and its keychain under the bundle `identifier`.
pub fn manage<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
    app: AccountApp,
    identifier: &str,
) -> tauri::Builder<R> {
    let secrets = keychain::for_app(identifier);
    builder
        .manage(keychain::AppSecrets(secrets.clone()))
        .manage(Arc::new(Account::new(app, deployment_origin(), secrets)))
}
