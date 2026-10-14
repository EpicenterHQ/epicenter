//! The credential-free account captured by an application's private device
//! storage: its SQLite files, keyring entries, and blobs. Authored folders hold
//! no account (ADR-0532).
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountIdentity {
    pub authority_id: String,
    pub principal_id: String,
}

/// The private storage address for `account`: `no-account` signed out, else
/// `accounts/<hex authority>/<hex principal>`. Hex keeps every byte of the
/// identity, reversibly, in a name any filesystem accepts; `deviceOwnerPath` in
/// `packages/principal/src/device-owner.ts` derives the same string.
pub fn path(account: Option<&AccountIdentity>) -> Result<String, String> {
    let Some(account) = account else {
        return Ok("no-account".into());
    };
    fn encode(value: &str) -> Result<String, String> {
        if value.is_empty() || value.chars().any(char::is_control) {
            return Err("Invalid device account identity.".into());
        }
        Ok(value
            .as_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect())
    }
    Ok(format!(
        "accounts/{}/{}",
        encode(&account.authority_id)?,
        encode(&account.principal_id)?
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_identity_matches_the_browser_path_encoding() {
        assert_eq!(path(None).unwrap(), "no-account");
        let account = AccountIdentity {
            authority_id: "a".into(),
            principal_id: "B".into(),
        };
        assert_eq!(path(Some(&account)).unwrap(), "accounts/61/42");
    }
}
