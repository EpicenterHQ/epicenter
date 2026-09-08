//! Internal OS credential-store backing for the desktop auth cell and for one
//! labeled secret per application account.
//!
//! The running bundle identifier names the service, isolating dev credentials.
//! Rust owns the service and account strings. Bun sends the desktop auth cell's
//! opaque value, or an application id and an account id; it never sends an
//! address in the credential store, and it cannot construct one. WebViews never
//! receive a credential-store primitive.
//!
//! No WebView command exposes this module. Rust reads the auth cell before Bun
//! boots and writes it, and every application secret, only for correlated
//! requests on the private sidecar pipe.

use keyring::{Entry, Error as KeyringCrateError};
use thiserror::Error;

// Epicenter stores exactly one desktop auth cell, so the account is a Rust
// constant rather than an input from Bun or a WebView.
const KEYRING_ACCOUNT: &str = "auth-grant";

/// The label grammar Rust will compose an account string out of.
///
/// Both halves are already validated at Bun's route; this is the second check,
/// and it is the one that matters, because it is what makes the composed string
/// unambiguous. A separator inside either label would let two different pairs
/// name one entry, so the grammar has no separator in it.
fn is_label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// Where one application's account secret is stored.
///
/// The `app:` prefix is what keeps this namespace clear of `auth-grant`, which
/// is a bare account name and can never collide with a prefixed one. Two
/// applications each naming a secret `gmail` land on two entries (ADR-0310).
fn app_secret_account(app_id: &str, account_id: &str) -> Result<String, KeyringError> {
    if !is_label(app_id) || !is_label(account_id) {
        return Err(KeyringError::Failed {
            message:
                "an application secret label must be one dot, dash, underscore, or alphanumeric run"
                    .to_string(),
        });
    }
    Ok(format!("app:{app_id}:{account_id}"))
}

pub(crate) fn read_app_secret(
    service: &str,
    app_id: &str,
    account_id: &str,
) -> Result<Option<String>, KeyringError> {
    let account = app_secret_account(app_id, account_id)?;
    let entry = Entry::new(service, &account)
        .map_err(|e| KeyringError::from_crate_error("opening keyring entry", e))?;
    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(KeyringCrateError::NoEntry) => Ok(None),
        Err(e) => Err(KeyringError::from_crate_error("reading keyring entry", e)),
    }
}

pub(crate) fn write_app_secret(
    service: &str,
    app_id: &str,
    account_id: &str,
    value: &str,
) -> Result<(), KeyringError> {
    let account = app_secret_account(app_id, account_id)?;
    Entry::new(service, &account)
        .map_err(|e| KeyringError::from_crate_error("opening keyring entry", e))?
        .set_password(value)
        .map_err(|e| KeyringError::from_crate_error("writing keyring entry", e))
}

pub(crate) fn delete_app_secret(
    service: &str,
    app_id: &str,
    account_id: &str,
) -> Result<(), KeyringError> {
    let account = app_secret_account(app_id, account_id)?;
    let entry = Entry::new(service, &account)
        .map_err(|e| KeyringError::from_crate_error("opening keyring entry", e))?;
    match entry.delete_credential() {
        Ok(()) | Err(KeyringCrateError::NoEntry) => Ok(()),
        Err(e) => Err(KeyringError::from_crate_error("deleting keyring entry", e)),
    }
}

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

#[cfg(test)]
mod tests {
    use super::app_secret_account;

    #[test]
    fn a_label_pair_composes_one_unambiguous_account() {
        assert_eq!(
            app_secret_account("so.epicenter.local-mail", "abc123").unwrap(),
            "app:so.epicenter.local-mail:abc123"
        );
    }

    #[test]
    fn a_separator_in_a_label_is_refused_rather_than_escaped() {
        for (app_id, account_id) in [
            ("so.epicenter:mail", "abc"),
            ("so.epicenter.mail", "a:b"),
            ("", "abc"),
            ("so.epicenter.mail", ""),
            ("so.epicenter.mail", "a/b"),
        ] {
            assert!(app_secret_account(app_id, account_id).is_err());
        }
    }
}
