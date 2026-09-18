//! Internal OS credential-store backing for the desktop auth cell and for one
//! labeled secret per application.
//!
//! The running bundle identifier names the service, isolating dev credentials.
//! Rust owns the service and account strings. Bun sends the desktop auth cell's
//! opaque value, or an application id, and label; it never sends an
//! address in the credential store, and it cannot construct one. WebViews never
//! receive a credential-store primitive.
//!
//! No WebView command exposes this module. Rust reads the auth cell before Bun
//! boots and writes it, and every application secret, only for correlated
//! requests on the private sidecar pipe.

use crate::device_owner::{self, AccountIdentity};
use keyring::{Entry, Error as KeyringCrateError};
use thiserror::Error;

// Epicenter stores exactly one desktop auth cell, so the account is a Rust
// constant rather than an input from Bun or a WebView.
const KEYRING_ACCOUNT: &str = "auth-grant";

fn is_label(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// JSON preserves identity component boundaries; the prefix excludes auth-grant.
fn app_secret_account(
    app_id: &str,
    label: &str,
    account: Option<&AccountIdentity>,
) -> Result<String, KeyringError> {
    if !is_label(app_id) || !is_label(label) {
        return Err(KeyringError::Failed {
            message: "invalid application secret identity or label".to_string(),
        });
    }
    let owner = device_owner::path(account).map_err(|message| KeyringError::Failed { message })?;
    serde_json::to_string(&(app_id, owner, label))
        .map(|address| format!("app-secret:{address}"))
        .map_err(|error| KeyringError::Failed {
            message: error.to_string(),
        })
}

pub(crate) fn read_app_secret(
    service: &str,
    app_id: &str,
    label: &str,
    owner: Option<&AccountIdentity>,
) -> Result<Option<String>, KeyringError> {
    let account = app_secret_account(app_id, label, owner)?;
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
    label: &str,
    value: &str,
    owner: Option<&AccountIdentity>,
) -> Result<(), KeyringError> {
    let account = app_secret_account(app_id, label, owner)?;
    Entry::new(service, &account)
        .map_err(|e| KeyringError::from_crate_error("opening keyring entry", e))?
        .set_password(value)
        .map_err(|e| KeyringError::from_crate_error("writing keyring entry", e))
}

pub(crate) fn delete_app_secret(
    service: &str,
    app_id: &str,
    label: &str,
    owner: Option<&AccountIdentity>,
) -> Result<(), KeyringError> {
    let account = app_secret_account(app_id, label, owner)?;
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
    fn account_keys_do_not_collide_with_other_accounts_or_no_account() {
        let mut keys = std::collections::HashSet::new();
        keys.insert(app_secret_account("so.epicenter.mail", "token", None).unwrap());
        for (authority, person) in [
            ("one", "alice"),
            ("one", "bob"),
            ("two", "alice"),
            ("one", "Alice"),
        ] {
            let account = crate::device_owner::AccountIdentity {
                authority_id: authority.into(),
                principal_id: person.into(),
            };
            assert!(keys
                .insert(app_secret_account("so.epicenter.mail", "token", Some(&account)).unwrap()));
        }
    }

    #[test]
    fn application_and_label_define_the_keychain_address() {
        let mut addresses = std::collections::HashSet::new();
        for app in ["so.epicenter.mail", "so.epicenter.other"] {
            for label in ["token", "other"] {
                assert!(addresses.insert(app_secret_account(app, label, None).unwrap()));
            }
        }
        assert_eq!(
            app_secret_account("so.epicenter.mail", "token", None).unwrap(),
            r#"app-secret:["so.epicenter.mail","no-account","token"]"#
        );
    }

    #[test]
    fn malformed_identity_and_labels_are_refused_without_opening_keychain() {
        assert!(app_secret_account("", "token", None).is_err());
        assert!(app_secret_account("so.epicenter.mail", "a/b", None).is_err());
    }
}
