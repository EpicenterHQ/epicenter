//! Internal OS credential-store backing for the desktop auth cell.
//!
//! The running bundle identifier names the service, isolating dev credentials.
//! Rust owns the service and account strings. Bun sends only the auth cell's
//! opaque value; it never sends an address in the credential store, and it
//! cannot construct one. WebViews never receive a credential-store primitive.
//!
//! No WebView command exposes this module. Rust reads the auth cell before Bun
//! boots and writes it only for correlated requests on the private sidecar
//! pipe.

use keyring::{Entry, Error as KeyringCrateError};
use thiserror::Error;

// Epicenter stores exactly one desktop auth cell, so the account is a Rust
// constant rather than an input from Bun or a WebView.
const KEYRING_ACCOUNT: &str = "auth-grant";

/// Internal keyring failure with enough context for the host startup log.
#[derive(Error, Debug)]
pub enum KeyringError {
    #[error("{message}")]
    Failed { message: String },
}

pub(crate) fn read_auth_cell(service: &str) -> Result<Option<String>, KeyringError> {
    let entry = Entry::new(service, KEYRING_ACCOUNT)
        .map_err(|e| KeyringError::from_crate_error("opening keyring entry", e))?;
    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(KeyringCrateError::NoEntry) => Ok(None),
        Err(e) => Err(KeyringError::from_crate_error("reading keyring entry", e)),
    }
}

pub(crate) fn write_auth_cell(service: &str, value: Option<String>) -> Result<(), KeyringError> {
    let entry = Entry::new(service, KEYRING_ACCOUNT)
        .map_err(|e| KeyringError::from_crate_error("opening keyring entry", e))?;
    match value {
        Some(password) => entry
            .set_password(&password)
            .map_err(|e| KeyringError::from_crate_error("writing keyring entry", e)),
        None => match entry.delete_credential() {
            Ok(()) | Err(KeyringCrateError::NoEntry) => Ok(()),
            Err(e) => Err(KeyringError::from_crate_error("deleting keyring entry", e)),
        },
    }
}

impl KeyringError {
    fn from_crate_error(context: &str, err: KeyringCrateError) -> Self {
        Self::Failed {
            message: format!("{context}: {err}"),
        }
    }
}
