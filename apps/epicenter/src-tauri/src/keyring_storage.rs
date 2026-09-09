//! Internal OS credential-store backing for the desktop auth cell and for one
//! labeled secret per application account.
//!
//! The running bundle identifier names the service, isolating dev credentials.
//! Rust owns the service and account strings. Bun sends the desktop auth cell's
//! opaque value, or an application id, captured account and label; it never sends an
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

/// The captured account, with explicit null for standalone local devices.
#[derive(Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(untagged)]
pub(crate) enum SecretAccount {
    Local(()),
    Personal {
        #[serde(rename = "authorityId")]
        authority_id: String,
        #[serde(rename = "principalId")]
        principal_id: String,
    },
}

fn is_label(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// JSON preserves identity component boundaries; the prefix excludes auth-grant.
fn app_secret_account(
    app_id: &str,
    account: &SecretAccount,
    label: &str,
) -> Result<String, KeyringError> {
    let valid_account = match account {
        SecretAccount::Local(()) => true,
        SecretAccount::Personal {
            authority_id,
            principal_id,
        } => [authority_id, principal_id].into_iter().all(|part| {
            !part.is_empty() && part != "." && part != ".." && !part.contains(['\0', '/', '\\'])
        }),
    };
    if !is_label(app_id) || !is_label(label) || !valid_account {
        return Err(KeyringError::Failed {
            message: "invalid application secret identity or label".to_string(),
        });
    }
    serde_json::to_string(&(app_id, account, label))
        .map(|address| format!("app-secret:{address}"))
        .map_err(|error| KeyringError::Failed {
            message: error.to_string(),
        })
}

pub(crate) fn read_app_secret(
    service: &str,
    app_id: &str,
    identity: &SecretAccount,
    label: &str,
) -> Result<Option<String>, KeyringError> {
    let account = app_secret_account(app_id, identity, label)?;
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
    identity: &SecretAccount,
    label: &str,
    value: &str,
) -> Result<(), KeyringError> {
    let account = app_secret_account(app_id, identity, label)?;
    Entry::new(service, &account)
        .map_err(|e| KeyringError::from_crate_error("opening keyring entry", e))?
        .set_password(value)
        .map_err(|e| KeyringError::from_crate_error("writing keyring entry", e))
}

pub(crate) fn delete_app_secret(
    service: &str,
    app_id: &str,
    identity: &SecretAccount,
    label: &str,
) -> Result<(), KeyringError> {
    let account = app_secret_account(app_id, identity, label)?;
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
    use super::{app_secret_account, SecretAccount};

    #[test]
    fn structured_account_addresses_preserve_each_identity_component() {
        let personal = |authority: &str, principal: &str| SecretAccount::Personal {
            authority_id: authority.to_string(),
            principal_id: principal.to_string(),
        };
        let accounts = [
            SecretAccount::Local(()),
            personal("a:b", "c"),
            personal("a", "b:c"),
            personal("a", "c"),
        ];
        let mut addresses = std::collections::HashSet::new();
        for app in ["so.epicenter.mail", "so.epicenter.other"] {
            for account in &accounts {
                for label in ["token", "other"] {
                    let address = app_secret_account(app, account, label).unwrap();
                    assert!(address.starts_with("app-secret:"));
                    assert!(addresses.insert(address));
                }
            }
        }
        assert_eq!(
            app_secret_account("so.epicenter.mail", &SecretAccount::Local(()), "token").unwrap(),
            r#"app-secret:["so.epicenter.mail",null,"token"]"#
        );
    }

    #[test]
    fn malformed_identity_and_labels_are_refused_without_opening_keychain() {
        assert!(app_secret_account("", &SecretAccount::Local(()), "token").is_err());
        assert!(app_secret_account("so.epicenter.mail", &SecretAccount::Local(()), "a/b").is_err());
        assert!(app_secret_account(
            "so.epicenter.mail",
            &SecretAccount::Personal {
                authority_id: "..".into(),
                principal_id: "person".into(),
            },
            "token"
        )
        .is_err());
    }
}
